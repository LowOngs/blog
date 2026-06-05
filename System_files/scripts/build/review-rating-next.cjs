#!/usr/bin/env node
'use strict';

/**
 * ============================================================
 * System_files/scripts/build/review-rating-next.cjs
 * ============================================================
 *
 * 역할:
 * - dist/queue/today.expanded.json 을 기준으로
 *   "오늘 신규 생성된 리뷰 포스트"를 찾아
 *   content/reviews/review-ratings-next.json 에 신규 review stub를 연결한다.
 *
 * 왜 필요한가:
 * - queue-to-posts.cjs 는 신규 리뷰 post JSON까지는 생성하지만,
 *   review SSOT(next)로 넘기는 신규 전용 브리지 단계가 비어 있었다.
 * - 이 파일은 그 빈 단계만 담당한다.
 *
 * 입력:
 * - System_files/dist/queue/today.expanded.json
 * - System_files/content/posts/{slug}.json
 *
 * 출력:
 * - System_files/content/reviews/review-ratings-next.json
 * - System_files/content/reviews/{app|device|subscription}-ratings-next.json
 *
 * 정책:
 * 1) today.expanded.json 우선 사용
 * 2) generatedSlug 우선, 없으면 slug
 * 3) 리뷰 라벨(app/device/subscription)만 대상
 * 4) post JSON 에 reviewEntity 또는 seedMeta.entity 가 있어야 생성
 * 5) 기존 next 전체 초기화 금지
 * 6) bySlug[slug] 단위 멱등 갱신
 * 7) 이미 더 강한 데이터(실측치/공식 source)가 있으면 seed stub로 덮어쓰지 않음
 *
 * 중요:
 * - 이 파일은 실제 리뷰 수집기가 아니다.
 * - "신규 리뷰를 next SSOT 후보에 연결"만 담당한다.
 * - 실제 값 수집은 기존 fetch/update 파이프가 이어서 수행한다.
 *
 * [이번 국부 추가]
 * - 글로벌 next(review-ratings-next.json)뿐 아니라
 *   버킷 next(app/device/subscription-ratings-next.json)도 함께 동기화한다.
 * - 목적:
 *   - 신규 리뷰 브리지와 기존 버킷 기반 diff/update 흐름의 정합성 보강
 * - 원칙:
 *   - 기존 stronger data 보호 정책은 글로벌/버킷 next 모두 동일 적용
 *   - 없는 구조 생성 없이 기존 next shape(bySlug)만 유지
 */

require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const QUEUE_EXPANDED_PATH = path.join(ROOT, 'dist', 'queue', 'today.expanded.json');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const REVIEWS_DIR = path.join(ROOT, 'content', 'reviews');
const NEXT_PATH = path.join(REVIEWS_DIR, 'review-ratings-next.json');

const BUCKET_NEXT_PATHS = {
  app: path.join(REVIEWS_DIR, 'app-ratings-next.json'),
  device: path.join(REVIEWS_DIR, 'device-ratings-next.json'),
  subscription: path.join(REVIEWS_DIR, 'subscription-ratings-next.json'),
};

const REVIEW_LABELS = new Set([
  'app-reviews',
  'device-reviews',
  'subscription-services',
]);

function log(...a) {
  console.log('[review-rating-next]', ...a);
}

