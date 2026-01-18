#!/usr/bin/env node
'use strict';

/**
 * review-meta-block: dist/posts의 review-rating/insights 섹션을 review-ratings SSOT로 교체
 *
 * ✅ 유지(기존 기능 그대로)
 * 1) rating 슬롯이 없어도 insights 슬롯만 있으면 insights는 교체(독립 처리)
 * 2) insights를 Positive / Negative로 분리하여 각 6개 목표로 출력(부족 시 6 미만 허용)
 * 3) 0개인 경우에도 섹션을 숨기지 않고 안내 멘트(영문)를 반드시 출력
 *
 * ✅ 이번 업데이트(추가/보강 — 기존 동작을 크게 바꾸지 않음)
 * A) .env 로더를 “최상단(공통규칙)”에 고정(가장 먼저 로딩)
 * B) 리뷰 대상 파일만 처리하는 옵션 추가(기본값: ON)
 * C) ✅ (추가) reviewId 우선 매칭 + slug 폴백
 *    - posts SSOT(content/posts/{slug}.json)에서 reviewId를 읽음
 *    - SSOT(review-ratings.json)에 byReviewId가 있으면 먼저 찾고,
 *      없으면 기존 bySlug[slug]로 처리
 */

require('./lib/env.cjs'); // ✅ 공통 규칙: env 로더 최우선

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');          // ✅ 추가
const DATA_DIR = path.join(ROOT, 'content', 'reviews');
const RATINGS_PATH = path.join(DATA_DIR, 'review-ratings.json');

// ✅ 기본값: 리뷰 슬러그만 처리(노이즈 제거)
// - 환경변수로 OFF 가능: REVIEW_META_ONLY_REVIEW_SLUGS=false
const ONLY_REVIEW_SLUGS = String(process.env.REVIEW_META_ONLY_REVIEW_SLUGS ?? 'true').toLowerCase() !== 'false';

function log(msg) {
  console.log(msg);
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadRatings() {
  if (!fs.existsSync(RATINGS_PATH)) return { bySlug: {}, byReviewId: {} };
  const raw = fs.readFileSync(RATINGS_PATH, 'utf8');
  try {
    const json = JSON.parse(raw);
    return json || { bySlug: {}, byReviewId: {} };
  } catch (e) {
    console.error('[review-meta] review-ratings.json parse failed:', e.message);
    return { bySlug: {}, byReviewId: {} };
  }
}

function formatRating(val) {
  if (typeof val !== 'number' || Number.isNaN(val)) return 'n/a';
  const fixed = val.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

function formatInt(val) {
  if (typeof val !== 'number' || Number.isNaN(val)) return 'n/a';
  return val.toLocaleString('en-US');
}

function formatDiff(val) {
  if (typeof val !== 'number' || Number.isNaN(val)) return 'n/a';
  const fixed = val.toFixed(1);
  const core = fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
  if (val > 0) return `+${core}`;
  return core;
}

function formatLastChecked(v) {
  if (!v) return 'n/a';
  return String(v);
}

function buildHistogramHtml(histogram) {
  if (!histogram || typeof histogram !== 'object') return '';

  const stars = [5, 4, 3, 2, 1];
  const rows = [];

  for (const star of stars) {
    const raw = Number(histogram[String(star)] ?? 0);
    if (!Number.isFinite(raw)) continue;

    const pct = Math.max(0, Math.min(100, raw));
    const pctText = (pct % 1 === 0)
      ? String(pct)
      : pct.toFixed(1).replace(/\.0$/, '');

    rows.push(
      [
        '<div class="review-histogram-row">',
        `  <div class="review-histogram-label">${star}★</div>`,
        '  <div class="review-histogram-bar-wrap">',
        `    <div class="review-histogram-bar" style="width: ${pct}%;"></div>`,
        '  </div>',
        `  <div class="review-histogram-value">${pctText}%</div>`,
        '</div>',
      ].join('\n')
    );
  }

  if (!rows.length) return '';

  return [
    '',
    '  <div class="review-histogram" aria-label="Rating distribution">',
    rows.map(r => '    ' + r).join('\n').replace(/\n/g, '\n    '),
    '  </div>',
  ].join('\n');
}

function buildRatingBlock(data) {
  const lastChecked = formatLastChecked(data.lastChecked);
  const status = data.status || 'n/a';
  const store = data.store || 'multi';

  const ratingCurrent = formatRating(data.ratingCurrent);
  const ratingPrevious = formatRating(data.ratingPrevious);
  const ratingDiff = formatDiff(data.ratingDiff);

  const votesCurrent = formatInt(data.votesCurrent);
  const votesPrevious = formatInt(data.votesPrevious);
  const votesDiff = (typeof data.votesDiff === 'number' && !Number.isNaN(data.votesDiff))
    ? (data.votesDiff > 0 ? `+${data.votesDiff.toLocaleString('en-US')}` : data.votesDiff.toLocaleString('en-US'))
    : 'n/a';

  const histogramHtml = buildHistogramHtml(data.histogram);

  return [
    '  <section id="review-rating-block" class="review-block">',
    '    <div class="review-block__title">User ratings snapshot (last 90 days)</div>',
    '    <div class="review-block__meta">',
    `      Last checked: ${lastChecked} · Status: ${status} · Store: ${store}`,
    '    </div>',
    '    <table class="review-rating-table">',
    '      <thead>',
    '        <tr>',
    '          <th scope="col"></th>',
    '          <th scope="col">Average rating</th>',
    '          <th scope="col">Ratings count</th>',
    '        </tr>',
    '      </thead>',
    '      <tbody>',
    '        <tr>',
    '          <th scope="row">Current</th>',
    `          <td>${ratingCurrent}</td>`,
    `          <td>${votesCurrent}</td>`,
    '        </tr>',
    '        <tr>',
    '          <th scope="row">3 months ago</th>',
    `          <td>${ratingPrevious}</td>`,
    `          <td>${votesPrevious}</td>`,
    '        </tr>',
    '        <tr>',
    '          <th scope="row">Change</th>',
    `          <td>${ratingDiff}</td>`,
    `          <td>${votesDiff}</td>`,
    '        </tr>',
    '      </tbody>',
    '    </table>',
    histogramHtml,
    '  </section>',
  ].join('\n');
}

function normalizeTextList(list) {
  return (Array.isArray(list) ? list : [])
    .map(t => (t ? String(t).trim() : ''))
    .filter(Boolean);
}

function takeUpTo6(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= 6) break;
  }
  return out;
}

