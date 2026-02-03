#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/seed-scheduler.cjs
 * 시드풀 → 오늘 발행할 큐(dist/queue/today.json) 생성
 *
 * ✅ 핵심 변경(2-a-3/2-a-4 대응):
 * - slotLabel(스케줄 슬롯 라벨)과 seedLabel(실제 시드 출처 라벨)을 분리
 * - fallback은 "seedLabel만" 대체하며, today.json의 label(=slotLabel)은 절대 바꾸지 않음
 * - 결과: 요일 슬롯 분배(통계/스코프)는 label(slotLabel)로 안정 유지
 *         posts 생성은 seedLabel 기준으로 하도록 후속 파일에서 사용
 */

// ✅ 로컬/CI 공통: .env 로드(필수)
require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');

// ────────────────────────────────────
// 기본 경로
// ────────────────────────────────────
const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const SEEDDIR = path.join(ROOT, 'seedpool');
const OUTDIR = path.join(ROOT, 'dist', 'queue');

fs.mkdirSync(OUTDIR, { recursive: true });

// ────────────────────────────────────
// today.json 상단 메타(스키마 확정분)
// ────────────────────────────────────
const QUEUE_TIMEZONE = 'Asia/Seoul';
const QUEUE_CUTOFF = '10:00';

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
  if (!ALLOWED_LABELS.has(v)) fatal(`label not allowed: "${v}" (${context})`);
  return v;
}

// ────────────────────────────────────
// 날짜/요일 유틸 (KST + cutoff 기반 “운영일” 계산)
// - 운영일: KST cutoff(10:00) 이전이면 전날로 간주
// - weekday: 운영일 기준 ISO(월=1 … 일=7)
// ────────────────────────────────────
function parseCutoffHHMM(hhmm) {
  const s = String(hhmm || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { hh: 10, mm: 0 }; // 안전 기본
  const hh = Math.min(23, Math.max(0, Number(m[1])));
  const mm = Math.min(59, Math.max(0, Number(m[2])));
  return { hh, mm };
}

function kstPartsFromUtcDate(d) {
  // KST = UTC+9
  const t = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    hh: t.getUTCHours(),
    mm: t.getUTCMinutes(),
    // weekday: 0=일..6=토 (UTC getter로 OK; t는 “KST 시각을 UTC로 담은 객체”)
    w: t.getUTCDay(),
  };
}

