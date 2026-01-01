#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/review-resolver.cjs
 *
 * - 라벨(리뷰 3종) 기준으로 bucket(app/device/subscription) 선택
 * - content/reviews/{bucket}-ratings.json + {bucket}-insights.json 을 읽어서
 *   content/posts/*.json 에 post.reviewData 로 주입한다.
 *
 * ✅ render-posts.cjs 는 post.reviewData || post.review 를 읽으므로
 *   렌더 연결은 여기서 끝(SSOT).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const REVIEWS_DIR = path.join(ROOT, 'content', 'reviews');

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
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
  return new Date(dateStr + 'T00:00:00+09:00');
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateStr, days) {
  const d = parseKstDate(dateStr);
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

function toKstIso(dateStr) {
  return `${dateStr}T00:00:00+09:00`;
}

function findRatingsPath(bucket) {
  return path.join(REVIEWS_DIR, `${bucket}-ratings.json`);
}

function findInsightsPath(bucket) {
  return path.join(REVIEWS_DIR, `${bucket}-insights.json`);
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
      lastChecked: lastChecked ? toKstIso(lastChecked) : '',
      nextCheck: nextCheck ? toKstIso(nextCheck) : '',
      platform: rec.store || rec.platform || '',
      source: rec.source || '',
      storeId: rec.storeId || null
    },
    histogram: rec.histogram || null
  };
}

function normalizeInsightsRecord(rec) {
  if (!rec || typeof rec !== 'object') return [];
  const list = Array.isArray(rec.insights) ? rec.insights : [];
  return list.map(x => String(x || '').trim()).filter(Boolean).slice(0, 12);
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[review-resolver] ROOT      =', ROOT);
  console.log('[review-resolver] POSTS_DIR =', POSTS_DIR);
  console.log('[review-resolver] REVIEWS   =', REVIEWS_DIR);

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
    if (!bucket) continue;

    matched++;

    const slug = post.slug || path.basename(f, '.json');
    const ratingsPath = findRatingsPath(bucket);
    const insightsPath = findInsightsPath(bucket);

    const ratingsDb = readJsonSafe(ratingsPath, { bySlug: {} });
    const insightsDb = readJsonSafe(insightsPath, { bySlug: {} });

    const rRec = ratingsDb?.bySlug?.[slug] || null;
    const iRec = insightsDb?.bySlug?.[slug] || null;

    const ratingNorm = normalizeRatingRecord(rRec);
    const insightsNorm = normalizeInsightsRecord(iRec);

    // 아무 데이터도 없으면 기존 reviewData를 건드리지 않음(빈 주입 금지)
    if (!ratingNorm && insightsNorm.length === 0) continue;

    const next = {
      bucket,
      source: rRec?.source || '',
      rating: ratingNorm ? ratingNorm.rating : undefined,
      histogram: ratingNorm ? ratingNorm.histogram : undefined,
      insights: insightsNorm
    };

    Object.keys(next).forEach(k => {
      if (next[k] === undefined) delete next[k];
    });

    const prev = JSON.stringify(post.reviewData || {});
    const now = JSON.stringify(next);

    if (prev !== now) {
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
