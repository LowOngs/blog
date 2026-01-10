#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/seed-scheduler.cjs
 * 시드풀 → 오늘 발행할 큐(dist/queue/today.json) 생성 + fallback 라벨 지원
 * ✅ SCHEDULE_MODE 제거: 큐 생성은 환경과 무관하게 항상 수행
 */

// ✅ 로컬/CI 공통: .env 로드(필수)
require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');

/**
 * AOIA FLOW MAP REFERENCE
 * --------------------------------------------------
 * Flow Map: System_files/docs/aoia-flow-map.md
 *
 * Role:
 *   - seedpool/*.json에서 오늘 발행할 seed를 골라 dist/queue/today.json(SSOT)를 생성
 *   - 부족하면 FALLBACK_LABELS에서 대체(seed만 대체, 라벨은 대체 라벨로 기록)
 *
 * Output:
 *   - dist/queue/today.json
 *
 * Invariants:
 *   - label은 6개 중 1개만 허용(오염/오타 즉시 차단)
 *   - expiresAt(YYYY-MM-DD...) 지난 시드는 제외
 *   - 동일 id 중복 선택 금지(usedIds)
 */

// ────────────────────────────────────
// 기본 경로 설정
// ────────────────────────────────────
const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const SEEDDIR = path.join(ROOT, 'seedpool');
const OUTDIR = path.join(ROOT, 'dist', 'queue');

fs.mkdirSync(OUTDIR, { recursive: true });

// ────────────────────────────────────
// 라벨(SSOT) 고정
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

function assertAllowedLabel(label, context) {
  const v = String(label || '').trim();
  if (!v) fatal(`label missing (${context})`);
  if (!ALLOWED_LABELS.has(v)) {
    fatal(`label not allowed: "${v}" (${context})`);
  }
  return v;
}

// ────────────────────────────────────
// 날짜/요일 유틸 (ISO: 월=1 … 일=7)
// ────────────────────────────────────
function getTodayInfo() {
  const now = new Date();

  // ISO 요일 (1=월 … 7=일)
  let weekday = now.getUTCDay();
  if (weekday === 0) weekday = 7;

  // ISO 주차(대략적)
  const oneJan = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const diff = (now - oneJan) / 86400000;
  const isoWeek = Math.floor((diff + oneJan.getUTCDay() + 1) / 7);

  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return { now, dateStr, weekday, isoWeek };
}

// ────────────────────────────────────
// 오늘 요일에 따른 기본 발행 라벨/모드 계획
// ────────────────────────────────────
function planForWeekday(weekday) {
  switch (weekday) {
    case 1:
      return [
        { label: 'how-to-playbooks', mode: 'trend' },
        { label: 'app-reviews', mode: 'trend' },
      ];
    case 2:
      return [{ label: 'how-to-playbooks', mode: 'trend' }];
    case 3:
      return [
        { label: 'how-to-playbooks', mode: 'trend' },
        { label: 'app-reviews', mode: 'trend' },
        { label: 'templates-checklists', mode: 'trend' },
      ];
    case 4:
      return [{ label: 'how-to-playbooks', mode: 'trend' }];
    case 5:
      return [
        { label: 'how-to-playbooks', mode: 'trend' },
        { label: 'app-reviews', mode: 'trend' },
      ];
    case 6:
      return [{ label: 'smart-savings', mode: 'trend' }];
    case 7:
      return [{ label: 'smart-savings', mode: 'trend' }];
    default:
      return [
        { label: 'how-to-playbooks', mode: 'trend' },
        { label: 'app-reviews', mode: 'trend' },
      ];
  }
}

/**
 * Fallback 라벨 설정
 * - “원래 슬롯 라벨”에서 seed가 없으면,
 *   이 목록에서 seed를 가져오고 label도 그 라벨로 기록합니다.
 */
const FALLBACK_LABELS = [
  'how-to-playbooks',
  'app-reviews',
].map((l) => assertAllowedLabel(l, 'FALLBACK_LABELS'));

const SEED_CACHE = new Map();

function loadSeedConfig(label) {
  const safeLabel = assertAllowedLabel(label, 'loadSeedConfig(label)');

  if (SEED_CACHE.has(safeLabel)) return SEED_CACHE.get(safeLabel);

  const file = path.join(SEEDDIR, `${safeLabel}.json`);
  if (!fs.existsSync(file)) {
    console.warn(`[seed-scheduler][WARN] 시드 파일 없음: ${file}`);
    const empty = { label: safeLabel, trendLimit: 0, evergreenLimit: 0, trend: [], evergreen: [] };
    SEED_CACHE.set(safeLabel, empty);
    return empty;
  }

  const raw = fs.readFileSync(file, 'utf8');
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    console.warn(`[seed-scheduler][WARN] 시드 JSON 파싱 실패(${safeLabel}):`, e.message || e);
    json = {};
  }

  const cfg = {
    label: assertAllowedLabel(json.label || safeLabel, `seed file label (${safeLabel}.json)`),
    trendLimit: json.trendLimit ?? 0,
    evergreenLimit: json.evergreenLimit ?? 0,
    trend: Array.isArray(json.trend) ? json.trend : [],
    evergreen: Array.isArray(json.evergreen) ? json.evergreen : [],
  };

  SEED_CACHE.set(safeLabel, cfg);
  return cfg;
}

