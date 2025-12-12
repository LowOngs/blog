// System_files/scripts/build/firstgate-pick.cjs

/* 
 * First-Gate Daily Picker
 * - Reads warehouse/first-gate/*.json (read-only)
 * - Picks exactly 1 unused first-gate seed across all labels
 * - Writes:
 *    - dist/queue/firstgate.json     (today's first-gate queue)
 *    - manifests/firstgate-usage.json (used seed tracking)
 *
 * Run time (추천): 매일 UTC 23:40 (발행 20분 전)
 */

const fs = require('fs');
const path = require('path');

/** 프로젝트 ROOT: System_files 기준 */
const ROOT = path.resolve(__dirname, '../..');
const WAREHOUSE_FIRSTGATE_DIR = path.join(
  ROOT,
  'seedpool',
  'warehouse',
  'first-gate'
);
const DIST_QUEUE_DIR = path.join(ROOT, 'dist', 'queue');
const DIST_QUEUE_FILE = path.join(DIST_QUEUE_DIR, 'firstgate.json');
const USAGE_FILE = path.join(ROOT, 'manifests', 'firstgate-usage.json');

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
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * 사용 기록 로드
 * 구조 예:
 * {
 *   "lastRunAt": "2025-12-12T23:40:00Z",
 *   "usedKeys": ["how-to-playbooks::ht-fg-001", ...]
 * }
 */
function loadUsage() {
  const base = {
    lastRunAt: null,
    usedKeys: []
  };
  const data = loadJson(USAGE_FILE);
  if (!data) return base;
  if (!Array.isArray(data.usedKeys)) data.usedKeys = [];
  return {
    lastRunAt: data.lastRunAt || null,
    usedKeys: data.usedKeys
  };
}

/** 사용 기록 저장 */
function saveUsage(usage) {
  saveJson(USAGE_FILE, usage);
}

/** warehouse/first-gate/*.json 에서 모든 시드 flatten */
function loadAllFirstGateSeeds() {
  if (!fs.existsSync(WAREHOUSE_FIRSTGATE_DIR)) {
    throw new Error(
      `First-gate warehouse directory not found: ${WAREHOUSE_FIRSTGATE_DIR}`
    );
  }

  const files = fs
    .readdirSync(WAREHOUSE_FIRSTGATE_DIR)
    .filter((f) => f.endsWith('-firstgate.json'));

  const allSeeds = [];

  files.forEach((filename) => {
    const fullPath = path.join(WAREHOUSE_FIRSTGATE_DIR, filename);
    const json = loadJson(fullPath);
    if (!json) return;

    const label = json.label;
    const firstGate = Array.isArray(json.firstGate) ? json.firstGate : [];

    firstGate.forEach((seed, index) => {
      const id = seed.id || `${label}-fg-${index + 1}`;
      const key = `${label}::${id}`;
      const createdAt = seed.createdAt || null;
      const priority =
        typeof seed.priority === 'number' ? seed.priority : 999;

      allSeeds.push({
        key,
        label,
        id,
        file: fullPath,
        index,
        priority,
        createdAt,
        seed
      });
    });
  });

  return allSeeds;
}

/**
 * 사용되지 않은 시드 중에서 1개 선택
 * 우선순위:
 *  1) priority 오름차순
 *  2) createdAt 오름차순 (없으면 항상 뒤로)
 *  3) file + index (안정적인 tie-breaker)
 */
function pickOneSeed(allSeeds, usedKeys) {
  const usedSet = new Set(usedKeys || []);
  const candidates = allSeeds.filter((s) => !usedSet.has(s.key));

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    // 1) priority
    if (a.priority !== b.priority) return a.priority - b.priority;

    // 2) createdAt
    if (a.createdAt && !b.createdAt) return -1;
    if (!a.createdAt && b.createdAt) return 1;
    if (a.createdAt && b.createdAt) {
      const ta = Date.parse(a.createdAt);
      const tb = Date.parse(b.createdAt);
      if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) {
        return ta - tb;
      }
    }

    // 3) file + index (안정된 순서)
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.index - b.index;
  });

  return candidates[0];
}

/**
 * 오늘자 큐 파일(dist/queue/firstgate.json) 쓰기
 * 스키마 예:
 * {
 *   "date": "2025-12-12",
 *   "source": "firstgate",
 *   "label": "how-to-playbooks",
 *   "seedId": "ht-fg-001",
 *   "pickedAt": "2025-12-12T23:40:00.000Z",
 *   "seed": { ... 원본 시드 객체 ... }
 * }
 */
function writeQueueFile(picked) {
  const payload = {
    date: getTodayUtcDate(),
    source: 'firstgate',
    label: picked.label,
    seedId: picked.id,
    pickedAt: nowUtcIso(),
    seed: picked.seed
  };

  saveJson(DIST_QUEUE_FILE, payload);
}

/** 메인 실행 */
function main() {
  console.log('[firstgate-pick] Start');

  const usage = loadUsage();
  const allSeeds = loadAllFirstGateSeeds();

  if (allSeeds.length === 0) {
    console.log(
      '[firstgate-pick] No first-gate seeds found in warehouse. Nothing to do.'
    );
    return;
  }

  const picked = pickOneSeed(allSeeds, usage.usedKeys);

  if (!picked) {
    console.log(
      '[firstgate-pick] No unused first-gate seeds remaining. Nothing to do.'
    );
    return;
  }

  // 큐 파일 생성
  writeQueueFile(picked);

  // 사용 기록 업데이트 (창고 파일은 수정하지 않음)
  const key = picked.key;
  const usedKeys = new Set(usage.usedKeys || []);
  usedKeys.add(key);

  const newUsage = {
    lastRunAt: nowUtcIso(),
    usedKeys: Array.from(usedKeys)
  };

  saveUsage(newUsage);

  console.log(
    `[firstgate-pick] Selected first-gate seed: ${picked.label} / ${picked.id}`
  );
  console.log(`[firstgate-pick] Queue written: ${DIST_QUEUE_FILE}`);
  console.log('[firstgate-pick] Done');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[firstgate-pick] ERROR:', err && err.message);
    process.exit(1);
  }
}
