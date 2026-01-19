#!/usr/bin/env node
'use strict';

require('./lib/env.cjs'); // ✅ .env 로드(필수)

/** build-ssot-reviews: review-ratings-next.json → review-ratings.json(baseline) 병합 + export(bySlug) */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files

const BASELINE_PATH = path.join(ROOT, 'content', 'reviews', 'review-ratings.json');
const NEXT_PATH     = path.join(ROOT, 'content', 'reviews', 'review-ratings-next.json');
const OUT_PATH      = path.join(ROOT, 'content', 'ssot', 'reviews.bySlug.json');

// ─────────────────────────────────────────────
// What/Why/I-O/Invariants
// What: next snapshot을 baseline SSOT에 멱등 병합하고 export 파일도 만든다.
// Why : inject 단계가 baseline(review-ratings.json)을 읽는 구조이므로 baseline 저장이 반드시 필요하다.
// I/O : READ content/reviews/review-ratings.json, review-ratings-next.json
//       WRITE content/reviews/review-ratings.json, content/ssot/reviews.bySlug.json
// Invariants: baseline을 "초기화(리셋)"하지 않는다. bySlug 구조를 유지한다.
// ─────────────────────────────────────────────

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function safeReadJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('[ssot] JSON parse failed:', p, e.message);
    process.exitCode = 1;
    return fallback;
  }
}

function writeJsonPretty(p, obj) {
  const pretty = JSON.stringify(obj, null, 2);
  fs.writeFileSync(p, pretty + '\n', 'utf8');
}

function ensureBySlug(obj) {
  if (!obj || typeof obj !== 'object') return { bySlug: {} };
  if (obj.bySlug && typeof obj.bySlug === 'object') return obj;
  // 구 포맷 방어: { app:[...] } 같은 케이스는 여기서 강제 변환하지 않고, 최소 안전 구조만 만든다.
  return { bySlug: {} };
}

function stableStringify(obj) {
  return JSON.stringify(obj);
}

function isMeaningfullyChanged(prev, curr) {
  const a = prev || {};
  const b = curr || {};
  return (
    String(a.ratingCurrent ?? '') !== String(b.ratingCurrent ?? '') ||
    String(a.votesCurrent ?? '')  !== String(b.votesCurrent ?? '')  ||
    String(a.status ?? '')        !== String(b.status ?? '')
  );
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[ssot] build-ssot-reviews 시작');
  console.log('[ssot] ROOT      =', ROOT);
  console.log('[ssot] baseline  =', BASELINE_PATH);
  console.log('[ssot] next      =', NEXT_PATH);
  console.log('[ssot] out       =', OUT_PATH);
  console.log('────────────────────────────────────────────');

  const baselineRaw = safeReadJson(BASELINE_PATH, { bySlug: {} });
  const nextRaw     = safeReadJson(NEXT_PATH, { bySlug: {} });

  const baseline = ensureBySlug(baselineRaw);
  const next     = ensureBySlug(nextRaw);

  const baseBy = baseline.bySlug || {};
  const nextBy = next.bySlug || {};

  let totalNext = 0;
  let newCount = 0;
  let changedCount = 0;
  let sameCount = 0;

  // 병합(멱등): next에 존재하는 slug만 baseline에 upsert
  for (const slug of Object.keys(nextBy)) {
    totalNext += 1;
    const prev = baseBy[slug];
    const curr = nextBy[slug];

    if (!prev) {
      baseBy[slug] = curr;
      newCount += 1;
      continue;
    }

    if (isMeaningfullyChanged(prev, curr)) {
      baseBy[slug] = Object.assign({}, prev, curr);
      changedCount += 1;
    } else {
      // 의미 변화 없어도 “최신 필드(예: lastChecked)”가 올 수 있으니 얕게 병합은 유지
      baseBy[slug] = Object.assign({}, prev, curr);
      sameCount += 1;
    }
  }

  baseline.bySlug = baseBy;

  console.log(`[ssot] 완료: next=${totalNext} | 신규=${newCount} | 변경=${changedCount} | 동일=${sameCount}`);

  // ✅ 핵심: baseline SSOT 저장 (이게 없으면 inject가 계속 구 값을 읽음)
  ensureDir(path.dirname(BASELINE_PATH));
  writeJsonPretty(BASELINE_PATH, baseline);
  console.log('[ssot] baseline 저장 완료:', BASELINE_PATH);

  // export(out)도 유지
  ensureDir(path.dirname(OUT_PATH));
  writeJsonPretty(OUT_PATH, baseline);
  console.log('[ssot] SSOT 저장 완료:', OUT_PATH);

  console.log('────────────────────────────────────────────');
}

if (require.main === module) main();
