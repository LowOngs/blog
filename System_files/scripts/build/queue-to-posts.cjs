#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/queue-to-posts.cjs
 * dist/queue/today.json → content/posts/*.json 자동 생성기
 * - 라벨 6개 강제 + profileId 필수 + 오염(누락/오타) 즉시 차단
 * - ✅ dist/queue/today.expanded.json 생성 (generatedSlug 주입)
 * - ✅ (추가) 리뷰 글(app/device/subscription)에 review.reviewId(영구) 주입
 */

// ✅ 로컬/CI 공통: .env 로드(필수)
require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ────────────────────────────────────
//  경로 설정
// ────────────────────────────────────
const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const QUEUE_DIR = path.join(ROOT, 'dist', 'queue');
const QUEUE_FILE = path.join(QUEUE_DIR, 'today.json');
const QUEUE_EXPANDED_FILE = path.join(QUEUE_DIR, 'today.expanded.json');

const CONTENT_DIR = path.join(ROOT, 'content', 'posts');
fs.mkdirSync(CONTENT_DIR, { recursive: true });

function log(...a) {
  console.log('[seed→post]', ...a);
}

function fatal(msg) {
  console.error('[seed→post][FATAL]', msg);
  process.exit(1);
}

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

// ────────────────────────────────────
//  프로필 로딩 (라벨 → profileId 매핑만 사용)
// ────────────────────────────────────
const SEEDPOOL_DIR = path.join(ROOT, 'seedpool');
const PROFILES_DIR = path.join(SEEDPOOL_DIR, 'profiles');
const LABELS_FILE = path.join(PROFILES_DIR, 'labels.json');

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      log(`경고: ${path.basename(file)} 없음, 기본값 사용.`);
      return fallback;
    }
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[seed→post]', path.basename(file), '읽기/파싱 실패:', e.message || e);
    return fallback;
  }
}

const LABEL_TO_PROFILE_ID = safeReadJson(LABELS_FILE, {});

function getProfileIdForLabel(label) {
  const pid = LABEL_TO_PROFILE_ID[label];
  return pid ? String(pid) : null;
}

// ────────────────────────────────────
//  today.json 로드
// ────────────────────────────────────
if (!fs.existsSync(QUEUE_FILE)) {
  log('today.json 없음. 생성할 포스트가 없어 건너뜀.');
  process.exit(0);
}

let queue;
try {
  const raw = fs.readFileSync(QUEUE_FILE, 'utf8');
  queue = JSON.parse(raw);
} catch (e) {
  fatal(`today.json 파싱 실패: ${e.message || e}`);
}

log(`today.json 로드 완료 → date=${queue.date || 'N/A'}`);

const items = Array.isArray(queue.items) ? queue.items : [];
if (!items.length) {
  log('today.json 안에 items가 비어 있음. 건너뜀.');
  process.exit(0);
}

// ────────────────────────────────────
//  라벨 → 파일 prefix 매핑 (blogger.cjs 인식 prefix 고정)
// ────────────────────────────────────
const LABEL_TO_PREFIX = {
  'app-reviews': 'app',
  'device-reviews': 'device',
  'subscription-services': 'subscription',
  'how-to-playbooks': 'howto',
  'smart-savings': 'smart',
  'templates-checklists': 'template',
};

const counters = {}; // label별 일련번호

function pad3(n) {
  return String(n).padStart(3, '0');
}

function getDateString(item) {
  const base = item.date || queue.date || new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  return String(base).slice(0, 10).replace(/-/g, ''); // "YYYYMMDD"
}

function isoUtcMidnight(dateYYYYMMDD) {
  const y = dateYYYYMMDD.slice(0, 4);
  const m = dateYYYYMMDD.slice(4, 6);
  const d = dateYYYYMMDD.slice(6, 8);
  return `${y}-${m}-${d}T00:00:00Z`;
}

function buildBodyPrompt(item, label) {
  const title = (item.title || '').trim();
  const angle = (item.angle || '').trim();
  const audience = (item.audience || '').trim();
  const intent = (item.intent || '').trim();
  const notes = (item.notes || '').trim();

  const lines = [
    'Write a complete blog post in English for an English-speaking audience.',
    'Use clear headings, short paragraphs, and practical examples.',
    '',
    `Title: ${title || '(Untitled)'}`,
    `Label: ${label}`,
    intent ? `Intent: ${intent}` : '',
    angle ? `Angle: ${angle}` : '',
    audience ? `Audience: ${audience}` : 'Audience: general readers who want clear, simple guidance',
    notes ? `Notes: ${notes}` : '',
    '',
    'Include:',
    '- Do NOT write TL;DR, Key Facts, FAQ, or Sources (they are injected separately).',
    '- Step-by-step guidance (when applicable)',
    '- Common mistakes and quick fixes',
    '- A concise conclusion',
  ].filter(Boolean);

  return lines.join('\n');
}

