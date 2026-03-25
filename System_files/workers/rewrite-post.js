// System_files/workers/rewrite-post.js

const ALLOWED_MODES = new Set(["repair", "rewrite"]);

/**
 * LLM/요청 해석 정책
 * - 본문(body) 한정 부분 수정만 허용
 * - 단어/문장/짧은 문단 일부/소제목 아래 일부 내용만 허용
 * - 전체 재작성 및 핵심 SSOT 필드 수정 금지
 */
const FORBIDDEN_REQUEST_PATTERNS = [
  /\btitle\b/i,
  /\bslug\b/i,
  /\bpage[\s_-]?id\b/i,
  /\blabels?\b/i,
  /\bcanonical\b/i,
  /\bmeta\b/i,
  /\bschema\b/i,
  /\bog\b/i,
  /\bjson-ld\b/i,
  /\bfaq\b.*\b(전체|전부|모두|재작성|교체)\b/i,
  /\bsources?\b.*\b(전체|전부|모두|재작성|교체)\b/i,
  /\b리뷰\b.*\b전체\b/i,
  /\btrust\b/i,
  /\bauthority\b/i,
  /전체\s*(수정|재작성|교체|갈아엎)/i,
  /본문\s*전체/i,
  /full\s*rewrite/i,
  /rewrite\s*entire/i,
  /rewrite\s*whole/i
];

const ALLOWED_SCOPE_HINT_PATTERNS = [
  /단어/i,
  /문장/i,
  /문단/i,
  /짧은\s*문단/i,
  /소제목/i,
  /표현\s*수정/i,
  /오타/i,
  /의미\s*왜곡/i,
  /정보\s*오류/i,
  /부분\s*수정/i,
  /문구\s*수정/i
];

