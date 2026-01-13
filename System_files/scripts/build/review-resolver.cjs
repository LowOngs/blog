'use strict';

/**
 * System_files/scripts/build/review-resolver.cjs
 * - render-posts.cjs에서 호출하는 "resolveReviewData" 제공 모듈
 *
 * ✅ 정책(1단계)
 * - 리뷰 SSOT(단일 소스) 우선: content/reviews/review-ratings.json
 * - SSOT 스키마(스냅샷형):
 *   ratingCurrent / votesCurrent / ratingPrevious / votesPrevious / ratingDiff / votesDiff / histogram / insights
 *   + (선택) lastChecked / nextCheck / platform / source / storeId / scale
 * - SSOT에 없으면 postJson.review 또는 postJson.reviews (있을 때만) fallback
 * - 리뷰 라벨이 아니면 null 반환(리뷰 블록 미출력)
 *
 * ✅ insights 규칙(1단계 확정)
 * - 총 12개 상한(최대 12)
 * - 긍정(pos) 최대 6, 부정(neg) 최대 6 → pos+neg 최대 12
 * - 부족하면 있는 만큼만 출력(억지로 12개 채우지 않음)
 * - 중복/의미없는 짧은 문장 제거
 * - 실행마다 결과가 바뀌지 않게 결정론적 정렬(입력 순서 영향 제거)
 *
 * ✅ blocks.cjs 연동 형태(중요)
 * - 반환 객체는 다음을 포함해야 함:
 *   { rating: { overall, votes, scale, lastChecked, nextCheck, platform, source, storeId }, histogram, insights, source }
 */

const fs = require('fs');
const path = require('path');

/* ------------------------------ 기본 유틸 ------------------------------ */

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function toNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeText(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[•·●\u2022]/g, '-') // 흔한 불릿 문자 정리
    .trim();
}

/* ------------------------------ insights 처리 ------------------------------ */

function inferSentiment(text) {
  const t = String(text || '').toLowerCase();

  const neg = /(crash|bug|error|refund|slow|lag|ads|billing|cancel|scam|freeze|broken|spam|drain)/i;
  const pos = /(fast|easy|great|good|useful|helpful|smooth|reliable|love|accurate|works well)/i;

  const hasNeg = neg.test(t);
  const hasPos = pos.test(t);

  if (hasNeg && !hasPos) return 'neg';
  if (hasPos && !hasNeg) return 'pos';
  return 'neu';
}

