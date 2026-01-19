#!/usr/bin/env node
'use strict';

// System_files/scripts/build/build-ssot-reviews.cjs
// 역할: review-ratings-next.json(bySlug)을 baseline(review-ratings.json)에 안전 업서트하고,
//      읽기 전용 미러(content/ssot/reviews.bySlug.json)도 함께 갱신한다.

require('./lib/env.cjs'); // ✅ env 로더 최우선

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const REV_DIR = path.join(ROOT, 'content', 'reviews');
const SSOT_DIR = path.join(ROOT, 'content', 'ssot');

const BASELINE_PATH = path.join(REV_DIR, 'review-ratings.json');
const NEXT_PATH = path.join(REV_DIR, 'review-ratings-next.json');
const OUT_PATH = path.join(SSOT_DIR, 'reviews.bySlug.json');

function parseDryRun(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'false' || s === '0') return false;
  return true; // 기본 안전
}

const DRY_RUN = parseDryRun(process.env.DRY_RUN);

function nowIsoKst() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  // 표기용(+09:00) — 엄밀한 TZ 처리까진 안 하지만, 프로젝트 표기 규칙 유지
  return d.toISOString().replace('Z', '+09:00');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeReadJSON(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) return defaultValue;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return defaultValue;
    const data = JSON.parse(raw);

    // 구포맷 방어: { app:[...] } → { bySlug:{...} }
    if (!data.bySlug && Array.isArray(data.app)) {
      const bySlug = {};
      for (const row of data.app) {
        if (row && typeof row === 'object' && row.slug) bySlug[row.slug] = row;
      }
      return { bySlug };
    }

    if (!data.bySlug || typeof data.bySlug !== 'object') return { bySlug: {} };
    return data;
  } catch (e) {
    console.error(`[ssot] JSON 파싱 실패: ${filePath}`);
    console.error(`[ssot] 이유: ${e.message}`);
    console.error('[ssot] 안전을 위해 종료합니다(파일 보호).');
    process.exit(1);
  }
}

function writePretty(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function clone(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : obj;
}

/**
 * 변경 판정(가볍게):
 * - ratingCurrent / votesCurrent / status / store / lastChecked / histogram / insights 중 하나라도 달라지면 변경
 */
function isChanged(prev, curr) {
  if (!prev) return true;

  const keys = ['ratingCurrent', 'votesCurrent', 'status', 'store', 'lastChecked', 'storeId', 'source'];
  for (const k of keys) {
    if ((prev[k] ?? null) !== (curr[k] ?? null)) return true;
  }

  // histogram 비교(1~5)
  const a = prev.histogram && typeof prev.histogram === 'object' ? prev.histogram : {};
  const b = curr.histogram && typeof curr.histogram === 'object' ? curr.histogram : {};
  for (const s of ['1', '2', '3', '4', '5']) {
    if (Number(a[s] ?? 0) !== Number(b[s] ?? 0)) return true;
  }

  // insights 비교(문자열 배열)
  const ia = Array.isArray(prev.insights) ? prev.insights.map(String) : [];
  const ib = Array.isArray(curr.insights) ? curr.insights.map(String) : [];
  if (ia.length !== ib.length) return true;
  for (let i = 0; i < ia.length; i++) {
    if (ia[i] !== ib[i]) return true;
  }

  return false;
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[ssot] build-ssot-reviews 시작');
  console.log('[ssot] ROOT      =', ROOT);
  console.log('[ssot] baseline  =', BASELINE_PATH);
  console.log('[ssot] next      =', NEXT_PATH);
  console.log('[ssot] out       =', OUT_PATH);
  console.log('[ssot] DRY_RUN   =', DRY_RUN ? 'true(dry-run)' : 'false(live)');
  console.log('────────────────────────────────────────────');

  ensureDir(SSOT_DIR);

  const baseline = safeReadJSON(BASELINE_PATH, { bySlug: {} });
  const next = safeReadJSON(NEXT_PATH, { bySlug: {} });

  const baseBySlug = baseline.bySlug || {};
  const nextBySlug = next.bySlug || {};

  // baseline 초기화 금지: baseline을 복사해서 “업서트”만 한다.
  const mergedBaseline = { bySlug: clone(baseBySlug) || {} };

  const nextSlugs = Object.keys(nextBySlug);
  let newCount = 0;
  let changedCount = 0;
  let sameCount = 0;

  for (const slug of nextSlugs) {
    const curr = nextBySlug[slug];
    if (!curr || typeof curr !== 'object') continue;

    const prev = mergedBaseline.bySlug[slug];
    if (!prev) newCount++;

    if (isChanged(prev, curr)) {
      mergedBaseline.bySlug[slug] = curr;
      if (prev) changedCount++;
    } else {
      sameCount++;
    }
  }

  // 읽기전용 SSOT 미러(항상 갱신)
  const mirror = {
    version: 1,
    updatedAt: nowIsoKst(),
    bySlug: mergedBaseline.bySlug,
  };

  // DRY_RUN이면 파일 WRITE 금지
  if (DRY_RUN) {
    console.log(`[ssot] DRY_RUN preview: next=${nextSlugs.length} | 신규=${newCount} | 변경=${changedCount} | 동일=${sameCount}`);
    console.log('[ssot] DRY_RUN: no file writes.');
    return;
  }

  // ✅ LIVE: baseline(review-ratings.json) 갱신 (업서트)
  // - baseline이 “주입기/리졸버/검증기”의 실제 SSOT이므로 반드시 여기가 갱신되어야 함.
  writePretty(BASELINE_PATH, { bySlug: mergedBaseline.bySlug });

  // ✅ LIVE: 미러도 함께 저장(디버깅/관측용)
  writePretty(OUT_PATH, mirror);

  console.log(`[ssot] 완료: next=${nextSlugs.length} | 신규=${newCount} | 변경=${changedCount} | 동일=${sameCount}`);
  console.log('[ssot] baseline 저장 완료:', BASELINE_PATH);
  console.log('[ssot] SSOT 미러 저장 완료:', OUT_PATH);
}

main();
