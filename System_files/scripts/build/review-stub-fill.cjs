#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/review-stub-fill.cjs
 * 역할: content/posts에서 리뷰 슬러그(app-/device-/subscription-)를 찾아,
 * content/reviews/* 파일들에 최소 구조(stub)를 "없을 때만" 업서트한다.
 *
 * ✅ 업데이트: posts의 reviewId/postId를 읽어 stub에 함께 기록
 * - bySlug 엔트리는 유지(기존 파이프라인 호환)
 * - 각 엔트리에 reviewId/postId를 함께 저장(추후 “id 기반 매칭” 옵션 확대용)
 *
 * ✅ 안정형 보강:
 * - slug 우선 매칭 유지
 * - slug가 달라져도 reviewId가 같으면 기존 엔트리를 찾아 재사용
 * - 실제 생성/보강이 발생했을 때만 updatedAt 갱신
 *
 * ✅ orphan 정리:
 * - posts SSOT에 없는 리뷰 slug는 이 파일이 직접 관리하는 reviews 파일 범위에서 제거
 * - 삭제 대상: app/device/subscription ratings/next/insights + review-sources
 * - 최종 병합 산출물(review-ratings*.json)은 이 파일 책임 범위 밖이라 건드리지 않음
 */

// ✅ 로컬/CI 공통: .env 로드(필수)
require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');

// ────────────────────────────────────
//  What: 경로 설정
//  Why : System_files 기준 단일화
//  I/O : R(content/posts/*.json), W(content/reviews/*.json)
//  Invariants: posts SSOT는 읽기만, reviews는 “없을 때만” 최소 업서트
// ────────────────────────────────────
const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const REVIEWS_DIR = path.join(ROOT, 'content', 'reviews');

// ────────────────────────────────────
//  What: JSON read/write 유틸
//  Why : 파싱 실패 시 기존 파일 보호(기본값으로 진행)
//  I/O : R/W(JSON 파일)
//  Invariants: write는 pretty + \n 유지
// ────────────────────────────────────
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

// ────────────────────────────────────
//  What: KST YYYY-MM-DD
//  Why : 리뷰 updatedAt/lastChecked 정책이 KST 문자열 기반인 흐름과 일치
//  I/O : 없음
//  Invariants: 날짜만(정밀도 과도하게 불필요)
// ────────────────────────────────────
function nowYmdKst() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// ────────────────────────────────────
//  What: 리뷰 슬러그/버킷 판정
//  Why : reviews/* 파일 분기
//  I/O : 없음
//  Invariants: app/device/subscription prefix만 리뷰
// ────────────────────────────────────
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
//  What: reviews 파일 기본 스키마 보정
//  Why : bySlug 맵이 항상 존재해야 업서트 가능
//  I/O : 없음
//  Invariants: {updatedAt, bySlug} 형태 강제
// ────────────────────────────────────
function ensureMaps(obj) {
  const base = { updatedAt: nowYmdKst(), bySlug: {} };
  if (!obj || typeof obj !== 'object') return base;
  if (!obj.bySlug || typeof obj.bySlug !== 'object') obj.bySlug = {};
  if (!obj.updatedAt) obj.updatedAt = nowYmdKst();
  return obj;
}

// ────────────────────────────────────
//  What: reviewId 기반 기존 엔트리 탐색
//  Why : slug 변경 시에도 기존 리뷰 엔트리를 재사용해 데이터 단절 방지
//  I/O : 없음
//  Invariants: reviewId 없으면 null 반환
// ────────────────────────────────────
function findExistingSlugByReviewId(bySlug, reviewId) {
  const rid = reviewId ? String(reviewId) : '';
  if (!rid) return null;

  for (const [slug, entry] of Object.entries(bySlug || {})) {
    if (entry && typeof entry === 'object' && String(entry.reviewId || '') === rid) {
      return slug;
    }
  }
  return null;
}

// ────────────────────────────────────
//  What: bySlug 내 orphan review slug 제거
//  Why : posts SSOT에 없는 잔존 엔트리를 정리해 로그 오염과 구조 혼선을 방지
//  I/O : W(content/reviews/*.json)
//  Invariants: review slug만 제거, 비리뷰 키는 유지
// ────────────────────────────────────
function pruneOrphanReviewEntries(bySlug, keepSlugSet) {
  let removed = 0;
  for (const slug of Object.keys(bySlug || {})) {
    if (!isReviewSlug(slug)) continue;
    if (keepSlugSet.has(slug)) continue;
    delete bySlug[slug];
    removed++;
  }
  return removed;
}

