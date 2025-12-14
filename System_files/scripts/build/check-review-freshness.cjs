#!/usr/bin/env node
'use strict';

/**
 * check-review-freshness.cjs
 * - 리뷰 3라벨만 90일 프레쉬니스 경고
 *   appliesTo: app-reviews, device-reviews, subscription-services
 * - 기준: content/reviews/review-ratings.json (bySlug[slug].lastChecked, UTC)
 * - WARN: ageDays >= 89
 * - STALE: ageDays >= 90
 *
 * 실행:
 *   C:\google-blog> node .\System_files\scripts\build\check-review-freshness.cjs
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
const RATINGS_PATH = path.join(ROOT, 'content', 'reviews', 'review-ratings.json');

const REVIEW_LABELS = new Set(['app-reviews', 'device-reviews', 'subscription-services']);
const WARN_DAYS = 89;
const STALE_DAYS = 90;

function log(...a) { console.log('[review-freshness]', ...a); }
function warn(...a) { console.warn('[review-freshness][WARN]', ...a); }

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    warn('JSON parse failed:', p, e.message);
    return fallback;
  }
}

function parseUtcDate(input) {
  if (!input) return null;
  const d = new Date(String(input));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function daysBetweenUtc(a, b) {
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function pickLabel(data) {
  if (Array.isArray(data.labels) && data.labels.length > 0) return String(data.labels[0]);
  if (data.label) return String(data.label);
  if (data.seedMeta && data.seedMeta.label) return String(data.seedMeta.label);
  return 'unknown';
}

function buildSlugToLabelMap() {
  const map = {};
  if (!fs.existsSync(POSTS_DIR)) return map;

  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const p = path.join(POSTS_DIR, f);
    const j = readJsonSafe(p, null);
    if (!j) continue;
    const slug = j.slug || path.basename(f, '.json');
    map[slug] = pickLabel(j);
  }
  return map;
}

function main() {
  log('ROOT =', ROOT);
  log('POSTS =', POSTS_DIR);
  log('DIST  =', DIST_DIR);
  log('SSOT  =', RATINGS_PATH);
  log('LABELS=', Array.from(REVIEW_LABELS).join(', '));

  if (!fs.existsSync(DIST_DIR)) {
    warn('dist/posts 폴더가 없습니다. render-posts.cjs 먼저 실행하세요.');
    process.exit(0);
  }

  const slugToLabel = buildSlugToLabelMap();

  const ssot = readJsonSafe(RATINGS_PATH, { bySlug: {} });
  const bySlug = (ssot && ssot.bySlug && typeof ssot.bySlug === 'object') ? ssot.bySlug : {};

  const htmlFiles = fs.readdirSync(DIST_DIR).filter(f => f.endsWith('.html'));
  log('HTML files =', htmlFiles.length);

  // 리뷰 라벨 3개만 targets로 선정
  const targets = [];
  for (const file of htmlFiles) {
    const slug = path.basename(file, '.html');
    const label = slugToLabel[slug] || 'unknown';
    if (REVIEW_LABELS.has(label)) targets.push(slug);
  }

  log('Review-label targets =', targets.length);

  const now = new Date();

  let fresh = 0, warnCnt = 0, stale = 0, missingDate = 0, ssotMissing = 0;
  const warnSlugs = [];
  const staleSlugs = [];
  const missingDateSlugs = [];
  const ssotMissingSlugs = [];

  for (const slug of targets) {
    const data = bySlug[slug];
    if (!data) {
      ssotMissing += 1;
      ssotMissingSlugs.push(slug);
      continue;
    }

    const d = parseUtcDate(data.lastChecked);
    if (!d) {
      missingDate += 1;
      missingDateSlugs.push(slug);
      continue;
    }

    const ageDays = daysBetweenUtc(d, now);

    if (ageDays >= STALE_DAYS) {
      stale += 1;
      staleSlugs.push(`${slug}(${ageDays}d)`);
    } else if (ageDays >= WARN_DAYS) {
      warnCnt += 1;
      warnSlugs.push(`${slug}(${ageDays}d)`);
    } else {
      fresh += 1;
    }
  }

  log(
    'done:',
    `targets=${targets.length}`,
    `fresh=${fresh}`,
    `warn=${warnCnt}`,
    `stale=${stale}`,
    `missingDate=${missingDate}`,
    `ssotMissing=${ssotMissing}`
  );

  if (warnSlugs.length) log('WARN slugs:', warnSlugs.join(', '));
  if (staleSlugs.length) log('STALE slugs:', staleSlugs.join(', '));
  if (missingDateSlugs.length) log('MISSING_DATE slugs:', missingDateSlugs.join(', '));
  if (ssotMissingSlugs.length) log('SSOT_MISSING slugs:', ssotMissingSlugs.join(', '));

  if (!warnCnt && !stale && !missingDate && !ssotMissing) {
    log(`OK: All review freshness checks are within ${WARN_DAYS}d, and SSOT coverage is complete.`);
  }
}

main();
