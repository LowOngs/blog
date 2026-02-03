#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/queue-to-posts.cjs
 * dist/queue/today.json → content/posts/*.json 자동 생성기
 *
 * ✅ 핵심 변경(2-a-3/2-a-4 대응):
 * - today.json의 label은 “슬롯/통계 기준”으로 유지
 * - 실제 posts 생성 기준 라벨은 seedLabel을 사용
 *   (fallback으로 다른 창고에서 seed를 가져와도 슬롯 라벨 오염 방지)
 *
 * 불변:
 * - today.json 원본 수정 금지
 * - pageId는 ids.cjs에서만 관리(여기서 절대 건드리지 않음)
 */

// .env 로드
require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ────────────────────────────────────
// 경로
// ────────────────────────────────────
const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const QUEUE_DIR = path.join(ROOT, 'dist', 'queue');
const QUEUE_FILE = path.join(QUEUE_DIR, 'today.json');
const QUEUE_EXPANDED_FILE = path.join(QUEUE_DIR, 'today.expanded.json');

const CONTENT_DIR = path.join(ROOT, 'content', 'posts');
fs.mkdirSync(CONTENT_DIR, { recursive: true });

// ────────────────────────────────────
// 로그/중단
// ────────────────────────────────────
function log(...a) {
  console.log('[seed→post]', ...a);
}
function fatal(msg) {
  console.error('[seed→post][FATAL]', msg);
  process.exit(1);
}

// ────────────────────────────────────
// 라벨(SSOT)
// ────────────────────────────────────
const ALLOWED_LABELS = new Set([
  'app-reviews',
  'device-reviews',
  'subscription-services',
  'how-to-playbooks',
  'smart-savings',
  'templates-checklists',
]);

// ────────────────────────────────────
// 리뷰 라벨 판정(실제 posts 기준 = seedLabel)
// ────────────────────────────────────
function isReviewLabel(label) {
  return (
    label === 'app-reviews' ||
    label === 'device-reviews' ||
    label === 'subscription-services'
  );
}

// ────────────────────────────────────
// 프로필 매핑(실제 posts 기준 = seedLabel)
// ────────────────────────────────────
const SEEDPOOL_DIR = path.join(ROOT, 'seedpool');
const PROFILES_DIR = path.join(SEEDPOOL_DIR, 'profiles');
const LABELS_FILE = path.join(PROFILES_DIR, 'labels.json');

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const LABEL_TO_PROFILE_ID = safeReadJson(LABELS_FILE, {});
function getProfileIdForLabel(label) {
  const pid = LABEL_TO_PROFILE_ID[label];
  return pid ? String(pid) : null;
}

// ────────────────────────────────────
// today.json 로드
// ────────────────────────────────────
if (!fs.existsSync(QUEUE_FILE)) {
  log('today.json 없음 → 종료');
  process.exit(0);
}

let queue;
try {
  queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
} catch (e) {
  fatal(`today.json 파싱 실패: ${e.message || e}`);
}

log(`today.json 로드 → date=${queue.date || 'N/A'} tz=${queue.timezone || 'N/A'} cutoff=${queue.cutoff || 'N/A'}`);

const items = Array.isArray(queue.items) ? queue.items : [];
if (!items.length) {
  log('items 비어 있음 → 종료');
  process.exit(0);
}

// ────────────────────────────────────
// 라벨 → prefix (posts 기준 = seedLabel)
// ────────────────────────────────────
const LABEL_TO_PREFIX = {
  'app-reviews': 'app',
  'device-reviews': 'device',
  'subscription-services': 'subscription',
  'how-to-playbooks': 'howto',
  'smart-savings': 'smart',
  'templates-checklists': 'template',
};

// label별 일련번호(실제 posts 기준)
const counters = {};

// ────────────────────────────────────
// 날짜 유틸(큐의 날짜를 신뢰)
// ────────────────────────────────────
function pad3(n) {
  return String(n).padStart(3, '0');
}

function getDateString(item) {
  const base = item.date || queue.date;
  if (!base) return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return String(base).slice(0, 10).replace(/-/g, '');
}

function isoUtcMidnight(dateYYYYMMDD) {
  const y = dateYYYYMMDD.slice(0, 4);
  const m = dateYYYYMMDD.slice(4, 6);
  const d = dateYYYYMMDD.slice(6, 8);
  return `${y}-${m}-${d}T00:00:00Z`;
}

// ────────────────────────────────────
// 본문 프롬프트
// ────────────────────────────────────
function buildBodyPrompt(item, effectiveLabel) {
  const lines = [
    'Write a complete blog post in English for an English-speaking audience.',
    'Use clear headings, short paragraphs, and practical examples.',
    '',
    `Title: ${(item.title || '').trim() || '(Untitled)'}`,
    `Label: ${effectiveLabel}`,
    item.intent ? `Intent: ${item.intent}` : '',
    item.angle ? `Angle: ${item.angle}` : '',
    item.audience ? `Audience: ${item.audience}` : 'Audience: general readers',
    item.notes ? `Notes: ${item.notes}` : '',
    '',
    'Include:',
    '- Do NOT write TL;DR, Key Facts, FAQ, or Sources (they are injected separately).',
    '- Step-by-step guidance (when applicable)',
    '- Common mistakes and quick fixes',
    '- A concise conclusion',
  ].filter(Boolean);

  return lines.join('\n');
}

