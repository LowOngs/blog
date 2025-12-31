'use strict';

const fs = require('fs');
const path = require('path');

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function getMainLabel(postJson) {
  const labels = Array.isArray(postJson?.labels) ? postJson.labels : [];
  return String(labels[0] || '').trim();
}

function labelToBucket(mainLabel) {
  if (mainLabel === 'app-reviews') return 'app';
  if (mainLabel === 'device-reviews') return 'device';
  if (mainLabel === 'subscription-services') return 'subscription';
  return '';
}

function toKstIso(dateStrYYYYMMDD) {
  if (!dateStrYYYYMMDD) return '';
  // '2025-12-13' -> '2025-12-13T00:00:00+09:00'
  return `${dateStrYYYYMMDD}T00:00:00+09:00`;
}

function pickBySlugDataset(obj, slug) {
  // review-ratings-next.json 스타일: { bySlug: { slug: {...} } }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.bySlug && obj.bySlug[slug]) return obj.bySlug[slug];
  if (obj[slug]) return obj[slug];
  return null;
}

function normalizeHistogram(hist) {
  const out = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  for (const k of [5, 4, 3, 2, 1]) {
    const v = hist?.[String(k)] ?? hist?.[k];
    const n = Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0;
    out[k] = n;
  }
  return out;
}

/**
 * blocks.js가 기대하는 공통 포맷으로 반환:
 * {
 *   rating: number,
 *   votes: number,
 *   updatedAt: 'YYYY-MM-DD' or ISO,
 *   source: string,
 *   histogram: {1..5},
 *   insights: string[]
 * }
 */
function resolveReviewData({ ROOT, postJson }) {
  const slug = postJson?.slug;
  if (!slug) return null;

  const mainLabel = getMainLabel(postJson);
  const bucket = labelToBucket(mainLabel);
  if (!bucket) return null;

  const ratingsPath = path.join(ROOT, 'content', 'reviews', bucket, 'ratings.json');
  const insightsPath = path.join(ROOT, 'content', 'reviews', bucket, 'insights.json');

  const ratingsRaw = readJsonSafe(ratingsPath, null);
  const insightsRaw = readJsonSafe(insightsPath, null);

  const r = pickBySlugDataset(ratingsRaw, slug);
  const i = pickBySlugDataset(insightsRaw, slug);

  // ratings.json이 없거나 항목이 없으면 null
  if (!r && !i) return null;

  const rating = Number(r?.ratingCurrent ?? r?.rating ?? r?.overall);
  const votes = Number(r?.votesCurrent ?? r?.votes ?? 0);
  const lastChecked = String(r?.lastChecked || r?.updatedAt || r?.lastUpdated || '').slice(0, 10);

  const histogram = r?.histogram ? normalizeHistogram(r.histogram) : null;

  const insights = Array.isArray(i?.insights)
    ? i.insights
    : Array.isArray(r?.insights)
      ? r.insights
      : [];

  // updatedAt은 blocks에서 문자열로 표시만 하므로 YYYY-MM-DD면 충분
  const updatedAt = lastChecked || '';

  const source =
    String(r?.store || r?.source || '') ||
    `${bucket}-dataset`;

  const out = {
    rating: Number.isFinite(rating) ? rating : NaN,
    votes: Number.isFinite(votes) ? votes : 0,
    updatedAt,
    source,
    histogram: histogram || null,
    insights: Array.isArray(insights) ? insights.filter(Boolean).slice(0, 12) : [],
    // nextCheck 같은 프레시니스용 확장 필드도 여기서 추가 가능(렌더에서 표시할 때 사용)
    lastCheckedIso: lastChecked ? toKstIso(lastChecked) : '',
  };

  // rating이 완전히 없고 insights만 있으면 rating은 NaN 그대로 두고 insights만 표시
  return out;
}

module.exports = { resolveReviewData };
