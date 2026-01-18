#!/usr/bin/env node
'use strict';
// review-fetch-official: 공식 API(1안)로 평점/투표/히스토그램을 수집해 *-ratings-next.json 업서트 + review-sources.json 업서트(품질 필터 포함)

require('./lib/env.cjs'); // ✅ 공통 규칙: env 로더 최우선

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// What: 공통 설정/게이트(외부 호출/쓰기 통제)
// Why: DRY_RUN에서 외부 호출/WRITE 금지(사고 방지)
// I/O: R(process.env), W(없음)
// Invariants: DRY_RUN이면 네트워크 호출/파일 WRITE 금지
// ─────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const REVIEWS_DIR = path.join(ROOT, 'content', 'reviews');

const isLive = (() => {
  const v = String(process.env.DRY_RUN ?? 'true').trim().toLowerCase();
  return (v === 'false' || v === '0');
})();

const MAX_CALLS_PER_RUN = Number(process.env.REVIEW_FETCH_MAX_CALLS ?? 25);
const ONLY_REVIEW_SLUGS = String(process.env.REVIEW_FETCH_ONLY_REVIEW_SLUGS ?? 'true').toLowerCase() !== 'false';
const PROVIDERS_ALLOW = String(process.env.REVIEW_FETCH_PROVIDERS ?? 'googleplay,amazon,trustpilot')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// sources 품질 필터 옵션(기본: ON)
const VALIDATE_SOURCES = String(process.env.REVIEW_SOURCES_VALIDATE ?? 'true').toLowerCase() !== 'false';
const SOURCE_MAX_PER_SLUG = Number(process.env.REVIEW_SOURCES_MAX_PER_SLUG ?? 20);

