#!/usr/bin/env node
'use strict';

/**
 * ============================================================
 * System_files/scripts/build/queue-to-posts.cjs
 * ============================================================
 *
 * 역할(SSOT 기준):
 * - dist/queue/today.json 을 입력으로 받아
 *   content/posts/*.json (포스트 SSOT)을 "신규 생성만" 수행한다.
 *
 * 이 파일의 책임:
 * 1) today.json을 “절대 수정하지 않는다” (입력 SSOT)
 * 2) posts가 없을 때만 생성한다 (멱등성 보장)
 * 3) 날짜/slug/updated 는 today.json 기준을 100% 신뢰한다
 * 4) pageId 발급에는 관여하지 않는다 (ids.cjs 전담)
 * 5) 실행 스냅샷(dist/queue/today.expanded.json)에 generatedSlug/postId/reviewId를 기록한다
 *
 * 절대 하지 말아야 할 것:
 * - 기존 posts 덮어쓰기
 * - today.json 구조 변경
 * - pageId 생성/수정
 *
 * 연결 파이프라인:
 * seed-scheduler.cjs
 *   → dist/queue/today.json (SSOT)
 *   → queue-to-posts.cjs (여기)
 *   → content/posts/*.json (SSOT)
 *   → ids.cjs / render-posts.cjs
 */

require('./lib/env.cjs'); // 환경변수/경로/DRY_RUN SSOT

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ============================================================
 * 경로 정의
 * ============================================================
 * System_files 기준으로 모든 경로를 고정한다.
 * 경로 변경 시 파이프라인 전체 영향 발생.
 */
const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const QUEUE_DIR = path.join(ROOT, 'dist', 'queue');
const QUEUE_FILE = path.join(QUEUE_DIR, 'today.json'); // 입력 SSOT
const QUEUE_EXPANDED_FILE = path.join(QUEUE_DIR, 'today.expanded.json'); // 실행 스냅샷(SSOT 아님)

const CONTENT_DIR = path.join(ROOT, 'content', 'posts'); // 출력 SSOT
fs.mkdirSync(CONTENT_DIR, { recursive: true });

/* ============================================================
 * 공통 로그 / 중단 유틸
 * ============================================================ */
function log(...a) {
  console.log('[seed→post]', ...a);
}
function fatal(msg) {
  console.error('[seed→post][FATAL]', msg);
  process.exit(1);
}

/* ============================================================
 * 라벨 SSOT
 * ============================================================
 * - seed-scheduler / blogger / qa-check 와 반드시 동일해야 함
 * - 하나라도 어긋나면 즉시 중단(FATAL)
 */
const ALLOWED_LABELS = new Set([
  'app-reviews',
  'device-reviews',
  'subscription-services',
  'how-to-playbooks',
  'smart-savings',
  'templates-checklists',
]);

/* ============================================================
 * 리뷰 라벨 판정
 * ============================================================
 * reviewId는 “리뷰 글”에만 존재한다.
 */
function isReviewLabel(label) {
  return (
    label === 'app-reviews' ||
    label === 'device-reviews' ||
    label === 'subscription-services'
  );
}

/* ============================================================
 * profileId 매핑
 * ============================================================
 * label → profileId
 * 매핑이 없으면 콘텐츠 생성 자체를 중단해야 한다.
 */
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

/* ============================================================
 * today.json 로드 (입력 SSOT)
 * ============================================================
 * - 파싱 실패 → 즉시 중단
 * - items 비어있으면 조용히 종료
 */
if (!fs.existsSync(QUEUE_FILE)) {
  log('today.json 없음. 생성할 포스트가 없어 종료.');
  process.exit(0);
}

let queue;
try {
  queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
} catch (e) {
  fatal(`today.json 파싱 실패: ${e.message || e}`);
}

const items = Array.isArray(queue.items) ? queue.items : [];
if (!items.length) {
  log('today.json items 비어 있음. 종료.');
  process.exit(0);
}

/* ============================================================
 * 입력 검증
 * ============================================================ */
function requireValidLabel(label, idx) {
  const v = String(label || '').trim();
  if (!v) fatal(`items[${idx}] label 누락`);
  if (!ALLOWED_LABELS.has(v)) {
    fatal(`items[${idx}] label 비정상: ${v}`);
  }
  return v;
}

function requireValidTitle(title, idx) {
  const t = String(title || '').trim();
  if (!t) fatal(`items[${idx}] title 누락`);
  return t;
}

/* ============================================================
 * 날짜 / 시간 정책 (운영 고정)
 * ============================================================
 * - today.json 의 date + cutoff + Asia/Seoul 을 절대 기준으로 사용
 * - 여기서 날짜 계산 로직을 새로 만들지 않는다
 */
function normalizeCutoff(v) {
  const s = String(v || '').trim();
  return /^\d{2}:\d{2}$/.test(s) ? s : '10:00';
}

