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
 * ✅ 최소패치(중요)
 * - 템플릿(B안)에서 모든 글에 리뷰 섹션이 존재하므로,
 *   리뷰 글이 아닌 경우 ratingMissing이 "가짜 결함"으로 누적됨.
 * - 따라서 slug prefix(app-/device-/subscription-)인 경우에만 주입을 시도한다.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
const RATINGS_PATH = path.join(ROOT, 'content', 'reviews', 'review-ratings.json');

function log(...a) { console.log('[inject-reviews]', ...a); }
function warn(...a) { console.warn('[inject-reviews][WARN]', ...a); }

// ─────────────────────────────────────────────
// What/Why/I-O/Invariants
// What: dist/posts HTML의 review 섹션 2개를 SSOT로 치환한다.
// Why : 템플릿(B안) placeholder를 "실데이터 섹션"으로 바꿔 표시한다.
// I/O : READ content/reviews/review-ratings.json, dist/posts/*.html
//       WRITE dist/posts/*.html (in-place overwrite)
// Invariants:
//  - 리뷰가 아닌 글은 스킵(가짜 ratingMissing 금지)
//  - section id는 고정(review-rating-block / review-insights-block)
// ─────────────────────────────────────────────

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

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + 'T00:00:00Z');
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pickFreshnessDate(data) {
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
    return { status: 'MISSING_DATE', daysSince: null, dateRaw: null, warn: true, stale: false };
  }
  const ds = daysSinceUtc(picked.date);
  const stale = ds >= STALE_DAYS;
  const w = !stale && ds >= WARN_DAYS;
  return { status: stale ? 'STALE' : (w ? 'WARN' : 'FRESH'), daysSince: ds, dateRaw: picked.raw, warn: w, stale };
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
// Review slug gate (MIN PATCH)
// ─────────────────────────────────────────────
function isReviewSlug(slug) {
  const s = String(slug || '');
  return s.startsWith('app-') || s.startsWith('device-') || s.startsWith('subscription-');
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

  let updated = 0;
  let ratingMissing = 0;
  let slotMissing = 0;

  let freshCount = 0;
  let warnCount = 0;
  let staleCount = 0;
  let missingDateCount = 0;

  const VERBOSE_FRESHNESS = true;

  // (추가) 운영 통계를 분리
  let skippedNotReview = 0;

  for (const file of files) {
    const slug = path.basename(file, '.html');

    // ✅ 최소패치: 리뷰 글만 주입 대상
    if (!isReviewSlug(slug)) {
      skippedNotReview += 1;
      continue;
    }

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
      // ✅ 여기부터는 "진짜 결함"만 카운트됨(리뷰 슬러그인데 SSOT가 없음)
      ratingMissing += 1;
      continue;
    }

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
    `skippedNotReview=${skippedNotReview}`,
    `fresh=${freshCount}`,
    `warn=${warnCount}`,
    `stale=${staleCount}`,
    `missingDate=${missingDateCount}`
  );

  if (staleCount > 0) {
    warn(`ACTION: STALE=${staleCount} (>=${STALE_DAYS}d). Update/refresh SSOT for those slugs.`);
  } else if (warnCount > 0 || missingDateCount > 0) {
    warn(`SOON: WARN=${warnCount}, MISSING_DATE=${missingDateCount}. Refresh before hitting ${STALE_DAYS}d.`);
  } else {
    log(`OK: All review freshness checks are within ${WARN_DAYS}d.`);
  }

  // 강화(가벼운 실패 신호 옵션): 리뷰 대상인데 SSOT 누락이 있으면 CI에서 잡고 싶을 때
  if (String(process.env.REVIEW_SSOT_STRICT || '').toLowerCase() === '1') {
    if (ratingMissing > 0 || slotMissing > 0) process.exitCode = 1;
  }
}

main();
