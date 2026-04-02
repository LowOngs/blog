#!/usr/bin/env node
/**
 * update-review-ratings.cjs
 *
 * 역할:
 * - 현재 기준 스냅샷:
 *   - 운영 SSOT: content/reviews/review-ratings.json
 * - 새 후보 스냅샷:
 *   - 운영 SSOT: content/reviews/review-ratings-next.json
 *
 * 두 파일을 비교하여 "의미 있는 변화"가 있는 슬러그만 기준 스냅샷으로 반영한다.
 *
 * 규칙(의미 있는 변화):
 * - legacy apps 구조일 때:
 *   1) 평점 차이: |newRating - oldRating| >= 0.1
 *   2) 투표 수 증가: newVotes >= oldVotes * 1.05 (5% 이상 증가)
 *   3) 별점 비율: 어느 한 별이라도 |newStar% - oldStar%| >= 5
 *   4) 인사이트(insights)가 길이/내용에서 달라지면 변화 있음
 *
 * - current snapshot 구조일 때:
 *   1) ratingCurrent / ratingPrevious / votesCurrent / votesPrevious / ratingDiff / votesDiff 비교
 *   2) histogram 비교
 *   3) insights 비교
 *   4) sources 비교
 *   5) 기타 주요 메타(lastChecked/status/store/source/storeId/bucket/histogramMeta) 비교
 *
 * 결과:
 * - 변화 있음: 해당 slug의 entry를 review-ratings.json에 덮어씀.
 * - 변화 없음: "no meaningful change" 로그만 출력하고 유지.
 *
 * 추가(현행 파이프라인 보강):
 * - REVIEW_SLUGS 환경변수 지원
 *   예) REVIEW_SLUGS=app-20260401-001,subscription-20260402-001
 * - 현재 SSOT의 bySlug 구조를 우선 지원
 * - legacy 루트 직접 slug 맵 구조도 fallback 지원
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const CURRENT_PATH = path.join(ROOT, 'content', 'reviews', 'review-ratings.json');
const NEXT_PATH = path.join(ROOT, 'content', 'reviews', 'review-ratings-next.json');

// 기준값
const RATING_DELTA_THRESHOLD = 0.1;
const VOTES_GROWTH_THRESHOLD = 0.05; // 5%
const STAR_DELTA_THRESHOLD = 5; // 퍼센트 포인트

function loadJsonSafe(filePath, defaultValue = {}) {
  if (!fs.existsSync(filePath)) return defaultValue;
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[update-review-ratings] ERROR: JSON parse 실패: ${filePath}`);
    console.error(e.message);
    process.exit(1);
  }
}

function toNumberOrNull(v) {
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function normalizeString(v) {
  return String(v == null ? '' : v).trim();
}

function isInsightsChanged(oldArr, newArr) {
  const a = Array.isArray(oldArr) ? oldArr : [];
  const b = Array.isArray(newArr) ? newArr : [];
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (String(a[i]) !== String(b[i])) return true;
  }
  return false;
}

function isArrayChanged(oldArr, newArr) {
  const a = Array.isArray(oldArr) ? oldArr : [];
  const b = Array.isArray(newArr) ? newArr : [];
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return true;
  }
  return false;
}

function isObjectChanged(oldObj = {}, newObj = {}) {
  return JSON.stringify(oldObj || {}) !== JSON.stringify(newObj || {});
}

function isStarChanged(oldStars = {}, newStars = {}) {
  const keys = ['5', '4', '3', '2', '1'];
  return keys.some(k => {
    const oldVal = toNumberOrNull(oldStars[k]);
    const newVal = toNumberOrNull(newStars[k]);
    if (oldVal === null || newVal === null) return false;
    const delta = Math.abs(newVal - oldVal);
    return delta >= STAR_DELTA_THRESHOLD;
  });
}

// 앱 1개 기준 비교 (legacy 구조)
function isAppChanged(oldApp, newApp) {
  const oldRating = toNumberOrNull(oldApp.rating);
  const newRating = toNumberOrNull(newApp.rating);

  const oldVotes = toNumberOrNull(oldApp.votes);
  const newVotes = toNumberOrNull(newApp.votes);

  let ratingChanged = false;
  let votesChanged = false;
  let starsChanged = false;

  if (oldRating !== null && newRating !== null) {
    if (Math.abs(newRating - oldRating) >= RATING_DELTA_THRESHOLD) {
      ratingChanged = true;
    }
  }

  if (oldVotes !== null && newVotes !== null && oldVotes > 0) {
    const growth = (newVotes - oldVotes) / oldVotes;
    if (growth >= VOTES_GROWTH_THRESHOLD) {
      votesChanged = true;
    }
  }

  if (isStarChanged(oldApp.stars, newApp.stars)) {
    starsChanged = true;
  }

  return ratingChanged || votesChanged || starsChanged;
}

function hasLegacyAppsShape(entry) {
  return !!(entry && typeof entry === 'object' && Array.isArray(entry.apps));
}

function hasCurrentSnapshotShape(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;

  return (
    Object.prototype.hasOwnProperty.call(entry, 'ratingCurrent') ||
    Object.prototype.hasOwnProperty.call(entry, 'votesCurrent') ||
    Object.prototype.hasOwnProperty.call(entry, 'histogram') ||
    Object.prototype.hasOwnProperty.call(entry, 'bucket') ||
    Object.prototype.hasOwnProperty.call(entry, 'sources')
  );
}

// slug 단위 비교
function isEntryChanged(oldEntry, newEntry) {
  if (!oldEntry) return true; // 신규 slug이면 무조건 변경

  // 1) legacy apps 구조 비교
  if (hasLegacyAppsShape(oldEntry) || hasLegacyAppsShape(newEntry)) {
    const oldAppsArr = Array.isArray(oldEntry.apps) ? oldEntry.apps : [];
    const newAppsArr = Array.isArray(newEntry.apps) ? newEntry.apps : [];

    const oldMap = new Map();
    oldAppsArr.forEach(app => {
      if (app && app.name) oldMap.set(app.name, app);
    });

    const newMap = new Map();
    newAppsArr.forEach(app => {
      if (app && app.name) newMap.set(app.name, app);
    });

    let anyAppChanged = false;

    newMap.forEach((newApp, name) => {
      const oldApp = oldMap.get(name);
      if (!oldApp) {
        anyAppChanged = true;
        return;
      }
      if (isAppChanged(oldApp, newApp)) {
        anyAppChanged = true;
      }
    });

    const insightsChanged = isInsightsChanged(oldEntry.insights, newEntry.insights);
    return anyAppChanged || insightsChanged;
  }

  // 2) current snapshot 구조 비교
  if (hasCurrentSnapshotShape(oldEntry) || hasCurrentSnapshotShape(newEntry)) {
    const keysToCompareAsNumber = [
      'ratingCurrent',
      'ratingPrevious',
      'ratingDiff',
      'votesCurrent',
      'votesPrevious',
      'votesDiff',
    ];

    for (const key of keysToCompareAsNumber) {
      const oldVal = toNumberOrNull(oldEntry[key]);
      const newVal = toNumberOrNull(newEntry[key]);
      if (oldVal !== newVal) return true;
    }

    const keysToCompareAsString = [
      'lastChecked',
      'status',
      'store',
      'source',
      'storeId',
      'bucket',
    ];

    for (const key of keysToCompareAsString) {
      if (normalizeString(oldEntry[key]) !== normalizeString(newEntry[key])) {
        return true;
      }
    }

    if (isObjectChanged(oldEntry.histogram, newEntry.histogram)) return true;
    if (isObjectChanged(oldEntry.histogramMeta, newEntry.histogramMeta)) return true;
    if (isInsightsChanged(oldEntry.insights, newEntry.insights)) return true;
    if (isArrayChanged(oldEntry.sources, newEntry.sources)) return true;

    return false;
  }

  // 3) 알 수 없는 구조면 안전하게 deep compare
  return JSON.stringify(oldEntry) !== JSON.stringify(newEntry);
}

function parseRequestedSlugs() {
  const raw = normalizeString(process.env.REVIEW_SLUGS);
  if (!raw) return null;

  const list = raw
    .split(',')
    .map(s => normalizeString(s))
    .filter(Boolean);

  if (!list.length) return null;
  return new Set(list);
}

function extractBySlugContainer(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return {
      root: { bySlug: {}, updatedAt: null },
      bySlug: {},
      style: 'current',
    };
  }

  if (obj.bySlug && typeof obj.bySlug === 'object' && !Array.isArray(obj.bySlug)) {
    return {
      root: obj,
      bySlug: obj.bySlug,
      style: 'current',
    };
  }

  // legacy fallback: 루트 바로 아래 slug 맵
  const cloned = { ...obj };
  delete cloned.updatedAt;

  return {
    root: obj,
    bySlug: cloned,
    style: 'legacy',
  };
}

function writeCurrentStyle(root, bySlug) {
  const out = {
    ...root,
    bySlug,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(CURRENT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
}

function writeLegacyStyle(root, bySlug) {
  const out = {
    ...bySlug,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(CURRENT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[update-review-ratings] 시작 — 기준 스냅샷 vs 후보 스냅샷 비교');

  const currentRaw = loadJsonSafe(CURRENT_PATH, {});
  const nextRaw = loadJsonSafe(NEXT_PATH, null);

  const currentWrapped = extractBySlugContainer(currentRaw);
  const nextWrapped = extractBySlugContainer(nextRaw);

  const currentMap = currentWrapped.bySlug || {};
  const nextMap = nextWrapped.bySlug || {};

  const requestedSlugs = parseRequestedSlugs();

  if (requestedSlugs) {
    console.log(`[update-review-ratings] REVIEW_SLUGS 필터 적용: ${Array.from(requestedSlugs).join(', ')}`);
  }

  const allNextSlugs = Object.keys(nextMap);
  const targetSlugs = requestedSlugs
    ? allNextSlugs.filter(slug => requestedSlugs.has(slug))
    : allNextSlugs;

  if (!targetSlugs.length) {
    console.log(`[update-review-ratings] 후보 데이터 없음 또는 필터 일치 없음: ${NEXT_PATH}`);
    console.log('[update-review-ratings] 종료 (반영할 내용이 없습니다)');
    return;
  }

  let changedCount = 0;
  let newSlugCount = 0;
  let noChangeCount = 0;

  targetSlugs.forEach(slug => {
    const nextEntry = nextMap[slug];
    const oldEntry = currentMap[slug];

    if (!oldEntry) {
      currentMap[slug] = nextEntry;
      newSlugCount++;
      console.log(`[update-review-ratings] ➕ NEW slug 추가: ${slug}`);
      return;
    }

    if (isEntryChanged(oldEntry, nextEntry)) {
      currentMap[slug] = nextEntry;
      changedCount++;
      console.log(`[update-review-ratings] ✓ 변경 반영: ${slug}`);
    } else {
      noChangeCount++;
      console.log(`[update-review-ratings] ≈ 변화 없음(스킵): ${slug}`);
    }
  });

  if (currentWrapped.style === 'current') {
    writeCurrentStyle(currentWrapped.root, currentMap);
  } else {
    writeLegacyStyle(currentWrapped.root, currentMap);
  }

  console.log('────────────────────────────────────────────');
  console.log(
    `[update-review-ratings] 결과 — 변경 반영: ${changedCount}개, 신규 slug: ${newSlugCount}개, 변화 없음: ${noChangeCount}개`
  );
  console.log(`[update-review-ratings] 기준 파일 업데이트 완료: ${CURRENT_PATH}`);
}

main();
