#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/seed-refill.cjs
 *
 * 역할:
 * - 시드 충전 전용 스크립트 (발급 로직과 완전 분리)
 *
 * 정책:
 * - evergreen : 최근 45일 사용량 × 2
 * - trend     : 최근 30일 사용량 × 2
 * - firstGate : 최근 10일 사용량 × 2
 *
 * 공통:
 * - 최소 100
 * - 최대 1000 (단, first-gate는 해당 limit 기준)
 * - fingerprint 중복 금지 (ledger 기준)
 */

require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const SEEDPOOL_DIR = path.join(ROOT, 'seedpool');
const WAREHOUSE_DIR = path.join(SEEDPOOL_DIR, 'warehouse');
const LOGS_DIR = path.join(ROOT, 'logs');

const LEDGER_FILE = path.join(LOGS_DIR, 'seed-ledger.jsonl');

const LABELS = [
  'app-reviews',
  'device-reviews',
  'how-to-playbooks',
  'smart-savings',
  'subscription-services',
  'templates-checklists'
];

const WINDOWS = {
  evergreen: 45,
  trend: 30,
  firstGate: 10
};

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function loadLedger() {
  if (!fs.existsSync(LEDGER_FILE)) return [];
  const lines = fs.readFileSync(LEDGER_FILE, 'utf8')
    .split('\n')
    .filter(Boolean);
  return lines.map(l => {
    try { return JSON.parse(l); }
    catch { return null; }
  }).filter(Boolean);
}

function countUsage(label, mode, days) {
  const ledger = loadLedger();
  const cutoff = daysAgo(days);
  return ledger.filter(r =>
    r.label === label &&
    r.mode === mode &&
    r.usedAt &&
    new Date(r.usedAt) >= cutoff
  ).length;
}

function computeTarget(currentCount, usedCount, maxLimit) {
  const desired = Math.max(100, usedCount * 2);
  const capped = Math.min(desired, maxLimit);
  if (currentCount >= capped) return 0;
  return capped - currentCount;
}

/**
 * fingerprint 생성 (간단 버전)
 */
function fingerprint(seed) {
  const base = [
    seed.title || '',
    seed.angle || '',
    seed.audience || '',
    seed.intent || ''
  ].join('|').toLowerCase().trim();
  return crypto.createHash('sha1').update(base).digest('hex');
}

function existingFingerprints() {
  const ledger = loadLedger();
  const set = new Set();
  for (const r of ledger) {
    if (r.fingerprint) set.add(r.fingerprint);
  }
  return set;
}

/**
 * 실제 LLM 호출 자리
 * 현재는 더미 생성기
 */
function generateSeeds(label, mode, count, usedFpSet) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const seed = {
      id: `${label}-${mode}-${Date.now()}-${i}`,
      title: `AUTO GENERATED ${label} ${mode} ${i}`,
      angle: `Auto angle ${i}`,
      audience: `General`,
      intent: mode,
      priority: 5
    };
    const fp = fingerprint(seed);
    if (usedFpSet.has(fp)) continue;
    seed._fingerprint = fp;
    out.push(seed);
  }
  return out;
}

function refillLabel(label) {
  const seedFile = path.join(SEEDPOOL_DIR, `${label}.json`);
  const seedData = readJSON(seedFile);

  const usedFpSet = existingFingerprints();

  for (const mode of ['trend', 'evergreen']) {
    const limit = seedData.limits?.[mode] || 1000;
    const current = seedData[mode]?.length || 0;
    const used = countUsage(label, mode, WINDOWS[mode]);
    const need = computeTarget(current, used, limit);

    if (need <= 0) {
      console.log(`[refill] ${label} ${mode} OK`);
      continue;
    }

    console.log(`[refill] ${label} ${mode} need ${need}`);

    const generated = generateSeeds(label, mode, need, usedFpSet);

    seedData[mode].push(...generated.map(s => {
      delete s._fingerprint;
      return s;
    }));

    writeJSON(seedFile, seedData);
  }
}

function refillFirstGate() {
  const fgFile = path.join(SEEDPOOL_DIR, 'first-gate.json');
  const fg = readJSON(fgFile);

  const usedFpSet = existingFingerprints();

  const current = fg.firstGate?.length || 0;
  const used = countUsage('first-gate', 'firstGate', WINDOWS.firstGate);
  const limit = fg.limits?.firstGate || 10;

  const need = computeTarget(current, used, limit);

  if (need <= 0) {
    console.log('[refill] first-gate OK');
    return;
  }

  console.log(`[refill] first-gate need ${need}`);

  const generated = generateSeeds('first-gate', 'firstGate', need, usedFpSet);

  fg.firstGate.push(...generated.map(s => {
    delete s._fingerprint;
    return s;
  }));

  writeJSON(fgFile, fg);
}

(function main() {
  console.log('=== Seed Refill Start ===');

  for (const label of LABELS) {
    refillLabel(label);
  }

  refillFirstGate();

  console.log('=== Seed Refill Done ===');
})();
