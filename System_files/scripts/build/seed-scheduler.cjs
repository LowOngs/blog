#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/seed-scheduler.cjs
 *
 * 역할:
 * - warehouse에서 "오늘 발행 큐"(dist/queue/today.json) 생성
 *
 * 핵심 규칙(확정):
 * - 시간 기준: today.json 메타(timezone=Asia/Seoul, cutoff=10:00)는 여기서 변경하지 않음
 * - 슬롯 라벨(slotLabel) ≠ 시드 출처 라벨(seedLabel)
 * - fallback은 "시드만" 대체, 슬롯 라벨은 유지
 *
 * 소비 규칙(확정):
 * - warehouse 배열은 FIFO 큐로 취급한다.
 * - scheduler는 항상 앞에서 꺼내고(shift), 꺼낸 건 창고에서 제거한다.
 * - 제거 전에 사용(소비) 기록을 seed-ledger에 남긴다.
 *
 * 최소 보강:
 * - evergreen 시드 고갈 감지 시 WARN 로그 출력
 *   (충전/대체/판단 로직은 refill 책임)
 *
 * [중요 수정(이번 패치)]
 * - consume 레코드에 fingerprint를 반드시 기록한다.
 *   - warehouse seed에 fingerprint가 있으면 그대로 사용
 *   - 없으면 lib/fingerprint.cjs의 buildFingerprintFromSeed()로 생성해서 기록
 * - fingerprint가 끝내 생성되지 않으면:
 *   - ledger 기록도 안 함
 *   - shift도 안 함
 *   - 해당 슬롯만 스킵(전체 파이프라인 중단 방지)
 */

require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');

// seed-ledger (존재 시 사용)
let seedLedger = null;
try {
  seedLedger = require('./lib/seed-ledger.cjs');
} catch {
  seedLedger = null;
}

// fingerprint 유틸(없어도 되지만, fingerprint 빈값 방지를 위해 사용)
let fpUtil = null;
try {
  fpUtil = require('./lib/fingerprint.cjs');
} catch {
  fpUtil = null;
}

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const SEEDPOOL_DIR = path.join(ROOT, 'seedpool');
const WAREHOUSE_DIR = path.join(SEEDPOOL_DIR, 'warehouse');
const WAREHOUSE_TREND_DIR = path.join(WAREHOUSE_DIR, 'trend');
const WAREHOUSE_EVERGREEN_DIR = path.join(WAREHOUSE_DIR, 'evergreen');

const OUTDIR = path.join(ROOT, 'dist', 'queue');
fs.mkdirSync(OUTDIR, { recursive: true });

// ────────────────────────────────────
// 라벨 SSOT
// ────────────────────────────────────
const ALLOWED_LABELS = new Set([
  'app-reviews',
  'device-reviews',
  'subscription-services',
  'how-to-playbooks',
  'smart-savings',
  'templates-checklists',
]);

// evergreen 최소 경고 기준 (의미만 전달, 제어는 refill 책임)
const MIN_EVERGREEN_THRESHOLD = 20;

function fatal(msg) {
  console.error('[seed-scheduler][FATAL]', msg);
  process.exit(1);
}
function warn(msg) {
  console.warn('[seed-scheduler][WARN]', msg);
}
function assertAllowedLabel(label, ctx) {
  const v = String(label || '').trim();
  if (!v) fatal(`label missing (${ctx})`);
  if (!ALLOWED_LABELS.has(v)) fatal(`label not allowed: "${v}" (${ctx})`);
  return v;
}

// ────────────────────────────────────
// 날짜(큐 날짜만 생성; 시간대는 today.json 메타)
// ────────────────────────────────────
function getTodayDateKstOnly() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ────────────────────────────────────
// 요일 슬롯 계획(기존 규칙 유지)
// ────────────────────────────────────
function planForWeekday(weekday) {
  switch (weekday) {
    case 1:
      return [
        { slotLabel: 'how-to-playbooks', mode: 'trend' },
        { slotLabel: 'app-reviews', mode: 'trend' },
      ];
    case 2:
      return [{ slotLabel: 'how-to-playbooks', mode: 'trend' }];
    case 3:
      return [
        { slotLabel: 'how-to-playbooks', mode: 'trend' },
        { slotLabel: 'app-reviews', mode: 'trend' },
        { slotLabel: 'templates-checklists', mode: 'trend' },
      ];
    case 4:
      return [{ slotLabel: 'how-to-playbooks', mode: 'trend' }];
    case 5:
      return [
        { slotLabel: 'how-to-playbooks', mode: 'trend' },
        { slotLabel: 'app-reviews', mode: 'trend' },
      ];
    case 6:
    case 7:
      return [{ slotLabel: 'smart-savings', mode: 'trend' }];
    default:
      return [{ slotLabel: 'how-to-playbooks', mode: 'trend' }];
  }
}

// ────────────────────────────────────
// IO helpers
// ────────────────────────────────────
function readJsonSafe(filePath, fallbackObj) {
  if (!fs.existsSync(filePath)) return fallbackObj;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    warn(`JSON parse failed: ${filePath} :: ${e.message}`);
    return fallbackObj;
  }
}

