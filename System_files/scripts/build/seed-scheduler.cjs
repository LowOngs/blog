#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/seed-scheduler.cjs
 *
 * 역할:
 * - seedpool에서 "오늘 발행 큐"(dist/queue/today.json) 생성
 *
 * 핵심 규칙(확정):
 * - 시간 기준: today.json 메타(timezone=Asia/Seoul, cutoff=10:00)는 여기서 변경하지 않음
 * - 슬롯 라벨(slotLabel) ≠ 시드 출처 라벨(seedLabel)
 * - fallback은 "시드만" 대체, 슬롯 라벨은 유지
 *
 * 최소 보강:
 * - evergreen 시드 고갈 감지 시 WARN 로그 출력
 *   (충전/대체/판단 로직은 여기 책임 아님)
 */

// .env 로드
require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');

// ────────────────────────────────────
// 경로
// ────────────────────────────────────
const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const SEEDDIR = path.join(ROOT, 'seedpool');
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

// evergreen 최소 경고 기준 (의미만 전달, 제어는 다른 파이프라인)
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
// Seed 로딩
// ────────────────────────────────────
const SEED_CACHE = new Map();

function loadSeedConfig(seedLabel) {
  const safe = assertAllowedLabel(seedLabel, 'loadSeedConfig(seedLabel)');
  if (SEED_CACHE.has(safe)) return SEED_CACHE.get(safe);

  const file = path.join(SEEDDIR, `${safe}.json`);
  if (!fs.existsSync(file)) {
    const empty = { label: safe, trend: [], evergreen: [] };
    SEED_CACHE.set(safe, empty);
    return empty;
  }

  let json = {};
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    json = {};
  }

  const cfg = {
    label: safe,
    trend: Array.isArray(json.trend) ? json.trend : [],
    evergreen: Array.isArray(json.evergreen) ? json.evergreen : [],
  };

  // 🔔 evergreen 고갈 감지 (알림만)
  if (cfg.evergreen.length < MIN_EVERGREEN_THRESHOLD) {
    warn(
      `evergreen low: label=${safe}, count=${cfg.evergreen.length} (< ${MIN_EVERGREEN_THRESHOLD})`
    );
  }

  SEED_CACHE.set(safe, cfg);
  return cfg;
}

function filterCandidates(list, usedIds, todayStr) {
  return list.filter((it) => {
    if (!it || !it.id) return false;
    if (usedIds.has(it.id)) return false;
    if (it.expiresAt && String(it.expiresAt).slice(0, 10) < todayStr) return false;
    return true;
  });
}

function pickOne(list, usedIds) {
  if (!list.length) return null;
  const sorted = [...list].sort(
    (a, b) => (a.priority ?? 999) - (b.priority ?? 999)
  );
  const topP = sorted[0].priority ?? 999;
  const top = sorted.filter((s) => (s.priority ?? 999) === topP);
  const picked = top[Math.floor(Math.random() * top.length)];
  usedIds.add(picked.id);
  return picked;
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
    const preferredMode = slot.mode;

    const cfg = loadSeedConfig(slotLabel);

    const candidates =
      preferredMode === 'trend'
        ? filterCandidates(cfg.trend, usedIds, todayStr)
        : filterCandidates(cfg.evergreen, usedIds, todayStr);

    const picked = pickOne(candidates, usedIds);
    if (!picked) continue;

    items.push({
      date: todayStr,
      label: slotLabel,
      seedLabel: slotLabel,
      mode: preferredMode,
      id: picked.id,
      title: picked.title,
      angle: picked.angle || '',
      audience: picked.audience || '',
      intent: picked.intent || '',
      priority: picked.priority ?? 0,
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
