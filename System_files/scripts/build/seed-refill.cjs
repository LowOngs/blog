#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/seed-refill.cjs
 *
 * 역할:
 * - warehouse(trend/evergreen) 시드 보충 전용 스크립트
 * - 발급(LLM 생성) 로직과 소비(scheduler) 로직과 분리
 *
 * 정책(최종 확정):
 * - first-gate는 본 스크립트 대상이 아님 (firstgate-daily.yml 별도)
 *
 * refill 실행 주기(정책):
 * - 7일 (스케줄러/액션에서 호출)
 *
 * 계산(최종):
 * - 최근 7일 사용량 × 1.5배를 "목표 재고(target)"로 본다.
 * - 콜드스타트 안전장치: 라벨별 limits 값을 최소 floor로 사용한다.
 *   => target = max(floor, ceil(used7 * 1.5))
 *
 * 저장:
 * - warehouse 뒤에 push만 수행 (재배치/중간삽입 없음)
 *
 * 중복 차단:
 * - fingerprint 기반 중복 금지
 * - 사용 여부 조회는 fp-cache used 기준으로 확인
 *
 * [중요 수정(기존)]
 * - 더미 생성기(generateSeedsDummy)가 매번 동일한 title/angle/audience/intent로 생성되어
 *   fingerprint가 동일해져 1개만 채워지는 문제가 있었음.
 * - 해결: title/angle에 idx(변동값)를 포함해 fingerprint가 서로 달라지게 함.
 *   (id는 fingerprint에 쓰지 않는 정책이므로 title/angle 변동으로 해결)
 *
 * [추가 중요 수정(기존)]
 * - need 만큼 "반드시" 채워야 하므로,
 *   부분 생성(guard로 중간 종료) 시 조용히 넘어가지 않고 FATAL로 중단한다.
 *
 * [이번 수정]
 * - seed-ledger.jsonl 전체 스캔으로 fingerprint를 모으지 않고
 *   lib/fp-cache.cjs 의 hasUsedFingerprint() 기준으로 중복 여부를 판정
 */

require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');

// fingerprint SSOT 유틸
const fpUtil = require('./lib/fingerprint.cjs');

// fp-cache 유틸
const fpCache = require('./lib/fp-cache.cjs');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const SEEDPOOL_DIR = path.join(ROOT, 'seedpool');
const WAREHOUSE_DIR = path.join(SEEDPOOL_DIR, 'warehouse');
const WAREHOUSE_TREND_DIR = path.join(WAREHOUSE_DIR, 'trend');
const WAREHOUSE_EVERGREEN_DIR = path.join(WAREHOUSE_DIR, 'evergreen');
const LOGS_DIR = path.join(ROOT, 'logs');

const LEDGER_FILE = path.join(LOGS_DIR, 'seed-ledger.jsonl');

const LABELS = [
  'app-reviews',
  'device-reviews',
  'how-to-playbooks',
  'smart-savings',
  'subscription-services',
  'templates-checklists',
];

const WINDOW_DAYS = 7;
const MULTIPLIER = 1.5;

function fatal(msg) {
  console.error('[seed-refill][FATAL]', msg);
  process.exit(1);
}
function warn(msg) {
  console.warn('[seed-refill][WARN]', msg);
}

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

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function loadLedgerLines() {
  if (!fs.existsSync(LEDGER_FILE)) return [];
  const lines = fs.readFileSync(LEDGER_FILE, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip bad line
    }
  }
  return out;
}

/**
 * 사용량 카운트 기준:
 * - scheduler가 남긴 레코드: {label, mode, status:'used', stage:'consume', usedAt: ISO}
 */
function countUsed(label, mode, windowDays) {
  const ledger = loadLedgerLines();
  const cutoff = new Date(daysAgoIso(windowDays));
  let n = 0;

  for (const r of ledger) {
    if (!r) continue;
    if (r.label !== label) continue;
    if (r.mode !== mode) continue;
    if (r.status !== 'used') continue;
    if (!r.usedAt) continue;
    const t = new Date(r.usedAt);
    if (Number.isNaN(t.getTime())) continue;
    if (t >= cutoff) n++;
  }
  return n;
}

/**
 * warehousePath
 */
function warehousePath(label, mode) {
  if (mode === 'trend') return path.join(WAREHOUSE_TREND_DIR, `${label}-trend.json`);
  if (mode === 'evergreen') return path.join(WAREHOUSE_EVERGREEN_DIR, `${label}-evergreen.json`);
  fatal(`unsupported mode: ${mode}`);
  return null;
}

