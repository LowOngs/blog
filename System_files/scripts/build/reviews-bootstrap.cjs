#!/usr/bin/env node
'use strict';

/**
 * reviews-bootstrap.cjs
 * - content/posts/*.json 스캔 → 리뷰라벨(app/device/subscription)별로
 *   content/reviews/{bucket}-ratings.json
 *   content/reviews/{bucket}-insights.json
 *   content/reviews/{bucket}-ratings-next.json
 *   를 "생성/병합"한다.
 *
 * ✅ 핵심 원칙
 * - 기존 파일/기존 bySlug/기존 레코드는 절대 덮어쓰지 않는다(보존).
 * - 없는 slug만 기본 알맹이(템플릿 레코드)로 자동 주입한다.
 * - 다음 단계 테스트를 위해 next에도 동일 slug를 자동 주입한다(빈 알맹이 or 기본값).
 *
 * 사용:
 *   node scripts/build/reviews-bootstrap.cjs
 *
 * 옵션:
 *   FORCE_FILL=1  → 기존 레코드가 있어도, 필수필드가 비었으면 최소값 채움(완전 덮어쓰기 X)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const REVIEWS_DIR = path.join(ROOT, 'content', 'reviews');

const FORCE_FILL = String(process.env.FORCE_FILL || '') === '1';

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error('[reviews-bootstrap] JSON 파싱 실패:', p, e.message);
    console.error('[reviews-bootstrap] 기존 파일을 보존하기 위해 종료합니다.');
    process.exit(1);
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

function todayKstYmd() {
  // 환경/타임존 꼬임 방지: +09:00 기준 문자열 생성
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function ensureBySlug(obj) {
  if (!obj || typeof obj !== 'object') obj = {};
  if (!obj.bySlug || typeof obj.bySlug !== 'object') obj.bySlug = {};
  return obj;
}

/** 기본 rating 레코드(테스트 가능한 최소 알맹이) */
function defaultRatingRecord(bucket) {
  // bucket별 플랫폼 힌트(프레시니스 근거지 분리 목적 반영)
  // app: store = multi (Play/App Store)
  // device: store = retail (Amazon/BestBuy 등)
  // subscription: store = vendor (공식 사이트/가격페이지)
  const store =
    bucket === 'app' ? 'multi'
    : bucket === 'device' ? 'retail'
    : 'vendor';

  return {
    lastChecked: todayKstYmd(),
    status: 'todo',
    store,
    source: '',

    ratingCurrent: 0,
    ratingPrevious: 0,
    ratingDiff: 0,

    votesCurrent: 0,
    votesPrevious: 0,
    votesDiff: 0,

    histogram: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },

    // 이 필드는 ratings에 두지 않아도 되지만, 운영 편의상 둬도 무방
    // (blocks는 reviewData.insights만 씀 / resolver가 insights.json에서 가져옴)
  };
}

/** 기본 insights 레코드(테스트 가능한 최소 알맹이) */
function defaultInsightsRecord() {
  return {
    lastChecked: todayKstYmd(),
    status: 'todo',
    insights: []
  };
}

/** FORCE_FILL일 때만, "비어있는 필수키"를 최소값으로 채움(덮어쓰기 X) */
function fillMissingRatingMin(bucket, rec) {
  if (!rec || typeof rec !== 'object') return defaultRatingRecord(bucket);
  const base = defaultRatingRecord(bucket);

  for (const k of Object.keys(base)) {
    if (rec[k] === undefined || rec[k] === null || rec[k] === '') rec[k] = base[k];
  }
  // histogram 보정
  if (!rec.histogram || typeof rec.histogram !== 'object') rec.histogram = base.histogram;
  for (const s of ['1','2','3','4','5']) {
    const v = rec.histogram[s];
    if (!Number.isFinite(Number(v))) rec.histogram[s] = 0;
  }
  return rec;
}

function fillMissingInsightsMin(rec) {
  if (!rec || typeof rec !== 'object') return defaultInsightsRecord();
  if (!rec.lastChecked) rec.lastChecked = todayKstYmd();
  if (!rec.status) rec.status = 'todo';
  if (!Array.isArray(rec.insights)) rec.insights = [];
  return rec;
}

