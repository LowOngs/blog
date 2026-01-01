#!/usr/bin/env node
'use strict';

/**
 * reviews-seed-sample.cjs
 *
 * 목적:
 * - content/posts/*.json 를 스캔해서 리뷰 라벨 3종(app/device/subscription)의 slug 목록을 뽑는다.
 * - content/reviews/{bucket}-ratings.json, {bucket}-insights.json 에
 *   bySlug 스켈레톤을 "덮어쓰기"가 아니라 "병합(merge)"으로 채운다.
 * - 그리고 각 버킷별로 1개 slug에만 샘플 알맹이(별점/인사이트)를 자동 주입해서
 *   review-resolver.cjs 실행 시 갱신=1 이상이 뜨게 만든다.
 *
 * 주의:
 * - 기존 파일을 절대 초기화하지 않는다(merge).
 * - 샘플 알맹이는 bucket당 1개 slug에만 넣는다(테스트용).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const REVIEWS_DIR = path.join(ROOT, 'content', 'reviews');

const BUCKETS = ['app', 'device', 'subscription'];

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

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

function todayKstYYYYMMDD() {
  // 로컬 시간이 KST일 가능성이 높지만, 포맷만 필요하니 단순화
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function ensureDbShape(obj) {
  if (!obj || typeof obj !== 'object') obj = {};
  if (!obj.bySlug || typeof obj.bySlug !== 'object') obj.bySlug = {};
  return obj;
}

function ratingsPath(bucket) {
  return path.join(REVIEWS_DIR, `${bucket}-ratings.json`);
}

function insightsPath(bucket) {
  return path.join(REVIEWS_DIR, `${bucket}-insights.json`);
}

function seedSkeletonOnly(db, slugs) {
  // bySlug[slug] 없으면 빈 객체만 만들어 둔다 (merge)
  for (const slug of slugs) {
    if (!db.bySlug[slug]) db.bySlug[slug] = {};
  }
}

function injectSampleIfEmpty(dbRatings, dbInsights, slug, bucket) {
  // 이미 ratingCurrent 등이 들어있으면 샘플 주입하지 않음
  const r = dbRatings.bySlug[slug] || {};
  const hasRating = Number.isFinite(Number(r.ratingCurrent));
  const i = dbInsights.bySlug[slug] || {};
  const hasInsights = Array.isArray(i.insights) && i.insights.length > 0;

  if (!hasRating) {
    dbRatings.bySlug[slug] = {
      lastChecked: todayKstYYYYMMDD(),
      status: 'ok',
      store: bucket === 'app' ? 'multi' : bucket, // 구분용
      ratingCurrent: bucket === 'subscription' ? 4.3 : bucket === 'device' ? 4.5 : 4.6,
      votesCurrent: bucket === 'subscription' ? 2300 : bucket === 'device' ? 5400 : 12000,
      histogram: { '1': 2, '2': 2, '3': 6, '4': 18, '5': 72 },
      source: 'sample',
      storeId: null
    };
  } else {
    // 기존값 유지
    dbRatings.bySlug[slug] = r;
  }

  if (!hasInsights) {
    dbInsights.bySlug[slug] = {
      insights: [
        'Sample insight 1 (remove later)',
        'Sample insight 2 (remove later)',
        'Sample insight 3 (remove later)'
      ]
    };
  } else {
    dbInsights.bySlug[slug] = i;
  }
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[reviews-seed] ROOT      =', ROOT);
  console.log('[reviews-seed] POSTS_DIR =', POSTS_DIR);
  console.log('[reviews-seed] REVIEWS   =', REVIEWS_DIR);
  console.log('────────────────────────────────────────────');

  if (!fs.existsSync(POSTS_DIR)) {
    console.log('[reviews-seed] posts dir 없음 → 종료');
    process.exit(0);
  }

  ensureDir(REVIEWS_DIR);

  // 1) 리뷰 라벨 slug 수집
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json')).sort();
  const bucketToSlugs = { app: [], device: [], subscription: [] };

  for (const f of files) {
    const p = path.join(POSTS_DIR, f);
    const post = readJsonSafe(p, null);
    if (!post || typeof post !== 'object') continue;

    const bucket = labelToBucket(firstLabel(post));
    if (!bucket) continue;

    const slug = post.slug || path.basename(f, '.json');
    bucketToSlugs[bucket].push(slug);
  }

  // 2) 각 버킷 파일 merge + skeleton + 샘플 1건 주입
  for (const bucket of BUCKETS) {
    const slugs = bucketToSlugs[bucket];
    const rPath = ratingsPath(bucket);
    const iPath = insightsPath(bucket);

    const dbRatings = ensureDbShape(readJsonSafe(rPath, { bySlug: {} }));
    const dbInsights = ensureDbShape(readJsonSafe(iPath, { bySlug: {} }));

    seedSkeletonOnly(dbRatings, slugs);
    seedSkeletonOnly(dbInsights, slugs);

    // 샘플 1건: 가장 첫 slug에만 알맹이 주입
    if (slugs.length > 0) {
      const sampleSlug = slugs[0];
      injectSampleIfEmpty(dbRatings, dbInsights, sampleSlug, bucket);
      console.log(`[reviews-seed] ${bucket}: slugs=${slugs.length}, sample=${sampleSlug}`);
    } else {
      console.log(`[reviews-seed] ${bucket}: slugs=0 (skip)`);
    }

    writeJsonPretty(rPath, dbRatings);
    writeJsonPretty(iPath, dbInsights);
  }

  console.log('────────────────────────────────────────────');
  console.log('[reviews-seed] 완료');
  console.log('다음 실행: node .\\System_files\\scripts\\build\\review-resolver.cjs');
}

if (require.main === module) main();
