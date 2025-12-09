#!/usr/bin/env node
/**
 * markdown-list.cjs
 * - content/posts/*.json 의 body 안 마크다운 스타일을
 *   기본 HTML 블록으로 정리하는 스크립트
 *
 * 1) "### 제목"  → <h2 class="section-heading">제목</h2>
 * 2) "1. **앱명** (설명)" → <p class="app-line">1. <strong class="app-name">앱명</strong> (설명)</p>
 * 3) 기타 줄은 그대로 두되, 나중 문단 정규화를 위해 줄바꿈 유지
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", ".."); // System_files/
const POSTS_DIR = path.join(ROOT, "content", "posts");

// 이미 처리했는지 표시할 마커
const MARKER = "<!--MD_NORMALIZED-->";

function transformBody(raw) {
  if (!raw) return raw;

  if (raw.includes(MARKER)) {
    return raw; // 중복 처리 방지
  }

  const text = String(raw).replace(/\r\n/g, "\n").trim();
  if (!text) return raw;

  const lines = text.split("\n");
  const out = [];

  for (let line of lines) {
    let trimmed = line.trim();

    // 완전히 빈 줄은 그대로 두어 문단 구분으로 사용
    if (!trimmed) {
      out.push("");
      continue;
    }

    // 1) 섹션 제목: "### 제목"
    let mHeading = trimmed.match(/^#{2,3}\s+(.+)$/);
    if (mHeading) {
      const title = mHeading[1].trim();
      out.push(`<h2 class="section-heading">${title}</h2>`);
      continue;
    }

    // 2) 번호 + 앱명: "1. **Todoist** (Task management)"
    let mAppLine = trimmed.match(
      /^(\d+)\.\s+\*\*(.+?)\*\*(.*)$/
    );
    if (mAppLine) {
      const num = mAppLine[1];
      const app = mAppLine[2].trim();
      const rest = mAppLine[3] || "";
      out.push(
        `<p class="app-line">${num}. <strong class="app-name">${app}</strong>${rest}</p>`
      );
      continue;
    }

    // 3) 앱 설명 첫 문장: "**Todoist** is ..." / "**Todoist** 앱은 ..."
    let mAppIntro = trimmed.match(/^\*\*(.+?)\*\*\s+(.*)$/);
    if (mAppIntro) {
      const app = mAppIntro[1].trim();
      const rest = mAppIntro[2] || "";
      out.push(
        `<p class="app-intro"><strong class="app-name">${app}</strong> ${rest}</p>`
      );
      continue;
    }

    // 4) 그냥 남겨두기 (나중에 normalize-body가 <p>로 감쌀 것)
    out.push(trimmed);
  }

  // 마지막에 마커 추가
  return `${MARKER}\n${out.join("\n")}`;
}

function processFile(filePath) {
  const filename = path.basename(filePath);

  let json;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    json = JSON.parse(raw);
  } catch (e) {
    console.warn(`[markdown-list] JSON 파싱 실패, 스킵: ${filename}`);
    return false;
  }

  if (!json.body) {
    return false;
  }

  const before = String(json.body);
  const after = transformBody(before);

  if (before === after) {
    console.log(`[markdown-list] 변경 없음: ${filename}`);
    return false;
  }

  json.body = after;
  fs.writeFileSync(filePath, JSON.stringify(json, null, 2), "utf8");
  console.log(`[markdown-list] 마크다운 정리 적용: ${filename}`);
  return true;
}

function main() {
  if (!fs.existsSync(POSTS_DIR)) {
    console.error(
      `[markdown-list] posts 디렉터리가 없습니다: ${POSTS_DIR}`
    );
    process.exit(1);
  }

  const files = fs
    .readdirSync(POSTS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".json"));

  if (!files.length) {
    console.log("[markdown-list] 처리할 JSON 파일이 없습니다.");
    return;
  }

  let applied = 0;
  for (const f of files) {
    const full = path.join(POSTS_DIR, f);
    if (processFile(full)) applied++;
  }

  console.log(
    `[markdown-list] 완료: 정리 적용 파일 수 = ${applied}, 전체 파일 수 = ${files.length}`
  );
}

if (require.main === module) {
  main();
}
