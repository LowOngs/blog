#!/usr/bin/env node
'use strict';

/**
 * review-diff-update.cjs (3버킷 대응 버전)
 *
 * - content/reviews/{bucket}-ratings-next.json 의 최신 스냅샷을
 *   content/reviews/{bucket}-ratings.json(bySlug) 기준선에 병합한다.
 * - 기존 파일이 있으면 절대 초기화하지 않고, bySlug 를 보존한다.
 *
 * ✅ buckets: app, device, subscription
 * ✅ 변경 판단: ratingCurrent / votesCurrent / status (기본 3필드)
 *
 * 사용:
 *   node scripts/build/review-diff-update.cjs
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..'); // System_files
const DATA_DIR = path.join(ROOT, 'content', 'reviews');

const BUCKETS = ['app', 'device', 'subscription'];

console.log('────────────────────────────────────────────');
console.log('[review-diff] 시작 (3버킷)');
console.log('[review-diff] ROOT     =', ROOT);
console.log('[review-diff] DATA_DIR =', DATA_DIR);
console.log('────────────────────────────────────────────');

/** JSON 안전 로더 (기존 내용 보호용) */
function safeReadJSON(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) return defaultValue;

  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return defaultValue;
    const data = JSON.parse(raw);

    // 혹시 과거/오류 포맷이 있더라도, 최소 bySlug만 보장
    // (예: { app:[...] } 같은 구 포맷은 여기서는 버킷 파일 구조상 거의 없지만 안전장치)
    if (!data.bySlug && Array.isArray(data.app)) {
      const bySlug = {};
      for (const row of data.app) {
        if (row && typeof row === 'object' && row.slug) bySlug[row.slug] = row;
      }
      data.bySlug = bySlug;
      delete data.app;
    }

    return data;
  } catch (e) {
    console.error(`[review-diff] 경고: ${filePath} 파싱 오류:`, e.message);
    console.error('[review-diff] 기존 내용을 보존하기 위해 파일을 수정하지 않고 종료합니다.');
    process.exit(1);
  }
}

/** bySlug 보정 유틸 */
function ensureBySlug(obj) {
  if (!obj || typeof obj !== 'object') obj = {};
  if (!obj.bySlug || typeof obj.bySlug !== 'object') obj.bySlug = {};
  return obj;
}

/**
 * 변경 여부는 핵심 필드 기준으로만 판단
 * (ratingCurrent / votesCurrent / status 3가지만 비교)
 */
function isChanged(prev, curr) {
  if (!prev) return true;
  const keys = ['ratingCurrent', 'votesCurrent', 'status'];
  return keys.some(k => prev?.[k] !== curr?.[k]);
}

function runBucket(bucket) {
  const BASELINE_PATH = path.join(DATA_DIR, `${bucket}-ratings.json`);
  const NEXT_PATH = path.join(DATA_DIR, `${bucket}-ratings-next.json`);

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

  // 3) next.bySlug → baseline.bySlug 병합
  for (const slug of nextSlugs) {
    const curr = nextBySlug[slug];
    const prev = baselineBySlug[slug];

    if (!prev) newCount++;
    else if (isChanged(prev, curr)) changedCount++;
    else sameCount++;

    baselineBySlug[slug] = curr;
  }

  // 4) 기준선 파일 저장
  const existedBefore = fs.existsSync(BASELINE_PATH);
  if (existedBefore) console.log(`[review-diff] (${bucket}) 기준선 업데이트:`, BASELINE_PATH);
  else console.log(`[review-diff] (${bucket}) 기준선 생성   :`, BASELINE_PATH);

  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf8');

  console.log(`[review-diff] (${bucket}) next slugs      = ${nextSlugs.length}`);
  console.log(`[review-diff] (${bucket}) 신규          = ${newCount}`);
  console.log(`[review-diff] (${bucket}) 변경          = ${changedCount}`);
  console.log(`[review-diff] (${bucket}) 변화없음      = ${sameCount}`);

  return { bucket, nextSlugs: nextSlugs.length, newCount, changedCount, sameCount };
}

function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.log('[review-diff] reviews dir 없음 → 종료:', DATA_DIR);
    process.exit(0);
  }

  const results = [];
  for (const bucket of BUCKETS) {
    console.log('────────────────────────────────────────────');
    console.log(`[review-diff] bucket=${bucket}`);
    results.push(runBucket(bucket));
  }

  console.log('────────────────────────────────────────────');
  console.log('[review-diff] 완료 — 이후 review-resolver.cjs → render-posts.cjs 순으로 실행하세요.');
  const total = results.reduce(
    (acc, r) => {
      acc.next += r.nextSlugs;
      acc.new += r.newCount;
      acc.changed += r.changedCount;
      acc.same += r.sameCount;
      return acc;
    },
    { next: 0, new: 0, changed: 0, same: 0 }
  );
  console.log(`[review-diff] 총합 next=${total.next} | 신규=${total.new} | 변경=${total.changed} | 동일=${total.same}`);
}

if (require.main === module) main();
