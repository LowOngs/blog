#!/usr/bin/env node
/**
 * posts:normalize
 * - 대상: dist/posts/*.html
 * - 역할:
 *   1) 본문(<main>...</main>) 안의 마크다운 스타일을 정규화
 *      - ### 제목  → <h2 class="section-heading"><span>제목</span></h2>
 *      - 문단/줄바꿈 정리(가능한 경우)
 *      - 앱 이름 볼륨체 강조(<strong class="app-name">Name</strong>)
 *      - ###, ** 같은 AI-티 마크다운 기호 제거
 *   2) 2차 검사
 *      - 처리 후에도 ###, **, "As an AI" 등이 남아 있으면 [WARN] 로그
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const DIST_DIR = path.join(ROOT, "dist", "posts");

// 필요 시 라벨별/글별로 확장 가능한 대표 앱 이름 리스트(예시)
const APP_NAMES = [
  "Todoist",
  "Microsoft OneNote",
  "Google Calendar",
  "Notion",
  "Dropbox",
];

/**
 * HTML에서 <main>...</main> 블록 추출
 */
function extractMain(html) {
  const re = /(<main[^>]*>)([\s\S]*?)(<\/main>)/i;
  const m = html.match(re);
  if (!m) return null;
  return {
    fullMatch: m[0],
    open: m[1],
    body: m[2],
    close: m[3],
    regex: re,
  };
}

/**
 * 1) ### 제목 → section-heading 블록으로 변환
 */
