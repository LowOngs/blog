#!/usr/bin/env node
/**
 * System_files/scripts/build/generate-body.cjs
 * - SCHEDULE_MODE 제거 완료
 * - BODY_WRITE_MODE만 사용: local | active
 *   - local  : 로컬/검증용 본문 생성 + 파일 저장
 *   - active : 실운영용 본문 생성 + 파일 저장 (실발행 여부는 PUBLISH_MODE 쪽에서 통제)
 *
 * 주의:
 * - 이 스크립트는 "본문 생성/저장"만 합니다.
 * - "pageId +1" 같은 발급 통제는 ids.cjs 쪽에서 처리해야 합니다.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const process = require("process");

const ROOT = path.resolve(process.cwd(), "System_files");
const POSTS_DIR = path.join(ROOT, "content", "posts");

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const BODY_WRITE_MODE = (process.env.BODY_WRITE_MODE || "local").trim().toLowerCase();
const IS_WRITE_ENABLED = BODY_WRITE_MODE === "local" || BODY_WRITE_MODE === "active";

console.log("────────────────────────────────────────────");
console.log("[generate-body] 시작");
console.log("[generate-body] ROOT            =", ROOT);
console.log("[generate-body] POSTS_DIR       =", POSTS_DIR);
console.log("[generate-body] MODEL           =", MODEL);
console.log("[generate-body] BODY_WRITE_MODE =", BODY_WRITE_MODE);

if (!fs.existsSync(POSTS_DIR)) {
  console.log("[generate-body] POSTS_DIR 없음 → 종료");
  process.exit(0);
}

if (!IS_WRITE_ENABLED) {
  console.log("[generate-body][GUARD] BODY_WRITE_MODE가 local/active가 아님 → 저장/생성 중단");
  process.exit(0);
}

const REVIEW_COMMON = {
  appliesTo: ["app-reviews", "device-reviews", "subscription-services"],
  structure: {
    fixedHeadings: ["Overview", "Key Features", "Specs & ROI", "Insights", "Ratings", "Verdict"],
    optionalHeadingsPool: ["Pros & Cons", "Best For / Not For", "Alternatives & Comparisons"],
    optionalRules: { min: 1, max: 2 }
  }
};

// utils
function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}
function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}
function pickRandom(arr, min, max) {
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  const n = Math.max(min, Math.min(max, shuffled.length));
  return shuffled.slice(0, n);
}
function hasAnyLabel(labels, targets) {
  return Array.isArray(labels) && labels.some((l) => targets.includes(l));
}

// review heading builder
function buildReviewHeadingPlan() {
  const fixed = REVIEW_COMMON.structure.fixedHeadings;
  const opt = REVIEW_COMMON.structure.optionalHeadingsPool;
  const { min, max } = REVIEW_COMMON.structure.optionalRules;
  return [...fixed, ...pickRandom(opt, min, max)];
}

function buildHeadingSkeleton(headings) {
  return headings.map((h) => `<h2>${h}</h2>\n<p><!-- content --></p>`).join("\n\n");
}

// generator stub (구조 고정: 리뷰 라벨은 중제목 강제 + 랜덤 1~2개)
function generateBodyText({ title, isReview }) {
  if (isReview) {
    const headings = buildReviewHeadingPlan();
    return buildHeadingSkeleton(headings);
  }
  return `<h2>${title}</h2>\n<p><!-- generated content --></p>`;
}

// main
const files = fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith(".json")).sort();
console.log("[generate-body] JSON 파일 수 =", files.length);

let created = 0;
let skipped = 0;
let failed = 0;

for (const file of files) {
  const full = path.join(POSTS_DIR, file);

  let post;
  try {
    post = readJSON(full);
  } catch (e) {
    failed++;
    console.error(`[FAIL] ${file} JSON 파싱 실패:`, e.message);
    continue;
  }

  const slug = post.slug || file.replace(/\.json$/i, "");

  if (post.body && String(post.body).trim()) {
    console.log(`[SKIP] ${slug} — body 이미 존재`);
    skipped++;
    continue;
  }
  if (!post.bodyPrompt) {
    console.log(`[SKIP] ${slug} — bodyPrompt 없음`);
    skipped++;
    continue;
  }

  const labels = post.labels || [];
  const isReview = hasAnyLabel(labels, REVIEW_COMMON.appliesTo);

  try {
    const title = (post.title || "Untitled").trim();
    const body = generateBodyText({ title, isReview });

    post.body = body;
    post.bodyGen = {
      mode: "generated",
      model: MODEL,
      bodyWriteMode: BODY_WRITE_MODE,
      reviewStrict: isReview ? true : false,
      updatedAt: new Date().toISOString()
    };

    if (isReview) {
      post.reviewMeta = {
        ratings: { source: "ssot:review-ratings.json", freshnessDays: 90 },
        insights: { source: "ssot:review-ratings.json", freshnessDays: 90 },
        headingHash: sha1(body)
      };
    }

    writeJSON(full, post);
    console.log(`[OK] ${slug} — 저장 완료 (${BODY_WRITE_MODE})`);
    created++;
  } catch (e) {
    failed++;
    console.error(`[FAIL] ${slug}`, e.message);
  }
}

console.log("────────────────────────────────────────────");
console.log("[generate-body] 요약");
console.log("  생성 완료 =", created);
console.log("  SKIP      =", skipped);
console.log("  실패      =", failed);
console.log("────────────────────────────────────────────");
console.log("[generate-body] 완료");
