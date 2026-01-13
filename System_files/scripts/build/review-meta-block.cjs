#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/review-meta-block.cjs
 * - dist/posts/*.html 안의 리뷰 섹션(review-rating / insights)을
 *   SSOT(content/reviews/review-ratings.json) 기준으로 "교체 또는 삽입"합니다.
 *
 * ✅ 정책(1단계)
 * - SSOT 우선: content/reviews/review-ratings.json (bySlug[slug])
 * - HTML에 기존 섹션이 있으면 replace
 * - 기존 섹션이 없으면 아래 우선순위로 "삽입"
 *   1) <!--SLOT:REVIEW-->
 *   2) <!--SLOT:FAQ--> 또는 id="faq" 섹션 앞
 *   3) </main> 직전
 *
 * ✅ insights 규칙(1단계)
 * - SSOT의 insights 배열을 그대로 출력(최대 12개 권장)
 * - 부족해도 출력(빈 배열이면 "no insights" 주석만 남김)
 */

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

function toNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeRatingData(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // SSOT 스냅샷형(권장)
  const snapshot = {
    lastChecked: raw.lastChecked ? String(raw.lastChecked) : null,
    status: raw.status ? String(raw.status) : 'ok',
    store: raw.store ? String(raw.store) : 'multi',

    ratingCurrent: toNumberOrNull(raw.ratingCurrent),
    ratingPrevious: toNumberOrNull(raw.ratingPrevious),
    ratingDiff: toNumberOrNull(raw.ratingDiff),

    votesCurrent: toNumberOrNull(raw.votesCurrent),
    votesPrevious: toNumberOrNull(raw.votesPrevious),
    votesDiff: toNumberOrNull(raw.votesDiff),

    histogram: (raw.histogram && typeof raw.histogram === 'object') ? raw.histogram : null,
    insights: Array.isArray(raw.insights) ? raw.insights : [],
  };

  // rating/votes 둘 다 없으면 무효
  const hasAny =
    snapshot.ratingCurrent !== null ||
    snapshot.votesCurrent !== null ||
    snapshot.ratingPrevious !== null ||
    snapshot.votesPrevious !== null;

  if (!hasAny) return null;

  return snapshot;
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

function escapeHtml(s) {
  // 최소한의 XSS 방어(인사이트는 SSOT이지만 안전하게)
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildInsightsBlock(data) {
  const insights = Array.isArray(data.insights) ? data.insights : [];

  const cleaned = insights
    .map(t => (t ? String(t).trim() : ''))
    .filter(Boolean)
    .slice(0, 12);

  if (!cleaned.length) {
    return [
      '  <section id="review-insights-block" class="review-block">',
      '    <!-- no insights -->',
      '  </section>',
    ].join('\n');
  }

  const items = cleaned
    .map(t => `      <li>${escapeHtml(t)}</li>`)
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

function insertReviewBlocks(html, combinedHtml) {
  // 1) SLOT:REVIEW
  if (html.includes('<!--SLOT:REVIEW-->')) {
    return { html: html.replace('<!--SLOT:REVIEW-->', combinedHtml), inserted: true, where: 'SLOT:REVIEW' };
  }

  // 2) FAQ 앞 (SLOT:FAQ or id="faq")
  if (html.includes('<!--SLOT:FAQ-->')) {
    return { html: html.replace('<!--SLOT:FAQ-->', `${combinedHtml}\n<!--SLOT:FAQ-->`), inserted: true, where: 'BEFORE_SLOT:FAQ' };
  }

  const faqSection = /<section\s+id="faq"[\s\S]*?>/i;
  if (faqSection.test(html)) {
    return { html: html.replace(faqSection, `${combinedHtml}\n$&`), inserted: true, where: 'BEFORE_FAQ' };
  }

  // 3) </main> 직전
  const mainClose = /<\/main>/i;
  if (mainClose.test(html)) {
    return { html: html.replace(mainClose, `${combinedHtml}\n$&`), inserted: true, where: 'BEFORE_</main>' };
  }

  // fallback: 맨 끝
  return { html: `${html}\n${combinedHtml}\n`, inserted: true, where: 'APPEND' };
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
  let insertedCount = 0;
  let replacedCount = 0;
  let invalidData = 0;

  for (const file of files) {
    const slug = path.basename(file, '.html');
    const raw = bySlug[slug];
    const ratingData = normalizeRatingData(raw);
    const fullPath = path.join(DIST_DIR, file);

    if (!raw) {
      ratingMissing += 1;
      continue;
    }
    if (!ratingData) {
      invalidData += 1;
      continue;
    }

    let html = fs.readFileSync(fullPath, 'utf8');

    const ratingBlockHtml = buildRatingBlock(ratingData);
    const insightsBlockHtml = buildInsightsBlock(ratingData);
    const combined = `${ratingBlockHtml}\n${insightsBlockHtml}`;

    let changed = false;

    // 1) 기존 섹션 있으면 교체
    const r1 = replaceSection(html, 'review-rating-block', ratingBlockHtml);
    html = r1.html;
    if (r1.changed) { changed = true; replacedCount += 1; }

    const r2 = replaceSection(html, 'review-insights-block', insightsBlockHtml);
    html = r2.html;
    if (r2.changed) { changed = true; replacedCount += 1; }

    // 2) 둘 다 없어서 교체가 하나도 안 됐다면 삽입
    if (!r1.changed && !r2.changed) {
      const ins = insertReviewBlocks(html, combined);
      html = ins.html;
      changed = true;
      insertedCount += 1;
    }

    if (changed) {
      fs.writeFileSync(fullPath, html, 'utf8');
      updatedCount += 1;
    }
  }

  log('────────────────────────────────────────────');
  log(`[review-meta] 처리 완료: 업데이트=${updatedCount}, rating없음=${ratingMissing}, 삽입=${insertedCount}, 교체=${replacedCount}, SSOT데이터무효=${invalidData}`);
  log('────────────────────────────────────────────');
}

main();
