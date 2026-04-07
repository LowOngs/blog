#!/usr/bin/env node
'use strict';

require('./lib/env.cjs');

/**
 * ============================================================
 * File: System_files/scripts/build/review-signal-guard-boost.cjs
 * Role: Review SSOT 보정 계층 (Penalty 제거 + Signal 강화)
 * ============================================================
 *
 * 목적
 * - 본문(body) 및 구조는 절대 수정하지 않는다.
 * - review signal layer만 보정한다.
 * - 15일 이상 지난 글 중 기준 미달 항목만 선별 보정한다.
 * - 한 번에 너무 많은 물량이 몰리지 않도록 최대 처리 개수를 제한한다.
 *
 * 기본 정책
 * - MIN_POST_AGE_DAYS: 기본 15
 * - MAX_ITEMS_PER_RUN: 기본 30
 * - TARGET_MODE: baseline | next | both (기본 baseline)
 *
 * 대상 파일
 * - baseline:
 *   review-ratings.json
 *   app-ratings.json
 *   device-ratings.json
 *   subscription-ratings.json
 *
 * - next:
 *   review-ratings-next.json
 *   app-ratings-next.json
 *   device-ratings-next.json
 *   subscription-ratings-next.json
 *
 * 주의
 * - slug/postId/reviewId/pageId/body/seedMeta/reviewEntity/labels는 수정 금지
 * - source는 실제 post.reviewTarget / 기존 source 기반으로만 보강
 * - 가짜 URL / example.com 등 금지
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const REVIEWS_DIR = path.join(ROOT, 'content', 'reviews');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const LOGS_DIR = path.join(ROOT, 'logs');
const REPORT_FILE = path.join(LOGS_DIR, 'review-signal-guard-boost-report.json');

const TARGET_MODE = String(process.env.SIGNAL_GUARD_TARGET_MODE || 'baseline').trim().toLowerCase();
const MIN_POST_AGE_DAYS = toPositiveInt(process.env.MIN_POST_AGE_DAYS, 15);
const MAX_ITEMS_PER_RUN = toPositiveInt(process.env.MAX_ITEMS_PER_RUN, 30);

const BASELINE_FILES = [
  'review-ratings.json',
  'app-ratings.json',
  'device-ratings.json',
  'subscription-ratings.json',
];

const NEXT_FILES = [
  'review-ratings-next.json',
  'app-ratings-next.json',
  'device-ratings-next.json',
  'subscription-ratings-next.json',
];

function toPositiveInt(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function readJSON(p, fallback = null) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`[guard-boost][WARN] JSON parse failed: ${p} :: ${e.message || e}`);
    return fallback;
  }
}

function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function todayKSTDate() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function normStr(v) {
  return String(v == null ? '' : v).trim();
}

function ensureArray(v) {
  return Array.isArray(v) ? v : [];
}

function normalizeNonNegativeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function uniqueStrings(list) {
  const out = [];
  const seen = new Set();

  for (const raw of ensureArray(list)) {
    const s = normStr(raw);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }

  return out;
}

function uniqueSources(list) {
  const out = [];
  const seen = new Set();

  for (const src of ensureArray(list)) {
    if (!src || typeof src !== 'object') continue;

    const url = normStr(src.url);
    const label = normStr(src.label);
    const provider = normStr(src.provider).toLowerCase();
    const type = normStr(src.type).toLowerCase();
    const key = [url.toLowerCase(), label.toLowerCase(), provider, type].join('|');

    if (!url && !label) continue;
    if (seen.has(key)) continue;
    seen.add(key);

    const item = {};
    if (type) item.type = type;
    if (provider) item.provider = provider;
    if (label) item.label = label;
    if (url) item.url = url;

    const lastChecked = normalizeDateString(src.lastChecked);
    if (lastChecked) item.lastChecked = lastChecked;

    out.push(item);
  }

  return out;
}

function normalizeDateString(v) {
  const s = normStr(v);
  if (!s) return '';

  const ymd = s.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;

  return '';
}

function parseDateSafe(v) {
  const s = normStr(v);
  if (!s) return null;

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function daysBetween(a, b) {
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function providerLabel(provider) {
  const p = normStr(provider).toLowerCase();

  if (p === 'googleplay') return 'Google Play (official)';
  if (p === 'trustpilot') return 'Trustpilot (official)';
  if (p === 'amazon') return 'Amazon (official)';
  if (p === 'manual') return 'Manual reference';

  return p ? `${p} (reference)` : 'Reference';
}

function loadPostMap() {
  const out = new Map();

  if (!fs.existsSync(POSTS_DIR)) return out;

  const files = fs.readdirSync(POSTS_DIR)
    .filter(name => name.toLowerCase().endsWith('.json'))
    .sort();

  for (const name of files) {
    const full = path.join(POSTS_DIR, name);
    const j = readJSON(full, null);
    if (!j || typeof j !== 'object') continue;

    const slug = normStr(j.slug || path.basename(name, '.json'));
    if (!slug) continue;

    out.set(slug, j);
  }

  return out;
}

function pickTargetFiles() {
  if (TARGET_MODE === 'next') return NEXT_FILES;
  if (TARGET_MODE === 'both') return [...BASELINE_FILES, ...NEXT_FILES];
  return BASELINE_FILES;
}

function inferPostDate(post) {
  if (!post || typeof post !== 'object') return null;

  const queueDate = normalizeDateString(post.seedMeta && post.seedMeta.queueDate);
  if (queueDate) return queueDate;

  const updated = normalizeDateString(post.updated);
  if (updated) return updated;

  return '';
}

function inferLastChecked(item, post) {
  const existing = normalizeDateString(item.lastChecked);
  if (existing) return existing;

  for (const src of ensureArray(item.sources)) {
    const d = normalizeDateString(src && src.lastChecked);
    if (d) return d;
  }

  const metaDate = normalizeDateString(item.histogramMeta && item.histogramMeta.generatedAt);
  if (metaDate) return metaDate;

  const postDate = inferPostDate(post);
  if (postDate) return postDate;

  return '';
}

function inferBucketFromSlug(slug) {
  const s = normStr(slug).toLowerCase();
  if (s.startsWith('app-')) return 'app';
  if (s.startsWith('device-')) return 'device';
  if (s.startsWith('subscription-')) return 'subscription';
  return '';
}

function inferSourceFromPost(post) {
  if (!post || typeof post !== 'object') return null;

  const rt = post.reviewTarget && typeof post.reviewTarget === 'object'
    ? post.reviewTarget
    : null;

  if (!rt) return null;

  const provider = normStr(rt.provider).toLowerCase();
  const url = normStr(rt.url);
  const storeId = normStr(rt.storeId);

  if (!provider && !url && !storeId) return null;

  const item = {};
  item.type = provider ? 'official' : 'manual';
  if (provider) item.provider = provider;
  item.label = providerLabel(provider || 'manual');
  if (url) item.url = url;

  return item;
}

function sanitizeSources(item, post) {
  const base = uniqueSources(item.sources);
  const inferred = inferSourceFromPost(post);

  let out = base.slice();

  if (inferred) {
    out = uniqueSources([...out, inferred]);
  }

  // source.lastChecked는 item.lastChecked와 정합성 있게 채울 수 있을 때만 채운다
  const itemLastChecked = normalizeDateString(item.lastChecked);
  out = out.map(src => {
    const next = { ...src };
    if (!next.label) {
      next.label = providerLabel(next.provider || 'manual');
    }
    if (!next.lastChecked && itemLastChecked) {
      next.lastChecked = itemLastChecked;
    }
    return next;
  });

  return uniqueSources(out);
}

function buildDataDrivenInsights(item) {
  const insights = [];

  const ratingCurrent = normalizeNonNegativeNumber(item.ratingCurrent);
  const ratingPrevious = normalizeNonNegativeNumber(item.ratingPrevious);
  const votesCurrent = normalizeNonNegativeNumber(item.votesCurrent);
  const ratingDiff = normalizeNonNegativeNumber(item.ratingDiff);
  const votesDiff = normalizeNonNegativeNumber(item.votesDiff);
  const status = normStr(item.status).toLowerCase();
  const store = normStr(item.store);

  if (ratingCurrent > 0) {
    insights.push(`Current average rating is ${formatRating(ratingCurrent)} out of 5.`);
  }

  if (votesCurrent > 0) {
    insights.push(`The current review count is ${formatInt(votesCurrent)}.`);
  }

  if (votesCurrent > 0 && ratingCurrent > 0) {
    insights.push('The rating signal is grounded in measurable user feedback rather than a zero-volume placeholder.');
  }

  if (ratingDiff > 0) {
    insights.push(`The rating trend is improving compared with the previous checkpoint (${formatRating(ratingDiff)} increase).`);
  } else if (ratingCurrent > 0 && ratingPrevious > 0) {
    insights.push('The rating trend is stable versus the previous checkpoint.');
  }

  if (votesDiff > 0) {
    insights.push(`Review volume increased by ${formatInt(votesDiff)} since the previous checkpoint.`);
  }

  const histogram = item.histogram && typeof item.histogram === 'object' ? item.histogram : null;
  if (histogram) {
    const totalShare = [1, 2, 3, 4, 5].reduce((acc, n) => acc + normalizeNonNegativeNumber(histogram[String(n)]), 0);
    if (totalShare > 0) {
      const high = normalizeNonNegativeNumber(histogram['4']) + normalizeNonNegativeNumber(histogram['5']);
      const low = normalizeNonNegativeNumber(histogram['1']) + normalizeNonNegativeNumber(histogram['2']);

      if (high > low) {
        insights.push('Higher-star feedback outweighs lower-star feedback in the current rating distribution.');
      } else if (low > high) {
        insights.push('Lower-star feedback is still material enough to justify caution before recommending this widely.');
      }
    }
  }

  if (store) {
    insights.push(`Primary review source is ${store}.`);
  }

  if (status === 'ok') {
    insights.push('The review record is currently in a valid state for structured snapshot injection.');
  }

  return uniqueStrings(insights);
}

function formatRating(v) {
  const n = normalizeNonNegativeNumber(v);
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

function formatInt(v) {
  const n = normalizeNonNegativeNumber(v);
  return n.toLocaleString('en-US');
}

function ensureHistogram(item) {
  const raw = item.histogram && typeof item.histogram === 'object' ? item.histogram : {};
  return {
    '1': normalizeNonNegativeNumber(raw['1']),
    '2': normalizeNonNegativeNumber(raw['2']),
    '3': normalizeNonNegativeNumber(raw['3']),
    '4': normalizeNonNegativeNumber(raw['4']),
    '5': normalizeNonNegativeNumber(raw['5']),
  };
}

function needsFix(item, post) {
  const lastChecked = inferLastChecked(item, post);
  const sources = sanitizeSources({ ...item, lastChecked }, post);
  const currentInsights = uniqueStrings(item.insights);
  const bucket = normStr(item.bucket || inferBucketFromSlug(normStr(post && post.slug) || ''));
  const status = normStr(item.status).toLowerCase();

  const histogram = ensureHistogram(item);
  const histSum = Object.values(histogram).reduce((a, b) => a + b, 0);

  if (!lastChecked) return true;
  if (!bucket) return true;
  if (!status || status === 'unknown' || status === 'queued') return true;
  if (sources.length < 2) return true;
  if (currentInsights.length < 4) return true;
  if (!item.histogramMeta || typeof item.histogramMeta !== 'object') return true;
  if (histSum === 0 && normalizeNonNegativeNumber(item.ratingCurrent) > 0) return true;

  const recomputedRatingDiff = round1(normalizeNonNegativeNumber(item.ratingCurrent) - normalizeNonNegativeNumber(item.ratingPrevious));
  const currentRatingDiff = round1(normalizeNonNegativeNumber(item.ratingDiff));
  if (recomputedRatingDiff !== currentRatingDiff) return true;

  const recomputedVotesDiff = normalizeNonNegativeNumber(item.votesCurrent) - normalizeNonNegativeNumber(item.votesPrevious);
  const currentVotesDiff = normalizeNonNegativeNumber(item.votesDiff);
  if (recomputedVotesDiff !== currentVotesDiff) return true;

  return false;
}

function round1(v) {
  return Math.round(Number(v || 0) * 10) / 10;
}

function guard(item, post) {
  const out = { ...item };

  // lastChecked는 근거 있는 값만 사용
  const inferredLastChecked = inferLastChecked(out, post);
  if (inferredLastChecked) {
    out.lastChecked = inferredLastChecked;
  }

  // status 정규화
  const existingStatus = normStr(out.status).toLowerCase();
  if (!existingStatus || existingStatus === 'unknown' || existingStatus === 'queued') {
    const hasSources = ensureArray(out.sources).length > 0 || !!inferSourceFromPost(post);
    out.status = hasSources ? 'ok' : 'manual';
  }

  // sources 정리
  out.sources = sanitizeSources(out, post);

  // bucket 정리
  if (!normStr(out.bucket)) {
    const bucket = inferBucketFromSlug(normStr(post && post.slug) || '');
    if (bucket) out.bucket = bucket;
  }

  // 수치 정규화
  out.ratingCurrent = normalizeNonNegativeNumber(out.ratingCurrent);
  out.ratingPrevious = normalizeNonNegativeNumber(out.ratingPrevious);
  out.votesCurrent = normalizeNonNegativeNumber(out.votesCurrent);
  out.votesPrevious = normalizeNonNegativeNumber(out.votesPrevious);

  out.ratingDiff = round1(out.ratingCurrent - out.ratingPrevious);
  out.votesDiff = out.votesCurrent - out.votesPrevious;

  if (out.ratingDiff < 0) out.ratingDiff = 0;
  if (out.votesDiff < 0) out.votesDiff = 0;

  out.histogram = ensureHistogram(out);

  // histogramMeta 최소 구조
  if (!out.histogramMeta || typeof out.histogramMeta !== 'object') {
    out.histogramMeta = {
      source: 'estimated',
      generatedAt: out.lastChecked || todayKSTDate(),
      reason: 'guard-normalize',
      method: 'signal-guard-boost-v2',
    };
  } else {
    if (!normStr(out.histogramMeta.source)) out.histogramMeta.source = 'estimated';
    if (!normalizeDateString(out.histogramMeta.generatedAt)) {
      out.histogramMeta.generatedAt = out.lastChecked || todayKSTDate();
    }
    if (!normStr(out.histogramMeta.reason)) out.histogramMeta.reason = 'guard-normalize';
    if (!normStr(out.histogramMeta.method)) out.histogramMeta.method = 'signal-guard-boost-v2';
  }

  return out;
}

function boost(item) {
  const out = { ...item };

  // grounded insights only
  const existing = uniqueStrings(out.insights);
  const generated = buildDataDrivenInsights(out);

  const merged = uniqueStrings([...existing, ...generated]);
  out.insights = merged.slice(0, 12);

  // sources는 최대 3개까지만
  out.sources = uniqueSources(out.sources).slice(0, 3);

  return out;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function collectCandidates(filePath, postMap) {
  const json = readJSON(filePath, { bySlug: {} });
  const bySlug = json && typeof json === 'object' && json.bySlug && typeof json.bySlug === 'object'
    ? json.bySlug
    : {};

  const today = new Date(todayKSTDate() + 'T00:00:00+09:00');
  const candidates = [];

  for (const slug of Object.keys(bySlug)) {
    const post = postMap.get(slug);
    if (!post) continue;

    const postDate = inferPostDate(post);
    const postDateObj = postDate ? parseDateSafe(postDate + 'T00:00:00+09:00') : null;
    if (!postDateObj) continue;

    const ageDays = daysBetween(postDateObj, today);
    if (ageDays < MIN_POST_AGE_DAYS) continue;

    const item = bySlug[slug];
    if (!item || typeof item !== 'object') continue;

    if (!needsFix(item, post)) continue;

    candidates.push({
      filePath,
      fileName: path.basename(filePath),
      slug,
      ageDays,
      post,
      item,
    });
  }

  return candidates;
}

function processAll() {
  ensureDir(LOGS_DIR);

  const targetFiles = pickTargetFiles()
    .map(name => path.join(REVIEWS_DIR, name))
    .filter(full => fs.existsSync(full));

  const postMap = loadPostMap();

  const allCandidates = [];
  for (const filePath of targetFiles) {
    allCandidates.push(...collectCandidates(filePath, postMap));
  }

  allCandidates.sort((a, b) => {
    if (b.ageDays !== a.ageDays) return b.ageDays - a.ageDays;
    if (a.fileName !== b.fileName) return a.fileName.localeCompare(b.fileName);
    return a.slug.localeCompare(b.slug);
  });

  const picked = allCandidates.slice(0, MAX_ITEMS_PER_RUN);

  const docs = new Map();
  for (const filePath of targetFiles) {
    docs.set(filePath, readJSON(filePath, { bySlug: {} }));
  }

  const processedItems = [];
  let changedFiles = 0;
  let changedItems = 0;

  for (const row of picked) {
    const doc = docs.get(row.filePath);
    if (!doc || !doc.bySlug || typeof doc.bySlug !== 'object') continue;

    const original = doc.bySlug[row.slug];
    if (!original || typeof original !== 'object') continue;

    let next = guard(original, row.post);
    next = boost(next);

    if (!deepEqual(original, next)) {
      doc.bySlug[row.slug] = next;
      changedItems += 1;
      processedItems.push({
        file: row.fileName,
        slug: row.slug,
        ageDays: row.ageDays,
        changed: true,
      });
    } else {
      processedItems.push({
        file: row.fileName,
        slug: row.slug,
        ageDays: row.ageDays,
        changed: false,
      });
    }
  }

  for (const [filePath, doc] of docs.entries()) {
    const originalDoc = readJSON(filePath, { bySlug: {} });
    if (!deepEqual(originalDoc, doc)) {
      doc.updatedAt = nowIso();
      writeJSON(filePath, doc);
      changedFiles += 1;
      console.log(`[guard-boost] ${path.basename(filePath)} → updated`);
    } else {
      console.log(`[guard-boost] ${path.basename(filePath)} → no-change`);
    }
  }

  const report = {
    generatedAt: nowIso(),
    targetMode: TARGET_MODE,
    minPostAgeDays: MIN_POST_AGE_DAYS,
    maxItemsPerRun: MAX_ITEMS_PER_RUN,
    scannedFiles: targetFiles.map(p => path.basename(p)),
    totalCandidates: allCandidates.length,
    pickedCandidates: picked.length,
    changedFiles,
    changedItems,
    items: processedItems,
  };

  writeJSON(REPORT_FILE, report);

  console.log('────────────────────────────────────────────');
  console.log('[guard-boost] 결과');
  console.log('  targetMode      =', TARGET_MODE);
  console.log('  minPostAgeDays  =', MIN_POST_AGE_DAYS);
  console.log('  maxItemsPerRun  =', MAX_ITEMS_PER_RUN);
  console.log('  totalCandidates =', allCandidates.length);
  console.log('  picked          =', picked.length);
  console.log('  changedFiles    =', changedFiles);
  console.log('  changedItems    =', changedItems);
  console.log('[guard-boost] report =', REPORT_FILE);
  console.log('────────────────────────────────────────────');
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[guard-boost] 시작');
  console.log('[guard-boost] ROOT =', ROOT);
  console.log('[guard-boost] REVIEWS_DIR =', REVIEWS_DIR);
  console.log('[guard-boost] POSTS_DIR =', POSTS_DIR);
  console.log('[guard-boost] TARGET_MODE =', TARGET_MODE);
  console.log('[guard-boost] MIN_POST_AGE_DAYS =', MIN_POST_AGE_DAYS);
  console.log('[guard-boost] MAX_ITEMS_PER_RUN =', MAX_ITEMS_PER_RUN);
  console.log('────────────────────────────────────────────');

  processAll();

  console.log('[guard-boost] 완료');
}

if (require.main === module) {
  main();
}
