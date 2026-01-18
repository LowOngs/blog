#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/review-stub-fill.cjs
 *
 * 역할:
 * - content/posts에서 리뷰 슬러그(app-/device-/subscription-)를 찾아
 * - content/reviews/* 파일들에 최소 구조(stub)를 "없을 때만" 업서트한다.
 *
 * ✅ 유지(기존 동작)
 * - bySlug 기반으로 stub 업서트
 * - subsctiption-insights.json 철자 유지
 *
 * ✅ 추가(업데이트)
 * - .env 로더를 “최상단(공통규칙)”에 고정(가장 먼저 로딩)
 * - posts의 postId를 읽어 “옵션”으로 byId 맵도 함께 유지(보험)
 *   - 기존 엔진들은 bySlug만 써도 그대로 동작
 *   - 미래에 slug 변경/이동이 생겨도 postId로 안전 매칭 가능
 */

// ✅ 공통 규칙: .env 로더 최우선(루트/게이트 일관성)
require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');

// ────────────────────────────────────
// What: 루트/디렉토리 고정
// Why: 경로 혼동/중첩 루트 사고 방지
// I/O: R=content/posts, W=content/reviews
// Invariants: ROOT=System_files 기준
// ────────────────────────────────────
const ROOT = path.resolve(__dirname, '..', '..'); // System_files/scripts/build 기준
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const REVIEWS_DIR = path.join(ROOT, 'content', 'reviews');

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function nowYmdKst() {
  // What: KST 기준 YYYY-MM-DD 생성
  // Why: 운영 로그/updatedAt 일관성
  // I/O: R=Date.now, W=문자열
  // Invariants: +09:00 오프셋만 적용(정밀도 과다 불필요)
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function isReviewSlug(slug) {
  return (
    typeof slug === 'string' &&
    (slug.startsWith('app-') || slug.startsWith('device-') || slug.startsWith('subscription-'))
  );
}

function bucketOf(slug) {
  if (slug.startsWith('app-')) return 'app';
  if (slug.startsWith('device-')) return 'device';
  return 'subscription';
}

// ────────────────────────────────────
// What: reviews JSON 공통 구조 보정
// Why: 빈 파일/오염 파일에서도 안전하게 bySlug를 보장
// I/O: R=content/reviews/*.json, W=보정된 객체(메모리상)
// Invariants: bySlug는 항상 object
// ────────────────────────────────────
function ensureMaps(obj) {
  const base = { updatedAt: nowYmdKst(), bySlug: {}, byId: {} };
  if (!obj || typeof obj !== 'object') return base;

  if (!obj.bySlug || typeof obj.bySlug !== 'object') obj.bySlug = {};
  if (!obj.byId || typeof obj.byId !== 'object') obj.byId = {}; // ✅ 옵션(보험)
  if (!obj.updatedAt) obj.updatedAt = nowYmdKst();

  return obj;
}

// ────────────────────────────────────
// What: ratings stub 업서트(bySlug)
// Why: review-build-next / review-ssot-merge가 next/baseline을 만들 수 있게 기반 제공
// I/O: W=content/reviews/*-ratings(.next).json(bySlug[slug])
// Invariants: "없을 때만" 생성(기존 값 보존)
// ────────────────────────────────────
function ensureRatingEntry(bySlug, slug, postId) {
  if (bySlug[slug]) return false;

  bySlug[slug] = {
    // ✅ 추가: postId(보험). 기존 엔진이 무시해도 무방
    postId: postId || null,

    lastChecked: nowYmdKst(),
    status: 'unknown',
    store: 'unknown',
    source: 'manual',
    storeId: null,

    ratingCurrent: 0,
    ratingPrevious: 0,
    ratingDiff: 0,

    votesCurrent: 0,
    votesPrevious: 0,
    votesDiff: 0,

    histogram: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },

    // ⚠️ 이 insights는 “통합 next/ssot”에서 사용될 수 있어 유지
    insights: [],
  };

  return true;
}

// ────────────────────────────────────
// What: insights stub 업서트(bySlug)
// Why: 인사이트가 비어도 구조는 유지되어야(플레이스홀더 정책/후속 채움) 안전
// I/O: W=content/reviews/*-insights.json(bySlug[slug])
// Invariants: "없을 때만" 생성(기존 값 보존)
// ────────────────────────────────────
function ensureInsightsEntry(bySlug, slug, postId) {
  if (bySlug[slug]) return false;

  bySlug[slug] = {
    // ✅ 추가: postId(보험)
    postId: postId || null,
    insights: [],
  };

  return true;
}

