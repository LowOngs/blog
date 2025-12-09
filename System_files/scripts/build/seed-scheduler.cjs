// System_files/scripts/build/seed-scheduler.cjs
// 시드풀 → 오늘 발행할 큐(dist/queue/today.json) 생성 + fallback 라벨 지원

const fs = require('fs');
const path = require('path');

// ────────────────────────────────────
// 기본 경로 설정
// ────────────────────────────────────
const ROOT    = path.resolve(__dirname, '..', '..'); // System_files
const SEEDDIR = path.join(ROOT, 'seedpool');
const OUTDIR  = path.join(ROOT, 'dist', 'queue');

fs.mkdirSync(OUTDIR, { recursive: true });

// ────────────────────────────────────
// 날짜/요일 유틸 (ISO: 월=1 … 일=7)
// ────────────────────────────────────
function getTodayInfo() {
  const now = new Date();

  // ISO 요일 (1=월 … 7=일)
  let weekday = now.getUTCDay();
  if (weekday === 0) weekday = 7;

  // ISO 주차(대략적, 정확한 통계 필요 없으니 간단 계산)
  const oneJan = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const diff   = (now - oneJan) / 86400000;
  const isoWeek = Math.floor((diff + oneJan.getUTCDay() + 1) / 7);

  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

  return { now, dateStr, weekday, isoWeek };
}

// ────────────────────────────────────
// 오늘 요일에 따른 기본 발행 라벨/모드 계획
//   ※ 이미 옹스님이 잡아둔 패턴에 맞춤
//   - 월(1): how-to + app
//   - 화(2): how-to
//   - 수(3): how-to + app + templates
//   - 목(4): how-to
//   - 금(5): how-to + app
//   - 토(6): smart-savings
//   - 일(7): smart-savings
//   (device / subscription은 추후 시드 충분해지면 추가)
// ────────────────────────────────────
function planForWeekday(weekday) {
  switch (weekday) {
    case 1: // Mon
      return [
        { label: 'how-to-playbooks', mode: 'trend' },
        { label: 'app-reviews',      mode: 'trend' }
      ];
    case 2: // Tue
      return [
        { label: 'how-to-playbooks', mode: 'trend' }
      ];
    case 3: // Wed
      return [
        { label: 'how-to-playbooks',     mode: 'trend' },
        { label: 'app-reviews',          mode: 'trend' },
        { label: 'templates-checklists', mode: 'trend' }
      ];
    case 4: // Thu
      return [
        { label: 'how-to-playbooks', mode: 'trend' }
      ];
    case 5: // Fri
      return [
        { label: 'how-to-playbooks', mode: 'trend' },
        { label: 'app-reviews',      mode: 'trend' }
      ];
    case 6: // Sat
      return [
        { label: 'smart-savings', mode: 'trend' }
      ];
    case 7: // Sun
      return [
        { label: 'smart-savings', mode: 'trend' }
      ];
    default:
      // 이론상 올 일은 없지만, 방어용
      return [
        { label: 'how-to-playbooks', mode: 'trend' },
        { label: 'app-reviews',      mode: 'trend' }
      ];
  }
}

// ────────────────────────────────────
/**
 * Fallback 라벨 설정
 *   - 어떤 라벨이든 시드가 부족하면 이 순서대로 대체 시도
 *   - 본인(label)과 같으면 건너뜀
 */
const FALLBACK_LABELS = [
  'how-to-playbooks',
  'app-reviews'
];
// ────────────────────────────────────

// 시드 JSON 캐시: label → { trend, evergreen, trendLimit, evergreenLimit }
const SEED_CACHE = new Map();

