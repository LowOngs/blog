#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/review-resolver.cjs
 *
 * 목적
 * - 리뷰 라벨 3종(app/device/subscription)에 대해
 *   content/reviews/{bucket}-ratings.json + {bucket}-insights.json 을 읽어
 *   content/posts/*.json 에 post.reviewData 로 주입한다. (SSOT)
 *
 * 전제(옹스님 현재 구조)
 * - content/reviews/
 *   - app-ratings.json
 *   - device-ratings.json
 *   - subscription-ratings.json
 *   - app-insights.json
 *   - device-insights.json
 *   - subscription-insights.json
 *
 * 데이터 키(권장 표준)
 * - ratings: { bySlug: { [slug]: { lastChecked:'YYYY-MM-DD', ratingCurrent:number, votesCurrent:number, histogram:{1..5}, store?, source?, storeId? } } }
 * - insights:{ bySlug: { [slug]: { insights:[...strings], lastChecked?:'YYYY-MM-DD', source? } } }
 *
 * 출력
 * - post.reviewData = {
 *     bucket: 'app'|'device'|'subscription',
 *     source: '...',
 *     rating: { overall, votes, scale, lastChecked, nextCheck, platform, source, storeId },
 *     histogram: {1..5} | null,
 *     insights: [ ... ]
 *   }
 *
 * 안전장치
 * - rating/insights 둘 다 완전 빈 경우: 기존 reviewData를 건드리지 않음(빈 주입 금지)
 * - undefined 필드는 제거하여 JSON 안정성 유지
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const REVIEWS_DIR = path.join(ROOT, 'content', 'reviews');

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf8');
    const s = (raw || '').trim();
    if (!s) return fallback;
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function writeJsonPretty(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function firstLabel(post) {
  const labels = asArray(post.labels);
  return labels[0] || '';
}

function labelToBucket(label) {
  if (label === 'app-reviews') return 'app';
  if (label === 'device-reviews') return 'device';
  if (label === 'subscription-services') return 'subscription';
  return '';
}

function parseKstDate(dateStr) {
  // 'YYYY-MM-DD' → Date(+09:00)
  return new Date(`${dateStr}T00:00:00+09:00`);
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateStr, days) {
  const d = parseKstDate(dateStr);
  if (!Number.isFinite(d.getTime())) return '';
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

function toKstIso(dateStr) {
  // 'YYYY-MM-DD' → 'YYYY-MM-DDT00:00:00+09:00'
  return dateStr ? `${dateStr}T00:00:00+09:00` : '';
}

function ratingsPath(bucket) {
  // 지금은 content/reviews/{bucket}-ratings.json 고정
  return path.join(REVIEWS_DIR, `${bucket}-ratings.json`);
}

function insightsPath(bucket) {
  return path.join(REVIEWS_DIR, `${bucket}-insights.json`);
}

function normalizeHistogram(hist) {
  if (!hist || typeof hist !== 'object') return null;
  const out = {};
  for (const k of ['1', '2', '3', '4', '5']) {
    if (hist[k] === undefined && hist[Number(k)] === undefined) continue;
    const v = hist[k] !== undefined ? hist[k] : hist[Number(k)];
    const n = Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0;
    out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeRatingRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;

  const lastChecked = typeof rec.lastChecked === 'string' ? rec.lastChecked : '';
  const nextCheck = typeof rec.nextCheck === 'string'
    ? rec.nextCheck
    : (lastChecked ? addDays(lastChecked, 90) : '');

  const ratingCurrent = Number(rec.ratingCurrent);
  if (!Number.isFinite(ratingCurrent)) return null;

  return {
    rating: {
      overall: ratingCurrent,
      votes: Number(rec.votesCurrent || 0) || 0,
      scale: 5,
      lastChecked: toKstIso(lastChecked),
      nextCheck: toKstIso(nextCheck),
      platform: rec.store || rec.platform || 'multi',
      source: rec.source || '',
      storeId: rec.storeId ?? null
    },
    histogram: normalizeHistogram(rec.histogram)
  };
}

function normalizeInsightsRecord(rec) {
  if (!rec || typeof rec !== 'object') return [];
  const list = Array.isArray(rec.insights) ? rec.insights : [];
  return list.map(x => String(x || '').trim()).filter(Boolean).slice(0, 12);
}

function dropUndefined(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) delete obj[k];
  }
  return obj;
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[review-resolver] ROOT      =', ROOT);
  console.log('[review-resolver] POSTS_DIR =', POSTS_DIR);
  console.log('[review-resolver] REVIEWS   =', REVIEWS_DIR);
  console.log('────────────────────────────────────────────');

  if (!fs.existsSync(POSTS_DIR)) {
    console.log('[review-resolver] posts dir 없음 → 종료');
    process.exit(0);
  }

  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json')).sort();

  let matched = 0;
  let touched = 0;

  for (const f of files) {
    const p = path.join(POSTS_DIR, f);
    const post = readJsonSafe(p, null);
    if (!post || typeof post !== 'object') continue;

    const label = firstLabel(post);
    const bucket = labelToBucket(label);
    if (!bucket) continue; // 리뷰 라벨 3종만

    matched++;

    const slug = post.slug || path.basename(f, '.json');

    const rDb = readJsonSafe(ratingsPath(bucket), { bySlug: {} });
    const iDb = readJsonSafe(insightsPath(bucket), { bySlug: {} });

    const rRec = rDb?.bySlug?.[slug] || null;
    const iRec = iDb?.bySlug?.[slug] || null;

    const ratingNorm = normalizeRatingRecord(rRec);
    const insightsNorm = normalizeInsightsRecord(iRec);

    // 둘 다 완전 빈 경우: 기존 reviewData 건드리지 않음
    if (!ratingNorm && insightsNorm.length === 0) continue;

    const next = {
      bucket,
      // 우선순위: ratings.source → insights.source → 기존 reviewData.source → ''
      source: (rRec && rRec.source) || (iRec && iRec.source) || (post.reviewData && post.reviewData.source) || '',
      rating: ratingNorm ? ratingNorm.rating : undefined,
      histogram: ratingNorm ? ratingNorm.histogram : undefined,
      insights: insightsNorm
    };

    dropUndefined(next);

    const prevStr = JSON.stringify(post.reviewData || {});
    const nextStr = JSON.stringify(next);

    if (prevStr !== nextStr) {
      post.reviewData = next;
      writeJsonPretty(p, post);
      touched++;
      console.log('[review-resolver] UPDATE:', slug, 'bucket=', bucket);
    }
  }

  console.log('────────────────────────────────────────────');
  console.log('[review-resolver] 대상(리뷰라벨) =', matched, '| 갱신 =', touched);
}

if (require.main === module) main();
