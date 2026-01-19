#!/usr/bin/env node
'use strict';

// System_files/scripts/build/review-build-next.cjs
// 역할: bucket별 next/insights/sources를 합쳐 review-ratings-next.json(bySlug)을 생성한다. (GPT/API 사용 없음)
// 변경: histogram이 비어있을 때(전부 0) rating/votes 기반 “롤백 더미(estimated)” 히스토그램을 생성한다.

require('./lib/env.cjs'); // ✅ 공통 규칙: env 로더 최우선

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// What: 경로 상수
// Why: reviews SSOT 파일들을 고정 위치에서 읽고/쓴다
// I/O: R/W(없음)
// Invariants: ROOT는 System_files
// ─────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..', '..');
const REVIEWS_DIR = path.join(ROOT, 'content', 'reviews');

// ─────────────────────────────────────────────
// What: JSON 안전 입출력
// Why: 파일 누락/파싱 실패로 빌드가 깨지는 것을 방지
// I/O: R/W(json files)
// Invariants: 파싱 실패 시 fallback 반환
// ─────────────────────────────────────────────
function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// ─────────────────────────────────────────────
// What: KST YYYY-MM-DD
// Why: 리뷰 날짜(checked/updatedAt) 표준 키로 사용
// I/O: R(Date.now), W(없음)
// Invariants: KST 기준 문자열만 반환
// ─────────────────────────────────────────────
function nowYmdKst() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────
// What: bySlug 안전 추출
// Why: 입력 파일이 깨져도 merge 루프가 죽지 않게
// I/O: R(obj), W(없음)
// Invariants: 항상 object 반환
// ─────────────────────────────────────────────
function getBySlug(obj) {
  if (!obj || typeof obj !== 'object') return {};
  if (!obj.bySlug || typeof obj.bySlug !== 'object') return {};
  return obj.bySlug;
}

// ─────────────────────────────────────────────
// What: 엔트리 병합 + 정규화
// Why: 후속 단계가 기대하는 histogram/insights/sources 구조를 보장
// I/O: R(base, patch), W(없음)
// Invariants: histogram 키(1~5) 고정, 배열 길이 상한 유지
// ─────────────────────────────────────────────
function mergeEntry(base, patch) {
  const out = { ...(base || {}), ...(patch || {}) };

  // histogram 키 보정(1~5)
  const h = out.histogram || {};
  out.histogram = {
    '1': Number(h['1'] ?? 0),
    '2': Number(h['2'] ?? 0),
    '3': Number(h['3'] ?? 0),
    '4': Number(h['4'] ?? 0),
    '5': Number(h['5'] ?? 0),
  };

  // insights 배열 보정
  if (!Array.isArray(out.insights)) out.insights = [];
  out.insights = out.insights
    .filter((v) => typeof v === 'string' && v.trim())
    .slice(0, 24);

  // sources 배열 보정
  if (!Array.isArray(out.sources)) out.sources = [];
  out.sources = out.sources
    .filter(
      (x) =>
        x &&
        typeof x === 'object' &&
        typeof x.label === 'string' &&
        typeof x.url === 'string'
    )
    .slice(0, 20);

  // 기본값
  if (!out.status) out.status = 'unknown';
  if (!out.store) out.store = 'unknown';
  if (!out.source) out.source = 'manual';
  if (!out.lastChecked) out.lastChecked = nowYmdKst();

  return out;
}

// ─────────────────────────────────────────────
// What: 히스토그램 “비어있음” 판정
// Why: 공식 파싱이 histogram을 못 주는 경우(0,0,0,0,0) 롤백 더미 생성 트리거
// I/O: R(entry.histogram), W(없음)
// Invariants: 숫자 0만이면 empty로 간주
// ─────────────────────────────────────────────
function isEmptyHistogram(histogram) {
  if (!histogram || typeof histogram !== 'object') return true;
  const v = (k) => Number(histogram[k] ?? 0);
  return v('1') === 0 && v('2') === 0 && v('3') === 0 && v('4') === 0 && v('5') === 0;
}