function warn(...a) {
  console.warn('[review-rating-next][WARN]', ...a);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function ensureNextShape(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { updatedAt: null, bySlug: {} };
  }
  if (!obj.bySlug || typeof obj.bySlug !== 'object' || Array.isArray(obj.bySlug)) {
    obj.bySlug = {};
  }
  if (!Object.prototype.hasOwnProperty.call(obj, 'updatedAt')) {
    obj.updatedAt = null;
  }
  return obj;
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function firstLabelFromPost(postJson) {
  const a = String(postJson?.label || '').trim();
  if (a) return a;
  const labels = asArray(postJson?.labels).map(x => String(x || '').trim()).filter(Boolean);
  if (labels.length) return labels[0];
  const b = String(postJson?.seedMeta?.label || '').trim();
  return b;
}

function isReviewLabel(label) {
  return REVIEW_LABELS.has(String(label || '').trim());
}

function resolveSlugFromQueueItem(item) {
  return String(item?.generatedSlug || item?.slug || '').trim();
}

function normalizeBucketFromLabel(label) {
  const v = String(label || '').trim();
  if (v === 'app-reviews') return 'app';
  if (v === 'device-reviews') return 'device';
  if (v === 'subscription-services') return 'subscription';
  return '';
}

function normalizeReviewEntity(postJson, queueItem = null) {
  const candidates = [
    queueItem?.reviewEntity,
    queueItem?.entity,
    queueItem?.seedMeta?.reviewEntity,
    queueItem?.seedMeta?.entity,
    postJson?.reviewEntity,
    postJson?.entity,
    postJson?.seedMeta?.reviewEntity,
    postJson?.seedMeta?.entity,
  ].filter(v => v && typeof v === 'object' && !Array.isArray(v));

  const e = candidates[0] || null;
  if (!e) return null;

  const type = String(e.type || '').trim().toLowerCase();
  const appId = String(e.appId || '').trim();
  const appName = String(e.appName || e.name || '').trim();
  const platform = String(e.platform || '').trim();
  const model = String(e.model || e.name || '').trim();
  const service = String(e.service || e.name || '').trim();

  let t = type;
  if (!t) {
    if (service && !model && !appId && !appName) t = 'subscription';
    else if (model) t = 'device';
    else if (appId || appName) t = 'app';
  }

  if (t === 'app') {
    if (appId) return { type: 'app', appId, platform, appName };
    if (appName) return { type: 'app', appName, platform };
    return null;
  }

  if (t === 'device') {
    if (model) return { type: 'device', model };
    return null;
  }

  if (t === 'subscription') {
    if (service) return { type: 'subscription', service };
    return null;
  }

  return null;
}

/**
 * 더 강한 데이터인지 판정
 * - 실제 수집/갱신으로 들어온 레코드를 seed stub가 덮어쓰면 안 된다.
 */
function hasMeaningfulRealData(rec) {
  if (!rec || typeof rec !== 'object') return false;

  const source = String(rec.source || '').trim().toLowerCase();
  if (source && source !== 'seed') return true;

  const ratingCurrent = Number(rec.ratingCurrent);
  if (Number.isFinite(ratingCurrent) && ratingCurrent > 0) return true;

  const votesCurrent = Number(rec.votesCurrent);
  if (Number.isFinite(votesCurrent) && votesCurrent > 0) return true;

  if (Array.isArray(rec.sources) && rec.sources.length > 0) return true;

  if (rec.lastChecked) return true;

  return false;
}

function extractStoreIdFromEntity(entity) {
  if (!entity || typeof entity !== 'object') return null;

  if (entity.type === 'app') {
    return entity.appId || entity.appName || null;
  }
  if (entity.type === 'device') {
    return entity.model || null;
  }
  if (entity.type === 'subscription') {
    return entity.service || null;
  }
  return null;
}

function buildSeedStubRecord({ postJson, label, entity }) {
  const bucket = normalizeBucketFromLabel(label);
  const reviewId = postJson?.reviewId ? String(postJson.reviewId) : null;
  const postId = postJson?.postId ? String(postJson.postId) : null;
  const storeId = extractStoreIdFromEntity(entity);

  return {
    reviewId,
    postId,
    lastChecked: null,
    status: 'queued',
    store: 'unknown',
    source: 'seed',
    storeId: storeId || null,
    ratingCurrent: 0,
    ratingPrevious: 0,
    ratingDiff: 0,
    votesCurrent: 0,
    votesPrevious: 0,
    votesDiff: 0,
    histogram: {
      '1': 0,
      '2': 0,
      '3': 0,
      '4': 0,
      '5': 0,
    },
    insights: [],
    sources: [],
    bucket,
  };
}

function upsertSeedStub(doc, slug, candidate) {
  const prev = doc.bySlug[slug];

  if (hasMeaningfulRealData(prev)) {
    return { action: 'keptStrong' };
  }

  const before = JSON.stringify(prev || null);
  const after = JSON.stringify(candidate);

  if (!prev) {
    doc.bySlug[slug] = candidate;
    return { action: 'created' };
  }

  if (before !== after) {
    doc.bySlug[slug] = candidate;
    return { action: 'updated' };
  }

  return { action: 'same' };
}

function touchUpdatedAt(doc) {
  doc.updatedAt = new Date().toISOString();
}

function main() {
  log('ROOT =', ROOT);
  log('QUEUE_EXPANDED =', QUEUE_EXPANDED_PATH);
  log('POSTS_DIR =', POSTS_DIR);
  log('NEXT_PATH =', NEXT_PATH);

  const expanded = readJsonSafe(QUEUE_EXPANDED_PATH, null);
  if (!expanded || typeof expanded !== 'object') {
    log('today.expanded.json 없음/파싱불가 → 스킵');
    process.exit(0);
  }

  const items = Array.isArray(expanded.items) ? expanded.items : [];
  if (!items.length) {
    log('today.expanded.json items 비어 있음 → 스킵');
    process.exit(0);
  }

  const next = ensureNextShape(readJsonSafe(NEXT_PATH, { updatedAt: null, bySlug: {} }));

  const bucketDocs = {
    app: ensureNextShape(readJsonSafe(BUCKET_NEXT_PATHS.app, { updatedAt: null, bySlug: {} })),
    device: ensureNextShape(readJsonSafe(BUCKET_NEXT_PATHS.device, { updatedAt: null, bySlug: {} })),
    subscription: ensureNextShape(readJsonSafe(BUCKET_NEXT_PATHS.subscription, { updatedAt: null, bySlug: {} })),
  };

  let checked = 0;
  let reviewTargets = 0;

  let globalCreated = 0;
  let globalUpdated = 0;
  let globalKeptStrong = 0;

  let bucketCreated = 0;
  let bucketUpdated = 0;
  let bucketKeptStrong = 0;

  let skippedNoSlug = 0;
  let skippedNoPost = 0;
  let skippedNoEntity = 0;
  let skippedNonReview = 0;

  for (const item of items) {
    checked += 1;

    const label = String(item?.label || '').trim();
    if (!isReviewLabel(label)) {
      skippedNonReview += 1;
      continue;
    }

    reviewTargets += 1;

    const slug = resolveSlugFromQueueItem(item);
    if (!slug) {
      skippedNoSlug += 1;
      continue;
    }

    const postPath = path.join(POSTS_DIR, `${slug}.json`);
    const postJson = readJsonSafe(postPath, null);
    if (!postJson || typeof postJson !== 'object') {
      skippedNoPost += 1;
      warn(`post JSON 없음/파싱불가: slug=${slug}`);
      continue;
    }

    const postLabel = firstLabelFromPost(postJson);
    if (!isReviewLabel(postLabel)) {
      skippedNonReview += 1;
      continue;
    }

    const entity = normalizeReviewEntity(postJson, item);
    if (!entity) {
      skippedNoEntity += 1;
      warn(`reviewEntity 없음: slug=${slug}`);
      continue;
    }

    const candidate = buildSeedStubRecord({
      postJson,
      label: postLabel,
      entity,
    });

    const globalResult = upsertSeedStub(next, slug, candidate);
    if (globalResult.action === 'created') globalCreated += 1;
    else if (globalResult.action === 'updated') globalUpdated += 1;
    else if (globalResult.action === 'keptStrong') globalKeptStrong += 1;

    const bucket = normalizeBucketFromLabel(postLabel);
    if (bucket && bucketDocs[bucket]) {
      const bucketResult = upsertSeedStub(bucketDocs[bucket], slug, candidate);
      if (bucketResult.action === 'created') bucketCreated += 1;
      else if (bucketResult.action === 'updated') bucketUpdated += 1;
      else if (bucketResult.action === 'keptStrong') bucketKeptStrong += 1;
    }
  }

  touchUpdatedAt(next);
  writeJsonAtomic(NEXT_PATH, next);

  for (const [bucket, filePath] of Object.entries(BUCKET_NEXT_PATHS)) {
    touchUpdatedAt(bucketDocs[bucket]);
    writeJsonAtomic(filePath, bucketDocs[bucket]);
  }

  log(
    `done: checked=${checked}, reviewTargets=${reviewTargets}, globalCreated=${globalCreated}, globalUpdated=${globalUpdated}, globalKeptStrong=${globalKeptStrong}, bucketCreated=${bucketCreated}, bucketUpdated=${bucketUpdated}, bucketKeptStrong=${bucketKeptStrong}, skippedNoSlug=${skippedNoSlug}, skippedNoPost=${skippedNoPost}, skippedNoEntity=${skippedNoEntity}, skippedNonReview=${skippedNonReview}`
  );
}

if (require.main === module) main();