function pickPositiveNegative(data) {
  if (data && data.insights && typeof data.insights === 'object' && !Array.isArray(data.insights)) {
    const pos = normalizeTextList(data.insights.positive);
    const neg = normalizeTextList(data.insights.negative);
    return { positive: pos, negative: neg };
  }

  if (data && (Array.isArray(data.insightsPositive) || Array.isArray(data.insightsNegative))) {
    const pos = normalizeTextList(data.insightsPositive);
    const neg = normalizeTextList(data.insightsNegative);
    return { positive: pos, negative: neg };
  }

  const flat = normalizeTextList(data && data.insights);
  return { positive: flat, negative: [] };
}

function buildInsightsBlock(data) {
  const { positive, negative } = pickPositiveNegative(data);

  const posPicked = takeUpTo6(positive);
  const negPicked = takeUpTo6(negative);

  const POS_EMPTY_MSG =
    'Positive feedback exists, but there are not enough specific, detailed comments to summarize yet.';
  const NEG_EMPTY_MSG =
    'No meaningful negative issues (specific complaints or problems) have been identified so far.';

  const posHtml = posPicked.length
    ? posPicked.map(t => `        <li>${t}</li>`).join('\n')
    : `        <li class="review-insights-empty">${POS_EMPTY_MSG}</li>`;

  const negHtml = negPicked.length
    ? negPicked.map(t => `        <li>${t}</li>`).join('\n')
    : `        <li class="review-insights-empty">${NEG_EMPTY_MSG}</li>`;

  return [
    '  <section id="review-insights-block" class="review-block">',
    '    <div class="review-block__title">User insights snapshot</div>',
    '    <div class="review-block__meta">Positive vs. negative signals (up to 6 each). If evidence is insufficient, a notice is shown.</div>',
    '',
    '    <div class="review-insights-split">',
    '      <div class="review-insights-col review-insights-col--positive">',
    '        <div class="review-insights-col__title">What users like</div>',
    '        <ul class="review-insights-list">',
    posHtml,
    '        </ul>',
    '      </div>',
    '',
    '      <div class="review-insights-col review-insights-col--negative">',
    '        <div class="review-insights-col__title">What users dislike</div>',
    '        <ul class="review-insights-list">',
    negHtml,
    '        </ul>',
    '      </div>',
    '    </div>',
    '  </section>',
  ].join('\n');
}

