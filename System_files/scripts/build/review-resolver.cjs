'use strict';

/**
 * System_files/scripts/build/review-resolver.cjs
 * - render-posts.cjs에서 호출하는 "resolveReviewData"를 제공하는 모듈
 *
 * ✅ 정책
 * - 리뷰 SSOT(단일 소스) 우선: content/reviews/review-ratings.json
 * - SSOT 스키마(스냅샷형): ratingCurrent/votesCurrent/ratingPrevious/.../histogram/insights
 * - 없으면 postJson.review / postJson.reviews (있을 때만) fallback
 * - 리뷰 라벨이 아니면 null 반환(리뷰 블록 미출력)
 *
 * ✅ insights 규칙(확정)
 * - 총 12개 "최대" (부족해도 출력)
 * - 긍정 최대 6, 부정 최대 6
 * - 한쪽이 부족하면 있는 만큼만 넣고, 다른 쪽은 최대 6까지
 * - 중립(neutral)은 남는 자리에 채우되 총 12개를 넘기지 않음
 * - 중복/의미없는 짧은 문장 제거, 실행마다 결과가 바뀌지 않게 결정론적 정렬
 */

const fs = require('fs');
const path = require('path');

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function asArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

function toNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeText(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[•·●\u2022]/g, '-') // 흔한 불릿 정리
    .trim();
}

function looksTooShort(s) {
  const t = normalizeText(s);
  // 너무 짧은 감탄사/빈약 문장 컷(기본 12자)
  if (t.length < 12) {
    // 숫자/에러/핵심 단어 있으면 예외
    if (/\d/.test(t)) return false;
    if (/(crash|bug|refund|slow|lag|scam|freeze|error|login|sync|billing|ads)/i.test(t)) return false;
    return true;
  }
  return false;
}

function dedupeTexts(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const t = normalizeText(raw);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;

    // 간단 유사 중복 컷(앞 30자 동일하면 중복 취급)
    const prefix = key.slice(0, 30);
    if (seen.has(prefix)) continue;

    seen.add(key);
    seen.add(prefix);
    out.push(t);
  }
  return out;
}

function inferSentiment(text) {
  const t = String(text || '').trim();
  const u = t.toLowerCase();

  // 1) 명시 프리픽스 우선
  if (/^(pro|positive|pos)\s*[:\-]/i.test(t)) return 'pos';
  if (/^(con|negative|neg)\s*[:\-]/i.test(t)) return 'neg';
  if (/^(neutral|note)\s*[:\-]/i.test(t)) return 'neu';

  // 2) 키워드(작게)
  const neg = /(crash|bug|refund|slow|lag|drain|scam|freeze|error|broken|ads|billing|cancel|spam)/i;
  const pos = /(fast|helpful|reliable|great|easy|simple|useful|love|smooth|accurate|works well)/i;

  const hasNeg = neg.test(u);
  const hasPos = pos.test(u);

  if (hasPos && !hasNeg) return 'pos';
  if (hasNeg && !hasPos) return 'neg';
  return 'neu';
}

function scoreInsight(text) {
  const t = String(text || '');
  let s = 0;
  if (/\d/.test(t)) s += 2; // 숫자/구체성
  if (t.length >= 40) s += 1; // 정보량
  if (/(crash|error|refund|sync|login|billing|battery|ads)/i.test(t)) s += 1; // 증거성 키워드
  return s;
}

function normalizeInsightsBalanced(v) {
  const rawList = asArray(v).flatMap((x) => {
    if (!x) return [];
    if (typeof x === 'string') return [x];
    if (typeof x === 'object') {
      const t = (x.text || x.note || x.value || x.title || '').toString();
      return t ? [t] : [];
    }
    return [];
  });

  // 1) 정리/컷
  const cleaned = dedupeTexts(rawList).filter((t) => !looksTooShort(t));
  if (cleaned.length === 0) {
    return { all: [], pos: [], neg: [], neu: [], counts: { pos: 0, neg: 0, neu: 0, total: 0 } };
  }

  // 2) 감정 분류 + 점수 부여 (결정론적 정렬)
  const items = cleaned.map((t) => ({
    text: t.replace(/^(pro|positive|pos|con|negative|neg|neutral|note)\s*[:\-]\s*/i, ''), // 프리픽스 제거
    kind: inferSentiment(t),
    score: scoreInsight(t),
  }));

  items.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.text.localeCompare(b.text, 'en');
  });

  const pos = [];
  const neg = [];
  const neu = [];

  for (const it of items) {
    if (it.kind === 'pos') pos.push(it.text);
    else if (it.kind === 'neg') neg.push(it.text);
    else neu.push(it.text);
  }

  // 3) 최종 선택: pos<=6, neg<=6, total<=12
  const posPick = pos.slice(0, 6);
  const negPick = neg.slice(0, 6);

  // 남는 자리 중립으로 채움
  const remain = Math.max(0, 12 - (posPick.length + negPick.length));
  const neuPick = neu.slice(0, remain);

  const all = [...posPick, ...negPick, ...neuPick].slice(0, 12);

  return {
    all,
    pos: posPick,
    neg: negPick,
    neu: neuPick,
    counts: {
      pos: posPick.length,
      neg: negPick.length,
      neu: neuPick.length,
      total: all.length,
    },
  };
}

