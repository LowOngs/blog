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

function fatal(msg) {
  console.error('[seed-scheduler][FATAL]', msg);
  process.exit(1);
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
  // 날짜 문자열만 생성(YYYY-MM-DD)
  // 시간대/컷오프 로직은 외부(today.json 메타)에서 이미 확정
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
// Seed 로딩(시드 출처 라벨은 파일 기준)
// ────────────────────────────────────
const SEED_CACHE = new Map();

function loadSeedConfig(seedLabel) {
  const safe = assertAllowedLabel(seedLabel, 'loadSeedConfig(seedLabel)');
  if (SEED_CACHE.has(safe)) return SEED_CACHE.get(safe);

  const file = path.join(SEEDDIR, `${safe}.json`);
  if (!fs.existsSync(file)) {
    SEED_CACHE.set(safe, { label: safe, trend: [], evergreen: [] });
    return SEED_CACHE.get(safe);
  }

  let json = {};
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    json = {};
  }

  const cfg = {
    label: safe, // 파일 label 신뢰하지 않음(오염 방지)
    trend: Array.isArray(json.trend) ? json.trend : [],
    evergreen: Array.isArray(json.evergreen) ? json.evergreen : [],
  };

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
// Fallback 대상(시드 출처만 대체)
// ────────────────────────────────────
const FALLBACK_SEED_LABELS = [
  'how-to-playbooks',
  'app-reviews',
].map((l) => assertAllowedLabel(l, 'FALLBACK_SEED_LABELS'));

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

    // 1) 기본: 슬롯 라벨과 동일한 시드 출처
    let seedLabel = slotLabel;
    let cfg = loadSeedConfig(seedLabel);

    let candidates =
      preferredMode === 'trend'
        ? filterCandidates(cfg.trend, usedIds, todayStr)
        : filterCandidates(cfg.evergreen, usedIds, todayStr);

    let picked = pickOne(candidates, usedIds);

    // 2) fallback: 시드 출처만 변경
    if (!picked) {
      for (const fb of FALLBACK_SEED_LABELS) {
        if (fb === seedLabel) continue;
        const fbCfg = loadSeedConfig(fb);
        const fbList =
          preferredMode === 'trend'
            ? filterCandidates(fbCfg.trend, usedIds, todayStr)
            : filterCandidates(fbCfg.evergreen, usedIds, todayStr);
        const alt = pickOne(fbList, usedIds);
        if (alt) {
          picked = alt;
          seedLabel = fb;
          break;
        }
      }
    }

    if (!picked) continue;

    items.push({
      date: todayStr,
      label: slotLabel,   // 슬롯 기준(통계/스코프)
      seedLabel,          // 실제 시드 출처
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
