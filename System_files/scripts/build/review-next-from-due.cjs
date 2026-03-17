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

function inferBucketFromSlug(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return '';
  if (s.startsWith('app-')) return 'app';
  if (s.startsWith('device-')) return 'device';
  if (s.startsWith('subscription-')) return 'subscription';
  return '';
}

function normalizeBucket(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'app' || s === 'device' || s === 'subscription') return s;
  return '';
}

function normalizeClass(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  return s;
}

function collectDueItems(due) {
  const items = [];

  // 케이스1: { items:[...] }
  if (Array.isArray(due.items)) {
    for (const it of due.items) {
      if (it && typeof it === 'object') items.push({ ...it });
    }
  }

  // 케이스2: { byBucket:{ app:[...], device:[...], subscription:[...] } }
  if (due.byBucket && typeof due.byBucket === 'object') {
    for (const b of Object.keys(due.byBucket)) {
      const arr = due.byBucket[b];
      if (!Array.isArray(arr)) continue;
      for (const x of arr) {
        if (x && typeof x === 'object') {
          items.push({ ...x, bucket: x.bucket || b });
        }
      }
    }
  }

  // 케이스3: { flat:{ overdue:[...], dueSoon:[...], ok:[...], unknown:[...] } }
  if (due.flat && typeof due.flat === 'object') {
    for (const cls of ['overdue', 'dueSoon', 'ok', 'unknown']) {
      const arr = due.flat[cls];
      if (!Array.isArray(arr)) continue;
      for (const x of arr) {
        if (x && typeof x === 'object') {
          items.push({ ...x, class: x.class || cls });
        }
      }
    }
  }

  // 케이스4: { buckets:{ app:{ overdue:[...], dueSoon:[...] ... }, ... } }
  if (due.buckets && typeof due.buckets === 'object') {
    for (const b of Object.keys(due.buckets)) {
      const group = due.buckets[b];
      if (!group || typeof group !== 'object') continue;

      for (const cls of ['overdue', 'dueSoon', 'ok', 'unknown']) {
        const arr = group[cls];
        if (!Array.isArray(arr)) continue;

        for (const x of arr) {
          if (x && typeof x === 'object') {
            items.push({
              ...x,
              bucket: x.bucket || b,
              class: x.class || cls,
            });
          }
        }
      }
    }
  }

  return items;
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

  const rawItems = collectDueItems(due);
  console.log(`[review-next] collected items = ${rawItems.length}`);

  const picked = { app: [], device: [], subscription: [] };

  let ignoredNoSlug = 0;
  let ignoredNoBucket = 0;
  let ignoredClass = 0;

  for (const it of rawItems) {
    const slug = String(it && it.slug ? it.slug : '').trim();
    if (!slug) {
      ignoredNoSlug++;
      continue;
    }

    let bucket = normalizeBucket(it.bucket);
    if (!bucket) bucket = inferBucketFromSlug(slug);
    if (!bucket || !picked[bucket]) {
      ignoredNoBucket++;
      continue;
    }

    // 우선 class 사용, 없으면 status도 보조 허용
    const cls = normalizeClass(it.class || it.status);

    // overdue / dueSoon / due 만 next 큐에 올림
    if (cls === 'overdue' || cls === 'dueSoon' || cls === 'due') {
      picked[bucket].push(slug);
    } else {
      ignoredClass++;
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
    let missingBaseline = 0;

    for (const slug of slugs) {
      const baseRec = baseline.bySlug[slug];
      if (!baseRec || typeof baseRec !== 'object') {
        missingBaseline++;
        continue;
      }

      // next에 넣을 레코드 (baseline 복제 + status 보정)
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
      console.log(`[review-next] (${bucket}) next 갱신: ${nextPath} wrote=${wrote} missingBaseline=${missingBaseline}`);
    } else {
      console.log(`[review-next] (${bucket}) 변경 없음 (queued=${slugs.length}, missingBaseline=${missingBaseline})`);
    }
  }

  console.log('────────────────────────────────────────────');
  console.log(`[review-next] ignored(noSlug)=${ignoredNoSlug} ignored(noBucket)=${ignoredNoBucket} ignored(class)=${ignoredClass}`);
  console.log(`[review-next] queued(total)=${totalQueued} | wrote(total)=${totalWritten}`);
  console.log('[review-next] 다음 순서: review-diff-update.cjs → review-resolver.cjs → render-posts.cjs');
  console.log('────────────────────────────────────────────');
}

if (require.main === module) main();
