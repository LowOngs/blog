// System_files/scripts/build/lib/page-ids.cjs
// 목적: slug → pageId 매핑을 안정적으로 제공
// 정책:
// - PAGE_ID_MODE=live: 새 slug는 lastIssued+1로 발급하고 manifests/page-ids.json에 영구 기록
// - PAGE_ID_MODE=test: 발급/기록 금지, 항상 page000001 반환(테스트에서 번호 낭비/중복 리스크 방지)

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..'); // System_files
const MANIFESTS_DIR = path.join(ROOT, 'manifests');
const PAGE_IDS_FILE = path.join(MANIFESTS_DIR, 'page-ids.json');

function pad6(n) {
  return String(n).padStart(6, '0');
}

function normalizeMode(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'live' ? 'live' : 'test';
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function atomicWriteJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function initState() {
  const fallback = {
    meta: { lastIssued: 0, lastMode: '', updatedAt: '' },
    map: {}
  };

  const data = safeReadJson(PAGE_IDS_FILE, fallback);
  if (!data || typeof data !== 'object') return fallback;

  if (!data.meta || typeof data.meta !== 'object') data.meta = fallback.meta;
  if (!data.map || typeof data.map !== 'object') data.map = {};

  const li = Number(data.meta.lastIssued);
  data.meta.lastIssued = Number.isFinite(li) && li >= 0 ? li : 0;

  return data;
}

function parsePageIdToNumber(pageId) {
  const m = String(pageId || '').match(/^page(\d{6,})$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function computeEffectiveLastIssued(state) {
  let maxNum = Number(state?.meta?.lastIssued) || 0;
  const map = state?.map || {};

  for (const slug of Object.keys(map)) {
    const n = parsePageIdToNumber(map[slug]);
    if (Number.isFinite(n) && n > maxNum) maxNum = n;
  }
  return maxNum;
}

function getTestPageId() {
  return 'page000001';
}

/**
 * slug의 pageId를 가져옵니다.
 * - live: 없으면 발급 + 파일 기록
 * - test: 항상 page000001
 */
function getPageIdForSlug(slug) {
  const mode = normalizeMode(process.env.PAGE_ID_MODE);

  if (!slug) return mode === 'live' ? 'page000001' : getTestPageId();

  if (mode !== 'live') {
    return getTestPageId();
  }

  const state = initState();

  // 기존 매핑 있으면 그대로 반환
  if (state.map[slug]) {
    return state.map[slug];
  }

  // 새 발급 (재사용 방지 보정 포함)
  const last = computeEffectiveLastIssued(state);
  const next = last + 1;
  const pageId = `page${pad6(next)}`;

  state.map[slug] = pageId;
  state.meta.lastIssued = next;
  state.meta.lastMode = 'live';
  state.meta.updatedAt = new Date().toISOString();

  atomicWriteJson(PAGE_IDS_FILE, state);
  return pageId;
}

/**
 * 외부에서 pageId를 강제로 박아넣고 싶을 때 사용(예: 이미 확정된 pageId 이관)
 * - live에서만 기록
 * - lastIssued 자동 보정(더 큰 번호가 들어오면 lastIssued를 끌어올림)
 */
function setPageIdForSlug(slug, pageId) {
  const mode = normalizeMode(process.env.PAGE_ID_MODE);
  if (mode !== 'live') return false;
  if (!slug || !pageId) return false;

  const state = initState();
  state.map[slug] = pageId;

  const n = parsePageIdToNumber(pageId);
  const last = computeEffectiveLastIssued(state);
  // map 반영 후 last를 다시 계산했으니, meta.lastIssued를 last로 동기화
  state.meta.lastIssued = last;
  state.meta.lastMode = 'live';
  state.meta.updatedAt = new Date().toISOString();

  atomicWriteJson(PAGE_IDS_FILE, state);
  return true;
}

/**
 * (선택) manifest를 읽기만 하고 싶을 때
 */
function readPageIdsManifest() {
  return initState();
}

module.exports = {
  getPageIdForSlug,
  setPageIdForSlug,
  readPageIdsManifest,
  PAGE_IDS_FILE
};
