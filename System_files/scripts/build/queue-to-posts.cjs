#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/queue-to-posts.cjs
 * dist/queue/today.json → content/posts/*.json 자동 생성기
 *
 * ✅ 유지(기존 기능 그대로)
 * - 라벨 6개 강제 + profileId 필수 + 오염(누락/오타) 즉시 차단
 * - dist/queue/today.expanded.json 생성(원본 today.json 불변)
 * - seedMeta 유지
 *
 * ✅ 추가(업데이트)
 * - postId(영구 ID) 생성/저장: doc.postId
 *   - slug는 사람이 읽기 좋은 “표면 ID”
 *   - postId는 장기 운영에서 “불변 식별자(내부 키)”로 사용
 *   - seed 추적/중복 방지/리뷰 SSOT 매칭의 안정성을 강화
 */

// ✅ 공통 규칙: .env 로더 최우선(게이트/루트/DRY_RUN 사고 방지)
require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ────────────────────────────────────
// What: 경로 설정(루트/입출력 파일 고정)
// Why: 상대경로 혼동/중첩 루트 생성 사고 방지
// I/O: R=dist/queue/today.json, W=content/posts/*.json, dist/queue/today.expanded.json
// Invariants: ROOT는 System_files 고정
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
// What: 라벨(SSOT) 고정
// Why: 라벨 오염 시 이후 파이프라인 전체가 깨짐(리뷰/스케줄/프로필 매핑)
// I/O: R=dist/queue/today.json(items[*].label), W=없음
// Invariants: 6개 라벨 외 즉시 중단
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
// What: 프로필 로딩(라벨→profileId 매핑)
// Why: profileId가 없으면 “의도/룰/템플릿” 결합이 무너짐
// I/O: R=seedpool/profiles/labels.json, W=없음
// Invariants: profileId 없으면 즉시 중단
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
// What: today.json 로드
// Why: 큐가 없으면 생성할 포스트가 없으므로 안전 종료
// I/O: R=dist/queue/today.json, W=없음
// Invariants: 파싱 실패는 FATAL
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
// What: 라벨→slug prefix 매핑(고정)
// Why: blogger.cjs 등 downstream이 prefix를 전제로 분기할 수 있음
// I/O: R=label, W=slug
// Invariants: 매핑 누락은 FATAL
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

// ────────────────────────────────────
// What: 날짜 문자열 생성(YYYYMMDD)
// Why: slug 규약 고정(기존 방식 유지)
// I/O: R=item.date/queue.date, W=slug 구성요소
// Invariants: "YYYY-MM-DD" → "YYYYMMDD" 변환
// ────────────────────────────────────
function getDateString(item) {
  const base = item.date || queue.date || new Date().toISOString().slice(0, 10);
  return String(base).slice(0, 10).replace(/-/g, '');
}

function isoUtcMidnight(dateYYYYMMDD) {
  const y = dateYYYYMMDD.slice(0, 4);
  const m = dateYYYYMMDD.slice(4, 6);
  const d = dateYYYYMMDD.slice(6, 8);
  return `${y}-${m}-${d}T00:00:00Z`;
}

// ────────────────────────────────────
// What: 본문 프롬프트 빌드(기존 유지)
// Why: body 생성 단계가 이를 참조할 수 있음
// I/O: R=item 필드, W=doc.bodyPrompt
// Invariants: TL;DR/FAQ/Sources 등은 별도 주입(본문에서 금지)
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
// What: label/title 검증(기존 유지)
// Why: 빈 문서/오염 확산 차단
// I/O: R=items[*], W=없음
// Invariants: label 6개만, title 없으면 생성 금지
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
// What: postId(영구) 생성
// Why: slug(표면 ID) 변경/충돌/이동에도 “동일 포스트”를 추적 가능(장기 무인 운영 필수)
// I/O: R=seedMeta(queueDate,label,seedId) + generated slug, W=doc.postId
// Invariants:
//  - 같은 입력이면 같은 postId(안정적)
//  - 외부 API/GPT 비용 없음
//  - 1회 생성 후 posts SSOT에 영구 저장
// ────────────────────────────────────
function makePostId({ queueDate, label, seedId, generatedSlug }) {
  const base = [
    'v1',
    String(queueDate || '').trim(),
    String(label || '').trim(),
    String(seedId || '').trim(),
    String(generatedSlug || '').trim(),
  ].join('|');

  const digest = crypto.createHash('sha1').update(base, 'utf8').digest('hex').slice(0, 16);
  return `post_${digest}`; // 예: post_a1b2c3d4e5f60789
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
  const slug = `${prefix}-${ymd}-${idx}`; // 예: app-20251212-001

  // ✅ expanded item에 generatedSlug 주입(항상)
  if (outItem) outItem.generatedSlug = slug;

  const targetPath = path.join(CONTENT_DIR, `${slug}.json`);

  // ────────────────────────────────────
  // What: 기존 파일 존재 시 스킵(기존 유지)
  // Why: posts SSOT 덮어쓰기 금지(운영 안정성)
  // I/O: R=content/posts/{slug}.json 존재 여부, W=없음
  // Invariants: 이미 존재하면 변경하지 않음
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

  // ────────────────────────────────────
  // What: postId 생성 및 저장(신규)
  // Why: 장기 운영에서 slug만 의존하면 “이력/중복/리뷰 매칭”이 취약해짐
  // I/O: R=item.id(seedId), queueDate, label, slug / W=doc.postId
  // Invariants: 생성된 postId는 문서 내 영구 저장(후속 단계에서 재사용)
  // ────────────────────────────────────
  const postId = makePostId({
    queueDate,
    label,
    seedId: item.id || '',
    generatedSlug: slug,
  });

  const doc = {
    // ✅ 신규: 포스트 영구 ID(내부키)
    postId,

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
  log(`created ${path.basename(targetPath)} from seed id=${item.id || '(no-id)'} postId=${postId}`);
  created++;
}

// ────────────────────────────────────
// What: today.expanded.json 저장(기존 유지)
// Why: today.json 원본 불변 유지 + 실행 스코프/slug 매칭키 제공
// I/O: R=dist/queue/today.json, W=dist/queue/today.expanded.json
// Invariants: today.json 원본 수정 금지
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
