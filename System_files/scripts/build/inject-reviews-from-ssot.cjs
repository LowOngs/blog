#!/usr/bin/env node
'use strict';

/**
 * inject-reviews-from-ssot.cjs
 *
 * What:
 * - dist/posts/*.html의 두 섹션을 SSOT로 치환한다.
 *   1) <section id="review-rating-block"> ... </section>
 *   2) <section id="review-insights-block"> ... </section>
 *
 * Why:
 * - 템플릿(post.html)에 "리뷰 섹션 실물(placeholder)"을 상시 탑재(B안)했으므로,
 *   실제 데이터 주입은 후처리 인젝터가 replaceSection으로 “교체”하는 것이 역할 분리상 정답.
 * - render 단계에서 주입하면 동일 id가 2개가 될 수 있어(중복 id) 금지.
 * - 리뷰가 아닌 글까지 주입을 시도하면 ratingMissing이 가짜 결함으로 누적됨 → 노이즈 제거 필요.
 *
 * I/O:
 * - READ : System_files/content/reviews/review-ratings.json (SSOT)
 * - READ : System_files/dist/posts/*.html
 * - WRITE: System_files/dist/posts/*.html (in-place overwrite)
 *
 * Invariants:
 * - id="review-rating-block" / id="review-insights-block"는 최종 HTML에 각 1개만 존재해야 함.
 * - 리뷰가 아닌 글은 스킵(가짜 missing 카운트 금지).
 * - 섹션이 없다면(slotMissing) 수정하지 않는다(구조 오염 방지).
 * - SSOT가 없으면(ratingMissing) 수정하지 않는다(“진짜 결함”만 카운트).
 */

require('./lib/env.cjs'); // ✅ 공통 규칙: env 로더 최우선

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
const RATINGS_PATH = path.join(ROOT, 'content', 'reviews', 'review-ratings.json');

// Freshness policy (UTC 기준)
const WARN_DAYS = 89;
const STALE_DAYS = 90;

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

function readTextSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
}

function writeTextSafe(p, s) {
  fs.writeFileSync(p, s, 'utf8');
}

// ─────────────────────────────────────────────
// Review slug gate (MIN PATCH, 노이즈 제거 핵심)
// - 템플릿(B안)에서 모든 글에 리뷰 섹션이 존재할 수 있으므로,
//   “리뷰 글만” 주입을 시도해야 ratingMissing이 진짜 결함만 남는다.
// - 기준: slug prefix (app-/device-/subscription-)
//   (labels 기반으로 바꾸고 싶으면 후속 단계에서 content/posts 읽어도 됨)
// ─────────────────────────────────────────────
function isReviewSlug(slug) {
  const s = String(slug || '').toLowerCase();
  return s.startsWith('app-') || s.startsWith('device-') || s.startsWith('subscription-');
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
// Freshness (UTC)
// - lastChecked 우선, 그 다음 updatedAt/checkedAt/fetchedAt
// - 날짜가 없으면 MISSING_DATE (WARN 취급)
// ─────────────────────────────────────────────
function parseDateUtcMaybe(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;

  // YYYY-MM-DD → UTC 00:00Z로 간주
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
// Review HTML builders (템플릿 CSS 클래스와 호환)
// - 이 파일은 “치환할 HTML 조각”만 생성한다.
// - 템플릿에서 placeholder는 .review-block--empty로 숨김 처리.
// - 여기서 만드는 블록은 .review-block--empty를 포함하지 않아 자동 노출된다.
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

function buildRatingBlock(data) {
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

function buildInsightsBlock(data) {
  const insights = Array.isArray(data.insights) ? data.insights : [];

  if (!insights.length) {
    // 섹션은 유지하되, 빈 블록으로 둔다(레이아웃 계약/DOM 안정성)
    return [
      '  <section id="review-insights-block" class="review-block">',
      '    <!-- insights: empty -->',
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

// ─────────────────────────────────────────────
// Replace helpers
// - section 전체를 통째로 치환한다.
// - id 중복 방지(최종 HTML에서 해당 id의 section은 정확히 1개여야 한다)
// ─────────────────────────────────────────────
function replaceSection(html, sectionId, newBlockHtml) {
  const re = new RegExp(`<section\\b[^>]*\\bid=["']${sectionId}["'][^>]*>[\\s\\S]*?<\\/section>`, 'i');
  if (!re.test(html)) return { html, changed: false };
  return { html: html.replace(re, newBlockHtml), changed: true };
}

function countSectionId(html, sectionId) {
  const re = new RegExp(`\\bid=["']${sectionId}["']`, 'gi');
  let n = 0;
  while (re.exec(String(html || ''))) n++;
  return n;
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

  const files = fs.readdirSync(DIST_DIR).filter(f => f.endsWith('.html')).sort();
  log('HTML files =', files.length);

  let updated = 0;

  // “진짜 결함” 카운트(리뷰 글에 대해서만)
  let ratingMissing = 0;
  let slotMissing = 0;

  // 통계
  let skippedNotReview = 0;

  // Freshness stats
  let freshCount = 0;
  let warnCount = 0;
  let staleCount = 0;
  let missingDateCount = 0;

  const VERBOSE_FRESHNESS = true;

  for (const file of files) {
    const slug = path.basename(file, '.html');

    // ✅ 리뷰 글만 주입 시도 (노이즈 제거 핵심)
    if (!isReviewSlug(slug)) {
      skippedNotReview += 1;
      continue;
    }

    const fullPath = path.join(DIST_DIR, file);
    const html0 = readTextSafe(fullPath);
    if (html0 == null) continue;

    // slot 존재 여부(없으면 건드리지 않음)
    const hasRatingSlot = html0.includes('id="review-rating-block"');
    const hasInsightsSlot = html0.includes('id="review-insights-block"');

    if (!hasRatingSlot || !hasInsightsSlot) {
      slotMissing += 1;
      continue;
    }

    const data = bySlug[slug];
    if (!data) {
      // ✅ 진짜 결함: 리뷰 slug인데 SSOT가 없음
      ratingMissing += 1;
      continue;
    }

    // Freshness logging (경고만, 차단은 qa/publish 단계에서 정책으로)
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

    // build blocks
    const ratingBlock = buildRatingBlock(data);
    const insightsBlock = buildInsightsBlock(data);

    // replace
    let html = html0;
    let changed = false;

    const r1 = replaceSection(html, 'review-rating-block', ratingBlock);
    html = r1.html;
    if (r1.changed) changed = true;

    const r2 = replaceSection(html, 'review-insights-block', insightsBlock);
    html = r2.html;
    if (r2.changed) changed = true;

    // ✅ 중복 id 가드(오염 방지)
    const cntRating = countSectionId(html, 'review-rating-block');
    const cntInsights = countSectionId(html, 'review-insights-block');
    if (cntRating !== 1 || cntInsights !== 1) {
      warn(`dup/invalid section id guarded: slug=${slug} rating=${cntRating} insights=${cntInsights} (write skipped)`);
      continue;
    }

    if (changed) {
      writeTextSafe(fullPath, html);
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

  // 선택: CI에서 “리뷰인데 SSOT 없음/slot 없음”을 실패로 잡고 싶으면 REVIEW_SSOT_STRICT=1
  const STRICT = String(process.env.REVIEW_SSOT_STRICT || '').trim() === '1';
  if (STRICT && (ratingMissing > 0 || slotMissing > 0)) {
    process.exitCode = 1;
  }
}

if (require.main === module) main();
```0
