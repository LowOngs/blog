#!/usr/bin/env node
'use strict';

/**
 * inject-reviews-from-ssot.cjs
 * - 입력(SSOT): content/reviews/review-ratings.json (bySlug)
 * - 출력: dist/posts/*.html
 *   - <section id="review-rating-block"> ... </section>
 *   - <section id="review-insights-block"> ... </section>
 *   를 최신 값으로 교체
 *
 * ✅ Freshness(UTC 기준)
 * - lastChecked(권장) 또는 updatedAt / checkedAt / fetchedAt 중 존재하는 값을 사용
 * - 89일 이상 & 90일 미만: WARN
 * - 90일 이상: STALE
 * - 날짜가 없거나 파싱 실패: MISSING_DATE (WARN 취급)
 *
 * ⚠️ 주의: 이 파일은 "경고/표시"까지 담당합니다.
 * 실제 업데이트(수집/크롤/갱신)는 후속 스크립트로 분리 권장.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
const RATINGS_PATH = path.join(ROOT, 'content', 'reviews', 'review-ratings.json');

function log(...a) { console.log('[inject-reviews]', ...a); }
function warn(...a) { console.warn('[inject-reviews][WARN]', ...a); }

// ─────────────────────────────────────────────
// JSON Safe
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// Freshness (UTC 기준)
// ─────────────────────────────────────────────
const WARN_DAYS = 89;
const STALE_DAYS = 90;

function parseDateUtcMaybe(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;

  // YYYY-MM-DD 형태는 UTC 00:00:00로 취급
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + 'T00:00:00Z');
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // ISO8601 등은 Date가 파싱하도록
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pickFreshnessDate(data) {
  // SSOT 쪽 필드명 변화에 대비해 후보를 둡니다.
  const candidates = [
    data && data.lastChecked,
    data && data.updatedAt,
    data && data.checkedAt,
    data && data.fetchedAt,
  ];
  for (const c of candidates) {
    const d = parseDateUtcMaybe(c);
    if (d) return { date: d, raw: String(c) };
  }
  return { date: null, raw: null };
}

function daysSinceUtc(dateObj) {
  const now = new Date();
  const nowUtcMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0, 0, 0, 0
  );
  const dUtcMidnight = Date.UTC(
    dateObj.getUTCFullYear(),
    dateObj.getUTCMonth(),
    dateObj.getUTCDate(),
    0, 0, 0, 0
  );
  const diffMs = nowUtcMidnight - dUtcMidnight;
  return Math.floor(diffMs / 86400000);
}

function getFreshnessStatus(data) {
  const picked = pickFreshnessDate(data);
  if (!picked.date) {
    return {
      status: 'MISSING_DATE',
      daysSince: null,
      dateRaw: null,
      warn: true,
      stale: false
    };
  }
  const ds = daysSinceUtc(picked.date);
  const stale = ds >= STALE_DAYS;
  const w = !stale && ds >= WARN_DAYS;
  return {
    status: stale ? 'STALE' : (w ? 'WARN' : 'FRESH'),
    daysSince: ds,
    dateRaw: picked.raw,
    warn: w,
    stale
  };
}

// ─────────────────────────────────────────────
// Review blocks
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// main
// ─────────────────────────────────────────────
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

  // 기존 카운트
  let updated = 0;
  let ratingMissing = 0;
  let slotMissing = 0;

  // freshness 카운트
  let freshCount = 0;
  let warnCount = 0;
  let staleCount = 0;
  let missingDateCount = 0;

  // 선택: 파일별 freshness 로그를 너무 많이 찍고 싶지 않으면 false로 바꾸세요.
  const VERBOSE_FRESHNESS = true;

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

    // ✅ Freshness 검사 (UTC 기준)
    const f = getFreshnessStatus(data);
    if (f.status === 'FRESH') freshCount += 1;
    else if (f.status === 'WARN') warnCount += 1;
    else if (f.status === 'STALE') staleCount += 1;
    else if (f.status === 'MISSING_DATE') missingDateCount += 1;

    if (VERBOSE_FRESHNESS) {
      if (f.status === 'WARN') {
        warn(`Freshness WARN: slug=${slug} daysSince=${f.daysSince} (>=${WARN_DAYS}d) last=${f.dateRaw || 'n/a'}`);
      } else if (f.status === 'STALE') {
        warn(`Freshness STALE: slug=${slug} daysSince=${f.daysSince} (>=${STALE_DAYS}d) last=${f.dateRaw || 'n/a'}`);
      } else if (f.status === 'MISSING_DATE') {
        warn(`Freshness MISSING_DATE: slug=${slug} (lastChecked/updatedAt 없음)`);
      }
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

  log('done:',
    `updated=${updated}`,
    `ratingMissing=${ratingMissing}`,
    `slotMissing=${slotMissing}`,
    `fresh=${freshCount}`,
    `warn=${warnCount}`,
    `stale=${staleCount}`,
    `missingDate=${missingDateCount}`
  );

  // 운영자가 “지금 당장 뭘 해야 하냐”를 한 줄로 보게 만드는 요약
  if (staleCount > 0) {
    warn(`ACTION: STALE=${staleCount} (>=${STALE_DAYS}d). Update/refresh SSOT for those slugs.`);
  } else if (warnCount > 0 || missingDateCount > 0) {
    warn(`SOON: WARN=${warnCount}, MISSING_DATE=${missingDateCount}. Refresh before hitting ${STALE_DAYS}d.`);
  } else {
    log(`OK: All review freshness checks are within ${WARN_DAYS}d.`);
  }
}

main();
