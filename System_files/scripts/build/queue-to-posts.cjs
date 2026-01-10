#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/queue-to-posts.cjs
 * dist/queue/today.json → content/posts/*.json 자동 생성기
 * - 라벨 6개 강제 + profileId 필수 + 오염(누락/오타) 즉시 차단
 */

// ✅ 로컬/CI 공통: .env 로드(필수)
require('./lib/env.cjs');

/**
 * AOIA FLOW MAP REFERENCE
 * --------------------------------------------------
 * Flow Map: System_files/docs/aoia-flow-map.md
 *
 * Role:
 *   - today.json(스케줄 결과, SSOT) → content/posts/*.json(포스트 SSOT) 변환
 *
 * Position:
 *   - Input:  dist/queue/today.json
 *   - Output: content/posts/*.json (slug 기반 신규 생성만)
 *
 * Invariants:
 *   - label은 6개 허용값만 통과
 *   - profileId는 labels.json 매핑 필수(없으면 즉시 중단)
 *   - title 누락 시 생성 금지(침묵/빈문서 방지)
 */

const fs = require('fs');
const path = require('path');

// ────────────────────────────────────
//  경로 설정
// ────────────────────────────────────
const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const QUEUE_DIR = path.join(ROOT, 'dist', 'queue');
const QUEUE_FILE = path.join(QUEUE_DIR, 'today.json');
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
//  라벨 → 파일 prefix 매핑
//  ✅ blogger.cjs가 확실히 인식하는 prefix로 고정
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

// queue.date 또는 item.date, 없으면 오늘 날짜 사용
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

let created = 0;
let skipped = 0;

for (let i = 0; i < items.length; i++) {
  const item = items[i] || {};

  const label = requireValidLabel(item.label, i);
  const title = requireValidTitle(item.title, i);

  const prefix = LABEL_TO_PREFIX[label];
  if (!prefix) fatal(`라벨 prefix 매핑 누락: label="${label}"`);

  const ymd = getDateString(item);

  if (!counters[label]) counters[label] = 1;
  else counters[label]++;

  const idx = pad3(counters[label]); // 001, 002, ...
  const slug = `${prefix}-${ymd}-${idx}`; // 예: app-20251212-001

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

log(`완료: created=${created}, skipped=${skipped}`);