function requireValidLabel(label, idx) {
  const v = String(label || '').trim();
  if (!v) fatal(`items[${idx}] label 누락 (today.json 오염)`);
  if (!ALLOWED_LABELS.has(v)) {
    fatal(`items[${idx}] label 비정상: "${v}" (허용: ${Array.from(ALLOWED_LABELS).join(', ')})`);
  }
  return v;
}

function requireValidTitle(title, idx) {
  const t = String(title || '').trim();
  if (!t) fatal(`items[${idx}] title 누락 (label은 정상이어도 title 없으면 생성 금지)`);
  return t;
}

// ────────────────────────────────────
//  ✅ reviewId 생성 규약(영구, 결정론적)
// ────────────────────────────────────
const SITE_BASE = String(process.env.SITE_BASE || 'https://ongsblog.com').replace(/\/+$/, '');

function bucketOfPrefix(prefix) {
  if (prefix === 'app') return 'app';
  if (prefix === 'device') return 'device';
  if (prefix === 'subscription') return 'subscription';
  return null;
}

function makeReviewId(bucket, slug) {
  const seed = `${SITE_BASE}|${slug}`;
  const sha = crypto.createHash('sha256').update(seed, 'utf8').digest('hex');
  return `rv_${bucket}_${sha.slice(0, 10)}`;
}

let created = 0;
let skipped = 0;

// ✅ today.expanded.json용: 원본 items를 복사해서 generatedSlug만 주입
const expandedItems = items.map((it) => (it && typeof it === 'object' ? { ...it } : it));

for (let i = 0; i < items.length; i++) {
  const item = items[i] || {};
  const outItem = expandedItems[i] && typeof expandedItems[i] === 'object' ? expandedItems[i] : null;

  const label = requireValidLabel(item.label, i);
  const title = requireValidTitle(item.title, i);

  const prefix = LABEL_TO_PREFIX[label];
  if (!prefix) fatal(`라벨 prefix 매핑 누락: label="${label}"`);

  const ymd = getDateString(item);

  if (!counters[label]) counters[label] = 1;
  else counters[label]++;

  const idx = pad3(counters[label]);
  const slug = `${prefix}-${ymd}-${idx}`;

  // ✅ expanded item에 generatedSlug 주입(항상)
  if (outItem) outItem.generatedSlug = slug;

  const targetPath = path.join(CONTENT_DIR, `${slug}.json`);

  if (fs.existsSync(targetPath)) {
    log(`이미 존재 → ${path.basename(targetPath)} , 건너뜀.`);
    skipped++;
    continue;
  }

  const queueDate = String(item.date || queue.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const ymdISO = queueDate.replace(/-/g, '');
  const updatedISO = isoUtcMidnight(ymdISO);

  const profileId = getProfileIdForLabel(label);
  if (!profileId) {
    fatal(`profileId 없음: label="${label}" (seedpool/profiles/labels.json 매핑 확인 필요)`);
  }

  // ✅ 리뷰 글이면 reviewId 주입
  const bucket = bucketOfPrefix(prefix);
  const reviewBlock = bucket
    ? {
        reviewId: makeReviewId(bucket, slug),
        bucket,
        // 확장 대비 최소 메타(원하면 나중에 provider/sourceMap 추가)
        createdAt: new Date().toISOString(),
      }
    : null;

  const doc = {
    slug,
    title,
    description: (item.angle || item.title || '').trim(),
    labels: [label],
    intent: (item.intent || '').trim() || 'review',
    updated: updatedISO,

    bodyPrompt: buildBodyPrompt(item, label),
    body: '',

    aio: {
      tldr: [],
      keyfacts: [],
      faq: [],
      sources: [],
      sourcesNote: 'Add at least 2 official sources when finalizing the post.',
    },

    // ✅ (추가) 리뷰 글에만 삽입
    ...(reviewBlock ? { review: reviewBlock } : {}),

    seedMeta: {
      queueDate,
      label,
      profileId,
      id: item.id || null,
      angle: item.angle || null,
      audience: item.audience || null,
      intent: item.intent || null,
      priority: item.priority ?? null,
      notes: item.notes || null,
    },
  };

  fs.writeFileSync(targetPath, JSON.stringify(doc, null, 2), 'utf8');
  log(`created ${path.basename(targetPath)} from seed id=${item.id || '(no-id)'}`);
  created++;
}

// ✅ today.expanded.json 저장(원본 today.json은 절대 수정하지 않음)
try {
  const expanded = {
    ...queue,
    expandedAt: new Date().toISOString(),
    items: expandedItems,
  };

  fs.writeFileSync(QUEUE_EXPANDED_FILE, JSON.stringify(expanded, null, 2), 'utf8');
  log(`expanded queue written → ${QUEUE_EXPANDED_FILE}`);
} catch (e) {
  fatal(`today.expanded.json 저장 실패: ${e.message || e}`);
}

log(`완료: created=${created}, skipped=${skipped}`);