// 허용 도메인(기본값 + ENV 확장)
const SOURCE_ALLOW_DOMAINS = (() => {
  const extra = String(process.env.REVIEW_SOURCES_ALLOW_DOMAINS ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  // 기본 allow: 공식 페이지 도메인(최소)
  const base = [
    'play.google.com',
    'amazon.com',
    'www.amazon.com',
    'trustpilot.com',
    'www.trustpilot.com',
  ];

  return Array.from(new Set([...base, ...extra]));
})();

function log(...a) { console.log('[review-fetch]', ...a); }
function warn(...a) { console.warn('[review-fetch][WARN]', ...a); }
function fatal(...a) { console.error('[review-fetch][FATAL]', ...a); process.exit(1); }

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

function normalizeHistogram(h) {
  // What: 1~5 키를 가진 퍼센트/비율 형태 정규화
  // Why: SSOT/렌더가 기대하는 키 존재 보장
  // I/O: R(entry.histogram), W(entry.histogram)
  // Invariants: '1'..'5' 키가 항상 존재, NaN 방지
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

function pickReviewKey(doc) {
  // What: posts JSON에서 provider/storeId/reviewId/url를 안전하게 추출
  // Why: 필드 확정 전 과도기(다중 후보 필드) 호환
  // I/O: R(content/posts/*.json), W(없음)
  // Invariants: provider/storeId 없으면 fetch 스킵(외부 호출 금지)
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
  // What: posts 폴더 스캔 후 JSON 로드
  // Why: 리뷰 대상 후보를 여기서 1차 확보
  // I/O: R(content/posts/*.json), W(없음)
  // Invariants: 파싱 실패는 스킵(전체 중단 금지)
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
// What: Provider 어댑터(공식 API) 인터페이스
// Why: provider 변경(구조/API 변경) 리스크를 격리
// I/O: R(process.env keys), W(없음)
// Invariants: DRY_RUN이면 절대 호출하지 않음(반드시 null 반환)
// ─────────────────────────────────────────────
async function fetchGooglePlay({ storeId }) {
  if (!isLive) return null;
  // TODO(옹스님): Google Play 공식 API 경로 확정 후 구현
  return null;
}

async function fetchAmazon({ storeId }) {
  if (!isLive) return null;
  // TODO(옹스님): Amazon PA-API(파트너 승인 후) 구현
  return null;
}

async function fetchTrustpilot({ storeId }) {
  if (!isLive) return null;
  // TODO(옹스님): Trustpilot 공식 API 키/엔드포인트 확정 후 구현
  return null;
}

async function fetchCommon(provider, key) {
  // What: provider별 fetch 분기
  // Why: 단일 진입점으로 allowlist/정책을 강제
  // I/O: R(provider, storeId), W(없음)
  // Invariants: provider allowlist 밖이면 호출 금지
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

function upsertNextEntry(nextMap, baselineMap, slug, provider, storeId, fetched) {
  // What: *-ratings-next.json의 slug 엔트리를 업서트
  // Why: diff-update/merge 단계가 기대하는 필드 보장
  // I/O: R(*-ratings.json baseline), W(*-ratings-next.json)
  // Invariants: fetched가 없으면 next를 변경하지 않음(오염 방지)
  if (!fetched) return { changed: false, reason: 'no-data' };

  const base = baselineMap[slug] || null;
  const prevRating = base && Number.isFinite(Number(base.ratingCurrent)) ? Number(base.ratingCurrent) : 0;
  const prevVotes = base && Number.isFinite(Number(base.votesCurrent)) ? Number(base.votesCurrent) : 0;

  const ratingCurrent = Number(fetched.ratingCurrent);
  const votesCurrent = Number(fetched.votesCurrent);

  const entry = nextMap[slug] && typeof nextMap[slug] === 'object' ? nextMap[slug] : {};

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
  entry.votesDiff = Math.round((entry.votesCurrent - entry.votesPrevious));

  entry.histogram = normalizeHistogram(fetched.histogram);

  // insights는 2안에서 채우는 영역(여기선 건드리지 않음)
  if (!Array.isArray(entry.insights)) entry.insights = [];

  nextMap[slug] = entry;
  return { changed: true, reason: 'upserted' };
}

function buildProviderUrl(provider, storeId) {
  // What: 공식 페이지 URL 생성
  // Why: sources 기록에 활용
  // I/O: R(provider/storeId), W(없음)
  // Invariants: storeId 없으면 null
  if (!storeId) return null;

  if (provider === 'googleplay' || provider === 'google-play' || provider === 'playstore') {
    return `https://play.google.com/store/apps/details?id=${encodeURIComponent(storeId)}`;
  }
  if (provider === 'amazon') {
    return `https://www.amazon.com/dp/${encodeURIComponent(storeId)}`;
  }
  if (provider === 'trustpilot') {
    return `https://www.trustpilot.com/review/${encodeURIComponent(storeId)}`;
  }
  return null;
}

// ─────────────────────────────────────────────
// What: review-sources 품질 필터(검증)
// Why: 저품질/오염 URL이 SSOT로 들어가면 장기적으로 리스크가 커짐
// I/O: R(url,label), W(없음)
// Invariants: https만 허용, javascript/data/file 차단, 도메인 allowlist 적용
// ─────────────────────────────────────────────
function validateSource(label, url) {
  if (!VALIDATE_SOURCES) return { ok: true, reason: 'disabled' };

  const lbl = (label ? String(label).trim() : '');
  const u = (url ? String(url).trim() : '');

  if (!u) return { ok: false, reason: 'empty_url' };
  if (u.length > 500) return { ok: false, reason: 'url_too_long' };
  if (lbl && lbl.length > 120) return { ok: false, reason: 'label_too_long' };

  // block obvious bad schemes
  const low = u.toLowerCase();
  if (low.startsWith('javascript:')) return { ok: false, reason: 'bad_scheme_js' };
  if (low.startsWith('data:')) return { ok: false, reason: 'bad_scheme_data' };
  if (low.startsWith('file:')) return { ok: false, reason: 'bad_scheme_file' };

  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (parsed.protocol !== 'https:') return { ok: false, reason: 'not_https' };

  const host = String(parsed.hostname || '').toLowerCase();
  if (!host) return { ok: false, reason: 'no_host' };

  // allowlist: exact match OR subdomain match
  const okHost = SOURCE_ALLOW_DOMAINS.some(d => host === d || host.endsWith(`.${d}`));
  if (!okHost) return { ok: false, reason: 'host_not_allowed' };

  return { ok: true, reason: 'ok' };
}

function upsertSources(sourcesMap, slug, provider, storeId, url) {
  // What: review-sources.json에 공식 출처를 최소 1개 기록(품질 필터 적용)
  // Why: AIO/신뢰/추적(검증/갱신 루프) 기반 마련
  // I/O: R/W(content/reviews/review-sources.json)
  // Invariants: url 없거나 validate 실패면 sources는 건드리지 않음(오염 방지)
  if (!url) return { changed: false, reason: 'no_url' };

  const label = provider === 'amazon'
    ? 'Amazon (official)'
    : provider === 'trustpilot'
      ? 'Trustpilot (official)'
      : 'Google Play (official)';

  const v = validateSource(label, url);
  if (!v.ok) return { changed: false, reason: `invalid_source:${v.reason}` };

  const arr = Array.isArray(sourcesMap[slug]) ? sourcesMap[slug] : [];
  const key = String(url).trim();

  const exists = arr.some(x => x && typeof x === 'object' && String(x.url || '').trim() === key);
  if (exists) {
    sourcesMap[slug] = arr.slice(0, SOURCE_MAX_PER_SLUG);
    return { changed: false, reason: 'exists' };
  }

  arr.push({ label, url: key });

  // 너무 많아지는 것 방지(장기 운영 안전)
  sourcesMap[slug] = arr.slice(0, SOURCE_MAX_PER_SLUG);
  return { changed: true, reason: 'added' };
}

async function main() {
  log('────────────────────────────────────────────');
  log('[review-fetch] start');
  log(`[review-fetch] ROOT = ${ROOT}`);
  log(`[review-fetch] POSTS = ${POSTS_DIR}`);
  log(`[review-fetch] REVIEWS = ${REVIEWS_DIR}`);
  log(`[review-fetch] DRY_RUN = ${isLive ? 'false(live)' : 'true(dry-run)'}`);
  log(`[review-fetch] ONLY_REVIEW_SLUGS = ${ONLY_REVIEW_SLUGS}`);
  log(`[review-fetch] MAX_CALLS_PER_RUN = ${MAX_CALLS_PER_RUN}`);
  log(`[review-fetch] PROVIDERS_ALLOW = ${PROVIDERS_ALLOW.join(', ')}`);
  log(`[review-fetch] SOURCES_VALIDATE = ${VALIDATE_SOURCES} (maxPerSlug=${SOURCE_MAX_PER_SLUG})`);

  const paths = {
    appRatings: path.join(REVIEWS_DIR, 'app-ratings.json'),
    appRatingsNext: path.join(REVIEWS_DIR, 'app-ratings-next.json'),

    deviceRatings: path.join(REVIEWS_DIR, 'device-ratings.json'),
    deviceRatingsNext: path.join(REVIEWS_DIR, 'device-ratings-next.json'),

    subscriptionRatings: path.join(REVIEWS_DIR, 'subscription-ratings.json'),
    subscriptionRatingsNext: path.join(REVIEWS_DIR, 'subscription-ratings-next.json'),

    reviewSources: path.join(REVIEWS_DIR, 'review-sources.json'),
  };

  const appBase = ensureMaps(safeReadJson(paths.appRatings, null));
  const appNext = ensureMaps(safeReadJson(paths.appRatingsNext, null));

  const deviceBase = ensureMaps(safeReadJson(paths.deviceRatings, null));
  const deviceNext = ensureMaps(safeReadJson(paths.deviceRatingsNext, null));

  const subBase = ensureMaps(safeReadJson(paths.subscriptionRatings, null));
  const subNext = ensureMaps(safeReadJson(paths.subscriptionRatingsNext, null));

  const sources = ensureMaps(safeReadJson(paths.reviewSources, null));

  const docs = listPostDocs();

  const candidates = [];
  for (const doc of docs) {
    const k = pickReviewKey(doc);
    if (!k.slug) continue;
    if (ONLY_REVIEW_SLUGS && !isReviewSlug(k.slug)) continue;
    if (!isReviewSlug(k.slug)) continue; // fetch는 리뷰 3버킷만(정책)
    candidates.push(k);
  }

  // 호출 대상 정렬: storeId 있는 것 우선, provider 있는 것 우선
  candidates.sort((a, b) => {
    const as = (a.storeId ? 1 : 0) + (a.provider ? 1 : 0);
    const bs = (b.storeId ? 1 : 0) + (b.provider ? 1 : 0);
    return bs - as;
  });

  let scanned = 0;
  let callPlanned = 0;
  let fetchedOk = 0;
  let upserted = 0;
  let sourcesAdded = 0;

  let skippedNoKey = 0;
  let skippedProvider = 0;
  let skippedLimit = 0;
  let skippedSourceInvalid = 0;

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

    if (callPlanned >= MAX_CALLS_PER_RUN) {
      skippedLimit += 1;
      continue;
    }

    callPlanned += 1;

    // DRY_RUN이면 외부 호출 없이 “계획 로그”만 출력
    if (!isLive) {
      log(`DRY_RUN plan: slug=${slug} provider=${provider} storeId=${storeId}`);
      // sources도 DRY_RUN에서는 변경하지 않음(WRITE 금지)
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

    // fetched expected shape:
    // { ratingCurrent:number, votesCurrent:number, histogram?:{'1'..'5':number} }
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

    // sources 업서트(공식 페이지 URL 기록, 품질 필터 적용)
    const url = k.url || buildProviderUrl(provider, storeId);
    const s = upsertSources(sources.bySlug, slug, provider, storeId, url);
    if (s.changed) sourcesAdded += 1;
    else if (String(s.reason || '').startsWith('invalid_source:')) skippedSourceInvalid += 1;
  }

  // updatedAt 갱신
  const ymd = nowYmdKst();
  for (const obj of [appNext, deviceNext, subNext, sources]) {
    obj.updatedAt = ymd;
  }

  // WRITE(라이브에서만)
  if (isLive) {
    writeJson(paths.appRatingsNext, appNext);
    writeJson(paths.deviceRatingsNext, deviceNext);
    writeJson(paths.subscriptionRatingsNext, subNext);
    writeJson(paths.reviewSources, sources);
  }

  log('────────────────────────────────────────────');
  log(`[review-fetch] done: scanned=${scanned} planned=${callPlanned} fetchedOk=${fetchedOk} upserted=${upserted} sourcesAdded=${sourcesAdded}`);
  log(`[review-fetch] skipped: noKey=${skippedNoKey} providerNotAllowed=${skippedProvider} overLimit=${skippedLimit} sourceInvalid=${skippedSourceInvalid}`);
  log('────────────────────────────────────────────');

  if (!isLive) {
    log('[review-fetch] DRY_RUN: no network calls, no file writes.');
  }
}

main().catch((e) => fatal(e && (e.stack || e.message) ? (e.stack || e.message) : String(e)));
