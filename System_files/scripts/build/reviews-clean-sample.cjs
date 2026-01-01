#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/reviews-clean-sample.cjs
 *
 * 목적:
 * - reviews-seed-sample.cjs 가 생성한 "샘플 슬러그" 레코드를 깨끗하게 제거한다.
 * - content/reviews/*-ratings.json, *-insights.json 의 bySlug에서 샘플 slug 삭제
 * - content/posts/*.json 에서 해당 slug의 reviewData 제거(샘플 주입 흔적 제거)
 *
 * 주의:
 * - 이 스크립트는 "파일을 지우는 것"이 아니라 "샘플로 생성된 데이터만 되돌리는 것"이다.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const REVIEWS_DIR = path.join(ROOT, 'content', 'reviews');

const SAMPLE_SLUGS_DEFAULT = [
  'app-20251207-001',
  'device-20251207-001',
  'subscription-20251207-001',
];

// 필요시: node reviews-clean-sample.cjs slug1 slug2 ...
const EXTRA_SLUGS = process.argv.slice(2).map(s => String(s || '').trim()).filter(Boolean);
const SAMPLE_SLUGS = Array.from(new Set([...SAMPLE_SLUGS_DEFAULT, ...EXTRA_SLUGS]));

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonPretty(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function ensureBySlugShape(obj) {
  if (!obj || typeof obj !== 'object') obj = {};
  if (!obj.bySlug || typeof obj.bySlug !== 'object') obj.bySlug = {};
  return obj;
}

function removeBySlugKeys(filePath, slugs) {
  const before = readJsonSafe(filePath, null);
  if (!before) return { changed: false, removed: 0, reason: 'missing' };

  const data = ensureBySlugShape(before);
  const bySlug = data.bySlug;

  let removed = 0;
  for (const slug of slugs) {
    if (Object.prototype.hasOwnProperty.call(bySlug, slug)) {
      delete bySlug[slug];
      removed++;
    }
  }

  if (removed > 0) {
    writeJsonPretty(filePath, data);
    return { changed: true, removed, reason: 'updated' };
  }
  return { changed: false, removed: 0, reason: 'noop' };
}

function cleanupReviewFiles() {
  if (!fs.existsSync(REVIEWS_DIR)) {
    return { scanned: 0, changed: 0, removed: 0 };
  }

  const files = fs.readdirSync(REVIEWS_DIR)
    .filter(f => f.endsWith('.json'))
    .filter(f =>
      f === 'app-ratings.json' ||
      f === 'device-ratings.json' ||
      f === 'subscription-ratings.json' ||
      f === 'app-insights.json' ||
      f === 'device-insights.json' ||
      f === 'subscription-insights.json'
    )
    .sort();

  let scanned = 0;
  let changed = 0;
  let removedTotal = 0;

  for (const f of files) {
    scanned++;
    const p = path.join(REVIEWS_DIR, f);
    const res = removeBySlugKeys(p, SAMPLE_SLUGS);
    if (res.changed) {
      changed++;
      removedTotal += res.removed;
      console.log('[clean-sample] reviews UPDATE:', f, `removed=${res.removed}`);
    } else {
      console.log('[clean-sample] reviews SKIP  :', f, `(${res.reason})`);
    }
  }

  return { scanned, changed, removed: removedTotal };
}

function cleanupPostsReviewData() {
  if (!fs.existsSync(POSTS_DIR)) {
    return { scanned: 0, changed: 0 };
  }

  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json')).sort();
  let scanned = 0;
  let changed = 0;

  for (const f of files) {
    const p = path.join(POSTS_DIR, f);
    const post = readJsonSafe(p, null);
    if (!post || typeof post !== 'object') continue;

    const slug = post.slug || path.basename(f, '.json');
    if (!SAMPLE_SLUGS.includes(slug)) continue;

    scanned++;

    const had = Object.prototype.hasOwnProperty.call(post, 'reviewData');
    if (had) {
      delete post.reviewData;
      writeJsonPretty(p, post);
      changed++;
      console.log('[clean-sample] posts  UPDATE:', slug, '(reviewData removed)');
    } else {
      console.log('[clean-sample] posts  SKIP  :', slug, '(no reviewData)');
    }
  }

  return { scanned, changed };
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[clean-sample] ROOT       =', ROOT);
  console.log('[clean-sample] POSTS_DIR  =', POSTS_DIR);
  console.log('[clean-sample] REVIEWSDIR =', REVIEWS_DIR);
  console.log('[clean-sample] SAMPLE_SLUGS =', SAMPLE_SLUGS.join(', '));
  console.log('────────────────────────────────────────────');

  const r = cleanupReviewFiles();
  const p = cleanupPostsReviewData();

  console.log('────────────────────────────────────────────');
  console.log('[clean-sample] reviews:', `scanned=${r.scanned}`, `changed=${r.changed}`, `removed=${r.removed}`);
  console.log('[clean-sample] posts  :', `targets=${p.scanned}`, `changed=${p.changed}`);
  console.log('────────────────────────────────────────────');
  console.log('[clean-sample] 완료');
}

if (require.main === module) main();
