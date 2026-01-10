// System_files/scripts/build/firstgate-pick.cjs
// First-Gate Daily Picker: warehouse/first-gate(read-only) → dist/queue/firstgate.json 생성

require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');

/** 프로젝트 ROOT: System_files 기준 */
const ROOT = path.resolve(__dirname, '../..');
const WAREHOUSE_FIRSTGATE_DIR = path.join(ROOT, 'seedpool', 'warehouse', 'first-gate');
const DIST_QUEUE_DIR = path.join(ROOT, 'dist', 'queue');
const DIST_QUEUE_FILE = path.join(DIST_QUEUE_DIR, 'firstgate.json');
const USAGE_FILE = path.join(ROOT, 'manifests', 'firstgate-usage.json');

/** firstgate에서 허용되는 라벨(6개) */
const ALLOWED_LABELS = new Set([
  'app-reviews',
  'device-reviews',
  'subscription-services',
  'how-to-playbooks',
  'smart-savings',
  'templates-checklists',
]);

function fatal(msg) {
  console.error('[firstgate-pick][FATAL]', msg);
  process.exit(1);
}

/** UTC 오늘 날짜 (YYYY-MM-DD) */
function getTodayUtcDate() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** ISO8601 (UTC) */
function nowUtcIso() {
  return new Date().toISOString();
}

/** 파일 존재 여부 */
function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** JSON 로드 (없으면 null) */
function loadJson(p) {
  if (!fileExists(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

/** JSON 저장 (pretty) */
function saveJson(p, data) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * 사용 기록 로드
 * {
 *   lastRunAt: ISO,
 *   usedKeys: ["label::seedId", ...]
 * }
 */
function loadUsage() {
  const base = { lastRunAt: null, usedKeys: [] };
  const data = loadJson(USAGE_FILE);
  if (!data) return base;

  const usedKeys = Array.isArray(data.usedKeys) ? data.usedKeys : [];
  return { lastRunAt: data.lastRunAt || null, usedKeys };
}

/** 사용 기록 저장 */
function saveUsage(usage) {
  saveJson(USAGE_FILE, usage);
}

/** 파일명에서 라벨 추출: {label}-firstgate.json */
function inferLabelFromFilename(filename) {
  const lower = String(filename || '').toLowerCase();
  const m = lower.match(/^(.+)-firstgate\.json$/);
  const label = m && m[1] ? m[1] : '';
  return label;
}

/** 라벨 검증(6개 중 1개) */
function assertAllowedLabel(label, context) {
  const v = String(label || '').trim();
  if (!v) fatal(`label missing (${context})`);
  if (!ALLOWED_LABELS.has(v)) fatal(`label not allowed: "${v}" (${context})`);
  return v;
}

/** warehouse/first-gate/*.json 에서 모든 시드 flatten */
function loadAllFirstGateSeeds() {
  if (!fs.existsSync(WAREHOUSE_FIRSTGATE_DIR)) {
    fatal(`First-gate warehouse directory not found: ${WAREHOUSE_FIRSTGATE_DIR}`);
  }

  const files = fs
    .readdirSync(WAREHOUSE_FIRSTGATE_DIR)
    .filter((f) => f.endsWith('-firstgate.json'));

  const allSeeds = [];

  for (const filename of files) {
    const fullPath = path.join(WAREHOUSE_FIRSTGATE_DIR, filename);
    const json = loadJson(fullPath);
    if (!json) continue;

    // 라벨: json.label 우선, 없으면 파일명에서 추론
    const inferred = inferLabelFromFilename(filename);
    const label = assertAllowedLabel(json.label || inferred, `warehouse file=${filename}`);

    const firstGate = Array.isArray(json.firstGate) ? json.firstGate : [];
    for (let i = 0; i < firstGate.length; i++) {
      const seed = firstGate[i] || {};
      const id = String(seed.id || `${label}-fg-${i + 1}`).trim();
      if (!id) continue;

      const key = `${label}::${id}`;
      const createdAt = seed.createdAt || null;
      const priority = typeof seed.priority === 'number' ? seed.priority : 999;

      // seed에 label이 없으면, 큐에서 쓰기 쉽게 주입(창고 파일은 수정하지 않음)
      const seedWithLabel = seed.label ? seed : { ...seed, label };

      allSeeds.push({
        key,
        label,
        id,
        file: fullPath,
        index: i,
        priority,
        createdAt,
        seed: seedWithLabel,
      });
    }
  }

  return allSeeds;
}

/**
 * 사용되지 않은 시드 중에서 1개 선택
 * 1) priority 오름차순
 * 2) createdAt 오름차순(없으면 뒤)
 * 3) file + index (tie-break)
 */
function pickOneSeed(allSeeds, usedKeys) {
  const usedSet = new Set(usedKeys || []);
  const candidates = allSeeds.filter((s) => !usedSet.has(s.key));
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;

    if (a.createdAt && !b.createdAt) return -1;
    if (!a.createdAt && b.createdAt) return 1;
    if (a.createdAt && b.createdAt) {
      const ta = Date.parse(a.createdAt);
      const tb = Date.parse(b.createdAt);
      if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta - tb;
    }

    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.index - b.index;
  });

  return candidates[0];
}

/**
 * dist/queue/firstgate.json 작성
 * {
 *   date, source, label, seedId, pickedAt, seed
 * }
 */
function writeQueueFile(picked) {
  const label = assertAllowedLabel(picked.label, `picked key=${picked.key}`);

  const payload = {
    date: getTodayUtcDate(),
    source: 'firstgate',
    label,
    seedId: picked.id,
    pickedAt: nowUtcIso(),
    seed: picked.seed,
  };

  saveJson(DIST_QUEUE_FILE, payload);
}

function main() {
  console.log('[firstgate-pick] Start');

  const usage = loadUsage();
  const allSeeds = loadAllFirstGateSeeds();

  if (allSeeds.length === 0) {
    console.log('[firstgate-pick] No first-gate seeds found. Nothing to do.');
    return;
  }

  const picked = pickOneSeed(allSeeds, usage.usedKeys);
  if (!picked) {
    console.log('[firstgate-pick] No unused first-gate seeds remaining. Nothing to do.');
    return;
  }

  // 큐 파일 생성
  writeQueueFile(picked);

  // 사용 기록 업데이트(warehouse는 수정하지 않음)
  const usedKeys = new Set(usage.usedKeys || []);
  usedKeys.add(picked.key);

  saveUsage({
    lastRunAt: nowUtcIso(),
    usedKeys: Array.from(usedKeys),
  });

  console.log(`[firstgate-pick] Selected: ${picked.label} / ${picked.id}`);
  console.log(`[firstgate-pick] Queue written: ${DIST_QUEUE_FILE}`);
  console.log('[firstgate-pick] Done');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[firstgate-pick] ERROR:', err && err.message ? err.message : err);
    process.exit(1);
  }
}
