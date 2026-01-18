#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/review-fetch-official.cjs
 * 역할: (A안) 공식 API/공식 데이터 소스 기반으로 rating/votes/histogram을 수집해
 *       content/reviews/*-ratings-next.json + review-sources.json에 업서트한다.
 */

require('./lib/env.cjs'); // ✅ 공통 규칙: env 로더 최우선(반드시 첫줄급)

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// What: 경로/게이트(안전 스위치)
// Why: DRY_RUN에서 외부 호출/WRITE 금지(사고 방지)
// I/O: R(process.env), W(없음)
// Invariants: DRY_RUN이면 네트워크 호출/파일 WRITE 0%
// ─────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const REVIEWS_DIR = path.join(ROOT, 'content', 'reviews');

function parseLive() {
  const v = String(process.env.DRY_RUN ?? 'true').trim().toLowerCase();
  return (v === 'false' || v === '0');
}
const IS_LIVE = parseLive();

const MAX_CALLS_PER_RUN = Number(process.env.REVIEW_FETCH_MAX_CALLS ?? 25);
const ONLY_REVIEW_SLUGS = String(process.env.REVIEW_FETCH_ONLY_REVIEW_SLUGS ?? 'true').toLowerCase() !== 'false';
const PROVIDERS_ALLOW = String(process.env.REVIEW_FETCH_PROVIDERS ?? 'googleplay,amazon,trustpilot')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function log(...a) { console.log('[review-fetch]', ...a); }
function warn(...a) { console.warn('[review-fetch][WARN]', ...a); }
function fatal(...a) { console.error('[review-fetch][FATAL]', ...a); process.exit(1); }

// ─────────────────────────────────────────────
// What: 유틸(날짜/JSON I/O)
// Why: SSOT 스키마/멱등/오염 방지
// I/O: R/W(content/reviews/*.json, content/posts/*.json)
// Invariants: 파싱 실패는 fallback(전체 중단 최소화), WRITE는 LIVE에서만
// ─────────────────────────────────────────────
function nowYmdKst() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    warn(`read/parse failed: ${path.basename(file)} -> ${e.message || e}`);
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function ensureMaps(obj) {
  const base = { updatedAt: nowYmdKst(), bySlug: {} };
  if (!obj || typeof obj !== 'object') return base;
  if (!obj.bySlug || typeof obj.bySlug !== 'object') obj.bySlug = {};
  if (!obj.updatedAt) obj.updatedAt = nowYmdKst();
  return obj;
}

// ─────────────────────────────────────────────
// What: 리뷰 대상 판정/버킷 분류
// Why: 3버킷(app/device/subscription)만 공식 fetch 대상으로 제한
// I/O: R(slug), W(없음)
// Invariants: 리뷰 외 라벨은 절대 외부 호출 금지
// ─────────────────────────────────────────────
function isReviewSlug(slug) {
  return typeof slug === 'string' && (
    slug.startsWith('app-') || slug.startsWith('device-') || slug.startsWith('subscription-')
  );
}

function bucketOf(slug) {
  if (slug.startsWith('app-')) return 'app';
  if (slug.startsWith('device-')) return 'device';
  return 'subscription';
}

// ─────────────────────────────────────────────
// What: 히스토그램/차이값 정규화
// Why: 렌더러/SSOT가 기대하는 키/숫자 안정성 보장
// I/O: R(fetched.histogram), W(entry.histogram)
// Invariants: '1'..'5' 키 항상 존재, NaN 금지
// ─────────────────────────────────────────────
function normalizeHistogram(h) {
  const out = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  if (!h || typeof h !== 'object') return out;
  for (const k of ['1', '2', '3', '4', '5']) {
    const v = Number(h[k] ?? 0);
    out[k] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

function computeDiff(current, previous, decimals = 1) {
  const c = Number(current);
  const p = Number(previous);
  if (!Number.isFinite(c) || !Number.isFinite(p)) return 0;
  const diff = c - p;
  const m = Math.pow(10, decimals);
  return Math.round(diff * m) / m;
}

// ─────────────────────────────────────────────
// What: posts JSON에서 review fetch 키 추출(과도기 호환)
// Why: 필드 확정 전에도 동작(후방호환), storeId 없으면 호출 금지
// I/O: R(content/posts/*.json), W(없음)
// Invariants: provider+storeId 없으면 fetch 스킵
// ─────────────────────────────────────────────
function pickReviewKey(doc) {
  const slug = String(doc.slug || '').trim();
  const reviewId = doc.reviewId || doc.seedMeta?.reviewId || null;

  const rt = doc.reviewTarget || doc.seedMeta?.reviewTarget || null;

  const provider =
    (rt && (rt.provider || rt.kind)) ||
    doc.provider ||
    doc.reviewProvider ||
    doc.seedMeta?.provider ||
    null;

  const storeId =
    (rt && (rt.storeId || rt.id)) ||
    doc.storeId ||
    doc.reviewStoreId ||
    doc.seedMeta?.storeId ||
    null;

  const url =
    (rt && rt.url) ||
    doc.reviewUrl ||
    null;

  return {
    slug,
    reviewId: reviewId ? String(reviewId) : null,
    provider: provider ? String(provider).toLowerCase() : null,
    storeId: storeId ? String(storeId) : null,
    url: url ? String(url) : null,
  };
}

function listPostDocs() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    const p = path.join(POSTS_DIR, f);
    const j = safeReadJson(p, null);
    if (!j || typeof j !== 'object') continue;
    const slug = j.slug || f.replace(/\.json$/, '');
    j.slug = slug;
    out.push(j);
  }
  return out;
}

