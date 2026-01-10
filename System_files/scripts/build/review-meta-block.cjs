#!/usr/bin/env node
'use strict';

/** review-meta-block: dist/posts의 review-rating/insights 섹션을 review-ratings SSOT로 교체 */

const fs = require('fs');
const path = require('path');

require('./lib/env.cjs');

const ROOT = path.resolve(__dirname, '../..');
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
const DATA_DIR = path.join(ROOT, 'content', 'reviews');
const RATINGS_PATH = path.join(DATA_DIR, 'review-ratings.json');

function log(msg) {
  console.log(msg);
}

function loadRatings() {
  if (!fs.existsSync(RATINGS_PATH)) return { bySlug: {} };
  const raw = fs.readFileSync(RATINGS_PATH, 'utf8');
  try {
    const json = JSON.parse(raw);
    return json || { bySlug: {} };
  } catch (e) {
    console.error('[review-meta] review-ratings.json 파싱 실패:', e.message);
    return { bySlug: {} };
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

function buildInsightsBlock(data) {
  const insights = Array.isArray(data.insights) ? data.insights : [];

  if (!insights.length) {
    return [
      '  <section id="review-insights-block" class="review-block">',
      '    <!-- no insights -->',
      '  </section>',
    ].join('\n');
  }

  const items = insights
    .map(t => (t ? String(t).trim() : ''))
    .filter(Boolean)
    .map(t => `      <li>${t}</li>`)
    .join('\n');

  return [
    '  <section id="review-insights-block" class="review-block">',
    '    <ul class="review-insights-list">',
    items,
    '    </ul>',
    '  </section>',
  ].join('\n');
}

function replaceSection(html, sectionId, newBlockHtml) {
  const pattern = new RegExp(
    `<section\\s+id="${sectionId}"[\\s\\S]*?<\\/section>`,
    'i'
  );
  if (!pattern.test(html)) return { html, changed: false };
  return { html: html.replace(pattern, newBlockHtml), changed: true };
}

function main() {
  log('────────────────────────────────────────────');
  log('[review-meta] 시작');
  log(`[review-meta] ROOT = ${ROOT}`);
  log(`[review-meta] DIST = ${DIST_DIR}`);
  log(`[review-meta] SSOT = ${RATINGS_PATH}`);

  const ratings = loadRatings();
  const bySlug = ratings.bySlug || {};

  if (!fs.existsSync(DIST_DIR)) {
    log('[review-meta] dist/posts 디렉터리가 없습니다. 종료합니다.');
    return;
  }

  const files = fs.readdirSync(DIST_DIR).filter(f => f.endsWith('.html'));
  log(`[review-meta] posts 로드: ${files.length} 개`);

  let updatedCount = 0;
  let ratingMissing = 0;
  let slotMissing = 0;

  for (const file of files) {
    const slug = path.basename(file, '.html');
    const ratingData = bySlug[slug];
    const fullPath = path.join(DIST_DIR, file);

    if (!ratingData) {
      ratingMissing += 1;
      continue;
    }

    let html = fs.readFileSync(fullPath, 'utf8');

    const hasRatingSlot = html.includes('id="review-rating-block"');
    const hasInsightsSlot = html.includes('id="review-insights-block"');
    if (!hasRatingSlot || !hasInsightsSlot) {
      slotMissing += 1;
      continue;
    }

    const ratingBlockHtml = buildRatingBlock(ratingData);
    const insightsBlockHtml = buildInsightsBlock(ratingData);

    let changed = false;

    const r1 = replaceSection(html, 'review-rating-block', ratingBlockHtml);
    html = r1.html;
    if (r1.changed) changed = true;

    const r2 = replaceSection(html, 'review-insights-block', insightsBlockHtml);
    html = r2.html;
    if (r2.changed) changed = true;

    if (changed) {
      fs.writeFileSync(fullPath, html, 'utf8');
      updatedCount += 1;
    }
  }

  log('────────────────────────────────────────────');
  log(`[review-meta] 처리 완료: 업데이트=${updatedCount}, rating없음=${ratingMissing}, 슬롯없음=${slotMissing}`);
  log('────────────────────────────────────────────');
}

main();