function replaceSection(html, sectionId, newBlockHtml) {
  const pattern = new RegExp(`<section\\s+id="${sectionId}"[\\s\\S]*?<\\/section>`, 'i');
  if (!pattern.test(html)) return { html, changed: false };
  return { html: html.replace(pattern, newBlockHtml), changed: true };
}

function isReviewSlug(slug) {
  return slug.startsWith('app-') || slug.startsWith('device-') || slug.startsWith('subscription-');
}

// ✅ 추가: posts SSOT에서 reviewId 읽기 (없으면 null)
function getReviewIdForSlug(slug) {
  const p = path.join(POSTS_DIR, `${slug}.json`);
  const j = safeReadJson(p, null);
  const rid = j && (j.reviewId || (j.seedMeta && j.seedMeta.reviewId));
  return rid ? String(rid) : null;
}

function main() {
  log('────────────────────────────────────────────');
  log('[review-meta] start');
  log(`[review-meta] ROOT = ${ROOT}`);
  log(`[review-meta] DIST = ${DIST_DIR}`);
  log(`[review-meta] SSOT = ${RATINGS_PATH}`);
  log(`[review-meta] ONLY_REVIEW_SLUGS = ${ONLY_REVIEW_SLUGS}`);

  const ratings = loadRatings();
  const bySlug = ratings.bySlug || {};
  const byReviewId = ratings.byReviewId || {}; // ✅ 추가(없으면 {})

  if (!fs.existsSync(DIST_DIR)) {
    log('[review-meta] dist/posts does not exist. exit.');
    return;
  }

  const files = fs.readdirSync(DIST_DIR).filter(f => f.endsWith('.html'));
  log(`[review-meta] posts loaded: ${files.length}`);

  let updatedCount = 0;
  let ratingMissing = 0;
  let slotMissing = 0;
  let skippedNonReview = 0;

  // ✅ 추가 통계(선택)
  let matchedById = 0;
  let matchedBySlug = 0;

  for (const file of files) {
    const slug = path.basename(file, '.html');

    if (ONLY_REVIEW_SLUGS && !isReviewSlug(slug)) {
      skippedNonReview += 1;
      continue;
    }

    // ✅ 1순위: reviewId 기반
    const reviewId = getReviewIdForSlug(slug);
    let ratingData = null;

    if (reviewId && byReviewId[reviewId]) {
      ratingData = byReviewId[reviewId];
      matchedById += 1;
    } else if (bySlug[slug]) {
      ratingData = bySlug[slug];
      matchedBySlug += 1;
    }

    const fullPath = path.join(DIST_DIR, file);

    if (!ratingData) {
      ratingMissing += 1;
      continue;
    }

    let html = fs.readFileSync(fullPath, 'utf8');

    const hasRatingSlot = html.includes('id="review-rating-block"');
    const hasInsightsSlot = html.includes('id="review-insights-block"');

    if (!hasRatingSlot && !hasInsightsSlot) {
      slotMissing += 1;
      continue;
    }

    let changed = false;

    if (hasRatingSlot) {
      const ratingBlockHtml = buildRatingBlock(ratingData);
      const r1 = replaceSection(html, 'review-rating-block', ratingBlockHtml);
      html = r1.html;
      if (r1.changed) changed = true;
    }

    if (hasInsightsSlot) {
      const insightsBlockHtml = buildInsightsBlock(ratingData);
      const r2 = replaceSection(html, 'review-insights-block', insightsBlockHtml);
      html = r2.html;
      if (r2.changed) changed = true;
    }

    if (changed) {
      fs.writeFileSync(fullPath, html, 'utf8');
      updatedCount += 1;
    }
  }

  log('────────────────────────────────────────────');
  log(`[review-meta] done: updated=${updatedCount}, ssot-missing=${ratingMissing}, slot-missing=${slotMissing}, skipped-non-review=${skippedNonReview}`);
  log(`[review-meta] match: byId=${matchedById}, bySlug=${matchedBySlug}`);
  log('────────────────────────────────────────────');
}

main();
