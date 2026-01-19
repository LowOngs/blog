#!/usr/bin/env node
'use strict';

// System_files/scripts/build/review-fetch-official.cjs
// review-fetch-official: 공식 API(1안)로 평점/투표/히스토그램을 수집해 *-ratings-next.json 업서트 (+ 스케줄링/실패정책/소스검증 내장)

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
const LOGS_DIR = path.join(ROOT, 'logs');

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

// 3-A: 90일 룰(기본 90). 운영에서 조정 가능.
const REFRESH_DAYS = Number(process.env.REVIEW_REFRESH_DAYS ?? 90);

// 3-D: 실패/부족 대응(공식 fetch 실패 백오프)
// - 1회 실패: 1일 후
// - 2회 실패: 3일 후
// - 3회 이상: 7일 후
const FAIL_BACKOFF_DAYS_1 = Number(process.env.REVIEW_FAIL_BACKOFF_DAYS_1 ?? 1);
const FAIL_BACKOFF_DAYS_2 = Number(process.env.REVIEW_FAIL_BACKOFF_DAYS_2 ?? 3);
const FAIL_BACKOFF_DAYS_3 = Number(process.env.REVIEW_FAIL_BACKOFF_DAYS_3 ?? 7);

// ledger 파일(스케줄링 SSOT: “시도/실패/다음 허용일”만 기록)
const LEDGER_PATH = path.join(LOGS_DIR, 'review-fetch-ledger.json');

function log(...a) { console.log('[review-fetch]', ...a); }
function warn(...a) { console.warn('[review-fetch][WARN]', ...a); }
function fatal(...a) { console.error('[review-fetch][FATAL]', ...a); process.exit(1); }

