'use strict';

/**
 * inject-reviews-from-ssot.cjs
 * - 입력(SSOT): content/reviews/review-ratings.json (bySlug)
 * - 출력: dist/posts/*.html
 *   - <section id="review-rating-block"> ... </section>
 *   - <section id="review-insights-block"> ... </section>
 *   를 최신 값으로 교체
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
const RATINGS_PATH = path.join(ROOT, 'content', 'reviews', 'review-ratings.json');

function log(...a) { console.log('[inject-reviews]', ...a); }
function warn(...a) { console.warn('[inject-reviews][WARN]', ...a); }

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
  return val > 0 ? `+${core}` : core;
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
    '  <div class="review-histogram" aria-label="Rating distribution">',
    rows.map(r => '    ' + r).join('\n').replace(/\n/g, '\n    '),
    '  </div>'
  ].join('\n');
}

function buildRatingBlock(slug, data) {
  const lastChecked = data.lastChecked ? String(data.lastChecked) : 'n/a';
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

function buildInsightsBlock(slug, data) {
  const insights = Array.isArray(data.insights) ? data.insights : [];

  if (!insights.length) {
    // 비어 있으면 “빈 섹션” 유지(레이아웃 유지)
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
  const re = new RegExp(`<section\\s+id="${sectionId}"[\\s\\S]*?<\\/section>`, 'i');
  if (!re.test(html)) return { html, changed: false };
  return { html: html.replace(re, newBlockHtml), changed: true };
}

function main() {
  log('ROOT =', ROOT);
  log('DIST =', DIST_DIR);
  log('SSOT =', RATINGS_PATH);

  if (!fs.existsSync(DIST_DIR)) {
    warn('dist/posts 폴더가 없습니다. posts:render 먼저 실행하세요.');
    process.exit(0);
  }

  const ssot = readJsonSafe(RATINGS_PATH, { bySlug: {} });
  const bySlug = (ssot && ssot.bySlug && typeof ssot.bySlug === 'object') ? ssot.bySlug : {};

  const files = fs.readdirSync(DIST_DIR).filter(f => f.endsWith('.html'));
  log('HTML files =', files.length);

  let updated = 0;
  let ratingMissing = 0;
  let slotMissing = 0;

  for (const file of files) {
    const slug = path.basename(file, '.html');
    const data = bySlug[slug];

    const fullPath = path.join(DIST_DIR, file);
    let html = fs.readFileSync(fullPath, 'utf8');

    const hasRatingSlot = html.includes('id="review-rating-block"');
    const hasInsightsSlot = html.includes('id="review-insights-block"');

    if (!hasRatingSlot || !hasInsightsSlot) {
      slotMissing += 1;
      continue;
    }

    if (!data) {
      ratingMissing += 1;
      continue;
    }

    const ratingBlock = buildRatingBlock(slug, data);
    const insightsBlock = buildInsightsBlock(slug, data);

    let changed = false;

    const r1 = replaceSection(html, 'review-rating-block', ratingBlock);
    html = r1.html; if (r1.changed) changed = true;

    const r2 = replaceSection(html, 'review-insights-block', insightsBlock);
    html = r2.html; if (r2.changed) changed = true;

    if (changed) {
      fs.writeFileSync(fullPath, html, 'utf8');
      updated += 1;
    }
  }

  log('done:', `updated=${updated}`, `ratingMissing=${ratingMissing}`, `slotMissing=${slotMissing}`);
}

main();
