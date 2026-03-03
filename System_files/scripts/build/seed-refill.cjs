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
 * - fingerprint 기반 중복 금지 (seed-ledger 기준)
 */

require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');

// fingerprint SSOT 유틸(이미 바이오에 존재한다고 기록됨)
const fpUtil = require('./lib/fingerprint.cjs');

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

function collectExistingFingerprints() {
  const ledger = loadLedgerLines();
  const set = new Set();
  for (const r of ledger) {
    if (r && r.fingerprint) set.add(String(r.fingerprint));
  }
  return set;
}

function warehousePath(label, mode) {
  if (mode === 'trend') return path.join(WAREHOUSE_TREND_DIR, `${label}-trend.json`);
  if (mode === 'evergreen') return path.join(WAREHOUSE_EVERGREEN_DIR, `${label}-evergreen.json`);
  fatal(`unsupported mode: ${mode}`);
  return null;
}

/**
 * 목표 재고 계산:
 * target = max(floor, ceil(used7 * 1.5))
 *
 * 여기서 floor는 warehouse 파일의 limits 값(라벨별 권장량).
 * upper cap은 "강제하지 않음":
 * - warehouse가 이미 더 많으면 건드리지 않는다(삭제/재배치 금지).
 * - 부족할 때만 채운다.
 */
function computeTarget(floor, used7) {
  const needByUsage = Math.ceil(used7 * MULTIPLIER);
  return Math.max(floor, needByUsage);
}

/**
 * LLM 생성 자리:
 * - 지금은 더미 생성기(형태/필드만 맞춘다)
 * - 실제 생성 로직으로 교체해도 fingerprint 중복 차단과 push 규칙은 유지
 */
function generateSeedsDummy(label, mode, count, fpSet) {
  const out = [];
  let guard = 0;

  while (out.length < count) {
    guard++;
    if (guard > count * 50) break; // 무한루프 방지(정책상 band-aid가 아니라 안전장치)

    const idx = String(Date.now()) + '-' + String(Math.floor(Math.random() * 1e9));
    const seed = {
      id: `${label}-${mode}-${idx}`,
      title: `AUTO GENERATED: ${label} (${mode})`,
      angle: `Auto angle (${mode})`,
      audience: 'General',
      intent: mode === 'trend' ? 'trend' : 'evergreen',
      priority: 5,
      createdAt: new Date().toISOString(),
      notes: 'Replace with real LLM generation.',
    };

    // fingerprint SSOT 유틸 사용
    const fp = fpUtil.fingerprint
      ? fpUtil.fingerprint(seed.title, seed.angle, seed.audience, seed.intent)
      : fpUtil(seed.title, seed.angle, seed.audience, seed.intent);

    if (fpSet.has(fp)) continue;
    fpSet.add(fp);

    // warehouse 아이템에 fingerprint 포함(후속 중복차단/감사에 유리)
    seed.fingerprint = fp;
    out.push(seed);
  }

  return out;
}

function refillOne(label, mode, fpSet) {
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
    console.log(`[refill] ${label} ${mode}: OK (current=${current}, target=${target}, used7=${used7}, floor=${floor})`);
    return;
  }

  const need = target - current;
  console.log(`[refill] ${label} ${mode}: need=${need} (current=${current}, target=${target}, used7=${used7}, floor=${floor})`);

  const gen = generateSeedsDummy(label, mode, need, fpSet);

  // push only (재배치 없음)
  data[mode] = arr.concat(gen);

  writeJsonAtomic(file, data);
}

(function main() {
  console.log('=== Seed Refill Start ===');
  console.log(`[refill] windowDays=${WINDOW_DAYS}, multiplier=${MULTIPLIER} (first-gate excluded)`);

  const fpSet = collectExistingFingerprints();

  // trend/evergreen만 대상
  for (const label of LABELS) {
    refillOne(label, 'trend', fpSet);
    refillOne(label, 'evergreen', fpSet);
  }

  console.log('=== Seed Refill Done ===');
})();