// ────────────────────────────────────
// 검증
// ────────────────────────────────────
function requireValidLabel(label, idx, name) {
  const v = String(label || '').trim();
  if (!v) fatal(`items[${idx}] ${name} 누락`);
  if (!ALLOWED_LABELS.has(v)) {
    fatal(`items[${idx}] ${name} 비정상: "${v}"`);
  }
  return v;
}

function requireValidTitle(title, idx) {
  const t = String(title || '').trim();
  if (!t) fatal(`items[${idx}] title 누락`);
  return t;
}

// ────────────────────────────────────
// ULID
// ────────────────────────────────────
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function encodeBase32Crockford(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ULID_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ULID_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function ulidNow() {
  const time = Date.now();
  const timeBuf = Buffer.alloc(6);
  timeBuf[0] = (time / 2 ** 40) & 255;
  timeBuf[1] = (time / 2 ** 32) & 255;
  timeBuf[2] = (time / 2 ** 24) & 255;
  timeBuf[3] = (time / 2 ** 16) & 255;
  timeBuf[4] = (time / 2 ** 8) & 255;
  timeBuf[5] = time & 255;
  const randBuf = crypto.randomBytes(10);
  return (
    encodeBase32Crockford(timeBuf).padStart(10, '0').slice(0, 10) +
    encodeBase32Crockford(randBuf).padStart(16, '0').slice(0, 16)
  ).slice(0, 26);
}

function resolvePostId(item) {
  return item.postId ? String(item.postId) : ulidNow();
}
function resolveReviewId(item, label) {
  if (!isReviewLabel(label)) return null;
  return item.reviewId ? String(item.reviewId) : ulidNow();
}

// ────────────────────────────────────
// 처리
// ────────────────────────────────────
let created = 0;
let skipped = 0;

const expandedItems = items.map((it) => (it && typeof it === 'object' ? { ...it } : it));

for (let i = 0; i < items.length; i++) {
  const item = items[i] || {};
  const outItem = expandedItems[i];

  // 슬롯 라벨(검증용)
  const slotLabel = requireValidLabel(item.label, i, 'label');

  // 실제 posts 기준 라벨
  const seedLabel = requireValidLabel(item.seedLabel || item.label, i, 'seedLabel');

  const title = requireValidTitle(item.title, i);

  const prefix = LABEL_TO_PREFIX[seedLabel];
  if (!prefix) fatal(`prefix 매핑 누락: seedLabel="${seedLabel}"`);

  const ymd = getDateString(item);

  if (!counters[seedLabel]) counters[seedLabel] = 1;
  else counters[seedLabel]++;

  const slug = `${prefix}-${ymd}-${pad3(counters[seedLabel])}`;

  const postId = resolvePostId(item);
  const reviewId = resolveReviewId(item, seedLabel);

  if (outItem) {
    outItem.generatedSlug = slug;
    outItem.postId = postId;
    if (reviewId) outItem.reviewId = reviewId;
  }

  const targetPath = path.join(CONTENT_DIR, `${slug}.json`);
  if (fs.existsSync(targetPath)) {
    log(`exists → ${slug}.json , skip`);
    skipped++;
    continue;
  }

  const queueDate = String(item.date || queue.date).slice(0, 10);
  const updatedISO = isoUtcMidnight(queueDate.replace(/-/g, ''));

  const profileId = getProfileIdForLabel(seedLabel);
  if (!profileId) fatal(`profileId 없음: seedLabel="${seedLabel}"`);

  const doc = {
    postId,
    reviewId: reviewId || null,

    slug,
    title,
    description: (item.angle || item.title || '').trim(),
    labels: [seedLabel],
    intent: item.intent || (isReviewLabel(seedLabel) ? 'review' : 'general'),
    updated: updatedISO,

    bodyPrompt: buildBodyPrompt(item, seedLabel),
    body: '',

    aio: {
      tldr: [],
      keyfacts: [],
      faq: [],
      sources: [],
      sourcesNote: 'Add at least 2 official sources when finalizing the post.',
    },

    seedMeta: {
      queueDate,
      slotLabel,     // 슬롯 기준 라벨(통계/스코프)
      seedLabel,     // 실제 시드 출처 라벨
      profileId,
      id: item.id || null,
      angle: item.angle || null,
      audience: item.audience || null,
      intent: item.intent || null,
      priority: item.priority ?? null,
      notes: item.notes || null,
      postId,
      reviewId: reviewId || null,
    },
  };

  fs.writeFileSync(targetPath, JSON.stringify(doc, null, 2), 'utf8');
  log(`created ${slug}.json (slot=${slotLabel}, seed=${seedLabel})`);
  created++;
}

// expanded 저장
try {
  fs.writeFileSync(
    QUEUE_EXPANDED_FILE,
    JSON.stringify({ ...queue, expandedAt: new Date().toISOString(), items: expandedItems }, null, 2),
    'utf8'
  );
  log(`expanded queue → ${QUEUE_EXPANDED_FILE}`);
} catch (e) {
  fatal(`today.expanded.json 저장 실패: ${e.message || e}`);
}

log(`완료: created=${created}, skipped=${skipped}`);
