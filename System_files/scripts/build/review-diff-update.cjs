#!/usr/bin/env node
/**
 * review-diff-update.cjs
 *
 * - content/reviews/{bucket}-ratings-next.json 의 최신 스냅샷(bySlug)을
 *   content/reviews/{bucket}-ratings.json 기준선(bySlug)에 병합합니다.
 * - 기준선 파일이 없으면 생성하되, "기존이 있으면 절대 초기화하지 않음" 원칙 유지.
 *
 * ✅ 기본: app/device/subscription 3종 모두 처리
 * ✅ 선택: BUCKET=app 처럼 단일 버킷만 처리 가능
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..'); // System_files
const DATA_DIR = path.join(ROOT, 'content', 'reviews');

const ALL_BUCKETS = ['app', 'device', 'subscription'];

function safeReadJSON(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) return defaultValue;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return defaultValue;
    const data = JSON.parse(raw);
    return data;
  } catch (e) {
    console.error(`[review-diff] ERROR: ${filePath} 파싱 실패:`, e.message);
    console.error('[review-diff] 기존 내용을 보호하기 위해 종료합니다.');
    process.exit(1);
  }
}

function ensureBySlug(obj) {
  if (!obj || typeof obj !== 'object') obj = {};
  if (!obj.bySlug || typeof obj.bySlug !== 'object') obj.bySlug = {};
  return obj;
}

function writePretty(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** 핵심 필드 기준 변경 판단(필요 최소 비교) */
function isChanged(prev, curr) {
  if (!prev) return true;
  const keys = ['ratingCurrent', 'votesCurrent', 'status'];
  return keys.some((k) => prev[k] !== curr[k]);
}

function resolvePaths(bucket) {
  const baseline = path.join(DATA_DIR, `${bucket}-ratings.json`);
  const next = path.join(DATA_DIR, `${bucket}-ratings-next.json`);
  return { baseline, next };
}

function mergeOneBucket(bucket) {
  const { baseline: BASELINE_PATH, next: NEXT_PATH } = resolvePaths(bucket);

  let baseline = ensureBySlug(safeReadJSON(BASELINE_PATH, { bySlug: {} }));
  let next = ensureBySlug(safeReadJSON(NEXT_PATH, { bySlug: {} }));

  const baselineBySlug = baseline.bySlug;
  const nextBySlug = next.bySlug;

  const nextSlugs = Object.keys(nextBySlug);

  let newCount = 0;
  let changedCount = 0;
  let sameCount = 0;

  for (const slug of nextSlugs) {
    const curr = nextBySlug[slug];
    const prev = baselineBySlug[slug];

    if (!prev) newCount++;
    else if (isChanged(prev, curr)) changedCount++;
    else sameCount++;

    baselineBySlug[slug] = curr;
  }

  // 저장 (baseline 없으면 생성)
  writePretty(BASELINE_PATH, baseline);

  return { bucket, BASELINE_PATH, NEXT_PATH, newCount, changedCount, sameCount, totalNext: nextSlugs.length };
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[review-diff] 시작');
  console.log('[review-diff] ROOT     =', ROOT);
  console.log('[review-diff] DATA_DIR =', DATA_DIR);

  if (!fs.existsSync(DATA_DIR)) {
    console.log('[review-diff] content/reviews 없음 → 종료');
    process.exit(0);
  }

  const envBucket = String(process.env.BUCKET || '').trim().toLowerCase();
  const buckets = envBucket ? [envBucket] : ALL_BUCKETS;

  for (const b of buckets) {
    if (!ALL_BUCKETS.includes(b)) {
      console.log(`[review-diff] SKIP: 알 수 없는 BUCKET=${b} (허용: ${ALL_BUCKETS.join(', ')})`);
      continue;
    }

    const r = mergeOneBucket(b);
    console.log('────────────────────────────────────────────');
    console.log(`[review-diff] bucket=${r.bucket}`);
    console.log(`[review-diff] next    = ${path.basename(r.NEXT_PATH)} (rows=${r.totalNext})`);
    console.log(`[review-diff] baseline= ${path.basename(r.BASELINE_PATH)}`);
    console.log(`[review-diff] 신규=${r.newCount} | 변경=${r.changedCount} | 동일=${r.sameCount}`);
  }

  console.log('────────────────────────────────────────────');
  console.log('[review-diff] 완료 — 다음 단계: review-resolver.cjs 실행 → posts에 reviewData 주입');
}

if (require.main === module) main();
