// System_files/scripts/build/ids.cjs

const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const MANIFESTS_DIR = path.join(ROOT, 'manifests');
const PAGE_IDS_FILE = path.join(MANIFESTS_DIR, 'page-ids.json');

function log(...a) {
  console.log('[ids]', ...a);
}

function pad6(n) {
  return String(n).padStart(6, '0');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    log('WARN read/parse failed:', path.basename(file), e.message || e);
    return fallback;
  }
}

function atomicWriteJson(file, obj) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function normalizeMode(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'live') return 'live';
  return 'test';
}

function extractSlugFromPostFilename(filename) {
  // content/posts/<slug>.json
  return filename.replace(/\.json$/i, '');
}

function getNowISO() {
  return new Date().toISOString();
}

function initState() {
  const fallback = {
    meta: {
      lastIssued: 0,
      lastMode: '',
      updatedAt: ''
    },
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

  // 혹시 lastIssued가 깨졌거나 map에 더 큰 값이 있으면 보정(재발급 방지)
  const map = state?.map || {};
  for (const k of Object.keys(map)) {
    const n = parsePageIdToNumber(map[k]);
    if (Number.isFinite(n) && n > maxNum) maxNum = n;
  }

  return maxNum;
}

function getOrCreatePageId(state, slug) {
  const existing = state.map[slug];
  if (existing) {
    // lastIssued보다 작게 저장돼 있어도 기존 매핑은 유지(재발급/중복 방지 목적)
    return existing;
  }

  const lastIssued = computeEffectiveLastIssued(state);
  const next = lastIssued + 1;
  const pageId = `page${pad6(next)}`;

  state.map[slug] = pageId;
  state.meta.lastIssued = next;
  state.meta.updatedAt = getNowISO();
  state.meta.lastMode = 'live';

  return pageId;
}

(async function main() {
  const mode = normalizeMode(process.env.PAGE_ID_MODE);
  const scheduleMode = String(process.env.SCHEDULE_MODE || '').trim();

  log('ROOT =', ROOT);
  log('PAGE_ID_MODE =', mode, scheduleMode ? `(SCHEDULE_MODE=${scheduleMode})` : '');

  if (!fs.existsSync(POSTS_DIR)) {
    log('No posts dir:', POSTS_DIR);
    process.exit(0);
  }

  const files = fg.sync('*.json', { cwd: POSTS_DIR }).sort();
  const slugs = files.map(extractSlugFromPostFilename);

  log('posts =', slugs.length);

  if (mode !== 'live') {
    // test 모드: 절대 기록하지 않음
    log('test mode: no persistence');
    process.exit(0);
  }

  const state = initState();
  const beforeLast = computeEffectiveLastIssued(state);

  let created = 0;
  for (const slug of slugs) {
    if (!slug) continue;
    const existed = !!state.map[slug];
    const pid = getOrCreatePageId(state, slug);
    if (!existed) created++;
    log(`${slug} -> ${pid}${existed ? '' : ' (new)'}`);
  }

  const afterLast = computeEffectiveLastIssued(state);

  ensureDir(MANIFESTS_DIR);
  atomicWriteJson(PAGE_IDS_FILE, state);

  log('manifest =', PAGE_IDS_FILE);
  log('lastIssued:', beforeLast, '->', afterLast);
  log('new mappings:', created);
})().catch((e) => {
  console.error('[ids][FAIL]', e.message || e);
  process.exit(1);
});