// ─────────────────────────────────────────────
// What: 날짜/시간 유틸(KST 일자 + ISO)
// Why: 90일 룰/백오프/로그의 기준을 통일
// I/O: R(Date.now), W(없음)
// Invariants: KST 기준 YYYY-MM-DD 문자열로 안정화
// ─────────────────────────────────────────────
function nowIso() {
  return new Date().toISOString();
}
function nowYmdKst() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
function ymdToEpochMs(ymd) {
  // ymd: YYYY-MM-DD
  const s = String(ymd || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}
function daysSinceYmdKst(ymd) {
  const ms = ymdToEpochMs(ymd);
  if (!ms) return null;
  const nowMs = Date.now();
  const diffDays = Math.floor((nowMs - ms) / (24 * 60 * 60 * 1000));
  return diffDays;
}
function addDaysIso(baseIso, days) {
  const ms = Date.parse(baseIso);
  if (!Number.isFinite(ms)) return null;
  const out = new Date(ms + Number(days) * 24 * 60 * 60 * 1000).toISOString();
  return out;
}

// ─────────────────────────────────────────────
// What: JSON 안전 입출력
// Why: 파싱 실패로 전체 중단 방지 + DRY_RUN 안전
// I/O: R/W(json files)
// Invariants: DRY_RUN이면 절대 WRITE하지 않음(여기서는 호출부에서 통제)
// ─────────────────────────────────────────────
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
// What: 리뷰 슬러그/버킷 판정
// Why: 오염 방지 + bucket별 파일에 정확히 upsert
// I/O: R(slug), W(없음)
// Invariants: app/device/subscription 3버킷만 official fetch 대상
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
// What: posts JSON에서 provider/storeId/reviewId/url 추출(호환 모드)
// Why: 필드가 완전히 고정되기 전, 여러 후보 필드와 seedMeta를 안전하게 지원
// I/O: R(content/posts/*.json), W(없음)
// Invariants: provider/storeId 없으면 외부 호출 금지(스킵)
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
// What: 히스토그램/차이값 정규화
// Why: 렌더/SSOT가 기대하는 필드/키를 항상 만족
// I/O: R(fetched/base), W(entry fields)
// Invariants: histogram '1'..'5' 키 항상 존재
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
// What: review-sources 검증(품질 필터)
// Why: 저품질/비정상 URL이 SSOT로 굳어지는 것을 차단
// I/O: R(url/provider), W(없음)
// Invariants: https만 허용, provider별 공식 도메인만 허용(기본)
// ─────────────────────────────────────────────
function safeUrl(u) {
  try {
    return new URL(String(u));
  } catch {
    return null;
  }
}

function validateSourceUrl(url, provider) {
  const U = safeUrl(url);
  if (!U) return { ok: false, reason: 'bad-url' };
  if (U.protocol !== 'https:') return { ok: false, reason: 'not-https' };

  const host = U.hostname.toLowerCase();

  // provider별 허용 도메인(공식만)
  if (provider === 'googleplay' || provider === 'google-play' || provider === 'playstore') {
    const ok = (host === 'play.google.com');
    return ok ? { ok: true } : { ok: false, reason: 'host-not-allowed' };
  }

  if (provider === 'amazon' || provider === 'amazonpaapi' || provider === 'paapi') {
    // 아마존은 국가 도메인이 다양하므로 *.amazon.* + amzn.to(공식 단축)까지만
    const ok =
      host === 'amzn.to' ||
      host.startsWith('www.amazon.') ||
      host.startsWith('amazon.');
    return ok ? { ok: true } : { ok: false, reason: 'host-not-allowed' };
  }

  if (provider === 'trustpilot') {
    const ok = (host === 'www.trustpilot.com' || host === 'trustpilot.com');
    return ok ? { ok: true } : { ok: false, reason: 'host-not-allowed' };
  }

  // 알 수 없는 provider는 차단(오염 방지)
  return { ok: false, reason: 'provider-unknown' };
}

function normalizeSourceLabel(provider) {
  if (provider === 'amazon') return 'Amazon (official)';
  if (provider === 'trustpilot') return 'Trustpilot (official)';
  return 'Google Play (official)';
}

// ─────────────────────────────────────────────
// What: provider 공식 페이지 URL 생성
// Why: sources 기록에 활용(공식 API가 아니더라도 공식 페이지 링크는 유효)
// I/O: R(provider/storeId), W(없음)
// Invariants: storeId 없으면 null
// ─────────────────────────────────────────────
function buildProviderUrl(provider, storeId) {
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
// What: review-fetch-ledger (스케줄링/실패정책 SSOT)
// Why: 무인 운영에서 “누구를 언제 다시 시도할지”를 안전하게 기록
// I/O: R/W(System_files/logs/review-fetch-ledger.json)
// Invariants: DRY_RUN이면 WRITE 금지(호출부에서 통제)
// ─────────────────────────────────────────────
function ensureLedger(obj) {
  const out = (obj && typeof obj === 'object') ? obj : {};
  if (!out.byKey || typeof out.byKey !== 'object') out.byKey = {};
  if (!out.updatedAt) out.updatedAt = nowYmdKst();
  return out;
}

function makeLedgerKey(provider, storeId, slug, reviewId) {
  // What: ledger key(중복 방지 키)
  // Why: provider/storeId가 핵심, 보조로 reviewId/slug를 덧붙여 안정성↑
  // Invariants: provider/storeId는 필수(없으면 null)
  if (!provider || !storeId) return null;
  const rid = reviewId ? String(reviewId) : '';
  const s = slug ? String(slug) : '';
  return `${provider}::${storeId}::${rid}::${s}`;
}

function backoffDaysForFailCount(n) {
  if (n <= 1) return FAIL_BACKOFF_DAYS_1;
  if (n === 2) return FAIL_BACKOFF_DAYS_2;
  return FAIL_BACKOFF_DAYS_3;
}

function ledgerCanRun(entry) {
  // What: ledger 기반으로 “지금 시도 가능?” 판정
  // Why: 연속 실패 시 불필요 호출/차단 리스크 감소
  // Invariants: nextEligibleAt이 미래면 스킵
  if (!entry || typeof entry !== 'object') return true;
  const nextAt = entry.nextEligibleAt ? String(entry.nextEligibleAt) : null;
  if (!nextAt) return true;
  const ms = Date.parse(nextAt);
  if (!Number.isFinite(ms)) return true;
  return Date.now() >= ms;
}

function ledgerMarkAttempt(ledger, key, ok) {
  const e = (ledger.byKey[key] && typeof ledger.byKey[key] === 'object') ? ledger.byKey[key] : {};
  e.lastTriedAt = nowIso();

  if (ok) {
    e.lastOkAt = e.lastTriedAt;
    e.failCount = 0;
    e.nextEligibleAt = null; // 성공 시 즉시 90일 룰에만 의존
  } else {
    const prev = Number(e.failCount || 0);
    const nextFail = prev + 1;
    e.failCount = nextFail;

    const waitDays = backoffDaysForFailCount(nextFail);
    e.nextEligibleAt = addDaysIso(e.lastTriedAt, waitDays);
  }

  ledger.byKey[key] = e;
}

// ─────────────────────────────────────────────
// What: SSOT에서 “갱신 필요” 판단(90일 룰)
// Why: 장기 무인 운영의 핵심(분산 갱신)
// I/O: R(review-ratings.json entry), W(없음)
// Invariants: lastChecked 없으면 “즉시 후보”로 간주(초기 채움)
// ─────────────────────────────────────────────
function needsRefreshBy90Days(entry) {
  if (!entry || typeof entry !== 'object') return true;
  const last = entry.lastChecked ? String(entry.lastChecked) : null;
  if (!last) return true;
  const days = daysSinceYmdKst(last);
  if (days === null) return true;
  return days >= REFRESH_DAYS;
}

function looksEmptyRating(entry) {
  if (!entry || typeof entry !== 'object') return true;
  const r = Number(entry.ratingCurrent ?? 0);
  const v = Number(entry.votesCurrent ?? 0);
  return !(Number.isFinite(r) && r > 0) || !(Number.isFinite(v) && v > 0);
}

// ─────────────────────────────────────────────
// What: Provider 어댑터(공식 API) 인터페이스
// Why: provider 변경(구조/API 변경) 리스크를 격리
// I/O: R(process.env keys), W(없음)
// Invariants: DRY_RUN이면 절대 호출하지 않음(반드시 null 반환)
// ─────────────────────────────────────────────
async function fetchGooglePlay({ storeId }) {
  if (!isLive) return null;
  // TODO(옹스님): Google Play Developer API/공식 제공 경로 확정 후 구현
  // expected: { ratingCurrent:number, votesCurrent:number, histogram?:{'1'..'5':number} }
  return null;
}

async function fetchAmazon({ storeId }) {
  if (!isLive) return null;
  // TODO(옹스님): Amazon PA-API(파트너 승인 후)로 별점/리뷰수 얻는 구현
  return null;
}

async function fetchTrustpilot({ storeId }) {
  if (!isLive) return null;
  // TODO(옹스님): Trustpilot 공식 API 키/엔드포인트 확정 후 구현
  return null;
}

async function fetchCommon(provider, key) {
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
// What: *-ratings-next.json 업서트(official 결과 반영)
// Why: 다음 단계(review-build-next/diff/merge)가 기대하는 필드 보장
// I/O: R(*-ratings.json baseline), W(*-ratings-next.json bySlug)
// Invariants: fetched가 없으면 next를 변경하지 않음(오염 방지)
// ─────────────────────────────────────────────
function upsertNextEntry(nextMap, baselineMap, slug, provider, storeId, fetched) {
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

// ─────────────────────────────────────────────
// What: review-sources.json 업서트(공식 출처 1개 이상 기록)
// Why: 신뢰/추적/검증 루프의 기반
// I/O: R/W(content/reviews/review-sources.json)
// Invariants: validateSourceUrl 통과한 것만 기록
// ─────────────────────────────────────────────
function upsertSources(sourcesMap, slug, provider, url) {
  if (!url) return { changed: false, reason: 'no-url' };

  const v = validateSourceUrl(url, provider);
  if (!v.ok) return { changed: false, reason: `invalid-url:${v.reason}` };

  const arr = Array.isArray(sourcesMap[slug]) ? sourcesMap[slug] : [];
  const key = String(url).trim();

  const exists = arr.some(x => x && typeof x === 'object' && String(x.url || '').trim() === key);
  if (exists) {
    sourcesMap[slug] = arr;
    return { changed: false, reason: 'exists' };
  }

  arr.push({
    label: normalizeSourceLabel(provider),
    url: key,
  });

  sourcesMap[slug] = arr.slice(0, 20);
  return { changed: true, reason: 'added' };
}

// ─────────────────────────────────────────────
// What: 스케줄링 점수(90일+비어있음 우선)
// Why: MAX_CALLS_PER_RUN 제한 안에서 “가치 큰 것부터” 갱신
// I/O: R(ssot entry), W(없음)
// Invariants: 점수는 결정론적(같으면 tie-breaker로 slug)
// ─────────────────────────────────────────────
function scoreCandidate(ssotEntry) {
  let score = 0;
  if (needsRefreshBy90Days(ssotEntry)) score += 100;
  if (looksEmptyRating(ssotEntry)) score += 50;

  // status가 unknown/error면 우선순위 조금 상승
  const st = (ssotEntry && ssotEntry.status) ? String(ssotEntry.status) : '';
  if (st && st !== 'ok') score += 10;

  return score;
}

async function main() {
  log('────────────────────────────────────────────');
  log('[review-fetch] start');
  log(`[review-fetch] ROOT = ${ROOT}`);
  log(`[review-fetch] POSTS = ${POSTS_DIR}`);
  log(`[review-fetch] REVIEWS = ${REVIEWS_DIR}`);
  log(`[review-fetch] LEDGER = ${LEDGER_PATH}`);
  log(`[review-fetch] DRY_RUN = ${isLive ? 'false(live)' : 'true(dry-run)'}`);
  log(`[review-fetch] ONLY_REVIEW_SLUGS = ${ONLY_REVIEW_SLUGS}`);
  log(`[review-fetch] MAX_CALLS_PER_RUN = ${MAX_CALLS_PER_RUN}`);
  log(`[review-fetch] REFRESH_DAYS = ${REFRESH_DAYS}`);
  log(`[review-fetch] PROVIDERS_ALLOW = ${PROVIDERS_ALLOW.join(', ')}`);

  const paths = {
    appRatings: path.join(REVIEWS_DIR, 'app-ratings.json'),
    appRatingsNext: path.join(REVIEWS_DIR, 'app-ratings-next.json'),

    deviceRatings: path.join(REVIEWS_DIR, 'device-ratings.json'),
    deviceRatingsNext: path.join(REVIEWS_DIR, 'device-ratings-next.json'),

    subscriptionRatings: path.join(REVIEWS_DIR, 'subscription-ratings.json'),
    subscriptionRatingsNext: path.join(REVIEWS_DIR, 'subscription-ratings-next.json'),

    reviewSources: path.join(REVIEWS_DIR, 'review-sources.json'),

    // SSOT(90일 룰 판정용)
    reviewSsot: path.join(REVIEWS_DIR, 'review-ratings.json'),
  };

  // bucket baseline/next
  const appBase = ensureMaps(safeReadJson(paths.appRatings, null));
  const appNext = ensureMaps(safeReadJson(paths.appRatingsNext, null));

  const deviceBase = ensureMaps(safeReadJson(paths.deviceRatings, null));
  const deviceNext = ensureMaps(safeReadJson(paths.deviceRatingsNext, null));

  const subBase = ensureMaps(safeReadJson(paths.subscriptionRatings, null));
  const subNext = ensureMaps(safeReadJson(paths.subscriptionRatingsNext, null));

  const sources = ensureMaps(safeReadJson(paths.reviewSources, null));

  // scheduling SSOT(merge된 통합 ssot)
  const ssotAll = safeReadJson(paths.reviewSsot, { bySlug: {}, byReviewId: {} }) || { bySlug: {}, byReviewId: {} };
  const ssotBySlug = (ssotAll && ssotAll.bySlug && typeof ssotAll.bySlug === 'object') ? ssotAll.bySlug : {};
  const ssotByReviewId = (ssotAll && ssotAll.byReviewId && typeof ssotAll.byReviewId === 'object') ? ssotAll.byReviewId : {};

  // ledger
  const ledger = ensureLedger(safeReadJson(LEDGER_PATH, null));

  const docs = listPostDocs();

  // ─────────────────────────────────────────────
  // What: 후보 추출 + SSOT/ledger 기반 “오늘 할당” 결정
  // Why: 90일 룰 분산 + 실패 백오프 + MAX_CALLS_PER_RUN
  // I/O: R(posts/ssot/ledger), W(없음)
  // Invariants: provider/storeId 없는 건 외부 호출 금지
  // ─────────────────────────────────────────────
  const candidates = [];
  for (const doc of docs) {
    const k = pickReviewKey(doc);
    if (!k.slug) continue;

    // 리뷰 파일만
    if (ONLY_REVIEW_SLUGS && !isReviewSlug(k.slug)) continue;
    if (!isReviewSlug(k.slug)) continue;

    const provider = (k.provider || '').toLowerCase();
    const storeId = k.storeId;

    if (!provider || !storeId) continue;
    if (!PROVIDERS_ALLOW.includes(provider)) continue;

    // 1순위: reviewId 매칭된 ssot 엔트리, 2순위: slug
    const ssotEntry =
      (k.reviewId && ssotByReviewId[k.reviewId]) ||
      ssotBySlug[k.slug] ||
      null;

    const ledgerKey = makeLedgerKey(provider, storeId, k.slug, k.reviewId);
    if (!ledgerKey) continue;

    const ledEntry = ledger.byKey[ledgerKey] || null;
    if (!ledgerCanRun(ledEntry)) continue;

    const score = scoreCandidate(ssotEntry);

    candidates.push({
      ...k,
      provider,
      storeId,
      ledgerKey,
      score,
      ssotEntry,
    });
  }

  // 정렬: score desc → (90일 초과/빈값 우선이 score에 반영됨) → slug asc
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.slug).localeCompare(String(b.slug));
  });

  let scanned = 0;
  let planned = 0;
  let fetchedOk = 0;
  let upserted = 0;
  let sourcesAdded = 0;

  let skippedLimit = 0;

  // ─────────────────────────────────────────────
  // What: MAX_CALLS_PER_RUN 만큼만 실행(일일 배치)
  // Why: 비용/차단/속도 리스크 통제
  // I/O: R(posts), W(next/sources/ledger) (live에서만)
  // Invariants: DRY_RUN이면 네트워크/WRITE 0%
  // ─────────────────────────────────────────────
  for (const k of candidates) {
    scanned += 1;

    if (planned >= MAX_CALLS_PER_RUN) {
      skippedLimit += 1;
      continue;
    }

    planned += 1;

    // DRY_RUN이면 계획만 출력(안전)
    if (!isLive) {
      log(`DRY_RUN plan: slug=${k.slug} provider=${k.provider} storeId=${k.storeId} score=${k.score}`);
      continue;
    }

    let fetched = null;
    try {
      fetched = await fetchCommon(k.provider, { storeId: k.storeId, slug: k.slug, reviewId: k.reviewId });
    } catch (e) {
      warn(`fetch failed: slug=${k.slug} provider=${k.provider} -> ${e.message || e}`);
      fetched = null;
    }

    if (!fetched) {
      ledgerMarkAttempt(ledger, k.ledgerKey, false);
      continue;
    }

    // 성공
    fetchedOk += 1;
    ledgerMarkAttempt(ledger, k.ledgerKey, true);

    const bucket = bucketOf(k.slug);

    if (bucket === 'app') {
      const r = upsertNextEntry(appNext.bySlug, appBase.bySlug, k.slug, k.provider, k.storeId, fetched);
      if (r.changed) upserted += 1;
    } else if (bucket === 'device') {
      const r = upsertNextEntry(deviceNext.bySlug, deviceBase.bySlug, k.slug, k.provider, k.storeId, fetched);
      if (r.changed) upserted += 1;
    } else {
      const r = upsertNextEntry(subNext.bySlug, subBase.bySlug, k.slug, k.provider, k.storeId, fetched);
      if (r.changed) upserted += 1;
    }

    // sources 업서트(공식 페이지 URL 기록)
    const url = k.url || buildProviderUrl(k.provider, k.storeId);
    const s = upsertSources(sources.bySlug, k.slug, k.provider, url);
    if (s.changed) sourcesAdded += 1;
  }

  // updatedAt 갱신
  const ymd = nowYmdKst();
  for (const obj of [appNext, deviceNext, subNext, sources]) obj.updatedAt = ymd;
  ledger.updatedAt = ymd;

  // WRITE(라이브에서만)
  if (isLive) {
    writeJson(paths.appRatingsNext, appNext);
    writeJson(paths.deviceRatingsNext, deviceNext);
    writeJson(paths.subscriptionRatingsNext, subNext);
    writeJson(paths.reviewSources, sources);
    writeJson(LEDGER_PATH, ledger);
  }

  log('────────────────────────────────────────────');
  log(`[review-fetch] done: candidates=${candidates.length} planned=${planned} fetchedOk=${fetchedOk} upserted=${upserted} sourcesAdded=${sourcesAdded}`);
  log(`[review-fetch] skipped: overLimit=${skippedLimit}`);
  log('────────────────────────────────────────────');

  if (!isLive) {
    log('[review-fetch] DRY_RUN: no network calls, no file writes.');
  }
}

main().catch((e) => fatal(e && (e.stack || e.message) ? (e.stack || e.message) : String(e)));
