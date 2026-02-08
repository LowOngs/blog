#!/usr/bin/env node
/**
 * System_files/scripts/build/patch-missing-labels.cjs
 * 목적: content/posts/*.json 중 labels가 없거나 빈 경우 자동 복구
 * 원칙:
 *  - 기존 labels가 있으면 스킵
 *  - slug prefix 기반 단일 라벨만 주입
 *  - dist/posts, 발행물에는 영향 없음
 *  - ✅ 단일 표준: templates- 만 허용 (template- 등 별칭 불허)
 */

const fs = require("fs");
const path = require("path");

// ✅ 다른 build 스크립트들과 동일 기준: ROOT = System_files
const ROOT = path.resolve(__dirname, "..", ".."); // System_files
const POSTS_DIR = path.join(ROOT, "content", "posts");

const LABEL_MAP = [
  { prefix: "app-", label: "app-reviews" },
  { prefix: "device-", label: "device-reviews" },
  { prefix: "subscription-", label: "subscription-services" },
  { prefix: "howto-", label: "how-to-playbooks" },
  { prefix: "smartsavings-", label: "smart-savings" },
  { prefix: "templates-", label: "templates-checklists" }, // ✅ 표준
];

let scanned = 0;
let patched = 0;
let skipped = 0;
let unmatched = 0;

console.log("[patch-labels] ROOT =", ROOT);
console.log("[patch-labels] POSTS =", POSTS_DIR);

if (!fs.existsSync(POSTS_DIR)) {
  console.log("[patch-labels] POSTS_DIR 없음 -> 종료");
  process.exit(0);
}

for (const file of fs.readdirSync(POSTS_DIR)) {
  if (!file.endsWith(".json")) continue;

  const full = path.join(POSTS_DIR, file);

  let json;
  try {
    json = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (e) {
    console.warn("[patch-labels] JSON parse fail:", file, e.message || e);
    continue;
  }

  scanned++;

  const slug = (json.slug || file.replace(/\.json$/, "")).toLowerCase();
  const labels = json.labels;

  // 이미 라벨 있으면 스킵
  if (Array.isArray(labels) && labels.length > 0) {
    skipped++;
    continue;
  }

  // ✅ 별칭 불허: template- 같은 건 unmatched로 남김(교정은 별도 스크립트에서)
  const rule = LABEL_MAP.find(r => slug.startsWith(r.prefix));
  if (!rule) {
    console.warn("[patch-labels] UNMATCHED:", slug);
    unmatched++;
    continue;
  }

  json.labels = [rule.label];
  fs.writeFileSync(full, JSON.stringify(json, null, 2) + "\n", "utf8");

  console.log("[patch-labels] PATCHED:", slug, "→", rule.label);
  patched++;
}

console.log("────────────────────────────────────────────");
console.log("[patch-labels] summary");
console.log(" scanned   =", scanned);
console.log(" patched   =", patched);
console.log(" skipped   =", skipped);
console.log(" unmatched =", unmatched);
console.log("[patch-labels] done");