function ymdStr(y, m, d) {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function addDaysYMD(y, m, d, deltaDays) {
  // 안전: UTC 기준 Date로 계산
  const base = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return {
    y: base.getUTCFullYear(),
    m: base.getUTCMonth() + 1,
    d: base.getUTCDate(),
  };
}

function isoWeekdayFromKstDow(dow0Sun) {
  // dow0Sun: 0=일..6=토 → ISO: 1=월..7=일
  if (dow0Sun === 0) return 7;
  return dow0Sun; // 1..6는 월..토 그대로
}

function getTodayInfo() {
  const nowUtc = new Date();

  const { hh: cutHH, mm: cutMM } = parseCutoffHHMM(QUEUE_CUTOFF);
  const kst = kstPartsFromUtcDate(nowUtc);

  // cutoff 이전이면 운영일을 "전날"로
  const beforeCutoff = (kst.hh < cutHH) || (kst.hh === cutHH && kst.mm < cutMM);
  const op = beforeCutoff ? addDaysYMD(kst.y, kst.m, kst.d, -1) : { y: kst.y, m: kst.m, d: kst.d };

  // 운영일 KST 요일 계산: 운영일 00:00(KST)을 UTC로 환산해 요일 계산
  const opUtc = new Date(Date.UTC(op.y, op.m - 1, op.d, 0, 0, 0) - 9 * 60 * 60 * 1000);
  const kstDow0Sun = new Date(opUtc.getTime() + 9 * 60 * 60 * 1000).getUTCDay();
  const weekday = isoWeekdayFromKstDow(kstDow0Sun);

  // ISO 주차(대략): 운영일 기반(엄밀 ISO는 아니나 기존 수준 유지)
  const oneJanUtc = new Date(Date.UTC(op.y, 0, 1, 0, 0, 0) - 9 * 60 * 60 * 1000);
  const opStartUtc = new Date(Date.UTC(op.y, op.m - 1, op.d, 0, 0, 0) - 9 * 60 * 60 * 1000);
  const diffDays = Math.floor((opStartUtc - oneJanUtc) / 86400000);
  const isoWeek = Math.floor((diffDays + oneJanUtc.getUTCDay() + 1) / 7);

  const dateStr = ymdStr(op.y, op.m, op.d); // 운영일 YYYY-MM-DD
  return {
    nowUtc,
    dateStr,
    weekday,
    isoWeek,
    kstNow: { y: kst.y, m: kst.m, d: kst.d, hh: kst.hh, mm: kst.mm },
    beforeCutoff,
  };
}

// ────────────────────────────────────
// 오늘 요일에 따른 기본 발행 슬롯 계획(라벨=slotLabel)
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

// ────────────────────────────────────
// Fallback 설정(“대체 seedLabel 후보 목록”)
// - slotLabel은 유지, seedLabel만 대체
// ────────────────────────────────────
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

  // ✅ seedpool 파일의 json.label이 있어도, “파일명 기반 safeLabel”과 다르면 오염으로 판단할 수 있음
  // 지금 단계에선 강제 FATAL 대신 “허용 라벨인지”만 체크하고, cfg.label은 safeLabel로 고정
  // (오염 FATAL 정책은 옹스님이 원하시면 다음 파일에서 강화/완화 선택)
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

    // expiresAt이 있으면 YYYY-MM-DD만 비교
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

function pickSeedForLabel(seedLabel, preferredMode, usedIds, todayStr) {
  const safeLabel = assertAllowedLabel(seedLabel, 'pickSeedForLabel(seedLabel)');
  const cfg = loadSeedConfig(safeLabel);
  const { list, effectiveMode } = getCandidates(cfg, preferredMode, usedIds, todayStr);
  if (!list.length) return null;
  return pickOne(list, effectiveMode, usedIds);
}

// ────────────────────────────────────
// main
// ────────────────────────────────────
(function main() {
  const { dateStr, weekday, isoWeek, kstNow, beforeCutoff } = getTodayInfo();

  console.log('────────────────────────────────────────────');
  console.log('[seed-scheduler] ROOT   =', ROOT);
  console.log('[seed-scheduler] SEED   =', SEEDDIR);
  console.log('[seed-scheduler] OUTDIR =', OUTDIR);
  console.log('[seed-scheduler] DATE   =', dateStr, 'weekday=', weekday, 'isoWeek=', isoWeek);
  console.log('[seed-scheduler] META   =', `tz=${QUEUE_TIMEZONE}`, `cutoff=${QUEUE_CUTOFF}`, `kstNow=${kstNow.hh}:${String(kstNow.mm).padStart(2, '0')}`, `beforeCutoff=${beforeCutoff}`);

  const plan = planForWeekday(weekday).map((p, i) => {
    const slotLabel = assertAllowedLabel(p.label, `planForWeekday slot[${i}]`);
    const mode = String(p.mode || 'trend').trim() || 'trend';
    return { slotLabel, mode };
  });

  console.log('[seed-scheduler] planned slot labels =', plan.map((p) => p.slotLabel).join(', '));

  const usedIds = new Set();
  const items = [];

  for (const slot of plan) {
    const slotLabel = slot.slotLabel;        // ✅ 슬롯 라벨(고정)
    const preferredMode = slot.mode || 'trend';

    // 1) 우선: slotLabel에서 seed 선택
    let picked = pickSeedForLabel(slotLabel, preferredMode, usedIds, dateStr);
    let seedLabel = slotLabel;               // ✅ 실제 seed 출처 라벨(기본=slotLabel)
    let fallbackFrom = null;

    // 2) 부족하면: fallback 라벨들에서 seed만 가져오고, slotLabel은 유지
    if (!picked) {
      for (const fb of FALLBACK_LABELS) {
        if (fb === slotLabel) continue;
        const alt = pickSeedForLabel(fb, preferredMode, usedIds, dateStr);
        if (alt) {
          picked = alt;
          seedLabel = fb;
          fallbackFrom = slotLabel;
          break;
        }
      }
    }

    if (!picked) {
      console.warn(`[seed-scheduler][WARN] slot=${slotLabel} 에서 사용 가능한 시드를 찾지 못했습니다. (fallback 포함)`);
      continue;
    }

    const { seed, mode } = picked;

    if (fallbackFrom) {
      console.log(`[seed-scheduler][PICK] slot=${slotLabel} seed=${seedLabel} (fallback) → ${mode} ${seed.id} | ${seed.title}`);
    } else {
      console.log(`[seed-scheduler][PICK] slot=${slotLabel} → ${mode} ${seed.id} | ${seed.title}`);
    }

    // ✅ today.json item
    // - label: slotLabel (스케줄 분배/통계/스코프의 기준)
    // - seedLabel: 실제 seed를 읽어온 출처 라벨 (posts 생성 기준으로 사용)
    const item = {
      date: dateStr,
      label: slotLabel,
      seedLabel,

      mode,
      id: seed.id,
      title: seed.title,
      angle: seed.angle || '',
      audience: seed.audience || '',
      intent: seed.intent || '',
      priority: typeof seed.priority === 'number' ? seed.priority : 0,
      notes: seed.notes || '',
    };

    if (fallbackFrom) item.fallbackFrom = fallbackFrom; // 디버그/감사 목적(선택)
    items.push(item);
  }

  const outFile = path.join(OUTDIR, 'today.json');
  const outJson = {
    date: dateStr,
    timezone: QUEUE_TIMEZONE,
    cutoff: QUEUE_CUTOFF,
    items,
  };

  fs.writeFileSync(outFile, JSON.stringify(outJson, null, 2), 'utf8');
  console.log('[seed-scheduler] queue written →', outFile);
})();