// ────────────────────────────────────
// What: sources stub 업서트(bySlug는 기존처럼 “배열” 유지)
// Why: inject-sources-from-ssot 등 기존 로직이 배열을 전제할 가능성 큼(스키마 유지)
// I/O: W=content/reviews/review-sources.json(bySlug[slug]=[])
// Invariants: bySlug[slug] 타입은 배열 유지(절대 object로 바꾸지 않음)
// ────────────────────────────────────
function ensureSourcesEntry(bySlug, slug) {
  if (bySlug[slug]) return false;
  bySlug[slug] = [];
  return true;
}

// ────────────────────────────────────
// What: byId 옵션 맵 업서트(보험)
// Why: slug 변경/이동에도 SSOT 연결을 유지하기 위한 장기 안전장치
// I/O: W=content/reviews/*(byId[postId])
// Invariants: byId는 "옵션"이며 bySlug 기반 동작을 절대 깨지 않음
// ────────────────────────────────────
function ensureByIdRating(byId, postId) {
  if (!postId) return false;
  if (byId[postId]) return false;

  byId[postId] = {
    lastChecked: nowYmdKst(),
    status: 'unknown',
    store: 'unknown',
    source: 'manual',
    storeId: null,
    ratingCurrent: 0,
    ratingPrevious: 0,
    ratingDiff: 0,
    votesCurrent: 0,
    votesPrevious: 0,
    votesDiff: 0,
    histogram: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
    insights: [],
  };

  return true;
}

function ensureByIdInsights(byId, postId) {
  if (!postId) return false;
  if (byId[postId]) return false;
  byId[postId] = { insights: [] };
  return true;
}

function ensureByIdSources(byId, postId) {
  if (!postId) return false;
  if (byId[postId]) return false;
  byId[postId] = [];
  return true;
}

// ────────────────────────────────────
// What: posts에서 리뷰 슬러그 + postId 목록 수집
// Why: 스텁 업서트의 단일 입력원(Posts SSOT)
// I/O: R=content/posts/*.json, W=메모리 배열
// Invariants: slug는 파일명 fallback, postId는 없으면 null
// ────────────────────────────────────
function listReviewPosts() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  const files = fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.json'));

  const out = [];
  for (const f of files) {
    const p = path.join(POSTS_DIR, f);
    const j = readJson(p, null);

    const slug = (j && j.slug) ? String(j.slug) : f.replace(/\.json$/, '');
    if (!isReviewSlug(slug)) continue;

    const postId = (j && j.postId) ? String(j.postId) : null;
    out.push({ slug, postId });
  }

  // slug 기준 고정 정렬(재현성)
  out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return out;
}

