#!/usr/bin/env node
/**
 * update-review-ratings.cjs
 *
 * 역할:
 * - 현재 기준 스냅샷: data/review-ratings.json
 * - 새 후보 스냅샷:   data/review-ratings-next.json
 * 두 파일을 비교하여 "의미 있는 변화"가 있는 슬러그만 기준 스냅샷으로 반영한다.
 *
 * 규칙(의미 있는 변화):
 * - 앱별로 아래 중 하나라도 만족하면 변화 있음:
 *   1) 평점 차이: |newRating - oldRating| >= 0.1
 *   2) 투표 수 증가: newVotes >= oldVotes * 1.05 (5% 이상 증가)
 *   3) 별점 비율: 어느 한 별이라도 |newStar% - oldStar%| >= 5
 * - 인사이트(insights)가 길이/내용에서 달라지면 변화 있음으로 본다.
 *
 * 결과:
 * - 변화 있음: 해당 slug의 entry를 review-ratings.json에 덮어씀.
 * - 변화 없음: "no meaningful change" 로그만 출력하고 유지.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const CURRENT_PATH = path.join(ROOT, 'data', 'review-ratings.json');
const NEXT_PATH = path.join(ROOT, 'data', 'review-ratings-next.json');

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

function isInsightsChanged(oldArr, newArr) {
  const a = Array.isArray(oldArr) ? oldArr : [];
  const b = Array.isArray(newArr) ? newArr : [];
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (String(a[i]) !== String(b[i])) return true;
  }
  return false;
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

// 앱 1개 기준 비교
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

// slug 단위 비교
function isEntryChanged(oldEntry, newEntry) {
  if (!oldEntry) return true; // 신규 slug이면 무조건 변경

  const oldAppsArr = Array.isArray(oldEntry.apps) ? oldEntry.apps : [];
  const newAppsArr = Array.isArray(newEntry.apps) ? newEntry.apps : [];

  // name 기반 맵으로 비교
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
      // 새로 추가된 앱이면 변화로 본다
      anyAppChanged = true;
      return;
    }
    if (isAppChanged(oldApp, newApp)) {
      anyAppChanged = true;
    }
  });

  // 인사이트 비교
  const insightsChanged = isInsightsChanged(oldEntry.insights, newEntry.insights);

  return anyAppChanged || insightsChanged;
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[update-review-ratings] 시작 — 기준 스냅샷 vs 후보 스냅샷 비교');

  const currentMap = loadJsonSafe(CURRENT_PATH, {});
  const nextMap = loadJsonSafe(NEXT_PATH, null);

  if (!nextMap || Object.keys(nextMap).length === 0) {
    console.log(`[update-review-ratings] 후보 데이터 없음: ${NEXT_PATH}`);
    console.log('[update-review-ratings] 종료 (반영할 내용이 없습니다)');
    return;
  }

  let changedCount = 0;
  let newSlugCount = 0;
  let noChangeCount = 0;

  Object.keys(nextMap).forEach(slug => {
    const nextEntry = nextMap[slug];
    const oldEntry = currentMap[slug];

    if (!oldEntry) {
      // 신규 slug: 무조건 추가
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

  // 기준 파일 덮어쓰기
  fs.writeFileSync(
    CURRENT_PATH,
    JSON.stringify(currentMap, null, 2),
    'utf8'
  );

  console.log('────────────────────────────────────────────');
  console.log(
    `[update-review-ratings] 결과 — 변경 반영: ${changedCount}개, 신규 slug: ${newSlugCount}개, 변화 없음: ${noChangeCount}개`
  );
  console.log(`[update-review-ratings] 기준 파일 업데이트 완료: ${CURRENT_PATH}`);
}

main();