// ────────────────────────────────────
//  What: Rating stub 업서트(없을 때만)
//  Why : 히스토그램/인사이트 슬롯이 최소한의 구조를 항상 갖게 함
//  I/O : W(content/reviews/*-ratings*.json)
//  Invariants: 기존 엔트리는 절대 덮어쓰지 않음(필드 주입은 “없을 때만”)
// ────────────────────────────────────
function ensureRatingEntry(bySlug, slug, ids) {
  let targetSlug = slug;
  let existing = bySlug[targetSlug];

  // ✅ slug 매칭 실패 시 reviewId 기반 fallback
  if ((!existing || typeof existing !== 'object') && ids.reviewId) {
    const matchedSlug = findExistingSlugByReviewId(bySlug, ids.reviewId);
    if (matchedSlug) {
      targetSlug = matchedSlug;
      existing = bySlug[targetSlug];
    }
  }

  if (existing && typeof existing === 'object') {
    let changed = false;
    // ✅ 기존 엔트리에 id 필드가 비어있으면 채움(내용 데이터는 유지)
    if (!existing.reviewId && ids.reviewId) {
      existing.reviewId = ids.reviewId;
      changed = true;
    }
    if (!existing.postId && ids.postId) {
      existing.postId = ids.postId;
      changed = true;
    }
    return { created: false, changed };
  }

  bySlug[targetSlug] = {
    // ✅ 신규: 매칭키(중복보험)
    reviewId: ids.reviewId || null,
    postId: ids.postId || null,

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

    // ✅ 호환: 기존 review-meta-block가 읽는 insights 필드 유지
    insights: [],
  };
  return { created: true, changed: true };
}

// ────────────────────────────────────
//  What: Insights stub 업서트(없을 때만)
//  Why : 인사이트 전용 파일에도 매칭키를 함께 남김
//  I/O : W(content/reviews/*-insights.json)
//  Invariants: 기존 엔트리는 덮어쓰지 않음, id만 비면 채움
// ────────────────────────────────────
function ensureInsightsEntry(bySlug, slug, ids) {
  let targetSlug = slug;
  let existing = bySlug[targetSlug];

  if ((!existing || typeof existing !== 'object') && ids.reviewId) {
    const matchedSlug = findExistingSlugByReviewId(bySlug, ids.reviewId);
    if (matchedSlug) {
      targetSlug = matchedSlug;
      existing = bySlug[targetSlug];
    }
  }

  if (existing && typeof existing === 'object') {
    let changed = false;
    if (!existing.reviewId && ids.reviewId) {
      existing.reviewId = ids.reviewId;
      changed = true;
    }
    if (!existing.postId && ids.postId) {
      existing.postId = ids.postId;
      changed = true;
    }
    if (!Array.isArray(existing.insights)) {
      existing.insights = [];
      changed = true;
    }
    return { created: false, changed };
  }

  bySlug[targetSlug] = {
    reviewId: ids.reviewId || null,
    postId: ids.postId || null,
    insights: [],
  };
  return { created: true, changed: true };
}

// ────────────────────────────────────
//  What: Sources stub 업서트(없을 때만)
//  Why : 2차 대안(웹/후기) 입력을 받을 “그릇”을 미리 확보
//  I/O : W(content/reviews/review-sources.json)
//  Invariants: 배열 유지, 메타는 객체로 감싸서 확장 가능하게
// ────────────────────────────────────
function ensureSourcesEntry(bySlug, slug, ids) {
  let targetSlug = slug;
  let existing = bySlug[targetSlug];

  if ((!existing || typeof existing !== 'object') && ids.reviewId) {
    const matchedSlug = findExistingSlugByReviewId(bySlug, ids.reviewId);
    if (matchedSlug) {
      targetSlug = matchedSlug;
      existing = bySlug[targetSlug];
    }
  }

  if (existing && typeof existing === 'object') {
    let changed = false;
    if (!existing.reviewId && ids.reviewId) {
      existing.reviewId = ids.reviewId;
      changed = true;
    }
    if (!existing.postId && ids.postId) {
      existing.postId = ids.postId;
      changed = true;
    }
    if (!Array.isArray(existing.items)) {
      existing.items = [];
      changed = true;
    }
    return { created: false, changed };
  }

  bySlug[targetSlug] = {
    reviewId: ids.reviewId || null,
    postId: ids.postId || null,
    items: [],
  };
  return { created: true, changed: true };
}

// ────────────────────────────────────
//  What: posts에서 리뷰 대상 + id 수집
//  Why : slug만이 아니라 reviewId/postId를 함께 전달
//  I/O : R(content/posts/*.json)
//  Invariants: reviewId/postId가 없으면 null로 흘림(스텁은 유지)
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

    out.push({
      slug,
      postId: j && j.postId ? String(j.postId) : null,
      reviewId: j && j.reviewId ? String(j.reviewId) : null,
    });
  }

  // slug 기준 결정론 정렬
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

