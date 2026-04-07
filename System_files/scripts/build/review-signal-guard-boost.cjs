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
 * - source는 원본 구조의 단일 필드(string)만 사용
 * - sources 같은 신규 구조를 만들지 않는다
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
  if (!post || typeof post !== 'object') return '';

  const queueDate = normalizeDateString(post.seedMeta && post.seedMeta.queueDate);
  if (queueDate) return queueDate;

  const updated = normalizeDateString(post.updated);
  if (updated) return updated;

  return '';
}

function inferBucketFromSlug(slug) {
  const s = normStr(slug).toLowerCase();
  if (s.startsWith('app-')) return 'app';
  if (s.startsWith('device-')) return 'device';
  if (s.startsWith('subscription-')) return 'subscription';
  return '';
}

function detectProvider(item, post) {
  const fromPost = normStr(post && post.reviewTarget && post.reviewTarget.provider).toLowerCase();
  if (fromPost) return fromPost;

  const fromStore = normStr(item && item.store).toLowerCase();
  if (fromStore && fromStore !== 'unknown') return fromStore;

  const fromSource = normStr(item && item.source).toLowerCase();
  if (fromSource && fromSource !== 'manual' && fromSource !== 'unknown' && fromSource !== 'seed') return fromSource;

  return '';
}

