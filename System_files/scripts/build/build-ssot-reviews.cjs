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
// Invariants:
//  - baseline을 "초기화(리셋)"하지 않는다. bySlug 구조를 유지한다.
//  - JSON 파싱 실패 시 기존 파일 보호(강제 초기화 금지)
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
  const pretty = JSON.stringify(obj, null, 2) + '\n';
  fs.writeFileSync(p, pretty, 'utf8');
}

function writeJsonPrettyAtomic(p, obj) {
  const dir = path.dirname(p);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(p)}.tmp`);
  const pretty = JSON.stringify(obj, null, 2) + '\n';
  fs.writeFileSync(tmp, pretty, 'utf8');
  fs.renameSync(tmp, p);
}

function ensureBySlug(obj) {
  if (!obj || typeof obj !== 'object') return { bySlug: {} };
  if (obj.bySlug && typeof obj.bySlug === 'object') return obj;
  return { bySlug: {} };
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

// (강화) 다음 데이터가 존재하는데 baseline 변화가 전혀 없을 때, 재발 방지용 경고/실패 스위치
function fingerprintForSlugs(bySlug, slugs) {
  const parts = [];
  for (const s of slugs) {
    const o = bySlug && bySlug[s] ? bySlug[s] : null;
    parts.push(s + ':' + JSON.stringify(o || null));
  }
  return parts.join('|');
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

  // (강화) 파싱 실패가 이미 발생했다면 안전하게 중단(기존 파일 보호)
  if (process.exitCode === 1) {
    console.error('[ssot] FATAL: JSON parse error detected. Abort to protect baseline.');
    process.exitCode = 1;
    return;
  }

  const baseline = ensureBySlug(baselineRaw);
  const next     = ensureBySlug(nextRaw);

  const baseBy = baseline.bySlug || {};
  const nextBy = next.bySlug || {};

  const nextSlugs = Object.keys(nextBy);
  const totalNext = nextSlugs.length;

  let newCount = 0;
  let changedCount = 0;
  let sameCount = 0;

  // (강화) 병합 전/후 fingerprint로 “실제로 바뀐 게 있는지” 감지
  const beforeFp = fingerprintForSlugs(baseBy, nextSlugs);

  for (const slug of nextSlugs) {
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
      baseBy[slug] = Object.assign({}, prev, curr);
      sameCount += 1;
    }
  }

  baseline.bySlug = baseBy;

  const afterFp = fingerprintForSlugs(baseBy, nextSlugs);

  console.log(`[ssot] 완료: next=${totalNext} | 신규=${newCount} | 변경=${changedCount} | 동일=${sameCount}`);

  // ✅ 핵심: baseline SSOT 저장(원자적)
  ensureDir(path.dirname(BASELINE_PATH));
  writeJsonPrettyAtomic(BASELINE_PATH, baseline);
  console.log('[ssot] baseline 저장 완료:', BASELINE_PATH);

  // export(out)도 유지(원자적)
  ensureDir(path.dirname(OUT_PATH));
  writeJsonPrettyAtomic(OUT_PATH, baseline);
  console.log('[ssot] SSOT 저장 완료:', OUT_PATH);

  // (강화) next가 있는데 변화 fingerprint가 동일하면 경고(필요시 fail)
  if (totalNext > 0 && beforeFp === afterFp) {
    console.warn('[ssot][WARN] next가 존재하지만 baseline 변화가 감지되지 않았습니다.');
    console.warn('[ssot][WARN] (가능 원인) next가 baseline과 동일 / next 생성이 잘못됨 / slug mismatch');
    if (String(process.env.SSOT_STRICT || '').toLowerCase() === '1') {
      console.error('[ssot] SSOT_STRICT=1 → exitCode=1');
      process.exitCode = 1;
    }
  }

  console.log('────────────────────────────────────────────');
}

if (require.main === module) main();