// ─────────────────────────────────────────────
// What: 공식 출처 URL 생성(가능한 범위)
// Why: review-sources.json에 “공식 링크” 최소 1개 기록
// I/O: R(provider/storeId), W(없음)
// Invariants: storeId 없으면 null
// ─────────────────────────────────────────────
function buildProviderUrl(provider, storeId) {
  if (!storeId) return null;

  if (provider === 'googleplay' || provider === 'google-play' || provider === 'playstore') {
    return `https://play.google.com/store/apps/details?id=${encodeURIComponent(storeId)}`;
  }
  if (provider === 'amazon' || provider === 'amazonpaapi' || provider === 'paapi') {
    return `https://www.amazon.com/dp/${encodeURIComponent(storeId)}`;
  }
  if (provider === 'trustpilot') {
    return `https://www.trustpilot.com/review/${encodeURIComponent(storeId)}`;
  }
  return null;
}

function sourceLabel(provider) {
  if (provider === 'amazon' || provider === 'amazonpaapi' || provider === 'paapi') return 'Amazon (official)';
  if (provider === 'trustpilot') return 'Trustpilot (official)';
  return 'Google Play (official)';
}

// ─────────────────────────────────────────────
// What: review-sources.json 업서트
// Why: AIO/검증/갱신 루프의 근거 데이터(링크) 축적
// I/O: R/W(content/reviews/review-sources.json)
// Invariants: url 없으면 변경 금지, 중복 URL 금지, 최대 20개
// ─────────────────────────────────────────────
function upsertSources(sourcesBySlug, slug, provider, url) {
  if (!url) return false;

  const arr = Array.isArray(sourcesBySlug[slug]) ? sourcesBySlug[slug] : [];
  const key = String(url).trim();

  const exists = arr.some(x => x && typeof x === 'object' && String(x.url || '').trim() === key);
  if (exists) {
    sourcesBySlug[slug] = arr;
    return false;
  }

  arr.push({ label: sourceLabel(provider), url: key });
  sourcesBySlug[slug] = arr.slice(0, 20);
  return true;
}

// ─────────────────────────────────────────────
// What: *-ratings-next.json 엔트리 업서트
// Why: diff-update/merge 단계가 기대하는 필드 보장
// I/O: R(*-ratings.json baseline), W(*-ratings-next.json)
// Invariants: fetched 없으면 변경 금지(오염 방지)
// ─────────────────────────────────────────────
function upsertNextEntry(nextBySlug, baseBySlug, slug, provider, storeId, fetched) {
  if (!fetched) return { changed: false, reason: 'no-data' };

  const base = baseBySlug[slug] || null;
  const prevRating = base && Number.isFinite(Number(base.ratingCurrent)) ? Number(base.ratingCurrent) : 0;
  const prevVotes = base && Number.isFinite(Number(base.votesCurrent)) ? Number(base.votesCurrent) : 0;

  const ratingCurrent = Number(fetched.ratingCurrent);
  const votesCurrent = Number(fetched.votesCurrent);

  const entry = nextBySlug[slug] && typeof nextBySlug[slug] === 'object' ? nextBySlug[slug] : {};

  entry.lastChecked = nowYmdKst();
  entry.status = 'ok';
  entry.store = provider || 'unknown';
  entry.source = 'official';
  entry.storeId = storeId || null;

  entry.ratingCurrent = Number.isFinite(ratingCurrent) ? ratingCurrent : 0;
  entry.votesCurrent = Number.isFinite(votesCurrent) ? votesCurrent : 0;

  entry.ratingPrevious = prevRating;
  entry.votesPrevious = prevVotes;

  entry.ratingDiff = computeDiff(entry.ratingCurrent, entry.ratingPrevious, 1);
  entry.votesDiff = Math.round(entry.votesCurrent - entry.votesPrevious);

  entry.histogram = normalizeHistogram(fetched.histogram);

  // insights는 (B안)에서 채움. 여기선 보존/기본만 보장.
  if (!Array.isArray(entry.insights)) entry.insights = [];

  nextBySlug[slug] = entry;
  return { changed: true, reason: 'upserted' };
}