function clampHistogramPctObject(hist) {
  if (!hist || typeof hist !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(hist)) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    // 0~100 범위로만 보정
    const pct = Math.max(0, Math.min(100, n));
    out[k] = pct;
  }
  return Object.keys(out).length ? out : null;
}

function isSsotSnapshotShape(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return (
    Object.prototype.hasOwnProperty.call(obj, 'ratingCurrent') ||
    Object.prototype.hasOwnProperty.call(obj, 'votesCurrent') ||
    Object.prototype.hasOwnProperty.call(obj, 'ratingPrevious') ||
    Object.prototype.hasOwnProperty.call(obj, 'histogram')
  );
}

function normalizeFromSsotSnapshot(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const ins = normalizeInsightsBalanced(obj.insights);

  const ratingCurrent = toNumberOrNull(obj.ratingCurrent);
  const votesCurrent = toNumberOrNull(obj.votesCurrent);
  const ratingPrevious = toNumberOrNull(obj.ratingPrevious);
  const votesPrevious = toNumberOrNull(obj.votesPrevious);
  const ratingDiff = toNumberOrNull(obj.ratingDiff);
  const votesDiff = toNumberOrNull(obj.votesDiff);

  // rating/votes 둘 다 없으면 무효
  if (
    ratingCurrent === null &&
    votesCurrent === null &&
    ratingPrevious === null &&
    votesPrevious === null
  ) {
    return null;
  }

  return {
    lastChecked: obj.lastChecked ? String(obj.lastChecked) : null,
    status: obj.status ? String(obj.status) : 'ok',
    store: obj.store ? String(obj.store) : 'multi',

    ratingCurrent,
    votesCurrent,
    ratingPrevious,
    votesPrevious,
    ratingDiff,
    votesDiff,

    histogram: clampHistogramPctObject(obj.histogram),
    insights: ins.all, // ✅ 총 12개 "최대"
    insightsPositive: ins.pos,
    insightsNegative: ins.neg,
    insightsNeutral: ins.neu,
    insightsCounts: ins.counts,
  };
}

function normalizeFromFallbackReview(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const ins = normalizeInsightsBalanced(obj.insights);

  const ratingCurrent = toNumberOrNull(obj.rating ?? obj.score ?? obj.stars ?? obj.overall);
  const votesCurrent = toNumberOrNull(obj.votes ?? obj.ratingsCount ?? obj.count);

  if (ratingCurrent === null && votesCurrent === null) return null;

  return {
    lastChecked: obj.lastChecked ? String(obj.lastChecked) : null,
    status: obj.status ? String(obj.status) : 'ok',
    store: obj.store ? String(obj.store) : 'multi',

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
    insightsNeutral: ins.neu,
    insightsCounts: ins.counts,
  };
}

function isReviewLabel(label) {
  const v = String(label || '').trim().toLowerCase();
  return v === 'app-reviews' || v === 'device-reviews' || v === 'subscription-services';
}

// SSOT 캐시(프로세스 내 1회 로드)
let _ssotCache = null;
let _ssotCachePath = null;

function readSsotOnce(ROOT) {
  const ssotPath = path.join(ROOT, 'content', 'reviews', 'review-ratings.json');
  if (_ssotCache && _ssotCachePath === ssotPath) return _ssotCache;

  const parsed = readJsonSafe(ssotPath);
  _ssotCache = parsed;
  _ssotCachePath = ssotPath;
  return _ssotCache;
}

function resolveReviewData({ ROOT, postJson }) {
  try {
    if (!postJson || typeof postJson !== 'object') return null;

    const label = (postJson.label || postJson.mainLabel || (postJson.labels && postJson.labels[0]) || '').toString();
    if (!isReviewLabel(label)) return null;

    const slug = (postJson.slug || '').toString().trim();
    if (!slug) {
      // slug 없으면 fallback review만 시도
      return normalizeFromFallbackReview(postJson.review || postJson.reviews || null);
    }

    // 1) SSOT 파일: content/reviews/review-ratings.json
    const ssot = readSsotOnce(ROOT);

    // 기대 형태:
    //  - { bySlug: { [slug]: {...} } }  또는
    //  - { [slug]: {...} }
    let found = null;
    if (ssot && typeof ssot === 'object') {
      if (ssot.bySlug && typeof ssot.bySlug === 'object' && ssot.bySlug[slug]) found = ssot.bySlug[slug];
      else if (ssot[slug]) found = ssot[slug];
    }

    // ✅ SSOT 스냅샷형 우선 처리
    if (found && isSsotSnapshotShape(found)) {
      const normalized = normalizeFromSsotSnapshot(found);
      if (normalized) return normalized;
      // normalized가 null이면 fallback로 시도
    }

    // 2) fallback: postJson에 리뷰가 직접 들어있는 경우
    return normalizeFromFallbackReview(postJson.review || postJson.reviews || null);
  } catch {
    return null;
  }
}

module.exports = { resolveReviewData };
