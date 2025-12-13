#!/usr/bin/env node
'use strict';

/**
 * inject-reviews-from-ssot.cjs
 * - 입력: content/ssot/reviews.bySlug.json (SSOT)
 * - 출력: dist/posts/*.html
 *   - review-rating-block / review-insights-block 섹션을 SSOT 최신값으로 교체
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
const SSOT_PATH = path.join(ROOT, 'content', 'ssot', 'reviews.bySlug.json');

function log(...args) {
  console.log('[inject-reviews]', ...args);
}

function loadJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
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

function buildHistogramHtml(histogram) {
  if (!histogram || typeof histogram !== 'object') return '';

  const stars = [5, 4, 3, 2, 1];
  const rows = [];

  for (const star of stars) {
    const raw = Number(histogram[String(star)] ?? 0);
    if (!Number.isFinite(raw)) continue;

    const pct = Math.max(0, Math.min(100, raw));
    const pctText = (pct % 1 === 0) ? String(pct) : pct.toFixed(1).replace(/\.0$/, '');

    rows.push(
      [
        '<div class="review-histogram-row">',
        `  <div class="review-histogram-label">${star}★</div>`,
        '  <div class="review-histogram-bar-wrap">',
        `    <div class="review-histogram-bar" style="width: ${pct}%;"></div>`,
        '  </div>',
        `  <div class="review-histogram-value">${pctText}%</div>`,
        '</div>'
      ].join('\n')
    );
  }

  if (!rows.length) return '';

  return [
    '',
    '  <div class="review-histogram" aria-label="Rating distribution">',
    rows.map(r => '    ' + r).join('\n').replace(/\n/g, '\n    '),
    '  </div>'
  ].join('\n');
}

function buildRatingBlock(data) {
  const lastChecked = data.lastChecked || 'n/a';
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
    '  </section>'
  ].join('\n');
}

function buildInsightsBlock(data) {
  const insights = Array.isArray(data.insights) ? data.insights : [];
  if (!insights.length) {
    return [
      '  <section id="review-insights-block" class="review-block">',
      '  ',
      '  </section>'
    ].join('\n');
  }

  const items = insights
    .map(t => (t == null ? '' : String(t).trim()))
    .filter(Boolean)
    .map(t => `      <li>${t}</li>`)
    .join('\n');

  return [
    '  <section id="review-insights-block" class="review-block">',
    '    <ul class="review-insights-list">',
    items,
    '    </ul>',
    '  </section>'
  ].join('\n');
}

function replaceSection(html, sectionId, newBlockHtml) {
  const pattern = new RegExp(`<section\\s+id="${sectionId}"[\\s\\S]*?<\\/section>`, 'i');
  if (!pattern.test(html)) return { html, changed: false };
  return { html: html.replace(pattern, newBlockHtml), changed: true };
}

function main() {
  console.log('────────────────────────────────────────────');
  log('시작');
  log('ROOT =', ROOT);
  log('DIST =', DIST_DIR);
  log('SSOT =', SSOT_PATH);

  if (!fs.existsSync(DIST_DIR)) {
    log('dist/posts 디렉터리 없음 → 종료');
    return;
  }

  const ssot = loadJsonSafe(SSOT_PATH, null);
  const bySlug = ssot && ssot.bySlug && typeof ssot.bySlug === 'object' ? ssot.bySlug : {};

  const files = fs.readdirSync(DIST_DIR).filter(f => f.endsWith('.html'));
  log(`HTML 파일 수 = ${files.length}`);

  let updated = 0;
  let noData = 0;
  let slotMissing = 0;

  for (const file of files) {
    const slug = path.basename(file, '.html');
    const data = bySlug[slug];
    if (!data) {
      noData++;
      continue;
    }

    const full = path.join(DIST_DIR, file);
    let html = fs.readFileSync(full, 'utf8');

    const hasRatingSlot = html.includes('id="review-rating-block"');
    const hasInsightsSlot = html.includes('id="review-insights-block"');
    if (!hasRatingSlot || !hasInsightsSlot) {
      slotMissing++;
      continue;
    }

    const ratingBlock = buildRatingBlock(data);
    const insightsBlock = buildInsightsBlock(data);

    let changed = false;
    const r1 = replaceSection(html, 'review-rating-block', ratingBlock);
    html = r1.html; changed = changed || r1.changed;

    const r2 = replaceSection(html, 'review-insights-block', insightsBlock);
    html = r2.html; changed = changed || r2.changed;

    if (changed) {
      fs.writeFileSync(full, html, 'utf8');
      updated++;
    }
  }

  console.log('────────────────────────────────────────────');
  log(`완료: 업데이트=${updated}, SSOT데이터없음=${noData}, 슬롯없음=${slotMissing}`);
}

main();