// 시드 파일 로드
function loadSeedConfig(label) {
  if (SEED_CACHE.has(label)) return SEED_CACHE.get(label);

  const file = path.join(SEEDDIR, `${label}.json`);
  if (!fs.existsSync(file)) {
    console.warn(`[seed-scheduler][WARN] 시드 파일 없음: ${file}`);
    const empty = {
      label,
      trendLimit: 0,
      evergreenLimit: 0,
      trend: [],
      evergreen: []
    };
    SEED_CACHE.set(label, empty);
    return empty;
  }

  const raw = fs.readFileSync(file, 'utf8');
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    console.warn(`[seed-scheduler][WARN] 시드 JSON 파싱 실패(${label}):`, e.message || e);
    json = {};
  }

  const cfg = {
    label:           json.label || label,
    trendLimit:      json.trendLimit ?? 0,
    evergreenLimit:  json.evergreenLimit ?? 0,
    trend:           Array.isArray(json.trend) ? json.trend : [],
    evergreen:       Array.isArray(json.evergreen) ? json.evergreen : []
  };

  SEED_CACHE.set(label, cfg);
  return cfg;
}

// 특정 라벨에서 후보 시드 목록 필터링
function getCandidates(cfg, mode, usedIds, todayStr) {
  const todayISO = todayStr;

  const filterBase = (item) => {
    if (!item || !item.id) return false;
    if (usedIds.has(item.id)) return false;
    if (item.expiresAt && typeof item.expiresAt === 'string') {
      // ISO8601 문자열이면 문자열 비교로도 대략 맞음(YYYY-MM-DD…)
      if (item.expiresAt < todayISO) return false;
    }
    return true;
  };

  let trend = cfg.trend.filter(filterBase);
  let evergreen = cfg.evergreen.filter(filterBase);

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

// 후보 중 1개 선택 (priority 낮은 숫자 우선 + 동순위 랜덤)
function pickOne(candidates, effectiveMode, usedIds) {
  if (!candidates.length) return null;

  const sorted = [...candidates].sort((a, b) => {
    const pa = (typeof a.priority === 'number') ? a.priority : 999;
    const pb = (typeof b.priority === 'number') ? b.priority : 999;
    return pa - pb;
  });

  const topPriority = (typeof sorted[0].priority === 'number') ? sorted[0].priority : 999;
  const topGroup = sorted.filter((s) => {
    const p = (typeof s.priority === 'number') ? s.priority : 999;
    return p === topPriority;
  });

  const picked = topGroup[Math.floor(Math.random() * topGroup.length)];
  usedIds.add(picked.id);

  return { seed: picked, mode: effectiveMode };
}

// 주 라벨에서 시드 1개 선택
function pickSeedForLabel(label, preferredMode, usedIds, todayStr) {
  const cfg = loadSeedConfig(label);
  const { list, effectiveMode } = getCandidates(cfg, preferredMode, usedIds, todayStr);
  if (!list.length) return null;
  return pickOne(list, effectiveMode, usedIds);
}

// ────────────────────────────────────
// 메인 로직
// ────────────────────────────────────
(function main() {
  const { dateStr, weekday, isoWeek } = getTodayInfo();

  console.log('────────────────────────────────────────────');
  console.log('[seed-scheduler] ROOT   =', ROOT);
  console.log('[seed-scheduler] SEED   =', SEEDDIR);
  console.log('[seed-scheduler] OUTDIR =', OUTDIR);
  console.log(
    '[seed-scheduler] DATE   =',
    dateStr,
    'weekday=',
    weekday,
    'isoWeek=',
    isoWeek
  );

  const plan = planForWeekday(weekday); // [{label, mode}, …]
  const plannedLabels = plan.map((p) => p.label).join(', ');
  console.log('[seed-scheduler] planned labels =', plannedLabels);

  const usedIds = new Set();
  const items = [];

  for (const slot of plan) {
    const primaryLabel = slot.label;
    const preferredMode = slot.mode || 'trend';

    // 1) 기본 라벨에서 시드 선택 시도
    let picked = pickSeedForLabel(primaryLabel, preferredMode, usedIds, dateStr);
    let finalLabel = primaryLabel;
    let fallbackFrom = null;

    // 2) 실패하면 fallback 라벨 순서대로 대체 시도
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
      notes: seed.notes || ''
    };

    if (fallbackFrom) {
      item.fallbackFrom = fallbackFrom;
    }

    items.push(item);
  }

  const outFile = path.join(OUTDIR, 'today.json');
  const outJson = {
    date: dateStr,
    items
  };

  fs.writeFileSync(outFile, JSON.stringify(outJson, null, 2), 'utf8');
  console.log('[seed-scheduler] queue written →', outFile);
})();