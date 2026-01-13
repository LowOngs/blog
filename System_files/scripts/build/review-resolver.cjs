'use strict';

/**
 * System_files/scripts/build/review-resolver.cjs
 * - render-posts.cjs에서 호출하는 "resolveReviewData" 제공 모듈
 *
 * ✅ 정책(1단계)
 * - 리뷰 SSOT(단일 소스) 우선: content/reviews/review-ratings.json
 * - SSOT 스키마(스냅샷형): lastChecked / status / source / ratingCurrent / votesCurrent / ratingPrevious / votesPrevious / ratingDiff / votesDiff / histogram / insights
 * - SSOT에 없으면 postJson.review 또는 postJson.reviews (있을 때만) fallback
 * - 리뷰 라벨이 아니면 null 반환(리뷰 블록 미출력)
 *
 * ✅ insights 규칙(1단계 확정)
 * - 총 12개 상한(최대 12)
 * - 긍정(pos) 최대 6, 부정(neg) 최대 6 → pos+neg 최대 12
 * - 부족하면 있는 만큼만 출력
 * - 중복/의미없는 짧은 문장 제거
 * - 실행마다 결과가 바뀌지 않게 결정론적 정렬
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

  return {
    all,
    pos,
    neg,
    counts: { pos: pos.length, neg: neg.length, total: all.length },
  };
}

/* ------------------------------ histogram 처리 ------------------------------ */

function clampHistogramPctObject(hist) {
  if (!hist || typeof hist !== 'object') return null;
  const out = {};
  for (const k of Object.keys(hist)) {
    const v = Number(hist[k]);
    if (!Number.isFinite(v)) continue;
    out[k] = Math.max(0, Math.min(100, v));
  }
  return Object.keys(out).length ? out : null;
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

/* ------------------------------ normalize(스냅샷/폴백) ------------------------------ */

function normalizeFromSnapshot(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const ratingCurrent = toNumberOrNull(obj.ratingCurrent);
  const votesCurrent = toNumberOrNull(obj.votesCurrent);
  const ratingPrevious = toNumberOrNull(obj.ratingPrevious);
  const votesPrevious = toNumberOrNull(obj.votesPrevious);

  if (ratingCurrent === null && votesCurrent === null && ratingPrevious === null && votesPrevious === null) {
    return null;
  }

  const ins = normalizeInsightsBalanced(obj.insights);

  // ✅ blocks.cjs가 기대하는 형태로 맞춤 (rating.overall/votes/lastChecked/source)
  return {
    rating: {
      overall: ratingCurrent ?? ratingPrevious ?? 0,
      votes: votesCurrent ?? votesPrevious ?? 0,
      scale: 5,
      lastChecked: obj.lastChecked ? String(obj.lastChecked) : '',
      source: obj.source ? String(obj.source) : '',
      storeId: null,
    },

    // 스냅샷 원본도 유지(향후 확장 대비)
    lastChecked: obj.lastChecked ? String(obj.lastChecked) : null,
    status: obj.status ? String(obj.status) : 'ok',
    source: obj.source ? String(obj.source) : '',

    ratingCurrent,
    votesCurrent,
    ratingPrevious,
    votesPrevious,
    ratingDiff: toNumberOrNull(obj.ratingDiff),
    votesDiff: toNumberOrNull(obj.votesDiff),

    histogram: clampHistogramPctObject(obj.histogram),

    insights: ins.all,
    insightsPositive: ins.pos,
    insightsNegative: ins.neg,
    insightsCounts: ins.counts,
  };
}

function normalizeFromFallback(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const ratingCurrent = toNumberOrNull(obj.rating ?? obj.score ?? obj.stars ?? obj.overall);
  const votesCurrent = toNumberOrNull(obj.votes ?? obj.ratingsCount ?? obj.count);

  if (ratingCurrent === null && votesCurrent === null) return null;

  const ins = normalizeInsightsBalanced(obj.insights);

  const source = obj.source ? String(obj.source) : '';

  return {
    rating: {
      overall: ratingCurrent ?? 0,
      votes: votesCurrent ?? 0,
      scale: Number(obj.scale || 5) || 5,
      lastChecked: obj.lastChecked ? String(obj.lastChecked) : '',
      source,
      storeId: obj.storeId ?? null,
    },

    lastChecked: obj.lastChecked ? String(obj.lastChecked) : null,
    status: obj.status ? String(obj.status) : 'ok',
    source,

    ratingCurrent,
    votesCurrent,
    ratingPrevious: null,
    votesPrevious: null,
    ratingDiff: null,
    votesDiff: null,

    histogram: clampHistogramPctObject(obj.histogram),

    insights: ins.all,
    insightsPositive: ins.pos,
    insightsNegative: ins.neg,
    insightsCounts: ins.counts,
  };
}

/* ------------------------------ main ------------------------------ */

function resolveReviewData({ ROOT, postJson }) {
  try {
    if (!postJson || typeof postJson !== 'object') return null;

    const label = (postJson.label || postJson.mainLabel || (postJson.labels && postJson.labels[0]) || '').toString();
    if (!isReviewLabel(label)) return null;

    const slug = String(postJson.slug || '').trim();

    // 1) SSOT 우선
    if (slug) {
      const ssot = readSsotOnce(ROOT);

      const found =
        (ssot && ssot.bySlug && typeof ssot.bySlug === 'object' && ssot.bySlug[slug]) ||
        (ssot && ssot[slug]) ||
        null;

      const normalized = normalizeFromSnapshot(found);
      if (normalized) return normalized;
    }

    // 2) fallback
    return normalizeFromFallback(postJson.review || postJson.reviews || null);
  } catch {
    return null;
  }
}

module.exports = { resolveReviewData };