// ─────────────────────────────────────────────
// What: Provider 어댑터(공식 API) 인터페이스(스켈레톤)
// Why: provider 구조/API 변경 리스크를 격리
// I/O: R(공식 API), W(없음)
// Invariants: DRY_RUN이면 절대 호출하지 않음(반드시 null 반환)
// ─────────────────────────────────────────────
async function fetchGooglePlay(/* key */) {
  if (!IS_LIVE) return null;
  // TODO(옹스님): Google Play 공식 경로 확정 후 구현
  // expected return: { ratingCurrent:number, votesCurrent:number, histogram?:{'1'..'5':number} }
  return null;
}

async function fetchAmazon(/* key */) {
  if (!IS_LIVE) return null;
  // TODO(옹스님): Amazon PA-API 승인 후 구현
  return null;
}

async function fetchTrustpilot(/* key */) {
  if (!IS_LIVE) return null;
  // TODO(옹스님): Trustpilot 공식 API 키/엔드포인트 확정 후 구현
  return null;
}

async function fetchCommon(provider, key) {
  // What: provider별 fetch 분기
  // Why: 단일 진입점으로 호출량/정책을 통제
  // I/O: R(provider/key), W(없음)
  // Invariants: allowlist 밖이면 호출 금지
  if (!provider || !PROVIDERS_ALLOW.includes(provider)) return null;

  if (provider === 'googleplay' || provider === 'google-play' || provider === 'playstore') {
    return fetchGooglePlay(key);
  }
  if (provider === 'amazon' || provider === 'amazonpaapi' || provider === 'paapi') {
    return fetchAmazon(key);
  }
  if (provider === 'trustpilot') {
    return fetchTrustpilot(key);
  }
  return null;
}

