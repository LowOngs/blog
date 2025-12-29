#!/usr/bin/env node
/**
 * generate-body.cjs (final)
 * - 6개 라벨 모두 "중제목 고정 skeleton" 생성
 * - BODY_WRITE_MODE=enable 일 때만 content/posts/*.json에 저장
 * - LLM 호출은 여기서 하지 않음(구조 고정이 목적)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const process = require("process");

const ROOT = path.resolve(process.cwd(), "System_files");
const POSTS_DIR = path.join(ROOT, "content", "posts");

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

// ✅ 저장 스위치(안전장치)
const BODY_WRITE_MODE = (process.env.BODY_WRITE_MODE || "disable").trim().toLowerCase();
const CAN_WRITE = BODY_WRITE_MODE === "enable";

// ────────────────────────────────────
//  중제목(최종) — 라벨별 고정
//  * 리뷰 3종: 이미 확정된 구조(고정 + 선택 1~2개) 유지
//  * 비리뷰 3종: 독자/AI 인식 안정형 구조로 고정
// ────────────────────────────────────
const REVIEW_LABELS = ["app-reviews", "device-reviews", "subscription-services"];

const REVIEW_FIXED = [
  "Overview",
  "Key Features",
  "Specs & ROI",
  "Insights",
  "Ratings",
  "Verdict"
];
const REVIEW_OPTIONAL_POOL = [
  "Pros & Cons",
  "Best For / Not For",
  "Alternatives & Comparisons"
];
const REVIEW_OPTIONAL_RULES = { min: 1, max: 2 };

// how-to-playbooks (비리뷰)
const HOWTO_HEADINGS = [
  "What Problem This Guide Solves",
  "Before You Start",
  "Step-by-Step Instructions",
  "Common Mistakes & Quick Fixes",
  "Options & Variations",
  "Wrap-Up"
];

// smart-savings (비리뷰) — 제휴/광고 유도 뉘앙스 제거, 판단/이해 중심
const SAVINGS_HEADINGS = [
  "Why This Topic Matters",
  "How Pricing Really Works",
  "Real-World Scenarios",
  "What Makes the Difference",
  "Common Misunderstandings",
  "Practical Takeaways"
];

// templates-checklists (비리뷰)
const TEMPLATES_HEADINGS = [
  "What You’ll Get",
  "When to Use This",
  "The Template / Checklist",
  "How to Use It",
  "Common Pitfalls",
  "Next Steps"
];

// 라벨 → headings
function getFixedHeadingsForLabel(label, title) {
  if (REVIEW_LABELS.includes(label)) return null; // review는 별도 로직
  if (label === "how-to-playbooks") return HOWTO_HEADINGS;
  if (label === "smart-savings") return SAVINGS_HEADINGS;
  if (label === "templates-checklists") return TEMPLATES_HEADINGS;

  // 방어: 라벨 미확인 시 최소 구조(그래도 중제목은 유지)
  return [title || "Overview", "Key Points", "Steps", "Notes", "FAQ", "Wrap-Up"];
}

// ────────────────────────────────────
// utils
// ────────────────────────────────────
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
function firstLabel(labels) {
  if (!Array.isArray(labels) || !labels.length) return "";
  return String(labels[0] || "").trim();
}

function buildHeadingSkeleton(headings) {
  return headings.map(h => `<h2>${h}</h2>\n<p><!-- content --></p>`).join("\n\n");
}

// 리뷰: 고정 + 선택 1~2개
function buildReviewHeadingPlan() {
  const { min, max } = REVIEW_OPTIONAL_RULES;
  const picked = pickRandom(REVIEW_OPTIONAL_POOL, min, max);
  return [...REVIEW_FIXED, ...picked];
}

// ────────────────────────────────────
// generator (LLM 호출 전: 구조만 고정)
// ────────────────────────────────────
function generateBodyText({ title, label }) {
  const isReview = REVIEW_LABELS.includes(label);

  if (isReview) {
    const headings = buildReviewHeadingPlan();
    return {
      body: buildHeadingSkeleton(headings),
      meta: {
        kind: "review",
        headings,
        headingHash: sha1(headings.join("|"))
      }
    };
  }

  const fixed = getFixedHeadingsForLabel(label, title);
  return {
    body: buildHeadingSkeleton(fixed),
    meta: {
      kind: "non-review",
      headings: fixed,
      headingHash: sha1(fixed.join("|"))
    }
  };
}

// ────────────────────────────────────
// main
// ────────────────────────────────────
console.log("────────────────────────────────────────────");
console.log("[generate-body] 시작");
console.log("[generate-body] ROOT           =", ROOT);
console.log("[generate-body] POSTS_DIR      =", POSTS_DIR);
console.log("[generate-body] MODEL          =", MODEL);
console.log("[generate-body] BODY_WRITE_MODE=", BODY_WRITE_MODE, CAN_WRITE ? "(WRITE)" : "(DRY)");

if (!fs.existsSync(POSTS_DIR)) {
  console.log("[generate-body] content/posts 없음 -> 종료");
  process.exit(0);
}

const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith(".json"));
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
    console.error(`[FAIL] read ${file}:`, e.message);
    failed++;
    continue;
  }

  const slug = post.slug || file.replace(/\.json$/i, "");

  // 이미 body 있으면 스킵(기존 정책 유지)
  if (post.body && String(post.body).trim()) {
    console.log(`[SKIP] ${slug} — body 이미 존재`);
    skipped++;
    continue;
  }

  // bodyPrompt 없으면 스킵(기존 정책 유지)
  if (!post.bodyPrompt) {
    console.log(`[SKIP] ${slug} — bodyPrompt 없음`);
    skipped++;
    continue;
  }

  const label = firstLabel(post.labels);
  if (!label) {
    console.log(`[SKIP] ${slug} — labels[0] 없음`);
    skipped++;
    continue;
  }

  try {
    const { body, meta } = generateBodyText({
      title: post.title || "Untitled",
      label
    });

    post.body = body;
    post.bodyGen = {
      mode: "skeleton",
      model: MODEL,
      label,
      kind: meta.kind,
      headingHash: meta.headingHash,
      updatedAt: new Date().toISOString()
    };

    // 리뷰 라벨이면 SSOT 연결 메타도 유지(주입 단계에서 사용)
    if (REVIEW_LABELS.includes(label)) {
      post.reviewMeta = {
        ratings: { source: "ssot:review-ratings.json", freshnessDays: 90 },
        insights: { source: "ssot:review-ratings.json", freshnessDays: 90 },
        headingHash: meta.headingHash
      };
    }

    if (CAN_WRITE) {
      writeJSON(full, post);
      console.log(`[OK] ${slug} — 저장 완료 label=${label} kind=${meta.kind}`);
      created++;
    } else {
      console.log(`[DRY] ${slug} — 생성만 수행(미저장) label=${label} kind=${meta.kind}`);
    }
  } catch (e) {
    failed++;
    console.error(`[FAIL] ${slug}`, e.message);
  }
}

console.log("────────────────────────────────────────────");
console.log("[generate-body] 요약");
console.log("  저장(WRITE) =", created);
console.log("  SKIP        =", skipped);
console.log("  실패        =", failed);
console.log("────────────────────────────────────────────");
console.log("[generate-body] 완료");
