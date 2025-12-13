#!/usr/bin/env node
'use strict';

/**
 * build-ssot-reviews.cjs
 * - 입력:
 *   content/reviews/review-ratings.json (baseline, bySlug)
 *   content/reviews/review-ratings-next.json (next, bySlug)
 * - 출력:
 *   content/ssot/reviews.bySlug.json (SSOT)
 *
 * 원칙:
 * - baseline 초기화 금지
 * - next가 없으면 baseline→SSOT로만 복사(갱신시간만 업데이트)
 * - 변경 판정은 "핵심 필드" 기준으로만(가볍고 안전)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const REV_DIR = path.join(ROOT, 'content', 'reviews');
const SSOT_DIR = path.join(ROOT, 'content', 'ssot');

const BASELINE_PATH = path.join(REV_DIR, 'review-ratings.json');
const NEXT_PATH = path.join(REV_DIR, 'review-ratings-next.json');
const OUT_PATH = path.join(SSOT_DIR, 'reviews.bySlug.json');

function nowIsoKst() {
  const d = new Date();
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const iso = kst.toISOString().replace('Z', '+09:00');
  // toISOString이 UTC 기준이라 +09 보정했으니, 표기만 +09:00으로
  return iso;
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

    if (!data.bySlug || typeof data.bySlug !== 'object') {
      return { bySlug: {} };
    }
    return data;
  } catch (e) {
    console.error(`[ssot] JSON 파싱 실패: ${filePath}`);
    console.error(`[ssot] 이유: ${e.message}`);
    console.error('[ssot] 안전을 위해 종료합니다(파일 보호).');
    process.exit(1);
  }
}

function writePretty(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * 변경 판정(가볍게):
 * - ratingCurrent / votesCurrent / status / histogram / insights 중 하나라도 달라지면 변경
 */
function isChanged(prev, curr) {
  if (!prev) return true;
  const keys = ['ratingCurrent', 'votesCurrent', 'status', 'store', 'lastChecked'];
  for (const k of keys) {
    if (prev[k] !== curr[k]) return true;
  }

  // histogram 비교
  const a = prev.histogram && typeof prev.histogram === 'object' ? prev.histogram : {};
  const b = curr.histogram && typeof curr.histogram === 'object' ? curr.histogram : {};
  const stars = ['5', '4', '3', '2', '1'];
  for (const s of stars) {
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

  ensureDir(SSOT_DIR);

  const baseline = safeReadJSON(BASELINE_PATH, { bySlug: {} });
  const next = safeReadJSON(NEXT_PATH, { bySlug: {} });

  const baseBySlug = baseline.bySlug || {};
  const nextBySlug = next.bySlug || {};

  const out = {
    version: 1,
    updatedAt: nowIsoKst(),
    bySlug: { ...baseBySlug }
  };

  const nextSlugs = Object.keys(nextBySlug);
  let newCount = 0;
  let changedCount = 0;
  let sameCount = 0;

  for (const slug of nextSlugs) {
    const curr = nextBySlug[slug];
    if (!curr || typeof curr !== 'object') continue;

    const prev = out.bySlug[slug];
    if (!prev) newCount++;

    if (isChanged(prev, curr)) {
      out.bySlug[slug] = curr;
      if (prev) changedCount++;
    } else {
      sameCount++;
    }
  }

  writePretty(OUT_PATH, out);

  console.log('────────────────────────────────────────────');
  console.log(`[ssot] 완료: next=${nextSlugs.length} | 신규=${newCount} | 변경=${changedCount} | 동일=${sameCount}`);
  console.log('[ssot] SSOT 저장 완료:', OUT_PATH);
}

main();