function normalizeSourceField(item, post) {
  const current = normStr(item && item.source).toLowerCase();
  if (current === 'official' || current === 'manual') return current;

  const provider = detectProvider(item, post);
  if (provider) return 'official';

  return 'manual';
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

function buildDataDrivenInsights(item) {
  const insights = [];

  const ratingCurrent = normalizeNonNegativeNumber(item.ratingCurrent);
  const ratingPrevious = normalizeNonNegativeNumber(item.ratingPrevious);
  const votesCurrent = normalizeNonNegativeNumber(item.votesCurrent);
  const ratingDiff = normalizeNonNegativeNumber(item.ratingDiff);
  const votesDiff = normalizeNonNegativeNumber(item.votesDiff);
  const status = normStr(item.status).toLowerCase();
  const store = normStr(item.store);
  const source = normStr(item.source).toLowerCase();

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

  if (source === 'official') {
    insights.push('The review source is classified as official rather than placeholder-only metadata.');
  }

  if (status === 'ok') {
    insights.push('The review record is currently in a valid state for structured snapshot injection.');
  }

  return uniqueStrings(insights);
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

function estimateHistogramFromRating(ratingCurrent, votesCurrent) {
  const rating = normalizeNonNegativeNumber(ratingCurrent);
  const votes = Math.max(5, Math.round(normalizeNonNegativeNumber(votesCurrent)));

  if (rating <= 0 || votes <= 0) {
    return { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  }

  let w5 = Math.max(0.05, Math.min(0.80, (rating - 3.0) / 2.0));
  let w4 = Math.max(0.10, Math.min(0.55, 0.35 + (rating - 3.5) * 0.18));
  let w3 = Math.max(0.05, Math.min(0.30, 0.22 - (rating - 3.5) * 0.08));
  let w2 = Math.max(0.02, Math.min(0.18, 0.08 - (rating - 3.5) * 0.04));
  let w1 = Math.max(0.01, Math.min(0.12, 0.05 - (rating - 3.5) * 0.03));

  const sum = w1 + w2 + w3 + w4 + w5;
  w1 /= sum;
  w2 /= sum;
  w3 /= sum;
  w4 /= sum;
  w5 /= sum;

  let c1 = Math.round(votes * w1);
  let c2 = Math.round(votes * w2);
  let c3 = Math.round(votes * w3);
  let c4 = Math.round(votes * w4);
  let c5 = Math.round(votes * w5);

  let total = c1 + c2 + c3 + c4 + c5;
  while (total < votes) {
    c5 += 1;
    total += 1;
  }
  while (total > votes) {
    if (c5 > 0) c5 -= 1;
    else if (c4 > 0) c4 -= 1;
    else if (c3 > 0) c3 -= 1;
    else if (c2 > 0) c2 -= 1;
    else if (c1 > 0) c1 -= 1;
    total -= 1;
  }

  return {
    '1': c1,
    '2': c2,
    '3': c3,
    '4': c4,
    '5': c5,
  };
}

function inferLastChecked(item, post) {
  const existing = normalizeDateString(item.lastChecked);
  if (existing) return existing;

  const metaDate = normalizeDateString(item.histogramMeta && item.histogramMeta.generatedAt);
  if (metaDate) return metaDate;

  const postDate = inferPostDate(post);
  if (postDate) return postDate;

  return '';
}

function round1(v) {
  return Math.round(Number(v || 0) * 10) / 10;
}

function needsFix(item, post) {
  const normalizedLastChecked = inferLastChecked(item, post);
  const normalizedInsights = uniqueStrings(item.insights);
  const bucket = normStr(item.bucket || inferBucketFromSlug(normStr(post && post.slug) || ''));
  const status = normStr(item.status).toLowerCase();
  const normalizedSource = normalizeSourceField(item, post);

  const histogram = ensureHistogram(item);
  const histSum = Object.values(histogram).reduce((a, b) => a + b, 0);

  const ratingCurrent = normalizeNonNegativeNumber(item.ratingCurrent);
  const ratingPrevious = normalizeNonNegativeNumber(item.ratingPrevious);
  const votesCurrent = normalizeNonNegativeNumber(item.votesCurrent);
  const votesPrevious = normalizeNonNegativeNumber(item.votesPrevious);

  const recomputedRatingDiff = round1(ratingCurrent - ratingPrevious);
  const currentRatingDiff = round1(normalizeNonNegativeNumber(item.ratingDiff));

  const recomputedVotesDiff = Math.max(0, votesCurrent - votesPrevious);
  const currentVotesDiff = normalizeNonNegativeNumber(item.votesDiff);

  if (!normalizedLastChecked) return true;
  if (!bucket) return true;
  if (!status || status === 'unknown' || status === 'queued') return true;
  if (!normalizedSource) return true;
  if (normalizedInsights.length < 3) return true;
  if (!item.histogramMeta || typeof item.histogramMeta !== 'object') return true;
  if (histSum === 0 && ratingCurrent > 0 && votesCurrent > 0) return true;
  if (recomputedRatingDiff !== currentRatingDiff) return true;
  if (recomputedVotesDiff !== currentVotesDiff) return true;

  return false;
}

function guard(item, post) {
  const out = { ...item };

  const inferredLastChecked = inferLastChecked(out, post);
  out.lastChecked = inferredLastChecked || todayKSTDate();

  const existingStatus = normStr(out.status).toLowerCase();
  if (!existingStatus || existingStatus === 'unknown' || existingStatus === 'queued') {
    out.status = normalizeSourceField(out, post) === 'official' ? 'ok' : 'manual';
  }

  if (!normStr(out.bucket)) {
    const bucket = inferBucketFromSlug(normStr(post && post.slug) || '');
    if (bucket) out.bucket = bucket;
  }

  const detectedProvider = detectProvider(out, post);
  if ((!normStr(out.store) || normStr(out.store).toLowerCase() === 'unknown') && detectedProvider) {
    out.store = detectedProvider;
  }

  out.source = normalizeSourceField(out, post);

  const postStoreId = normStr(post && post.reviewTarget && post.reviewTarget.storeId);
  if (!normStr(out.storeId) && postStoreId) {
    out.storeId = postStoreId;
  }

  out.ratingCurrent = normalizeNonNegativeNumber(out.ratingCurrent);
  out.ratingPrevious = normalizeNonNegativeNumber(out.ratingPrevious);
  out.votesCurrent = normalizeNonNegativeNumber(out.votesCurrent);
  out.votesPrevious = normalizeNonNegativeNumber(out.votesPrevious);

  out.ratingDiff = round1(out.ratingCurrent - out.ratingPrevious);
  out.votesDiff = out.votesCurrent - out.votesPrevious;

  if (out.ratingDiff < 0) out.ratingDiff = 0;
  if (out.votesDiff < 0) out.votesDiff = 0;

  out.histogram = ensureHistogram(out);
  const histSum = Object.values(out.histogram).reduce((a, b) => a + b, 0);
  if (histSum === 0 && out.ratingCurrent > 0 && out.votesCurrent > 0) {
    out.histogram = estimateHistogramFromRating(out.ratingCurrent, out.votesCurrent);
  }

  if (!out.histogramMeta || typeof out.histogramMeta !== 'object') {
    out.histogramMeta = {
      source: 'estimated',
      generatedAt: out.lastChecked || todayKSTDate(),
      reason: 'guard-normalize',
      method: 'signal-guard-boost-v4',
    };
  } else {
    if (!normStr(out.histogramMeta.source)) out.histogramMeta.source = 'estimated';
    if (!normalizeDateString(out.histogramMeta.generatedAt)) {
      out.histogramMeta.generatedAt = out.lastChecked || todayKSTDate();
    }
    if (!normStr(out.histogramMeta.reason)) out.histogramMeta.reason = 'guard-normalize';
    if (!normStr(out.histogramMeta.method)) out.histogramMeta.method = 'signal-guard-boost-v4';
  }

  return out;
}

function boost(item, post) {
  const out = { ...item };

  const existing = uniqueStrings(out.insights);
  const generated = buildDataDrivenInsights(out);

  const provider = detectProvider(out, post);
  if (provider && normStr(out.source).toLowerCase() === 'official') {
    generated.push(`Source coverage includes ${providerLabel(provider)} metadata for structured trust signaling.`);
  }

  const merged = uniqueStrings([...existing, ...generated]);
  out.insights = merged.slice(0, 12);

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

  const today = new Date(`${todayKSTDate()}T00:00:00+09:00`);
  const candidates = [];

  for (const slug of Object.keys(bySlug)) {
    const post = postMap.get(slug);
    if (!post) continue;

    const postDate = inferPostDate(post);
    const postDateObj = postDate ? parseDateSafe(`${postDate}T00:00:00+09:00`) : null;
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
    next = boost(next, row.post);

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