function getCandidates(cfg, mode, usedIds, todayStr) {
  const todayISO = String(todayStr || '').slice(0, 10);

  const filterBase = (item) => {
    if (!item || typeof item !== 'object') return false;
    if (!item.id) return false;
    if (usedIds.has(item.id)) return false;

    // expiresAt이 있으면 YYYY-MM-DD만 비교(문자열 비교 가능)
    if (item.expiresAt && typeof item.expiresAt === 'string') {
      const exp = item.expiresAt.slice(0, 10);
      if (exp < todayISO) return false;
    }
    return true;
  };

  const trend = cfg.trend.filter(filterBase);
  const evergreen = cfg.evergreen.filter(filterBase);

  if (mode === 'trend') {
    if (trend.length) return { list: trend, effectiveMode: 'trend' };
    if (evergreen.length) return { list: evergreen, effectiveMode: 'evergreen' };
    return { list: [], effectiveMode: 'trend' };
  } else {
    if (evergreen.length) return { list: evergreen, effectiveMode: 'evergreen' };
    if (trend.length) return { list: trend, effectiveMode: 'trend' };
    return { list: [], effectiveMode: 'evergreen' };
  }
}

function pickOne(candidates, effectiveMode, usedIds) {
  if (!candidates.length) return null;

  const sorted = [...candidates].sort((a, b) => {
    const pa = typeof a.priority === 'number' ? a.priority : 999;
    const pb = typeof b.priority === 'number' ? b.priority : 999;
    return pa - pb;
  });

  const topPriority = typeof sorted[0].priority === 'number' ? sorted[0].priority : 999;
  const topGroup = sorted.filter((s) => {
    const p = typeof s.priority === 'number' ? s.priority : 999;
    return p === topPriority;
  });

  const picked = topGroup[Math.floor(Math.random() * topGroup.length)];
  usedIds.add(picked.id);

  return { seed: picked, mode: effectiveMode };
}

function pickSeedForLabel(label, preferredMode, usedIds, todayStr) {
  const safeLabel = assertAllowedLabel(label, 'pickSeedForLabel(label)');
  const cfg = loadSeedConfig(safeLabel);
  const { list, effectiveMode } = getCandidates(cfg, preferredMode, usedIds, todayStr);
  if (!list.length) return null;
  return pickOne(list, effectiveMode, usedIds);
}

(function main() {
  const { dateStr, weekday, isoWeek } = getTodayInfo();

  console.log('────────────────────────────────────────────');
  console.log('[seed-scheduler] ROOT   =', ROOT);
  console.log('[seed-scheduler] SEED   =', SEEDDIR);
  console.log('[seed-scheduler] OUTDIR =', OUTDIR);
  console.log('[seed-scheduler] DATE   =', dateStr, 'weekday=', weekday, 'isoWeek=', isoWeek);

  const plan = planForWeekday(weekday).map((p, i) => {
    const label = assertAllowedLabel(p.label, `planForWeekday slot[${i}]`);
    const mode = String(p.mode || 'trend').trim() || 'trend';
    return { label, mode };
  });

  console.log('[seed-scheduler] planned labels =', plan.map((p) => p.label).join(', '));

  const usedIds = new Set();
  const items = [];

  for (const slot of plan) {
    const primaryLabel = slot.label;
    const preferredMode = slot.mode || 'trend';

    let picked = pickSeedForLabel(primaryLabel, preferredMode, usedIds, dateStr);
    let finalLabel = primaryLabel;
    let fallbackFrom = null;

    if (!picked) {
      for (const fb of FALLBACK_LABELS) {
        if (fb === primaryLabel) continue;
        const alt = pickSeedForLabel(fb, preferredMode, usedIds, dateStr);
        if (alt) {
          picked = alt;
          finalLabel = fb;
          fallbackFrom = primaryLabel;
          break;
        }
      }
    }

    if (!picked) {
      console.warn(
        `[seed-scheduler][WARN] ${primaryLabel} 슬롯에서 사용 가능한 시드를 찾지 못했습니다. (fallback 포함)`
      );
      continue;
    }

    const { seed, mode } = picked;

    if (fallbackFrom) {
      console.log(
        `[seed-scheduler][PICK] ${finalLabel} (fallback from ${fallbackFrom}) → ${mode} ${seed.id} | ${seed.title}`
      );
    } else {
      console.log(
        `[seed-scheduler][PICK] ${finalLabel} → ${mode} ${seed.id} | ${seed.title}`
      );
    }

    const item = {
      date: dateStr,
      label: finalLabel,
      mode,
      id: seed.id,
      title: seed.title,
      angle: seed.angle || '',
      audience: seed.audience || '',
      intent: seed.intent || '',
      priority: typeof seed.priority === 'number' ? seed.priority : 0,
      notes: seed.notes || '',
    };

    if (fallbackFrom) item.fallbackFrom = fallbackFrom;
    items.push(item);
  }

  const outFile = path.join(OUTDIR, 'today.json');
  const outJson = { date: dateStr, items };

  fs.writeFileSync(outFile, JSON.stringify(outJson, null, 2), 'utf8');
  console.log('[seed-scheduler] queue written →', outFile);
})();
