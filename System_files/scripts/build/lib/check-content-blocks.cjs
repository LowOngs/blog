// System_files/scripts/build/check-blocks.cjs
// dist/posts/*.html 대상으로:
// - [object Object] 잔존 여부
// - 필수 ID 존재 여부(tldr/keyfacts 등은 기존 validate가 보지만 blocks도 같이 점검)
// - 결과 요약 로그 출력

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const DIST = path.join(ROOT, "dist", "posts");

function listHtmlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((x) => x.endsWith(".html")).map((x) => path.join(dir, x));
}

function hasId(html, id) {
  return html.includes(`id="${id}"`) || html.includes(`id='${id}'`);
}

const files = listHtmlFiles(DIST);
console.log(`[check-blocks] ROOT = ${ROOT}`);
console.log(`[check-blocks] DIST = ${DIST}`);
console.log(`[check-blocks] HTML files = ${files.length}`);

let bad = 0;
let obj = 0;

for (const fp of files) {
  const name = path.basename(fp);
  const html = fs.readFileSync(fp, "utf8");

  if (html.includes("[object Object]")) {
    console.log(`[check-blocks][OBJ] ${name}`);
    obj++;
    bad++;
    continue;
  }

  // 최소한의 구조 점검(핵심 ID만)
  const required = ["tldr", "keyfacts"];
  const missing = required.filter((id) => !hasId(html, id));
  if (missing.length) {
    console.log(`[check-blocks][MISS] ${name} missing=${missing.join(",")}`);
    bad++;
  }
}

console.log(`[check-blocks] done: bad=${bad} objectObject=${obj}`);
process.exit(bad ? 1 : 0);