// ─────────────────────────────────────────────
// What: 롤백 더미(estimated) 히스토그램 생성기
// Why: rating/votes와 “모순 없는” 분포를 결정론적으로 생성해 안전하게 표시
// I/O: R(ratingCurrent, votesCurrent), W(histogram object)
// Invariants:
//  - 결과는 1~5 키만 포함
//  - 합계는 100(%)로 고정 (votes 크기에 영향받아 폭만 조절)
//  - 랜덤 사용 금지(재현성)
// ─────────────────────────────────────────────
function estimateHistogramPct(ratingCurrent, votesCurrent) {
  const r = Number(ratingCurrent);
  const v = Number(votesCurrent);

  // 방어: 값이 말이 안 되면 보수적 기본값
  if (!Number.isFinite(r) || r <= 0 || r > 5 || !Number.isFinite(v) || v <= 0) {
    return { '1': 5, '2': 8, '3': 17, '4': 30, '5': 40 };
  }

  // votes가 적을수록 분포를 넓게(=불확실) / 많을수록 좁게(=집중)
  // (과도한 집중을 막기 위해 하한/상한 고정)
  let sigma = 1.1;
  if (v >= 50000) sigma = 0.75;
  else if (v >= 10000) sigma = 0.85;
  else if (v >= 1000) sigma = 0.95;

  const weights = [];
  for (let k = 1; k <= 5; k++) {
    const d = k - r;
    const w = Math.exp(-(d * d) / (2 * sigma * sigma));
    weights.push(w);
  }

  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map((w) => (w / sum) * 100);

  // 정수화(합 100 보장)
  const ints = raw.map((x) => Math.floor(x));
  let remain = 100 - ints.reduce((a, b) => a + b, 0);

  // 소수점이 큰 순으로 remainder 배분(결정론적)
  const fracs = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  for (let t = 0; t < fracs.length && remain > 0; t++) {
    ints[fracs[t].i] += 1;
    remain -= 1;
  }

  // 안전: 음수/초과 방지(이론상 불필요하지만 보호)
  const out = {
    '1': Math.max(0, ints[0]),
    '2': Math.max(0, ints[1]),
    '3': Math.max(0, ints[2]),
    '4': Math.max(0, ints[3]),
    '5': Math.max(0, ints[4]),
  };

  // 마지막 합계 보정(혹시 모를 오차)
  const s2 = out['1'] + out['2'] + out['3'] + out['4'] + out['5'];
  if (s2 !== 100) out['5'] = Math.max(0, out['5'] + (100 - s2));

  return out;
}

// ─────────────────────────────────────────────
// What: 엔트리에 롤백 더미 히스토그램을 주입
// Why: “공식/실데이터처럼 보이게”가 아니라, 비어있을 때만 안전한 placeholder로 채움
// I/O: R(entry.ratingCurrent/votesCurrent/histogram), W(entry.histogram/histogramMeta)
// Invariants: 기존 histogram이 0이 아니면 절대 덮어쓰기 금지
// ─────────────────────────────────────────────
function applyEstimatedHistogramIfNeeded(entry, ymd) {
  if (!entry || typeof entry !== 'object') return entry;

  const rating = Number(entry.ratingCurrent ?? 0);
  const votes = Number(entry.votesCurrent ?? 0);

  // rating/votes가 있어야만 추정치 생성
  if (!(Number.isFinite(rating) && rating > 0) || !(Number.isFinite(votes) && votes > 0)) return entry;

  // 이미 histogram이 있으면 스킵
  if (!isEmptyHistogram(entry.histogram)) return entry;

  entry.histogram = estimateHistogramPct(rating, votes);
  entry.histogramMeta = {
    source: 'estimated',
    generatedAt: ymd,
    reason: 'official-missing-histogram',
    method: 'gaussian-v1',
  };

  return entry;
}

function main() {
  const ymd = nowYmdKst();

  const appNext = readJson(path.join(REVIEWS_DIR, 'app-ratings-next.json'), null);
  const deviceNext = readJson(path.join(REVIEWS_DIR, 'device-ratings-next.json'), null);
  const subscriptionNext = readJson(path.join(REVIEWS_DIR, 'subscription-ratings-next.json'), null);

  const appInsights = readJson(path.join(REVIEWS_DIR, 'app-insights.json'), null);
  const deviceInsights = readJson(path.join(REVIEWS_DIR, 'device-insights.json'), null);

  // ⚠️ 철자 유지
  const subscriptionInsights = readJson(path.join(REVIEWS_DIR, 'subsctiption-insights.json'), null);

  const sources = readJson(path.join(REVIEWS_DIR, 'review-sources.json'), null);

  const bySlug = {};

  // 1) next 3종 병합
  for (const map of [getBySlug(appNext), getBySlug(deviceNext), getBySlug(subscriptionNext)]) {
    for (const [slug, entry] of Object.entries(map)) {
      bySlug[slug] = mergeEntry(bySlug[slug], entry);
    }
  }

  // 2) insights 붙이기
  for (const m of [getBySlug(appInsights), getBySlug(deviceInsights), getBySlug(subscriptionInsights)]) {
    for (const [slug, x] of Object.entries(m)) {
      const insights = Array.isArray(x && x.insights) ? x.insights : [];
      bySlug[slug] = mergeEntry(bySlug[slug], { insights });
    }
  }

  // 3) sources 붙이기
  const sMap = getBySlug(sources);
  for (const [slug, arr] of Object.entries(sMap)) {
    const sourcesArr = Array.isArray(arr) ? arr : [];
    bySlug[slug] = mergeEntry(bySlug[slug], { sources: sourcesArr });
  }

  // 4) 롤백 더미(estimated histogram) 주입
  for (const slug of Object.keys(bySlug)) {
    bySlug[slug] = applyEstimatedHistogramIfNeeded(bySlug[slug], ymd);
  }

  const out = { updatedAt: ymd, bySlug };
  writeJson(path.join(REVIEWS_DIR, 'review-ratings-next.json'), out);

  console.log(`[review-build-next] slugs=${Object.keys(bySlug).length} -> review-ratings-next.json`);
}

main();
```0