function looksTooShort(t) {
  const s = normalizeText(t);
  return s.length < 8;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const t = normalizeText(raw);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function normalizeInsightsBalanced(v) {
  const raw = asArray(v).flatMap((x) => {
    if (!x) return [];
    if (typeof x === 'string') return [x];
    if (typeof x === 'object') {
      const t = x.text || x.note || x.value || x.title;
      return t ? [t] : [];
    }
    return [];
  });

  const cleaned = dedupe(raw).filter((t) => !looksTooShort(t));

  if (cleaned.length === 0) {
    return { all: [], pos: [], neg: [], counts: { pos: 0, neg: 0, total: 0 } };
  }

  // 결정론 정렬(입력 순서 제거)
  const sorted = cleaned.slice().sort((a, b) => a.localeCompare(b, 'en'));

  const pos = [];
  const neg = [];

  for (const t of sorted) {
    const s = inferSentiment(t);
    if (s === 'pos' && pos.length < 6) pos.push(t);
    else if (s === 'neg' && neg.length < 6) neg.push(t);

    if (pos.length === 6 && neg.length === 6) break;
  }

  const all = [...pos, ...neg].slice(0, 12);

  return { all, pos, neg, counts: { pos: pos.length, neg: neg.length, total: all.length } };
}

/* ------------------------------ histogram 처리 ------------------------------ */
/**
 * blocks.cjs가 normalizeHistogram에서 "1".."5" 키를 int로 정리하므로
 * 여기서는 형태만 보존(객체면 그대로)하고, 명백히 잘못된 경우만 null 처리합니다.
 */
function normalizeHistogramPassThrough(hist) {
  if (!hist || typeof hist !== 'object') return null;
  if (Array.isArray(hist)) return null;
  const keys = Object.keys(hist);
  if (keys.length === 0) return null;
  return hist;
}

/* ------------------------------ SSOT 로딩 ------------------------------ */

let _ssotCache = null;

function readSsotOnce(ROOT) {
  if (_ssotCache) return _ssotCache;
  const p = path.join(ROOT, 'content', 'reviews', 'review-ratings.json');
  _ssotCache = readJsonSafe(p);
  return _ssotCache;
}

function isReviewLabel(label) {
  const v = String(label || '').trim().toLowerCase();
  return v === 'app-reviews' || v === 'device-reviews' || v === 'subscription-services';
}

function pickLabel(postJson) {
  // labels 우선(SSOT 규격), 그다음 legacy 필드들
  const labels = Array.isArray(postJson?.labels) ? postJson.labels : [];
  const first = labels.length ? labels[0] : '';
  return String(first || postJson?.label || postJson?.mainLabel || '').trim();
}

/* ------------------------------ normalize(SSOT 스냅샷 → blocks용) ------------------------------ */

function normalizeFromSnapshot(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const ratingCurrent = toNumberOrNull(obj.ratingCurrent);
  const votesCurrent = toNumberOrNull(obj.votesCurrent);

  const ratingPrevious = toNumberOrNull(obj.ratingPrevious);
  const votesPrevious = toNumberOrNull(obj.votesPrevious);

  // rating/votes가 둘 다 완전 비면 무효
  if (
    ratingCurrent === null &&
    votesCurrent === null &&
    ratingPrevious === null &&
    votesPrevious === null
  ) {
    return null;
  }

  const ins = normalizeInsightsBalanced(obj.insights);

  // blocks.cjs가 기대하는 rating 객체
  const overall = ratingCurrent !== null ? ratingCurrent : ratingPrevious;
  const votes = votesCurrent !== null ? votesCurrent : (votesPrevious !== null ? votesPrevious : 0);

  if (overall === null) return null;

  const scale = toNumberOrNull(obj.scale) || 5;

  const rating = {
    overall,
    votes: votes || 0,
    scale,
    lastChecked: obj.lastChecked ? String(obj.lastChecked) : '',
    nextCheck: obj.nextCheck ? String(obj.nextCheck) : '',
    platform: obj.platform ? String(obj.platform) : (obj.store ? String(obj.store) : ''),
    source: obj.source ? String(obj.source) : '',
    storeId: (obj.storeId === undefined) ? null : obj.storeId,
  };

  return {
    rating,
    histogram: normalizeHistogramPassThrough(obj.histogram),
    insights: ins.all,
    // blocks.cjs에서 reviewData.source fallback도 보므로 같이 제공
    source: rating.source || '',
    // 디버그/추적용(필요 시)
    snapshot: {
      ratingCurrent,
      votesCurrent,
      ratingPrevious,
      votesPrevious,
      ratingDiff: toNumberOrNull(obj.ratingDiff),
      votesDiff: toNumberOrNull(obj.votesDiff),
      status: obj.status ? String(obj.status) : 'ok',
      lastChecked: rating.lastChecked,
      nextCheck: rating.nextCheck,
      insightsCounts: ins.counts,
    },
  };
}

function normalizeFromFallback(obj) {
  if (!obj || typeof obj !== 'object') return null;

  // 다양한 필드명 허용
  const overall = toNumberOrNull(obj.rating ?? obj.score ?? obj.stars ?? obj.overall);
  const votes = toNumberOrNull(obj.votes ?? obj.ratingsCount ?? obj.count) || 0;

  if (overall === null) return null;

  const ins = normalizeInsightsBalanced(obj.insights);

  const rating = {
    overall,
    votes,
    scale: toNumberOrNull(obj.scale) || 5,
    lastChecked: obj.lastChecked ? String(obj.lastChecked) : '',
    nextCheck: obj.nextCheck ? String(obj.nextCheck) : '',
    platform: obj.platform ? String(obj.platform) : (obj.store ? String(obj.store) : ''),
    source: obj.source ? String(obj.source) : '',
    storeId: (obj.storeId === undefined) ? null : obj.storeId,
  };

  return {
    rating,
    histogram: normalizeHistogramPassThrough(obj.histogram),
    insights: ins.all,
    source: rating.source || '',
    snapshot: {
      ratingCurrent: overall,
      votesCurrent: votes,
      ratingPrevious: null,
      votesPrevious: null,
      ratingDiff: null,
      votesDiff: null,
      status: obj.status ? String(obj.status) : 'ok',
      lastChecked: rating.lastChecked,
      nextCheck: rating.nextCheck,
      insightsCounts: ins.counts,
    },
  };
}

/* ------------------------------ main ------------------------------ */

function resolveReviewData({ ROOT, postJson }) {
  try {
    if (!postJson || typeof postJson !== 'object') return null;

    // 리뷰 글만 리뷰 블록 출력
    const label = pickLabel(postJson);
    if (!isReviewLabel(label)) return null;

    const slug = String(postJson.slug || '').trim();

    // 1) SSOT 우선
    if (slug) {
      const ssot = readSsotOnce(ROOT);

      // 기대 형태:
      // - { bySlug: { [slug]: {...} } }
      // - { [slug]: {...} }
      const found =
        (ssot && ssot.bySlug && typeof ssot.bySlug === 'object' && ssot.bySlug[slug]) ||
        (ssot && typeof ssot === 'object' && ssot[slug]) ||
        null;

      const normalized = normalizeFromSnapshot(found);
      if (normalized) return normalized;
    }

    // 2) fallback (있을 때만)
    return normalizeFromFallback(postJson.review || postJson.reviews || null);
  } catch {
    return null;
  }
}

module.exports = { resolveReviewData };
