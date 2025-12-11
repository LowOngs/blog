// System_files/scripts/build/lib/mode.cjs
// 발행·스케줄 관련 모드 스위치 공용 유틸
// - SCHEDULE_MODE: 'test' | 'live'
// - PAGE_ID_MODE:  'test' | 'live' (page-ids.cjs는 자체 로직 있지만 참고용으로도 사용 가능)

function normalizeFlag(value) {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();

  if (['live', 'on', 'true', '1'].includes(v)) return 'live';
  if (['test', 'off', 'false', '0'].includes(v)) return 'test';

  return null;
}

function getScheduleMode() {
  const raw = process.env.SCHEDULE_MODE;
  const norm = normalizeFlag(raw);
  // 기본은 test 모드 유지 (자동 발행 방지)
  return norm || 'test';
}

function getPageIdMode() {
  const raw = process.env.PAGE_ID_MODE;
  const norm = normalizeFlag(raw);
  // 기본은 test 모드 (page000001만 사용)
  return norm || 'test';
}

module.exports = {
  getScheduleMode,
  getPageIdMode,
};