function main() {
  const ymd = nowYmdKst();
  const reviewPosts = listReviewPosts();

  // ────────────────────────────────────
  // What: 대상 파일 경로 고정
  // Why: 파일명/철자 변경은 금지(특히 subsctiption-insights.json)
  // I/O: R/W=content/reviews/*.json
  // Invariants: 기존 파일명 유지
  // ────────────────────────────────────
  const paths = {
    appRatings: path.join(REVIEWS_DIR, 'app-ratings.json'),
    appRatingsNext: path.join(REVIEWS_DIR, 'app-ratings-next.json'),
    appInsights: path.join(REVIEWS_DIR, 'app-insights.json'),

    deviceRatings: path.join(REVIEWS_DIR, 'device-ratings.json'),
    deviceRatingsNext: path.join(REVIEWS_DIR, 'device-ratings-next.json'),
    deviceInsights: path.join(REVIEWS_DIR, 'device-insights.json'),

    subscriptionRatings: path.join(REVIEWS_DIR, 'subscription-ratings.json'),
    subscriptionRatingsNext: path.join(REVIEWS_DIR, 'subscription-ratings-next.json'),

    // ⚠️ 철자 그대로 유지
    subscriptionInsights: path.join(REVIEWS_DIR, 'subsctiption-insights.json'),

    reviewSources: path.join(REVIEWS_DIR, 'review-sources.json'),
  };

  // ────────────────────────────────────
  // What: 파일 로드 + 기본 구조 보정
  // Why: 파일이 비었거나 깨져도 “안전하게 업서트”
  // I/O: R=content/reviews/*.json, W=보정된 객체(메모리상)
  // Invariants: bySlug/byId는 object
  // ────────────────────────────────────
  const appRatings = ensureMaps(readJson(paths.appRatings, null));
  const appRatingsNext = ensureMaps(readJson(paths.appRatingsNext, null));
  const appInsights = ensureMaps(readJson(paths.appInsights, null));

  const deviceRatings = ensureMaps(readJson(paths.deviceRatings, null));
  const deviceRatingsNext = ensureMaps(readJson(paths.deviceRatingsNext, null));
  const deviceInsights = ensureMaps(readJson(paths.deviceInsights, null));

  const subscriptionRatings = ensureMaps(readJson(paths.subscriptionRatings, null));
  const subscriptionRatingsNext = ensureMaps(readJson(paths.subscriptionRatingsNext, null));
  const subscriptionInsights = ensureMaps(readJson(paths.subscriptionInsights, null));

  const reviewSources = ensureMaps(readJson(paths.reviewSources, null));

  let created = 0;

  // ────────────────────────────────────
  // What: 리뷰 포스트 목록을 기준으로 “없을 때만” 스텁 업서트
  // Why: 더미/기본구조를 자동으로 보장해서 downstream이 항상 동작하도록
  // I/O: W=content/reviews/* (bySlug + byId 옵션)
  // Invariants:
  //  - 기존 엔트리는 절대 덮어쓰지 않음
  //  - bySlug 타입 유지(특히 sources는 배열)
  // ────────────────────────────────────
  for (const { slug, postId } of reviewPosts) {
    const b = bucketOf(slug);

    if (b === 'app') {
      if (ensureRatingEntry(appRatings.bySlug, slug, postId)) created++;
      if (ensureRatingEntry(appRatingsNext.bySlug, slug, postId)) created++;
      if (ensureInsightsEntry(appInsights.bySlug, slug, postId)) created++;

      // byId 옵션(보험)
      if (ensureByIdRating(appRatings.byId, postId)) created++;
      if (ensureByIdRating(appRatingsNext.byId, postId)) created++;
      if (ensureByIdInsights(appInsights.byId, postId)) created++;
    } else if (b === 'device') {
      if (ensureRatingEntry(deviceRatings.bySlug, slug, postId)) created++;
      if (ensureRatingEntry(deviceRatingsNext.bySlug, slug, postId)) created++;
      if (ensureInsightsEntry(deviceInsights.bySlug, slug, postId)) created++;

      // byId 옵션(보험)
      if (ensureByIdRating(deviceRatings.byId, postId)) created++;
      if (ensureByIdRating(deviceRatingsNext.byId, postId)) created++;
      if (ensureByIdInsights(deviceInsights.byId, postId)) created++;
    } else {
      if (ensureRatingEntry(subscriptionRatings.bySlug, slug, postId)) created++;
      if (ensureRatingEntry(subscriptionRatingsNext.bySlug, slug, postId)) created++;
      if (ensureInsightsEntry(subscriptionInsights.bySlug, slug, postId)) created++;

      // byId 옵션(보험)
      if (ensureByIdRating(subscriptionRatings.byId, postId)) created++;
      if (ensureByIdRating(subscriptionRatingsNext.byId, postId)) created++;
      if (ensureByIdInsights(subscriptionInsights.byId, postId)) created++;
    }

    // sources(bySlug)는 배열 유지
    if (ensureSourcesEntry(reviewSources.bySlug, slug)) created++;

    // sources(byId) 옵션(보험)
    if (ensureByIdSources(reviewSources.byId, postId)) created++;
  }

  // ────────────────────────────────────
  // What: updatedAt 갱신
  // Why: 운영상 “마지막 스텁 보장 실행 시점” 추적
  // I/O: W=content/reviews/*.json(updatedAt)
  // Invariants: 실행 시점만 갱신(데이터 덮어쓰지 않음)
  // ────────────────────────────────────
  const allObjs = [
    appRatings, appRatingsNext, appInsights,
    deviceRatings, deviceRatingsNext, deviceInsights,
    subscriptionRatings, subscriptionRatingsNext, subscriptionInsights,
    reviewSources,
  ];
  for (const obj of allObjs) obj.updatedAt = ymd;

  // ────────────────────────────────────
  // What: 파일 저장
  // Why: stub 보장 결과를 SSOT(content/reviews)에 반영
  // I/O: W=content/reviews/*.json
  // Invariants: JSON pretty + newline
  // ────────────────────────────────────
  writeJson(paths.appRatings, appRatings);
  writeJson(paths.appRatingsNext, appRatingsNext);
  writeJson(paths.appInsights, appInsights);

  writeJson(paths.deviceRatings, deviceRatings);
  writeJson(paths.deviceRatingsNext, deviceRatingsNext);
  writeJson(paths.deviceInsights, deviceInsights);

  writeJson(paths.subscriptionRatings, subscriptionRatings);
  writeJson(paths.subscriptionRatingsNext, subscriptionRatingsNext);
  writeJson(paths.subscriptionInsights, subscriptionInsights);

  writeJson(paths.reviewSources, reviewSources);

  console.log(`[review-stub-fill] slugs=${reviewPosts.length} createdOrFilled=${created}`);
}

main();