function resolveQueueDate(item, queueObj) {
  const d = String(item?.date || queueObj?.date || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;

  // 안전망: KST 기준 오늘(입력이 비정상일 때만)
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function resolveUpdatedIsoKst(queueDate, cutoffHHMM) {
  return `${queueDate}T${cutoffHHMM}:00+09:00`;
}

/* ============================================================
 * slug 규칙
 * ============================================================
 * prefix-yyyyMMdd-001
 * prefix는 blogger / qa-check 와 공유 규칙
 */
const LABEL_TO_PREFIX = {
  'app-reviews': 'app',
  'device-reviews': 'device',
  'subscription-services': 'subscription',
  'how-to-playbooks': 'howto',
  'smart-savings': 'smartsavings',
  'templates-checklists': 'templates',
};

function pad3(n) {
  return String(n).padStart(3, '0');
}

/* ============================================================
 * ID 정책
 * ============================================================
 * - postId / reviewId : 여기서 1회만 발급 (ULID)
 * - pageId            : ids.cjs 전담 (절대 관여 금지)
 */
function ulidNow() {
  const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function encode(buf) {
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

  const time = Date.now();
  const tbuf = Buffer.alloc(6);
  tbuf[0] = (time / 2 ** 40) & 255;
  tbuf[1] = (time / 2 ** 32) & 255;
  tbuf[2] = (time / 2 ** 24) & 255;
  tbuf[3] = (time / 2 ** 16) & 255;
  tbuf[4] = (time / 2 ** 8) & 255;
  tbuf[5] = time & 255;

  const rbuf = crypto.randomBytes(10);
  return (encode(tbuf).padStart(10, '0') + encode(rbuf).padStart(16, '0')).slice(0, 26);
}

/* ============================================================
 * today.expanded.json (실행 스냅샷)
 * ============================================================
 * - today.json 원본은 절대 수정하지 않음
 * - 아이템별 생성 결과(슬러그/ID)를 남겨 ids.cjs(active)의 publishable SSOT로 사용
 */
function writeExpandedSnapshot(queueObj, expandedItems) {
  try {
    const expanded = {
      ...queueObj,
      expandedAt: new Date().toISOString(),
      items: expandedItems,
    };
    fs.writeFileSync(QUEUE_EXPANDED_FILE, JSON.stringify(expanded, null, 2) + '\n', 'utf8');
    log(`expanded queue written → ${QUEUE_EXPANDED_FILE}`);
  } catch (e) {
    fatal(`today.expanded.json 저장 실패: ${e.message || e}`);
  }
}

/* ============================================================
 * 메인 처리
 * ============================================================ */
const counters = {};
let created = 0;
let skipped = 0;

const queueCutoff = normalizeCutoff(queue.cutoff || '10:00');

// snapshot 용: 원본 item 복제 후 결과 주입
const expandedItems = items.map((it) => (it && typeof it === 'object' ? { ...it } : it));

for (let i = 0; i < items.length; i++) {
  const item = items[i] || {};
  const outItem = expandedItems[i] && typeof expandedItems[i] === 'object' ? expandedItems[i] : null;

  const label = requireValidLabel(item.label, i);
  const title = requireValidTitle(item.title, i);

  const prefix = LABEL_TO_PREFIX[label];
  if (!prefix) fatal(`prefix 매핑 누락: ${label}`);

  const queueDate = resolveQueueDate(item, queue);
  const ymd = queueDate.replace(/-/g, '');

  counters[label] = (counters[label] || 0) + 1;
  const slug = `${prefix}-${ymd}-${pad3(counters[label])}`;

  const targetPath = path.join(CONTENT_DIR, `${slug}.json`);

  // ✅ ULID: 없을 때만 발급(멱등)
  const postId = String(item.postId || '').trim() ? String(item.postId).trim() : ulidNow();
  const reviewId = isReviewLabel(label)
    ? (String(item.reviewId || '').trim() ? String(item.reviewId).trim() : ulidNow())
    : null;

  // ✅ expanded 스냅샷에 “항상” 주입 (생성되든/스킵되든 실행 스코프를 남김)
  if (outItem) {
    outItem.generatedSlug = slug;
    outItem.postId = postId;
    if (reviewId) outItem.reviewId = reviewId;
  }

  // 이미 존재하면 스킵(덮어쓰기 금지)
  if (fs.existsSync(targetPath)) {
    skipped++;
    continue;
  }

  const profileId = getProfileIdForLabel(label);
  if (!profileId) fatal(`profileId 없음: ${label}`);

  const doc = {
    postId,
    reviewId,
    slug,
    title,
    labels: [label],
    updated: resolveUpdatedIsoKst(queueDate, queueCutoff),

    // 본문 생성은 별도 단계에서 채움(여기서는 SSOT 뼈대만)
    bodyPrompt: '',
    body: '',

    seedMeta: {
      queueDate,
      cutoff: queueCutoff,
      label,
      profileId,
      id: item.id || null,

      // 추적 키(사람이 읽기 쉬움)
      postId,
      reviewId,
    },
  };

  fs.writeFileSync(targetPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  created++;
}

// ✅ 실행 스냅샷 저장(SSOT 입력 불변)
writeExpandedSnapshot(queue, expandedItems);

log(`완료: created=${created}, skipped=${skipped}`);
