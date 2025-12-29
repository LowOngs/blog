#!/usr/bin/env node
/**
 * generate-body.cjs
 * - 본문 생성(현재는 스켈레톤) + content/posts/*.json에 저장
 * - 제어축:
 *   BODY_WRITE_MODE=local | active -> 저장(WRITE)
 *   그 외 -> DRY(미저장)
 *
 * ✅ 중요한 원칙
 * - "카운트(+1)" 로직은 여기서 하지 않습니다.
 *   (카운트는 ids.cjs / ledger 쪽에서 BODY_WRITE_MODE를 보고 local에서만 증가시키는 구조로 분리)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const process = require("process");

const ROOT = path.resolve(process.cwd(), "System_files");
const POSTS_DIR = path.join(ROOT, "content", "posts");

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

// local | active 일 때만 저장
const BODY_WRITE_MODE = String(process.env.BODY_WRITE_MODE || "local").trim().toLowerCase();
const CAN_WRITE = BODY_WRITE_MODE === "local" || BODY_WRITE_MODE === "active";

console.log("────────────────────────────────────────────");
console.log("[generate-body] 시작");
console.log("[generate-body] ROOT           =", ROOT);
console.log("[generate-body] POSTS_DIR      =", POSTS_DIR);
console.log("[generate-body] MODEL          =", MODEL);
console.log("[generate-body] BODY_WRITE_MODE=", BODY_WRITE_MODE, CAN_WRITE ? "(WRITE)" : "(DRY)");

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
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
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
  return Array.isArray(labels) && labels.some(l => targets.includes(l));
}

// review heading builder
function buildReviewHeadingPlan() {
  const fixed = REVIEW_COMMON.structure.fixedHeadings;
  const opt = REVIEW_COMMON.structure.optionalHeadingsPool;
  const { min, max } = REVIEW_COMMON.structure.optionalRules;
  return [...fixed, ...pickRandom(opt, min, max)];
}

function buildHeadingSkeleton(headings) {
  return headings.map(h => `<h2>${h}</h2>\n<p><!-- content --></p>`).join("\n\n");
}

// generator stub (LLM 호출 전 구조 고정)
function generateBodyText({ title, isReview }) {
  if (isReview) {
    const headings = buildReviewHeadingPlan();
    return buildHeadingSkeleton(headings);
  }
  return `<h2>${title}</h2>\n<p><!-- generated content --></p>`;
}

// main
if (!fs.existsSync(POSTS_DIR)) {
  console.log("[generate-body] content/posts 없음 -> 종료");
  process.exit(0);
}

const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith(".json"));
console.log("[generate-body] JSON 파일 수 =", files.length);

let written = 0;
let skipped = 0;
let failed = 0;

for (const file of files) {
  const full = path.join(POSTS_DIR, file);
  const post = readJSON(full);

  if (post.body && String(post.body).trim()) {
    console.log(`[SKIP] ${post.slug} — body 이미 존재`);
    skipped++;
    continue;
  }
  if (!post.bodyPrompt) {
    console.log(`[SKIP] ${post.slug} — bodyPrompt 없음`);
    skipped++;
    continue;
  }

  const labels = post.labels || [];
  const isReview = hasAnyLabel(labels, REVIEW_COMMON.appliesTo);

  try {
    const body = generateBodyText({ title: post.title, isReview });

    post.body = body;
    post.bodyGen = {
      mode: "generated",
      model: MODEL,
      reviewStrict: isReview || null,
      updatedAt: new Date().toISOString(),
      writeMode: BODY_WRITE_MODE
    };

    if (isReview) {
      post.reviewMeta = {
        ratings: { source: "ssot:review-ratings.json", freshnessDays: 90 },
        insights: { source: "ssot:review-ratings.json", freshnessDays: 90 },
        headingHash: sha1(body)
      };
    }

    if (CAN_WRITE) {
      writeJSON(full, post);
      console.log(`[OK] ${post.slug} — 저장 완료`);
      written++;
    } else {
      console.log(`[DRY] ${post.slug} — 생성만 수행(미저장)`);
    }
  } catch (e) {
    failed++;
    console.error(`[FAIL] ${post.slug}`, e.message || e);
  }
}

console.log("────────────────────────────────────────────");
console.log("[generate-body] 요약");
console.log("  저장(WRITE) =", written);
console.log("  SKIP        =", skipped);
console.log("  실패        =", failed);
console.log("────────────────────────────────────────────");
console.log("[generate-body] 완료");
