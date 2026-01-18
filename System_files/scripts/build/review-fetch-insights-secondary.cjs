#!/usr/bin/env node
'use strict';
// review-fetch-insights-secondary: 2차 인사이트 엔진 (비공식/저비용, GPT 미사용)

require('./lib/env.cjs'); // ✅ 공통 규칙: env 로더 최우선

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// 기본 경로 설정
// ─────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const REVIEWS_DIR = path.join(ROOT, 'content', 'reviews');

// DRY_RUN 기본 true
const isLive = (() => {
  const v = String(process.env.DRY_RUN ?? 'true').trim().toLowerCase();
  return (v === 'false' || v === '0');
})();

function log(...a) { console.log('[review-insights-2]', ...a); }
function warn(...a) { console.warn('[review-insights-2][WARN]', ...a); }
function fatal(...a) { console.error('[review-insights-2][FATAL]', ...a); process.exit(1); }

function nowYmdKst() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────
// JSON 유틸
// ─────────────────────────────────────────────
function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function ensureMaps(obj) {
  const base = { updatedAt: nowYmdKst(), bySlug: {} };
  if (!obj || typeof obj !== 'object') return base;
  if (!obj.bySlug || typeof obj.bySlug !== 'object') obj.bySlug = {};
  if (!obj.updatedAt) obj.updatedAt = nowYmdKst();
  return obj;
}

// ─────────────────────────────────────────────
// 리뷰 대상 판별
// ─────────────────────────────────────────────
function isReviewSlug(slug) {
  return typeof slug === 'string' &&
    (slug.startsWith('app-') || slug.startsWith('device-') || slug.startsWith('subscription-'));
}

function listPostDocs() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    const p = path.join(POSTS_DIR, f);
    const j = safeReadJson(p, null);
    if (!j || typeof j !== 'object') continue;
    const slug = j.slug || f.replace(/\.json$/, '');
    j.slug = slug;
    out.push(j);
  }
  return out;
}

// ─────────────────────────────────────────────
// 인사이트 추출 규칙(룰 기반, LLM 미사용)
// ─────────────────────────────────────────────

// 긍정/부정 키워드(확장 가능)
const POSITIVE_KEYWORDS = [
  'fast', 'easy', 'simple', 'useful', 'reliable', 'stable',
  'convenient', 'intuitive', 'helpful', 'good', 'great'
];

const NEGATIVE_KEYWORDS = [
  'slow', 'bug', 'issue', 'problem', 'crash', 'confusing',
  'expensive', 'hard', 'difficult', 'bad'
];

// 문장 정규화
function normalizeSentence(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s.,-]/g, '')
    .trim();
}

// 간단한 긍/부정 판별
function classifySentence(text) {
  const t = text.toLowerCase();
  const posHit = POSITIVE_KEYWORDS.some(k => t.includes(k));
  const negHit = NEGATIVE_KEYWORDS.some(k => t.includes(k));

  if (posHit && !negHit) return 'positive';
  if (negHit && !posHit) return 'negative';
  return null;
}

// 최대 6개까지, 중복 제거
function collectInsights(sentences) {
  const pos = [];
  const neg = [];
  const seen = new Set();

  for (const raw of sentences) {
    const s = normalizeSentence(raw);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const c = classifySentence(s);
    if (c === 'positive' && pos.length < 6) pos.push(s);
    else if (c === 'negative' && neg.length < 6) neg.push(s);

    if (pos.length >= 6 && neg.length >= 6) break;
  }

  return { positive: pos, negative: neg };
}

// ─────────────────────────────────────────────
// 메인 로직
// ─────────────────────────────────────────────
function main() {
  log('────────────────────────────────────────────');
  log('[review-insights-2] start');
  log(`[review-insights-2] DRY_RUN = ${isLive ? 'false(live)' : 'true(dry-run)'}`);

  const paths = {
    appInsights: path.join(REVIEWS_DIR, 'app-insights.json'),
    deviceInsights: path.join(REVIEWS_DIR, 'device-insights.json'),
    subscriptionInsights: path.join(REVIEWS_DIR, 'subsctiption-insights.json'),
  };

  const appInsights = ensureMaps(safeReadJson(paths.appInsights, null));
  const deviceInsights = ensureMaps(safeReadJson(paths.deviceInsights, null));
  const subInsights = ensureMaps(safeReadJson(paths.subscriptionInsights, null));

  const docs = listPostDocs();

  let processed = 0;
  let updated = 0;

  for (const doc of docs) {
    const slug = doc.slug;
    if (!isReviewSlug(slug)) continue;

    processed += 1;

    // 2안 입력 소스:
    // - post.body
    // - post.aio.sourcesNote
    // - seedMeta.notes
    const textPool = [];
    if (typeof doc.body === 'string') textPool.push(...doc.body.split(/[.!?]\s+/));
    if (typeof doc.seedMeta?.notes === 'string') textPool.push(doc.seedMeta.notes);
    if (typeof doc.aio?.sourcesNote === 'string') textPool.push(doc.aio.sourcesNote);

    const insights = collectInsights(textPool);
    if (!insights.positive.length && !insights.negative.length) continue;

    let target;
    if (slug.startsWith('app-')) target = appInsights.bySlug;
    else if (slug.startsWith('device-')) target = deviceInsights.bySlug;
    else target = subInsights.bySlug;

    target[slug] = { insights };
    updated += 1;
  }

  const ymd = nowYmdKst();
  appInsights.updatedAt = ymd;
  deviceInsights.updatedAt = ymd;
  subInsights.updatedAt = ymd;

  if (isLive) {
    writeJson(paths.appInsights, appInsights);
    writeJson(paths.deviceInsights, deviceInsights);
    writeJson(paths.subscriptionInsights, subInsights);
  }

  log('────────────────────────────────────────────');
  log(`[review-insights-2] done: processed=${processed}, updated=${updated}`);
  if (!isLive) log('[review-insights-2] DRY_RUN: no file writes.');
  log('────────────────────────────────────────────');
}

main();