// ─────────────────────────────────────────────
// main
// ─────────────────────────────────────────────
async function main() {
  log('────────────────────────────────────────────');
  log('[review-fetch] start');
  log(`[review-fetch] ROOT = ${ROOT}`);
  log(`[review-fetch] POSTS = ${POSTS_DIR}`);
  log(`[review-fetch] REVIEWS = ${REVIEWS_DIR}`);
  log(`[review-fetch] DRY_RUN = ${IS_LIVE ? 'false(live)' : 'true(dry-run)'}`);
  log(`[review-fetch] ONLY_REVIEW_SLUGS = ${ONLY_REVIEW_SLUGS}`);
  log(`[review-fetch] MAX_CALLS_PER_RUN = ${MAX_CALLS_PER_RUN}`);
  log(`[review-fetch] PROVIDERS_ALLOW = ${PROVIDERS_ALLOW.join(', ')}`);

  const paths = {
    appRatings: path.join(REVIEWS_DIR, 'app-ratings.json'),
    appRatingsNext: path.join(REVIEWS_DIR, 'app-ratings-next.json'),

    deviceRatings: path.join(REVIEWS_DIR, 'device-ratings.json'),
    deviceRatingsNext: path.join(REVIEWS_DIR, 'device-ratings-next.json'),

    subscriptionRatings: path.join(REVIEWS_DIR, 'subscription-ratings.json'),
    subscriptionRatingsNext: path.join(REVIEWS_DIR, 'subscription-ratings-next.json'),

    reviewSources: path.join(REVIEWS_DIR, 'review-sources.json'),
  };

  // What: SSOT/next/sources 로드
  // Why: upsert 대상 준비
  // I/O: R(content/reviews/*.json), W(없음)
  // Invariants: 구조 깨져도 ensureMaps로 복구(최소 구조)
  const appBase = ensureMaps(safeReadJson(paths.appRatings, null));
  const appNext = ensureMaps(safeReadJson(paths.appRatingsNext, null));

  const deviceBase = ensureMaps(safeReadJson(paths.deviceRatings, null));
  const deviceNext = ensureMaps(safeReadJson(paths.deviceRatingsNext, null));

  const subBase = ensureMaps(safeReadJson(paths.subscriptionRatings, null));
  const subNext = ensureMaps(safeReadJson(paths.subscriptionRatingsNext, null));

  const sources = ensureMaps(safeReadJson(paths.reviewSources, null));

  // What: posts 스캔 → 후보 구성
  // Why: 리뷰 대상만 추려서 호출량/비용 통제
  // I/O: R(content/posts/*.json), W(없음)
  // Invariants: provider+storeId 없으면 외부 호출 금지
  const docs = listPostDocs();
  const candidates = [];

  for (const doc of docs) {
    const k = pickReviewKey(doc);
    if (!k.slug) continue;

    if (ONLY_REVIEW_SLUGS && !isReviewSlug(k.slug)) continue;
    if (!isReviewSlug(k.slug)) continue; // fetch는 리뷰 3버킷만(정책)

    candidates.push(k);
  }

  // What: 호출 우선순위 정렬
  // Why: storeId/provider가 있는 것부터 처리(성공률 우선)
  // I/O: R(candidates), W(없음)
  // Invariants: 정렬만, 데이터 변형 금지
  candidates.sort((a, b) => {
    const as = (a.storeId ? 1 : 0) + (a.provider ? 1 : 0);
    const bs = (b.storeId ? 1 : 0) + (b.provider ? 1 : 0);
    return bs - as;
  });

  let scanned = 0;
  let planned = 0;
  let fetchedOk = 0;
  let upserted = 0;
  let sourcesAdded = 0;

  let skippedNoKey = 0;
  let skippedProvider = 0;
  let skippedLimit = 0;

  for (const k of candidates) {
    scanned += 1;

    const slug = k.slug;
    const provider = (k.provider || '').toLowerCase();
    const storeId = k.storeId;

    if (!provider || !storeId) {
      skippedNoKey += 1;
      continue;
    }

    if (!PROVIDERS_ALLOW.includes(provider)) {
      skippedProvider += 1;
      continue;
    }

    if (planned >= MAX_CALLS_PER_RUN) {
      skippedLimit += 1;
      continue;
    }

    planned += 1;

    // What: DRY_RUN 계획 로그
    // Why: 호출/WRITE 없이 계획만 검증
    // I/O: R(candidate), W(없음)
    // Invariants: DRY_RUN이면 네트워크/WRITE 금지
    if (!IS_LIVE) {
      log(`DRY_RUN plan: slug=${slug} provider=${provider} storeId=${storeId}`);
      continue;
    }

    let fetched = null;
    try {
      fetched = await fetchCommon(provider, { storeId, slug, reviewId: k.reviewId });
    } catch (e) {
      warn(`fetch failed: slug=${slug} provider=${provider} -> ${e.message || e}`);
      fetched = null;
    }

    if (!fetched) continue;
    fetchedOk += 1;

    const bucket = bucketOf(slug);

    if (bucket === 'app') {
      const r = upsertNextEntry(appNext.bySlug, appBase.bySlug, slug, provider, storeId, fetched);
      if (r.changed) upserted += 1;
    } else if (bucket === 'device') {
      const r = upsertNextEntry(deviceNext.bySlug, deviceBase.bySlug, slug, provider, storeId, fetched);
      if (r.changed) upserted += 1;
    } else {
      const r = upsertNextEntry(subNext.bySlug, subBase.bySlug, slug, provider, storeId, fetched);
      if (r.changed) upserted += 1;
    }

    const url = k.url || buildProviderUrl(provider, storeId);
    if (upsertSources(sources.bySlug, slug, provider, url)) {
      sourcesAdded += 1;
    }
  }

  // What: updatedAt 갱신
  // Why: “언제 마지막으로 갱신 시도/반영했는지” 추적
  // I/O: W(content/reviews/*next.json, review-sources.json)
  // Invariants: LIVE에서만 실제 WRITE
  const ymd = nowYmdKst();
  for (const obj of [appNext, deviceNext, subNext, sources]) obj.updatedAt = ymd;

  if (IS_LIVE) {
    writeJson(paths.appRatingsNext, appNext);
    writeJson(paths.deviceRatingsNext, deviceNext);
    writeJson(paths.subscriptionRatingsNext, subNext);
    writeJson(paths.reviewSources, sources);
  }

  log('────────────────────────────────────────────');
  log(`[review-fetch] done: scanned=${scanned} planned=${planned} fetchedOk=${fetchedOk} upserted=${upserted} sourcesAdded=${sourcesAdded}`);
  log(`[review-fetch] skipped: noKey=${skippedNoKey} providerNotAllowed=${skippedProvider} overLimit=${skippedLimit}`);
  log('────────────────────────────────────────────');

  if (!IS_LIVE) {
    log('[review-fetch] DRY_RUN: no network calls, no file writes.');
  }
}

main().catch((e) => fatal(e && (e.stack || e.message) ? (e.stack || e.message) : String(e)));
