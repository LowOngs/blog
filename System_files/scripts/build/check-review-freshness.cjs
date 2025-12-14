#!/usr/bin/env node
'use strict';

/**
 * check-review-freshness.cjs
 * - 리뷰 3라벨(리뷰 슬롯이 있는 글)만 90일 프레쉬니스 경고
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
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
const RATINGS_PATH = path.join(ROOT, 'content', 'reviews', 'review-ratings.json');

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
  return d; // JS Date is UTC internally when using ISO/Z
}

function daysBetweenUtc(a, b) {
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function hasReviewSlots(html) {
  return html.includes('id="review-rating-block"') || html.includes('id="review-insights-block"');
}

function main() {
  log('ROOT =', ROOT);
  log('DIST =', DIST_DIR);
  log('SSOT =', RATINGS_PATH);

  if (!fs.existsSync(DIST_DIR)) {
    warn('dist/posts 폴더가 없습니다. render-posts.cjs 먼저 실행하세요.');
    process.exit(0);
  }

  const ssot = readJsonSafe(RATINGS_PATH, { bySlug: {} });
  const bySlug = (ssot && ssot.bySlug && typeof ssot.bySlug === 'object') ? ssot.bySlug : {};

  const files = fs.readdirSync(DIST_DIR).filter(f => f.endsWith('.html'));
  log('HTML files =', files.length);

  const now = new Date(); // now(UTC 기준 계산용)
  const targets = [];
  for (const file of files) {
    const slug = path.basename(file, '.html');
    const fullPath = path.join(DIST_DIR, file);
    const html = fs.readFileSync(fullPath, 'utf8');
    if (hasReviewSlots(html)) targets.push(slug);
  }

  log('Review-slot targets =', targets.length);

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

    if (ageDays >= 90) {
      stale += 1;
      staleSlugs.push(`${slug}(${ageDays}d)`);
    } else if (ageDays >= 89) {
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
    log('OK: All review freshness checks are within 89d, and SSOT coverage is complete.');
  }
}

main();