function main() {
  const ymd = nowYmdKst();
  const reviewPosts = listReviewPosts();
  const keepSlugSet = new Set(reviewPosts.map((x) => x.slug));

  // ────────────────────────────────────
  //  What: 대상 파일 경로 고정
  //  Why : 파일명/철자 혼동 방지(특히 subscription insights 철자)
  //  I/O : W(content/reviews/*.json)
  //  Invariants: 기존 파일명 유지
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

    // ⚠️ 파일명이 실제로 subsctiption-insights.json 라면 그 철자 그대로 유지
    subscriptionInsights: path.join(REVIEWS_DIR, 'subsctiption-insights.json'),

    // ✅ sources는 확장형 객체 스키마로 운영
    reviewSources: path.join(REVIEWS_DIR, 'review-sources.json'),
  };

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
  let changedAny = false;
  let pruned = 0;

  // ────────────────────────────────────
  //  What: orphan 리뷰 엔트리 정리
  //  Why : posts SSOT 기준으로 고립 엔트리를 제거해 로그 오염 방지
  //  I/O : W(content/reviews/*.json)
  //  Invariants: 직접 관리하는 파일 범위에서만 제거
  // ────────────────────────────────────
  const pruneTargets = [
    appRatings.bySlug,
    appRatingsNext.bySlug,
    appInsights.bySlug,
    deviceRatings.bySlug,
    deviceRatingsNext.bySlug,
    deviceInsights.bySlug,
    subscriptionRatings.bySlug,
    subscriptionRatingsNext.bySlug,
    subscriptionInsights.bySlug,
    reviewSources.bySlug,
  ];

  for (const map of pruneTargets) {
    const removed = pruneOrphanReviewEntries(map, keepSlugSet);
    if (removed > 0) {
      pruned += removed;
      changedAny = true;
    }
  }

  // ────────────────────────────────────
  //  What: 리뷰 포스트별 stub 업서트
  //  Why : “없을 때만” 생성, 기존 데이터 보존
  //  I/O : W(content/reviews/*.json)
  //  Invariants: 기존 엔트리의 본문 데이터는 변경 금지
  // ────────────────────────────────────
  for (const rp of reviewPosts) {
    const slug = rp.slug;
    const ids = { postId: rp.postId, reviewId: rp.reviewId };
    const b = bucketOf(slug);

    if (b === 'app') {
      const r1 = ensureRatingEntry(appRatings.bySlug, slug, ids);
      const r2 = ensureRatingEntry(appRatingsNext.bySlug, slug, ids);
      const r3 = ensureInsightsEntry(appInsights.bySlug, slug, ids);
      if (r1.created) created++;
      if (r2.created) created++;
      if (r3.created) created++;
      if (r1.changed || r2.changed || r3.changed) changedAny = true;
    } else if (b === 'device') {
      const r1 = ensureRatingEntry(deviceRatings.bySlug, slug, ids);
      const r2 = ensureRatingEntry(deviceRatingsNext.bySlug, slug, ids);
      const r3 = ensureInsightsEntry(deviceInsights.bySlug, slug, ids);
      if (r1.created) created++;
      if (r2.created) created++;
      if (r3.created) created++;
      if (r1.changed || r2.changed || r3.changed) changedAny = true;
    } else {
      const r1 = ensureRatingEntry(subscriptionRatings.bySlug, slug, ids);
      const r2 = ensureRatingEntry(subscriptionRatingsNext.bySlug, slug, ids);
      const r3 = ensureInsightsEntry(subscriptionInsights.bySlug, slug, ids);
      if (r1.created) created++;
      if (r2.created) created++;
      if (r3.created) created++;
      if (r1.changed || r2.changed || r3.changed) changedAny = true;
    }

    const rs = ensureSourcesEntry(reviewSources.bySlug, slug, ids);
    if (rs.created) created++;
    if (rs.changed) changedAny = true;
  }

  // ────────────────────────────────────
  //  What: updatedAt 갱신
  //  Why : 실제 변경이 있었을 때만 갱신하여 freshness 왜곡 방지
  //  I/O : W(content/reviews/*.json)
  //  Invariants: 데이터 변경 없으면 updatedAt도 유지
  // ────────────────────────────────────
  const allObjs = [
    appRatings,
    appRatingsNext,
    appInsights,
    deviceRatings,
    deviceRatingsNext,
    deviceInsights,
    subscriptionRatings,
    subscriptionRatingsNext,
    subscriptionInsights,
    reviewSources,
  ];
  if (changedAny) {
    for (const obj of allObjs) obj.updatedAt = ymd;
  }

  // ────────────────────────────────────
  //  What: 파일 저장
  //  Why : SSOT(stub) 확정
  //  I/O : W(content/reviews/*.json)
  //  Invariants: JSON pretty + \n
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

  console.log(`[review-stub-fill] slugs=${reviewPosts.length} createdOrFilled=${created} pruned=${pruned} changed=${changedAny ? 1 : 0}`);
}

main();