export default {
  /**
   * Cloudflare Worker entry
   * - POST /rewrite-post
   * - 헤더: X-Rewrite-Secret: (env.REWRITE_SECRET와 동일해야 함)
   * - 바디: {
   *     slug: "howto-20251121-001",
   *     mode: "repair" | "rewrite",
   *     instructions: "본문 한정 부분 수정 요청"
   *   }
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 헬스체크용
    if (request.method === "GET" && pathname === "/") {
      return new Response("rewrite-post worker OK", { status: 200 });
    }

    if (pathname !== "/rewrite-post") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // 간단한 공유 시크릿 인증
    const secretHeader = request.headers.get("X-Rewrite-Secret");
    if (!secretHeader || secretHeader !== env.REWRITE_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return jsonError(400, "INVALID_JSON", "유효한 JSON 요청이 아닙니다.");
    }

    const slug = payload?.slug;
    const mode = payload?.mode || "rewrite";
    const instructions = normalizeInstructions(payload?.instructions);

    if (!slug || typeof slug !== "string") {
      return jsonError(400, "INVALID_SLUG", "slug 필드는 필수입니다.");
    }
    if (!isValidSlug(slug)) {
      return jsonError(
        400,
        "INVALID_SLUG_FORMAT",
        "slug 형식이 유효하지 않습니다. 영문 소문자/숫자/하이픈만 허용됩니다."
      );
    }
    if (!ALLOWED_MODES.has(mode)) {
      return jsonError(400, "INVALID_MODE", 'mode는 "repair" 또는 "rewrite"만 허용됩니다.');
    }
    if (!instructions) {
      return jsonError(
        400,
        "INVALID_INSTRUCTIONS",
        "instructions 필드는 필수이며, 본문 한정 부분 수정 요청이어야 합니다."
      );
    }

    const policyError = validatePatchInstructions(instructions);
    if (policyError) {
      return jsonError(400, policyError.code, policyError.message, {
        allowedScope:
          "본문(body) 한정 부분 수정만 허용됩니다. 단어/문장/짧은 문단/소제목 아래 일부 내용만 수정 가능합니다.",
        forbiddenFields:
          ["title", "slug", "pageId", "labels", "canonical", "meta", "schema", "FAQ 전체", "Sources 전체"]
      });
    }

    // GitHub env
    const owner = env.GITHUB_OWNER;   // 예: "LowOngs"
    const repo = env.GITHUB_REPO;     // 예: "blog"
    const branch = env.GITHUB_BRANCH || "google-blog";
    const token = env.GITHUB_TOKEN;

    if (!owner || !repo || !token) {
      return jsonError(
        500,
        "MISSING_ENV",
        "GITHUB_OWNER / GITHUB_REPO / GITHUB_TOKEN 환경변수가 필요합니다."
      );
    }

    const filePath = `google-blog/System_files/content/posts/${slug}.json`;

    try {
      // 1) 기존 포스트 JSON 가져오기
      const getUrl =
        `https://api.github.com/repos/${owner}/${repo}/contents/` +
        encodeURIComponent(filePath) +
        `?ref=${encodeURIComponent(branch)}`;

      const getRes = await fetch(getUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "ongs-rewrite-worker",
          Accept: "application/vnd.github.v3+json"
        }
      });

      if (!getRes.ok) {
        const text = await getRes.text();
        return jsonError(
          getRes.status,
          "GITHUB_GET_FAILED",
          `GitHub에서 파일을 가져오지 못했습니다. (${filePath})`,
          { githubStatus: getRes.status, githubBody: text }
        );
      }

      const fileJson = await getRes.json();
      const sha = fileJson.sha;
      const encodedContent = fileJson.content || "";
      const rawJson = atob(encodedContent.replace(/\n/g, ""));
      const postJson = JSON.parse(rawJson);

      const nowIso = toKSTISO(new Date());
      const oldBody = typeof postJson.body === "string" ? postJson.body : "";

      const immutableSnapshot = {
        slug: postJson.slug,
        pageId: postJson.pageId,
        page_id: postJson.page_id
      };

      // 2) 새 body 만들기
      //    ↳ 다음 단계에서 OpenAI 호출로 교체 예정
      //    단, 정책상 "본문 일부 수정"만 허용
      let newBody;

      if (mode === "repair") {
        newBody =
          oldBody +
          `\n\n<!-- repaired by worker at ${nowIso} | body-only patch -->`;
      } else {
        newBody =
          oldBody +
          `\n\n<!-- rewritten by worker at ${nowIso} | body-only partial rewrite -->`;
      }

      const updatedPost = {
        ...postJson,
        body: newBody,
        // updated 필드가 있는 현재 스키마에 맞춰 저장
        // 운영 정책 일관화를 위해 KST ISO 사용
        updated: nowIso,

        // SSOT 보호: 핵심 필드는 원본 유지
        slug: immutableSnapshot.slug,
        pageId: immutableSnapshot.pageId,
        page_id: immutableSnapshot.page_id
      };

      const immutableViolation = detectImmutableViolation(immutableSnapshot, updatedPost);
      if (immutableViolation) {
        return jsonError(
          400,
          "IMMUTABLE_FIELD_VIOLATION",
          immutableViolation
        );
      }

      const newContentString = JSON.stringify(updatedPost, null, 2);
      const newEncodedContent = btoa(unescape(encodeURIComponent(newContentString)));

      // 3) GitHub에 수정 커밋 업로드
      const putUrl =
        `https://api.github.com/repos/${owner}/${repo}/contents/` +
        encodeURIComponent(filePath);

      const commitMessage = `[worker:${mode}] body-only partial patch for ${slug} at ${nowIso}`;

      const putRes = await fetch(putUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "ongs-rewrite-worker",
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: commitMessage,
          content: newEncodedContent,
          sha,
          branch
        })
      });

      if (!putRes.ok) {
        const text = await putRes.text();
        return jsonError(
          putRes.status,
          "GITHUB_PUT_FAILED",
          `GitHub에 수정 내용을 저장하지 못했습니다. (${filePath})`,
          { githubStatus: putRes.status, githubBody: text }
        );
      }

      const putJson = await putRes.json();

      return new Response(
        JSON.stringify({
          ok: true,
          slug,
          mode,
          updatedAt: nowIso,
          policy: {
            bodyOnly: true,
            partialOnly: true,
            immutableFields: ["slug", "pageId", "page_id", "labels", "canonical", "meta", "schema"]
          },
          commit: {
            path: filePath,
            sha: putJson.content?.sha || null
          }
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        }
      );
    } catch (err) {
      return jsonError(
        500,
        "UNEXPECTED_ERROR",
        "Worker 처리 중 알 수 없는 오류가 발생했습니다.",
        { message: String(err) }
      );
    }
  }
};

/** KST ISO 생성 */
function toKSTISO(d) {
  const utc = d.getTime() + 9 * 60 * 60 * 1000;
  const k = new Date(utc);
  const yyyy = k.getUTCFullYear();
  const mm = String(k.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(k.getUTCDate()).padStart(2, "0");
  const hh = String(k.getUTCHours()).padStart(2, "0");
  const mi = String(k.getUTCMinutes()).padStart(2, "0");
  const ss = String(k.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+09:00`;
}

/** slug 형식 검증 */
function isValidSlug(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug || ""));
}

/** instructions 정규화 */
function normalizeInstructions(v) {
  if (typeof v !== "string") return "";
  return v.trim().replace(/\s+/g, " ");
}

/** 본문 부분 수정 정책 검증 */
function validatePatchInstructions(instructions) {
  const text = String(instructions || "");

  for (const re of FORBIDDEN_REQUEST_PATTERNS) {
    if (re.test(text)) {
      return {
        code: "FORBIDDEN_SCOPE",
        message:
          "수정 요청 범위가 너무 넓거나 SSOT 핵심 필드를 침범합니다. 본문(body) 한정 부분 수정만 허용됩니다."
      };
    }
  }

  const hasAllowedHint = ALLOWED_SCOPE_HINT_PATTERNS.some((re) => re.test(text));
  if (!hasAllowedHint) {
    return {
      code: "UNCLEAR_SCOPE",
      message:
        "수정 범위가 불명확합니다. 단어/문장/짧은 문단/소제목 아래 일부 내용 중 무엇을 고칠지 명시해 주세요."
    };
  }

  return null;
}

/** 불변 필드 검증 */
function detectImmutableViolation(original, updatedPost) {
  if ((original.slug || null) !== (updatedPost.slug || null)) {
    return "slug는 수정할 수 없습니다.";
  }
  if ((original.pageId || null) !== (updatedPost.pageId || null)) {
    return "pageId는 수정할 수 없습니다.";
  }
  if ((original.page_id || null) !== (updatedPost.page_id || null)) {
    return "page_id는 수정할 수 없습니다.";
  }
  return "";
}

/** 에러 응답 헬퍼 */
function jsonError(status, code, message, extra) {
  return new Response(
    JSON.stringify({ ok: false, code, message, ...(extra || {}) }),
    {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    }
  );
}
