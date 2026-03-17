#!/usr/bin/env node
'use strict';

/**
 * review-next-from-due.cjs
 *
 * - dist/reviews/due-90days.json (review-due-90days.cjs 산출물)을 읽어서
 *   content/reviews/{bucket}-ratings-next.json 을 자동 생성/갱신한다.
 *
 * 목적:
 * - 90일 만기 대상 slug를 "next 작업 큐"로 확정해두는 단계(B 스텝).
 * - 실제 원천 수집/스크래핑은 다음 단계(외부)에서 next를 덮어쓸 수 있지만,
 *   최소한 next 파일이 "대상 슬러그"를 갖도록 보장한다.
 *
 * 규칙:
 * - baseline({bucket}-ratings.json)에서 해당 slug 레코드를 가져와 next에 넣는다.
 * - 레코드에 status가 없으면 status='due'로 넣는다.
 * - next 파일은 bySlug 구조를 유지하며, 다른 slug는 건드리지 않는다(멱등).
 *
 * 사용:
 *   node scripts/build/review-next-from-due.cjs
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..'); // System_files
const REVIEWS_DIR = path.join(ROOT, 'content', 'reviews');
const DUE_PATH = path.join(ROOT, 'dist', 'reviews', 'due-90days.json');

const BUCKETS = ['app', 'device', 'subscription'];

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonPretty(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function ensureBySlug(obj) {
  if (!obj || typeof obj !== 'object') obj = {};
  if (!obj.bySlug || typeof obj.bySlug !== 'object') obj.bySlug = {};
  return obj;
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[review-next] ROOT       =', ROOT);
  console.log('[review-next] REVIEWS    =', REVIEWS_DIR);
  console.log('[review-next] DUE_PATH   =', DUE_PATH);
  console.log('────────────────────────────────────────────');

  if (!fs.existsSync(REVIEWS_DIR)) {
    console.log('[review-next] reviews dir 없음 → 종료:', REVIEWS_DIR);
    process.exit(0);
  }

  const due = readJsonSafe(DUE_PATH, null);
  if (!due || typeof due !== 'object') {
    console.log('[review-next] due-90days.json 없음/파싱불가 → 종료');
    process.exit(0);
  }

  // 🔧 수정: due 구조 확장 지원 (flat / buckets 포함)
  const items = [];

  // 기존 케이스 유지
  if (Array.isArray(due.items)) {
    for (const it of due.items) items.push(it);
  } else if (due.byBucket && typeof due.byBucket === 'object') {
    for (const b of Object.keys(due.byBucket)) {
      const arr = due.byBucket[b];
      if (Array.isArray(arr)) {
        for (const x of arr) items.push({ ...x, bucket: x.bucket || b });
      }
    }
  }

  // 🔧 추가: flat 구조 지원
  if (due.flat && typeof due.flat === 'object') {
    for (const cls of ['overdue', 'dueSoon']) {
      const arr = due.flat[cls];
      if (Array.isArray(arr)) {
        for (const x of arr) items.push({ ...x, class: cls });
      }
    }
  }

  // 🔧 추가: buckets 구조 지원
  if (due.buckets && typeof due.buckets === 'object') {
    for (const b of Object.keys(due.buckets)) {
      const group = due.buckets[b];
      if (!group) continue;
      for (const cls of ['overdue', 'dueSoon']) {
        const arr = group[cls];
        if (Array.isArray(arr)) {
          for (const x of arr) {
            items.push({ ...x, bucket: x.bucket || b, class: cls });
          }
        }
      }
    }
  }

  const picked = { app: [], device: [], subscription: [] };

  for (const it of items) {
    const bucket = String(it.bucket || '').trim();
    const slug = String(it.slug || '').trim();
    if (!bucket || !slug) continue;
    if (!picked[bucket]) continue;

    // 🔧 수정: class 기준으로 필터링
    const cls = String(it.class || '').trim();

    if (cls === 'overdue' || cls === 'dueSoon' || cls === 'due') {
      picked[bucket].push(slug);
    }
  }

  let totalQueued = 0;
  let totalWritten = 0;

  for (const bucket of BUCKETS) {
    const slugs = uniq(picked[bucket]);
    totalQueued += slugs.length;

    const baselinePath = path.join(REVIEWS_DIR, `${bucket}-ratings.json`);
    const nextPath = path.join(REVIEWS_DIR, `${bucket}-ratings-next.json`);

    let baseline = ensureBySlug(readJsonSafe(baselinePath, { bySlug: {} }));
    let next = ensureBySlug(readJsonSafe(nextPath, { bySlug: {} }));

    let wrote = 0;

    for (const slug of slugs) {
      const baseRec = baseline.bySlug[slug];
      if (!baseRec || typeof baseRec !== 'object') continue;

      const cloned = JSON.parse(JSON.stringify(baseRec));
      if (!cloned.status) cloned.status = 'due';

      const prev = JSON.stringify(next.bySlug[slug] || null);
      const now = JSON.stringify(cloned);

      if (prev !== now) {
        next.bySlug[slug] = cloned;
        wrote++;
      }
    }

    if (wrote > 0) {
      writeJsonPretty(nextPath, next);
      totalWritten += wrote;
      console.log(`[review-next] (${bucket}) next 갱신: ${nextPath} wrote=${wrote}`);
    } else {
      console.log(`[review-next] (${bucket}) 변경 없음 (queued=${slugs.length})`);
    }
  }

  console.log('────────────────────────────────────────────');
  console.log(`[review-next] queued(total)=${totalQueued} | wrote(total)=${totalWritten}`);
  console.log('[review-next] 다음 순서: review-diff-update.cjs → review-resolver.cjs → render-posts.cjs');
  console.log('────────────────────────────────────────────');
}

if (require.main === module) main();
