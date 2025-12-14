#!/usr/bin/env node
/**
 * generate-body.cjs
 * - Review normalization FIRST (generator 단계)
 * - Render는 조립만 수행
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import process from "process";

const ROOT = path.resolve(process.cwd(), "System_files");
const POSTS_DIR = path.join(ROOT, "content", "posts");

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const SCHEDULE_MODE = process.env.SCHEDULE_MODE || "test"; // test | live
const IS_LIVE = SCHEDULE_MODE === "live";

console.log("────────────────────────────────────────────");
console.log("[generate-body] 시작");
console.log("[generate-body] ROOT          =", ROOT);
console.log("[generate-body] POSTS_DIR     =", POSTS_DIR);
console.log("[generate-body] MODEL         =", MODEL);
console.log(
  "[generate-body] SCHEDULE_MODE =",
  SCHEDULE_MODE,
  IS_LIVE ? "(LIVE)" : "(DRY-RUN)"
);

const REVIEW_COMMON = {
  appliesTo: ["app-reviews", "device-reviews", "subscription-services"],
  structure: {
    fixedHeadings: [
      "Overview",
      "Key Features",
      "Specs & ROI",
      "Insights",
      "Ratings",
      "Verdict"
    ],
    optionalHeadingsPool: [
      "Pros & Cons",
      "Best For / Not For",
      "Alternatives & Comparisons"
    ],
    optionalRules: { min: 1, max: 2 }
  }
};

// ─────────────────────────────────────────────
// utils
function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
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
  return labels.some(l => targets.includes(l));
}

// ─────────────────────────────────────────────
// review heading builder
function buildReviewHeadingPlan() {
  const fixed = REVIEW_COMMON.structure.fixedHeadings;
  const opt = REVIEW_COMMON.structure.optionalHeadingsPool;
  const { min, max } = REVIEW_COMMON.structure.optionalRules;

  const pickedOptional = pickRandom(opt, min, max);
  return [...fixed, ...pickedOptional];
}

function buildHeadingSkeleton(headings) {
  return headings
    .map(h => `<h2>${h}</h2>\n<p><!-- content --></p>`)
    .join("\n\n");
}

// ─────────────────────────────────────────────
// fake LLM call placeholder
// 실제 OpenAI 호출은 기존 구현 그대로 두고,
// 여기서는 구조 제어만 수행
async function generateBodyText({ title, label, isReview }) {
  if (isReview) {
    const headings = buildReviewHeadingPlan();
    return buildHeadingSkeleton(headings);
  }

  // 비리뷰: 기존 자유 생성 (간단 스텁)
  return `<h2>${title}</h2>\n<p><!-- generated content --></p>`;
}

// ─────────────────────────────────────────────
// main
const files = fs
  .readdirSync(POSTS_DIR)
  .filter(f => f.endsWith(".json"));

console.log("[generate-body] JSON 파일 수 =", files.length);

let created = 0;
let skipped = 0;
let fallback = 0;
let failed = 0;

for (const file of files) {
  const full = path.join(POSTS_DIR, file);
  const post = readJSON(full);

  if (post.body && post.body.trim()) {
    console.log(`[generate-body] [SKIP] slug=${post.slug} — body 이미 존재`);
    skipped++;
    continue;
  }

  if (!post.bodyPrompt) {
    console.log(`[generate-body] [SKIP] slug=${post.slug} — bodyPrompt 없음`);
    skipped++;
    continue;
  }

  const labels = post.labels || [];
  const isReview = hasAnyLabel(labels, REVIEW_COMMON.appliesTo);

  console.log(
    `[generate-body] [TARGET] slug=${post.slug}, review=${isReview}`
  );

  try {
    const body = await generateBodyText({
      title: post.title,
      label: labels[0],
      isReview
    });

    post.body = body;
    post.bodyGen = {
      mode: "generated",
      model: MODEL,
      attemptsUsed: 1,
      reviewStrict: isReview || null,
      updatedAt: new Date().toISOString()
    };

    // 리뷰 메타 선반영 (90일 프레쉬니스 대상)
    if (isReview) {
      post.reviewMeta = {
        ratings: { source: "ssot:review-ratings.json", freshnessDays: 90 },
        insights: { source: "ssot:review-ratings.json", freshnessDays: 90 },
        headingHash: sha1(body)
      };
    }

    if (IS_LIVE) {
      writeJSON(full, post);
      console.log(
        `[generate-body] [OK] slug=${post.slug} — body 생성 저장 완료`
      );
      created++;
    } else {
      console.log(
        `[generate-body] [DRY] slug=${post.slug} — 생성만 수행`
      );
    }
  } catch (e) {
    failed++;
    console.error(
      `[generate-body] [FAIL] slug=${post.slug}`,
      e.message
    );
  }
}

console.log("────────────────────────────────────────────");
console.log("[generate-body] 요약");
console.log("  총 파일 수                 =", files.length);
console.log("  생성 완료(LIVE)           =", created);
console.log("  폴백 주입(LIVE)           =", fallback);
console.log("  SKIP                      =", skipped);
console.log("  실패                      =", failed);
console.log("────────────────────────────────────────────");
console.log("[generate-body] 완료");
