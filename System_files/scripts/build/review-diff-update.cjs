#!/usr/bin/env node
/**
 * review-diff-update.cjs
 * - content/reviews/review-ratings-next.json 의 최신 스냅샷을
 *   content/reviews/review-ratings.json(bySlug) 기준선에 병합한다.
 * - 기존 파일이 있으면 절대 초기화하지 않고, bySlug 를 보존한다.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const DATA_DIR = path.join(ROOT, "content", "reviews");
const BASELINE_PATH = path.join(DATA_DIR, "review-ratings.json");
const NEXT_PATH = path.join(DATA_DIR, "review-ratings-next.json");

console.log("────────────────────────────────────────────");
console.log("[review-diff] 시작");
console.log("[review-diff] ROOT      =", ROOT);
console.log("[review-diff] DATA_DIR  =", DATA_DIR);
console.log("────────────────────────────────────────────");

/** JSON 안전 로더 (기존 내용 보호용) */
function safeReadJSON(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) return defaultValue;

  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return defaultValue;
    const data = JSON.parse(raw);

    // 구(舊) 포맷: { "app": [ ... ] } → { bySlug: { slug: row } } 로 마이그레이션
    if (!data.bySlug && Array.isArray(data.app)) {
      const bySlug = {};
      for (const row of data.app) {
        if (row && typeof row === "object" && row.slug) {
          bySlug[row.slug] = row;
        }
      }
      data.bySlug = bySlug;
      delete data.app;
    }

    return data;
  } catch (e) {
    console.error(
      `[review-diff] 경고: ${filePath} 파싱 중 오류가 발생했습니다:`,
      e.message
    );
    console.error(
      "[review-diff] 기존 내용을 보존하기 위해 파일을 수정하지 않고 종료합니다."
    );
    process.exit(1);
  }
}

/** bySlug 보정 유틸 */
function ensureBySlug(obj) {
  if (!obj || typeof obj !== "object") obj = {};
  if (!obj.bySlug || typeof obj.bySlug !== "object") {
    obj.bySlug = {};
  }
  return obj;
}

// 1) 기준선 로드 (없으면 새로 생성)
let baseline = safeReadJSON(BASELINE_PATH, { bySlug: {} });
baseline = ensureBySlug(baseline);

// 2) 최신 스냅샷 로드 (없으면 빈 상태)
let next = safeReadJSON(NEXT_PATH, { bySlug: {} });
next = ensureBySlug(next);

const baselineBySlug = baseline.bySlug;
const nextBySlug = next.bySlug;

const nextSlugs = Object.keys(nextBySlug);
let newCount = 0;
let changedCount = 0;
let sameCount = 0;

/**
 * 변경 여부는 핵심 필드 기준으로만 판단
 * (ratingCurrent / votesCurrent / status 3가지만 비교)
 */
function isChanged(prev, curr) {
  if (!prev) return true;
  const keys = ["ratingCurrent", "votesCurrent", "status"];
  return keys.some((k) => prev[k] !== curr[k]);
}

// 3) next.bySlug → baseline.bySlug 병합
for (const slug of nextSlugs) {
  const curr = nextBySlug[slug];
  const prev = baselineBySlug[slug];

  if (!prev) {
    newCount++;
  } else if (isChanged(prev, curr)) {
    changedCount++;
  } else {
    sameCount++;
  }

  baselineBySlug[slug] = curr;
}

// 4) 기준선 파일 저장
const existedBefore = fs.existsSync(BASELINE_PATH);
if (existedBefore) {
  console.log("[review-diff] 기준선 파일 업데이트:", BASELINE_PATH);
} else {
  console.log("[review-diff] 기준선 파일 생성   :", BASELINE_PATH);
}

fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n", "utf8");

console.log(`[review-diff] 신규 앱     = ${newCount}`);
console.log(`[review-diff] 변경 발생 앱 = ${changedCount}`);
console.log(`[review-diff] 변화 없음 앱 = ${sameCount}`);
console.log("────────────────────────────────────────────");
console.log(
  "[review-diff] 완료 — 이후 posts:review:meta 를 실행해 HTML 블록을 갱신하세요."
);