function filePaths(bucket) {
  return {
    ratings: path.join(REVIEWS_DIR, `${bucket}-ratings.json`),
    insights: path.join(REVIEWS_DIR, `${bucket}-insights.json`),
    next: path.join(REVIEWS_DIR, `${bucket}-ratings-next.json`)
  };
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[reviews-bootstrap] ROOT      =', ROOT);
  console.log('[reviews-bootstrap] POSTS_DIR =', POSTS_DIR);
  console.log('[reviews-bootstrap] REVIEWS   =', REVIEWS_DIR);
  console.log('[reviews-bootstrap] FORCE_FILL=', FORCE_FILL ? '1' : '0');

  ensureDir(REVIEWS_DIR);

  if (!fs.existsSync(POSTS_DIR)) {
    console.log('[reviews-bootstrap] posts dir 없음 → 종료');
    process.exit(0);
  }

  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json')).sort();

  // bucket별 slug 수집
  const bucketSlugs = { app: [], device: [], subscription: [] };

  for (const f of files) {
    const p = path.join(POSTS_DIR, f);
    const post = readJsonSafe(p, null);
    if (!post || typeof post !== 'object') continue;

    const bucket = labelToBucket(firstLabel(post));
    if (!bucket) continue;

    const slug = post.slug || path.basename(f, '.json');
    if (!slug) continue;

    bucketSlugs[bucket].push(slug);
  }

  // 중복 제거
  for (const b of Object.keys(bucketSlugs)) {
    bucketSlugs[b] = Array.from(new Set(bucketSlugs[b]));
  }

  const buckets = ['app', 'device', 'subscription'];

  for (const bucket of buckets) {
    const slugs = bucketSlugs[bucket];
    const { ratings, insights, next } = filePaths(bucket);

    let ratingsDb = ensureBySlug(readJsonSafe(ratings, { bySlug: {} }));
    let insightsDb = ensureBySlug(readJsonSafe(insights, { bySlug: {} }));
    let nextDb = ensureBySlug(readJsonSafe(next, { bySlug: {} }));

    let addedR = 0, addedI = 0, addedN = 0, filled = 0;

    for (const slug of slugs) {
      if (!ratingsDb.bySlug[slug]) {
        ratingsDb.bySlug[slug] = defaultRatingRecord(bucket);
        addedR++;
      } else if (FORCE_FILL) {
        const before = JSON.stringify(ratingsDb.bySlug[slug]);
        ratingsDb.bySlug[slug] = fillMissingRatingMin(bucket, ratingsDb.bySlug[slug]);
        if (JSON.stringify(ratingsDb.bySlug[slug]) !== before) filled++;
      }

      if (!insightsDb.bySlug[slug]) {
        insightsDb.bySlug[slug] = defaultInsightsRecord();
        addedI++;
      } else if (FORCE_FILL) {
        const before = JSON.stringify(insightsDb.bySlug[slug]);
        insightsDb.bySlug[slug] = fillMissingInsightsMin(insightsDb.bySlug[slug]);
        if (JSON.stringify(insightsDb.bySlug[slug]) !== before) filled++;
      }

      // next는 “최신 스냅샷 임시 저장” 용도지만,
      // 테스트를 빨리 하려면 slug 키만이라도 같이 만들어두는 게 편합니다.
      if (!nextDb.bySlug[slug]) {
        nextDb.bySlug[slug] = defaultRatingRecord(bucket);
        nextDb.bySlug[slug].status = 'todo-next';
        addedN++;
      } else if (FORCE_FILL) {
        const before = JSON.stringify(nextDb.bySlug[slug]);
        nextDb.bySlug[slug] = fillMissingRatingMin(bucket, nextDb.bySlug[slug]);
        if (JSON.stringify(nextDb.bySlug[slug]) !== before) filled++;
      }
    }

    writeJsonPretty(ratings, ratingsDb);
    writeJsonPretty(insights, insightsDb);
    writeJsonPretty(next, nextDb);

    console.log('────────────────────────────────────────────');
    console.log(`[reviews-bootstrap] bucket=${bucket}`);
    console.log(`  slugs=${slugs.length}`);
    console.log(`  +ratings  added=${addedR}`);
    console.log(`  +insights added=${addedI}`);
    console.log(`  +next     added=${addedN}`);
    console.log(`  filled(min)=${filled}`);
    console.log(`  saved: ${path.basename(ratings)}, ${path.basename(insights)}, ${path.basename(next)}`);
  }

  console.log('────────────────────────────────────────────');
  console.log('[reviews-bootstrap] 완료');
  console.log('다음: node scripts/build/review-resolver.cjs 실행 → post.reviewData 주입 후 렌더 테스트');
}

if (require.main === module) main();
