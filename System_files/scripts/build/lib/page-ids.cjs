// System_files/scripts/build/lib/page-ids.cjs
// pageId 발급/조회 공용 라이브러리
// 형식: page + 6자리 0패딩(예: page000001)
//
// ■ 동작 모드 정리
// - SCHEDULE_MODE !== 'live'  인 동안: 항상 테스트 모드
//    · ensurePageId(slug) → 항상 page000001 반환
//    · page-ids.json 파일/카운터 변경 없음(동결)
// - SCHEDULE_MODE === 'live' 인 경우에만 실제 카운트 증가 + 매핑 저장
//
// ※ PAGE_ID_MODE 환경변수는 과거 호환용으로 남길 수 있으나,
//    최종 판정은 SCHEDULE_MODE가 'live'인지 여부로만 결정합니다.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MANIFEST_DIR = path.join(ROOT, 'manifests');
const PAGE_IDS_PATH = path.join(MANIFEST_DIR, 'page-ids.json');

// 스케줄 모드에 강하게 종속
const SCHEDULE_MODE = process.env.SCHEDULE_MODE || 'test';

// SCHEDULE_MODE 가 'live' 일 때만 실제 카운트 동작
const MODE = SCHEDULE_MODE === 'live' ? 'live' : 'test';

const TEST_PAGE_ID = 'page000001';

/**
 * 내부용: page-ids.json 로드 (없으면 기본값 반환)
 * (test 모드에서는 호출하지 않음)
 */
function loadPageIds() {
  try {
    const raw = fs.readFileSync(PAGE_IDS_PATH, 'utf8');
    const data = JSON.parse(raw);

    if (typeof data.lastPageNumber !== 'number') {
      data.lastPageNumber = 0;
    }
    if (!data.pages || typeof data.pages !== 'object') {
      data.pages = {};
    }
    return data;
  } catch (e) {
    return {
      version: 1,
      lastPageNumber: 0,
      pages: {},
      updatedAt: new Date().toISOString()
    };
  }
}

/**
 * 내부용: page-ids.json 저장
 * (live 모드에서만 호출)
 */
function savePageIds(data) {
  data.version = 1;
  data.updatedAt = new Date().toISOString();

  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  fs.writeFileSync(PAGE_IDS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * slug에 대한 pageId를 보장해서 돌려줌.
 * - test 모드: 항상 page000001 반환, 파일/카운트 변경 없음
 * - live 모드:
 *    · 이미 있으면 그대로 반환
 *    · 없으면 next 번호로 신규 발급 후 저장
 */
function ensurePageId(slug) {
  // 테스트 모드: 카운트 동결, 항상 1번으로 테스트
  if (MODE !== 'live') {
    return TEST_PAGE_ID;
  }

  const data = loadPageIds();

  if (data.pages[slug]) {
    return data.pages[slug];
  }

  const nextNumber = (data.lastPageNumber || 0) + 1;
  const pageId = 'page' + String(nextNumber).padStart(6, '0');

  data.lastPageNumber = nextNumber;
  data.pages[slug] = pageId;
  savePageIds(data);

  return pageId;
}

/**
 * slug에 대한 pageId 조회만 (없으면 null)
 * - test 모드에서는 항상 null 반환(실제 매핑 없음)
 */
function getPageId(slug) {
  if (MODE !== 'live') {
    return null;
  }
  const data = loadPageIds();
  return data.pages[slug] || null;
}

/**
 * 디버그/관리용: 전체 상태 반환
 * - test 모드에서는 "카운트 동결 상태"만 간단히 돌려줌
 */
function getState() {
  if (MODE !== 'live') {
    return {
      mode: MODE,
      scheduleMode: SCHEDULE_MODE,
      note: 'SCHEDULE_MODE is not "live" — counter is frozen and TEST_PAGE_ID is always used.',
      testPageId: TEST_PAGE_ID
    };
  }
  const data = loadPageIds();
  data.mode = MODE;
  data.scheduleMode = SCHEDULE_MODE;
  return data;
}

module.exports = {
  ensurePageId,
  getPageId,
  getState,
  PAGE_IDS_PATH
};
