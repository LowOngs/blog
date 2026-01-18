#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/queue-to-posts.cjs
 * dist/queue/today.json → content/posts/*.json 자동 생성기
 *
 * ✅ 업데이트: postId(전 포스트), reviewId(리뷰 포스트) 발급/주입
 * - postId: 영구 ULID (모든 포스트에 1회 발급, 이후 유지)
 * - reviewId: 영구 ULID (리뷰 포스트에만 1회 발급, 이후 유지)
 * - pageId와는 역할 분리: pageId는 ids.cjs에서만 발급/관리(여기서 절대 건드리지 않음)
 */

// ✅ 로컬/CI 공통: .env 로드(필수)
require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ────────────────────────────────────
//  What: 경로 설정
//  Why : SSOT/산출물 경로를 단일화
//  I/O : R(dist/queue/today.json), W(content/posts/*.json, dist/queue/today.expanded.json)
//  Invariants: System_files 가 ROOT, today.json 원본 수정 금지
// ────────────────────────────────────
const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const QUEUE_DIR = path.join(ROOT, 'dist', 'queue');
const QUEUE_FILE = path.join(QUEUE_DIR, 'today.json');
const QUEUE_EXPANDED_FILE = path.join(QUEUE_DIR, 'today.expanded.json');

const CONTENT_DIR = path.join(ROOT, 'content', 'posts');
fs.mkdirSync(CONTENT_DIR, { recursive: true });

// ────────────────────────────────────
//  What: 로그/중단 유틸
//  Why : CI에서 원인 즉시 노출
//  I/O : 없음
//  Invariants: 오염 발견 시 즉시 exit(1)
// ────────────────────────────────────
function log(...a) {
  console.log('[seed→post]', ...a);
}
function fatal(msg) {
  console.error('[seed→post][FATAL]', msg);
  process.exit(1);
}

// ────────────────────────────────────
//  What: 라벨(SSOT) 고정
//  Why : 라벨 오염(오타/누락) 방지
//  I/O : 없음
//  Invariants: 6개 라벨만 허용
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
//  What: 리뷰 라벨 판정
//  Why : reviewId는 리뷰 포스트만 대상
//  I/O : 없음
//  Invariants: app/device/subscription 3종만 리뷰
// ────────────────────────────────────
function isReviewLabel(label) {
  return (
    label === 'app-reviews' ||
    label === 'device-reviews' ||
    label === 'subscription-services'
  );
}

// ────────────────────────────────────
//  What: 프로필 로딩(라벨 → profileId)
//  Why : profileId 누락은 생성 자체를 막아야 함
//  I/O : R(seedpool/profiles/labels.json)
//  Invariants: 매핑 없으면 즉시 FATAL
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
//  What: today.json 로드
//  Why : 실행 스코프 입력(Plan SSOT)
//  I/O : R(dist/queue/today.json)
//  Invariants: 파싱 실패/오염 시 즉시 중단
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
//  What: 라벨 → prefix 매핑
//  Why : slug 규칙 고정(후속 파이프라인/발행 안정)
//  I/O : 없음
//  Invariants: blogger.cjs가 인식하는 prefix로 고정
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

// ────────────────────────────────────
//  What: slug 날짜/번호 유틸
//  Why : 파일명/슬러그 충돌 방지
//  I/O : 없음
//  Invariants: YYYYMMDD + 001.. 로 고정
// ────────────────────────────────────
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

// ────────────────────────────────────
//  What: 본문 프롬프트 생성
//  Why : body 생성기는 여기 프롬프트에 의존
//  I/O : 없음
//  Invariants: TLDR/FAQ/Sources는 작성 금지(주입 전제)
// ────────────────────────────────────
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

