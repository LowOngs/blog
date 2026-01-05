#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/review-resolver.cjs
 * - render-posts.cjs에서 호출하는 "resolveReviewData"를 제공하는 모듈
 *
 * ✅ 정책
 * - 리뷰 SSOT(단일 소스) 우선: content/reviews/review-ratings.json
 * - 없으면 postJson.review / postJson.reviews (있을 때만) fallback
 * - 리뷰 라벨이 아니면 null 반환(리뷰 블록 미출력)
 */

const fs = require('fs');
const path = require('path');

function readJsonSafe(p) {
  try {
    if (!p) return null;
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function toNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeReview(obj) {
  if (!obj || typeof obj !== 'object') return null;

  // 허용 필드(필요 최소)
  const rating = toNumberOrNull(obj.rating ?? obj.score ?? obj.stars);
  const scale = toNumberOrNull(obj.scale ?? obj.outOf ?? 5) ?? 5;

  const summary = (obj.summary || obj.oneLine || obj.verdict || '').toString().trim();
  const pros = asArray(obj.pros).map(String).map(s => s.trim()).filter(Boolean);
  const cons = asArray(obj.cons).map(String).map(s => s.trim()).filter(Boolean);

  // insights: 문자열 배열로만 통일
  const insights = asArray(obj.insights).flatMap((x) => {
    if (!x) return [];
    if (typeof x === 'string') return [x.trim()];
    if (typeof x === 'object') {
      // { text } 또는 { note } 같은 흔한 형태를 흡수
      const t = (x.text || x.note || x.value || '').toString().trim();
      return t ? [t] : [];
    }
    return [];
  }).filter(Boolean).slice(0, 12);

  // sources: URL 배열 또는 {name,url} 배열이 섞여도 URL만 추출
  const sources = asArray(obj.sources).flatMap((x) => {
    if (!x) return [];
    if (typeof x === 'string') return [x.trim()];
    if (typeof x === 'object') {
      const u = (x.url || x.href || '').toString().trim();
      return u ? [u] : [];
    }
    return [];
  }).filter(Boolean).slice(0, 20);

  // rating이 아예 없고, summary/insights/pros/cons도 없으면 "없음" 취급
  if (rating === null && !summary && pros.length === 0 && cons.length === 0 && insights.length === 0) {
    return null;
  }

  return {
    rating,     // number|null
    scale,      // number (default 5)
    summary,    // string
    pros,       // string[]
    cons,       // string[]
    insights,   // string[]
    sources,    // string[]
  };
}

function isReviewLabel(label) {
  const v = String(label || '').trim().toLowerCase();
  return v === 'app-reviews' || v === 'device-reviews' || v === 'subscription-services';
}

/**
 * ✅ render-posts.cjs에서 호출하는 함수
 * @param {object} ctx
 * @param {string} ctx.ROOT - System_files 절대 경로
 * @param {object} ctx.postJson - content/posts/*.json 파싱 객체
 * @returns {object|null} normalized review object
 */
function resolveReviewData({ ROOT, postJson }) {
  try {
    if (!postJson || typeof postJson !== 'object') return null;

    const label = (postJson.label || postJson.mainLabel || (postJson.labels && postJson.labels[0]) || '').toString();
    if (!isReviewLabel(label)) return null;

    const slug = (postJson.slug || '').toString().trim();
    if (!slug) {
      // slug 없으면 fallback review만 시도
      const fallback = normalizeReview(postJson.review || postJson.reviews || null);
      return fallback;
    }

    // 1) SSOT 파일: content/reviews/review-ratings.json
    const ssotPath = path.join(ROOT, 'content', 'reviews', 'review-ratings.json');
    const ssot = readJsonSafe(ssotPath);

    // 기대 형태:
    //  - { bySlug: { [slug]: {...} } }  또는
    //  - { [slug]: {...} }
    let found = null;
    if (ssot && typeof ssot === 'object') {
      if (ssot.bySlug && typeof ssot.bySlug === 'object' && ssot.bySlug[slug]) found = ssot.bySlug[slug];
      else if (ssot[slug]) found = ssot[slug];
    }

    const normalized = normalizeReview(found);
    if (normalized) return normalized;

    // 2) fallback: postJson에 리뷰가 직접 들어있는 경우
    return normalizeReview(postJson.review || postJson.reviews || null);
  } catch {
    return null;
  }
}

module.exports = { resolveReviewData };

/* ───────────────────── 단독 실행(디버그용) ───────────────────── */
if (require.main === module) {
  const ROOT = path.resolve(__dirname, '..', '..'); // System_files
  console.log('[review-resolver] ROOT =', ROOT);
  const p = path.join(ROOT, 'content', 'reviews', 'review-ratings.json');
  console.log('[review-resolver] SSOT =', p, fs.existsSync(p) ? '(found)' : '(missing)');
}
