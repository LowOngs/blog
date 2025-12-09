// System_files/workers/rewrite-post.js

export default {
  /**
   * Cloudflare Worker entry
   * - POST /rewrite-post
   * - 헤더: X-Rewrite-Secret: (env.REWRITE_SECRET와 동일해야 함)
   * - 바디: { slug: "howto-20251121-001", mode: "repair" | "rewrite", instructions?: "선택 설명" }
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
    const instructions = payload?.instructions || "";

    if (!slug || typeof slug !== "string") {
      return jsonError(400, "INVALID_SLUG", "slug 필드는 필수입니다.");
    }
    if (mode !== "repair" && mode !== "rewrite") {
      return jsonError(400, "INVALID_MODE", 'mode는 "repair" 또는 "rewrite"만 허용됩니다.');
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

      const nowIso = new Date().toISOString();
      const oldBody = postJson.body || "";

      // 2) 새 body 만들기 (지금은 테스트용: 꼬리만 다르게 붙임)
      //    ↳ 다음 단계에서 OpenAI 호출로 교체 예정
      let newBody;

      if (mode === "repair") {
        newBody =
          oldBody +
          `\n\n<!-- repaired by worker at ${nowIso} -->`;
      } else {
        newBody =
          oldBody +
          `\n\n<!-- rewritten by worker at ${nowIso} -->`;
      }

      const updatedPost = {
        ...postJson,
        body: newBody,
        // updated 필드가 있는 현재 스키마에 맞춰 저장
        updated: nowIso
      };

      const newContentString = JSON.stringify(updatedPost, null, 2);
      const newEncodedContent = btoa(unescape(encodeURIComponent(newContentString)));

      // 3) GitHub에 수정 커밋 업로드
      const putUrl =
        `https://api.github.com/repos/${owner}/${repo}/contents/` +
        encodeURIComponent(filePath);

      const commitMessage = `[worker:${mode}] rewrite body for ${slug} at ${nowIso}`;

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