// ────────────────────────────────────
//  What: 입력 검증(라벨/타이틀)
//  Why : 오염된 큐는 조용히 진행하면 후폭풍이 큼
//  I/O : 없음
//  Invariants: label/title 누락은 즉시 중단
// ────────────────────────────────────
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
//  What: ULID 생성기(의존성 없이 구현)
//  Why : postId/reviewId를 영구 랜덤으로(Provider 변경/slug 변경에도 안전)
//  I/O : 없음
//  Invariants: 문자열 26자, 충돌확률 극저
// ────────────────────────────────────
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function encodeBase32Crockford(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
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
  // 48-bit time
  timeBuf[0] = (time / 2 ** 40) & 255;
  timeBuf[1] = (time / 2 ** 32) & 255;
  timeBuf[2] = (time / 2 ** 24) & 255;
  timeBuf[3] = (time / 2 ** 16) & 255;
  timeBuf[4] = (time / 2 ** 8) & 255;
  timeBuf[5] = time & 255;

  const randBuf = crypto.randomBytes(10); // 80-bit random
  const timeStr = encodeBase32Crockford(timeBuf).padStart(10, '0').slice(0, 10);
  const randStr = encodeBase32Crockford(randBuf).padStart(16, '0').slice(0, 16);
  return (timeStr + randStr).slice(0, 26);
}

// ────────────────────────────────────
//  What: postId/reviewId 발급 규칙
//  Why : “없을 때만” 발급하여 영구성 확보
//  I/O : 없음
//  Invariants: 재실행해도 동일 파일은 생성 스킵(멱등), 기존 값은 유지
// ────────────────────────────────────
function resolvePostId(item) {
  const v = String(item.postId || '').trim();
  return v ? v : ulidNow();
}
function resolveReviewId(item, label) {
  if (!isReviewLabel(label)) return null;
  const v = String(item.reviewId || '').trim();
  return v ? v : ulidNow();
}

let created = 0;
let skipped = 0;

// ────────────────────────────────────
//  What: today.expanded.json 생성 준비
//  Why : item ↔ slug(+id) 매칭키를 실행 스코프에 남김
//  I/O : W(dist/queue/today.expanded.json)
//  Invariants: today.json 원본 수정 금지
// ────────────────────────────────────
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

  // ✅ id 발급(없을 때만)
  const postId = resolvePostId(item);
  const reviewId = resolveReviewId(item, label);

  // ✅ expanded item에 매칭키 주입(항상)
  if (outItem) {
    outItem.generatedSlug = slug;
    outItem.postId = postId;
    if (reviewId) outItem.reviewId = reviewId;
  }

  const targetPath = path.join(CONTENT_DIR, `${slug}.json`);

  // ────────────────────────────────────
  //  What: SSOT posts 생성(없을 때만)
  //  Why : content/posts는 SSOT, 덮어쓰기는 정책상 금지
  //  I/O : W(content/posts/{slug}.json)
  //  Invariants: 이미 존재하면 절대 수정하지 않음
  // ────────────────────────────────────
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
    // ✅ 신규: 영구 postId
    postId,

    // ✅ 신규: 리뷰 포스트만 reviewId (없으면 null)
    reviewId: reviewId || null,

    slug,
    title,
    description: (item.angle || item.title || '').trim(),
    labels: [label],
    intent: (item.intent || '').trim() || (isReviewLabel(label) ? 'review' : 'general'),
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

      // ✅ 신규: 추적 편의(중복보험) — SSOT 키는 postId/reviewId, 사람이 보는 키는 slug
      postId,
      reviewId: reviewId || null,
    },
  };

  fs.writeFileSync(targetPath, JSON.stringify(doc, null, 2), 'utf8');
  log(`created ${path.basename(targetPath)} postId=${postId} reviewId=${reviewId || '(n/a)'} seed=${item.id || '(no-id)'}`);
  created++;
}

// ────────────────────────────────────
//  What: today.expanded.json 저장
//  Why : 실행 스코프(매칭키 포함) 고정
//  I/O : W(dist/queue/today.expanded.json)
//  Invariants: today.json 원본은 절대 수정하지 않음
// ────────────────────────────────────
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