function writeJsonAtomic(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function warehouseFilePath(label, mode) {
  if (mode === 'trend') {
    return path.join(WAREHOUSE_TREND_DIR, `${label}-trend.json`);
  }
  if (mode === 'evergreen') {
    return path.join(WAREHOUSE_EVERGREEN_DIR, `${label}-evergreen.json`);
  }
  fatal(`unsupported mode: ${mode}`);
  return null;
}

// ────────────────────────────────────
// FIFO pop from warehouse (with expired/invalid purge on head)
// ────────────────────────────────────
function isExpired(it, todayStr) {
  if (!it || !it.expiresAt) return false;
  const exp = String(it.expiresAt).slice(0, 10);
  return exp < todayStr;
}

function isValidSeed(it) {
  return !!(it && typeof it === 'object' && it.id && it.title);
}

// fingerprint 보정(warehouse에 없을 때 생성)
function ensureFingerprint(seed) {
  if (!seed || typeof seed !== 'object') return '';
  const have = String(seed.fingerprint || '').trim();
  if (have) return have;

  // ✅ 옹스님이 제공한 fingerprint.cjs 기준: buildFingerprintFromSeed 가 정답 export
  if (fpUtil && typeof fpUtil.buildFingerprintFromSeed === 'function') {
    try {
      const fp = fpUtil.buildFingerprintFromSeed(seed);
      return String(fp || '').trim();
    } catch (e) {
      warn(`[fingerprint] build failed: ${e.message}`);
      return '';
    }
  }

  warn('[fingerprint] fp util missing or invalid export; cannot build fingerprint');
  return '';
}

/**
 * FIFO 소비:
 * - 배열 맨 앞부터 유효한 1개를 찾는다.
 * - 선두에 "만료/무효"가 걸려 있으면 shift로 제거(창고가 막히지 않게).
 * - picked는 ledger 기록 후 제거(shift)한다.
 */
function popNextFromWarehouse(label, mode, usedIds, todayStr) {
  const file = warehouseFilePath(label, mode);
  const empty = { label, limits: { [mode]: 0 }, [mode]: [] };

  const data = readJsonSafe(file, empty);
  const arrName = mode; // trend or evergreen
  const arr = Array.isArray(data[arrName]) ? data[arrName] : [];

  // evergreen 고갈 경고(알림만)
  if (mode === 'evergreen' && arr.length < MIN_EVERGREEN_THRESHOLD) {
    warn(`evergreen low: label=${label}, count=${arr.length} (< ${MIN_EVERGREEN_THRESHOLD})`);
  }

  while (arr.length > 0) {
    const head = arr[0];

    // 무효/만료는 제거(막힘 방지)
    if (!isValidSeed(head)) {
      warn(`[warehouse] drop invalid head: label=${label}, mode=${mode}`);
      arr.shift();
      continue;
    }
    if (isExpired(head, todayStr)) {
      warn(`[warehouse] drop expired head: label=${label}, mode=${mode}, id=${head.id}`);
      arr.shift();
      continue;
    }
    if (usedIds.has(head.id)) {
      warn(`[warehouse] drop duplicate head in-run: label=${label}, mode=${mode}, id=${head.id}`);
      arr.shift();
      continue;
    }

    const picked = head;

    // ✅ fingerprint 확보(warehouse에 없으면 생성)
    const fp = ensureFingerprint(picked);

    // ✅ fp가 끝내 비면: "소비 자체를 중단"이 아니라, "해당 슬롯만 스킵"
    // - ledger 기록 X
    // - shift X
    // - today.json에서도 이 슬롯은 빠짐
    if (!fp) {
      warn(
        `[fingerprint] empty -> skip slot (no ledger, no shift): label=${label}, mode=${mode}, id=${picked.id}`
      );
      return null;
    }

    // ledger 기록(제거 전에)
    if (seedLedger && typeof seedLedger.upsert === 'function') {
      try {
        seedLedger.upsert({
          label,
          mode,
          seedId: picked.id,
          title: picked.title || '',
          intent: picked.intent || '',
          fingerprint: fp,
          status: 'used',
          stage: 'consume',
          usedAt: new Date().toISOString(),
        });
      } catch (e) {
        // 옹스님 원칙: 기록 후 제거. 기록 실패 시 제거하면 안 됨 → 여기서 중단.
        fatal(`[ledger] upsert failed: ${e.message}`);
      }
    } else {
      fatal('seed-ledger.cjs not available: cannot record before consuming.');
    }

    // 제거(shift)
    arr.shift();

    // 저장
    data[arrName] = arr;
    writeJsonAtomic(file, data);

    usedIds.add(picked.id);

    // 반환 객체에도 fingerprint 채움
    if (!picked.fingerprint) picked.fingerprint = fp;

    return picked;
  }

  return null;
}

// ────────────────────────────────────
// main
// ────────────────────────────────────
(function main() {
  const todayStr = getTodayDateKstOnly();
  const weekday = new Date().getDay() || 7;

  console.log('[seed-scheduler] date=', todayStr, 'weekday=', weekday);

  const plan = planForWeekday(weekday).map((p) => ({
    slotLabel: assertAllowedLabel(p.slotLabel, 'slotLabel'),
    mode: p.mode || 'trend',
  }));

  const usedIds = new Set();
  const items = [];

  for (const slot of plan) {
    const slotLabel = slot.slotLabel;
    const preferredMode = slot.mode === 'evergreen' ? 'evergreen' : 'trend';

    const picked = popNextFromWarehouse(slotLabel, preferredMode, usedIds, todayStr);
    if (!picked) continue;

    items.push({
      date: todayStr,
      label: slotLabel,      // 슬롯 라벨 유지
      seedLabel: slotLabel,  // 현재는 동일(확장 여지 유지)
      mode: preferredMode,
      id: picked.id,
      title: picked.title,
      angle: picked.angle || '',
      audience: picked.audience || '',
      intent: picked.intent || '',
      priority: picked.priority ?? 0, // 기존 출력 필드 유지 (필드 삭제 금지)
      notes: picked.notes || '',
    });
  }

  const outFile = path.join(OUTDIR, 'today.json');
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        date: todayStr,
        timezone: 'Asia/Seoul',
        cutoff: '10:00',
        items,
      },
      null,
      2
    ),
    'utf8'
  );

  console.log('[seed-scheduler] written →', outFile);
})();