/**
 * 목표 재고 계산:
 * target = max(floor, ceil(used7 * 1.5))
 */
function computeTarget(floor, used7) {
  const needByUsage = Math.ceil(used7 * MULTIPLIER);
  return Math.max(floor, needByUsage);
}

/**
 * 더미 생성기:
 * - title/angle에 idx 포함 → fingerprint 고유화
 * - need 만큼 못 채우면 FATAL (부분 충전 금지)
 * - fp-cache.hasUsedFingerprint() 기준으로 이미 사용된 fingerprint는 폐기
 *
 * 주의:
 * - 여기서는 "used 기록"을 하지 않음
 * - refill은 생성/보충 단계이므로, 실제 소비 전에는 fp-cache used에 기록하면 안 됨
 */
function generateSeedsDummy(label, mode, count) {
  const out = [];
  let guard = 0;

  // "부분생성 방지"를 위해 상한을 크게 잡고, 상한 도달 시 즉시 실패 처리
  const MAX_ATTEMPTS = Math.max(1000, count * 500);

  // 같은 refill 실행 안에서의 중복 방지
  const localFpSet = new Set();

  while (out.length < count) {
    guard++;
    if (guard > MAX_ATTEMPTS) {
      fatal(
        `dummy generation exhausted: label=${label}, mode=${mode}, want=${count}, got=${out.length}, attempts=${guard}. ` +
        `Likely fingerprint collisions due to non-varying fields or fp-cache already saturated.`
      );
    }

    const idx = String(Date.now()) + '-' + String(Math.floor(Math.random() * 1e9));
    const seed = {
      id: `${label}-${mode}-${idx}`,

      // title/angle에 idx 포함 → fp 중복 방지
      title: `AUTO GENERATED: ${label} (${mode}) #${idx}`,
      angle: `Auto angle (${mode}) var=${idx}`,

      audience: 'General',
      intent: mode === 'trend' ? 'trend' : 'evergreen',
      priority: 5,
      createdAt: new Date().toISOString(),
      notes: 'Replace with real LLM generation.',
    };

    const fp = fpUtil.buildFingerprintFromSeed(seed);

    // 같은 refill 실행 내부 중복 방지
    if (localFpSet.has(fp)) continue;

    // 장기 사용 이력 기준 중복 방지 (fp-cache used 기준)
    if (fpCache.hasUsedFingerprint(fp)) continue;

    localFpSet.add(fp);

    seed.fingerprint = fp;
    out.push(seed);
  }

  // 방어: 정책상 "부분생성" 절대 금지
  if (out.length !== count) {
    fatal(`dummy generation shortfall: label=${label}, mode=${mode}, want=${count}, got=${out.length}`);
  }

  return out;
}

function refillOne(label, mode) {
  const file = warehousePath(label, mode);

  const empty = { label, limits: { [mode]: 0 }, [mode]: [] };
  const data = readJsonSafe(file, empty);

  if (data.label !== label) {
    fatal(`label mismatch in warehouse file: ${file} (got=${data.label}, want=${label})`);
  }

  const floor = Number(data.limits && data.limits[mode]);
  if (!Number.isFinite(floor) || floor < 0) {
    fatal(`missing/invalid limits.${mode} in: ${file}`);
  }

  const arr = Array.isArray(data[mode]) ? data[mode] : [];
  const current = arr.length;

  const used7 = countUsed(label, mode, WINDOW_DAYS);
  const target = computeTarget(floor, used7);

  if (current >= target) {
    console.log(
      `[refill] ${label} ${mode}: OK (current=${current}, target=${target}, used7=${used7}, floor=${floor})`
    );
    return;
  }

  const need = target - current;
  console.log(
    `[refill] ${label} ${mode}: need=${need} (current=${current}, target=${target}, used7=${used7}, floor=${floor})`
  );

  const gen = generateSeedsDummy(label, mode, need);

  // push only
  data[mode] = arr.concat(gen);

  writeJsonAtomic(file, data);
}

(function main() {
  console.log('=== Seed Refill Start ===');
  console.log(`[refill] windowDays=${WINDOW_DAYS}, multiplier=${MULTIPLIER} (first-gate excluded)`);

  for (const label of LABELS) {
    refillOne(label, 'trend');
    refillOne(label, 'evergreen');
  }

  console.log('=== Seed Refill Done ===');
})();