function normalizeHeadings(body) {
  let changed = false;
  // 줄 단위로 처리
  const lines = body.split("\n");
  const out = lines.map((line) => {
    const m = line.match(/^\s*#{2,6}\s+(.+?)\s*$/); // ##, ###, ####...
    if (!m) return line;

    const titleText = m[1].trim();
    changed = true;
    return `\n<h2 class="section-heading"><span>${titleText}</span></h2>\n`;
  });

  return { body: out.join("\n"), changed };
}

/**
 * 2) 앱 이름 볼륨체 처리
 * - 문단/리스트 첫 부분의 앱이름을 <strong class="app-name">Name</strong> 으로 교체
 */
function emphasizeAppNames(body) {
  let changed = false;

  // 2-1) "1. **Todoist** ..." / "- **Todoist** ..." 패턴 우선 처리
  body = body.replace(
    /(^|\n)(\s*(?:[-*]|\d+\.)\s*)(\*\*([^*]+)\*\*)([^\n]*)/g,
    (_all, lead, bullet, _wrap, name, rest) => {
      changed = true;
      return `${lead}${bullet}<strong class="app-name">${name.trim()}</strong>${rest}`;
    }
  );

  // 2-2) 일반 문장의 첫 앱 이름
  if (APP_NAMES.length) {
    const escaped = APP_NAMES.map((n) =>
      n.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
    );
    const appRe = new RegExp(`(^|[>\\s])(${escaped.join("|")})\\b`, "g");

    body = body.replace(appRe, (match, lead, name) => {
      // 이미 strong 안이면 그대로 둠
      if (/<\/strong>$/.test(lead)) return match;
      changed = true;
      return `${lead}<strong class="app-name">${name}</strong>`;
    });
  }

  // 2-3) 남은 **텍스트**는 일반 볼드로만 교체(마크다운 기호 제거)
  if (/\*\*[^*]+\*\*/.test(body)) {
    changed = true;
    body = body.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }

  return { body, changed };
}

/**
 * 3) 문단 정규화
 * - 이미 <p>가 충분히 있으면 크게 손대지 않고,
 * - <p>가 거의 없고 생텍스트 덩어리만 있는 경우에만 기본 문단 래핑 시도
 */
function normalizeParagraphs(body) {
  let changed = false;

  const hasP = /<p[\s>]/i.test(body);
  // 이미 <p>가 있으면 과한 개입을 피함
  if (hasP) {
    return { body, changed };
  }

  // main 내부에서 <h2>, <details>, <section> 등 블록요소 기준으로 적당히 문단 쪼개기
  const blocks = body.split(/\n{2,}/);
  const normalizedBlocks = [];

  for (let raw of blocks) {
    const chunk = raw.trim();
    if (!chunk) continue;

    // 이미 블록 태그로 시작하면 그대로 유지
    if (/^<(h[1-6]|details|section|figure|ul|ol|table|blockquote)\b/i.test(chunk)) {
      normalizedBlocks.push(chunk);
      continue;
    }

    // 그 외는 <p>로 래핑
    normalizedBlocks.push(`<p>${chunk}</p>`);
    changed = true;
  }

  if (!changed) return { body, changed };
  return { body: normalizedBlocks.join("\n\n"), changed };
}

/**
 * 4) AI-티 문장/문구 제거
 */
function removeAiStyleSentences(body) {
  let changed = false;

  const patterns = [
    /As an AI[^.]*\./gi,
    /As a language model[^.]*\./gi,
    /I am an AI[^.]*\./gi,
    /저는 인공지능[^\n]*\n/gi,
    /AI 언어 모델로서[^\n]*\n/gi,
  ];

  for (const re of patterns) {
    const before = body;
    body = body.replace(re, "");
    if (before !== body) changed = true;
  }

  return { body, changed };
}

/**
 * 2차 검사: 남은 ###, **, AI티 문장이 있는지 확인
 */
function secondPassCheck(body, filename) {
  const warns = [];

  if (/^\s*#{2,6}\s+/m.test(body)) {
    warns.push("남은 markdown heading(### 등)");
  }
  if (/\*\*[^*]+\*\*/.test(body)) {
    warns.push("남은 bold 마크다운(**)");
  }
  if (/As an AI|language model|인공지능/gi.test(body)) {
    warns.push("남은 AI 자기소개 문장");
  }

  if (warns.length) {
    console.warn(
      `[normalize-body][WARN] ${filename}: ${warns.join(
        ", "
      )} — 추가 수동 확인 필요`
    );
  }
}

/**
 * 파일 1개 처리
 */
function processFile(fullPath) {
  const filename = path.basename(fullPath);
  let html = fs.readFileSync(fullPath, "utf8");

  const mainBlock = extractMain(html);
  if (!mainBlock) {
    console.warn(
      `[normalize-body] <main> 블록을 찾지 못해 스킵: ${filename}`
    );
    return;
  }

  let body = mainBlock.body;
  let anyChanged = false;

  // 1) heading 정규화
  let r1 = normalizeHeadings(body);
  body = r1.body;
  anyChanged = anyChanged || r1.changed;

  // 2) 앱 이름 볼륨체 + 마크다운 ** 제거
  let r2 = emphasizeAppNames(body);
  body = r2.body;
  anyChanged = anyChanged || r2.changed;

  // 3) 문단 정규화 (<p> 거의 없을 때만)
  let r3 = normalizeParagraphs(body);
  body = r3.body;
  anyChanged = anyChanged || r3.changed;

  // 4) AI-티 문장 제거
  let r4 = removeAiStyleSentences(body);
  body = r4.body;
  anyChanged = anyChanged || r4.changed;

  // 2차 검사(경고용)
  secondPassCheck(body, filename);

  if (!anyChanged) {
    console.log(`[normalize-body] 변경 없음: ${filename}`);
    return;
  }

  const replaced = html.replace(
    mainBlock.regex,
    `${mainBlock.open}${body}${mainBlock.close}`
  );
  fs.writeFileSync(fullPath, replaced, "utf8");

  console.log(`[normalize-body] 정규화 완료: ${filename}`);
}

/**
 * 메인 실행
 */
function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error(
      `[normalize-body] dist/posts 디렉터리가 없습니다: ${DIST_DIR}`
    );
    process.exit(1);
  }

  const files = fs
    .readdirSync(DIST_DIR)
    .filter((f) => f.toLowerCase().endsWith(".html"));

  if (!files.length) {
    console.log("[normalize-body] 처리할 HTML 파일이 없습니다.");
    return;
  }

  let changedCount = 0;
  for (const f of files) {
    const full = path.join(DIST_DIR, f);
    processFile(full);
    changedCount++;
  }

  console.log(
    `[normalize-body] 처리 완료: ${changedCount}개 파일 검사/정규화`
  );
}

if (require.main === module) {
  main();
}
