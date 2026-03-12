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
 * 추가(2-a-7 대응: B안 카운터 정책):
 * - 같은 날짜/같은 라벨로 재실행해도 slug가 001로 되감기지 않도록
 *   manifests/issue-seq.json(신규)로 라벨별 발행번호를 영속 관리한다.
 * - 또한, 같은 seed(id)가 이미 content/posts에 존재하면 해당 slug/postId/reviewId를 “재사용”하여
 *   today.expanded 실행 스코프와 실제 SSOT가 어긋나는 상황을 최소화한다.
 *
 * 절대 하지 말아야 할 것:
 * - 기존 posts 덮어쓰기
 * - today.json 구조 변경
 * - pageId 생성/수정
 */

require('./lib/env.cjs'); // 환경변수/경로/DRY_RUN SSOT

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ✅ slug policy SSOT
const slugPolicy = require('./lib/slug-policy.cjs');
const {
  ALLOWED_LABEL_SET,
  assertAllowedLabel,
  getCanonicalPrefixByLabel,
  buildSlug,
} = slugPolicy;

/* ============================================================
 * 경로 정의
 * ============================================================ */
const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const QUEUE_DIR = path.join(ROOT, 'dist', 'queue');
const QUEUE_FILE = path.join(QUEUE_DIR, 'today.json'); // 입력 SSOT
const QUEUE_EXPANDED_FILE = path.join(QUEUE_DIR, 'today.expanded.json'); // 실행 스냅샷(SSOT 아님)

const CONTENT_DIR = path.join(ROOT, 'content', 'posts'); // 출력 SSOT
fs.mkdirSync(CONTENT_DIR, { recursive: true });

const MANIFESTS_DIR = path.join(ROOT, 'manifests');
const ISSUE_SEQ_FILE = path.join(MANIFESTS_DIR, 'issue-seq.json'); // ✅ SSOT(영속 카운터)

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
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/* ============================================================
 * 라벨 SSOT (slug-policy로 단일화)
 * ============================================================ */
const ALLOWED_LABELS = ALLOWED_LABEL_SET || new Set();

/* ============================================================
 * 리뷰 라벨 판정
 * ============================================================ */
function isReviewLabel(label) {
  return (
    label === 'app-reviews' ||
    label === 'device-reviews' ||
    label === 'subscription-services'
  );
}

/* ============================================================
 * profileId 매핑
 * [2-b-5] labels.json 단일 SSOT 확정
 * - labels.json 만 신뢰한다.
 * - label-profiles.json 은 프로필 정의 파일이며 매핑 대체재가 아니다.
 * - labels.json 이 없거나 구조가 비정상이면 즉시 FATAL.
 * ============================================================ */
const SEEDPOOL_DIR = path.join(ROOT, 'seedpool');
const PROFILES_DIR = path.join(SEEDPOOL_DIR, 'profiles');
const LABELS_FILE = path.join(PROFILES_DIR, 'labels.json');

function loadLabelToProfileMapStrict() {
  if (!fs.existsSync(LABELS_FILE)) {
    fatal(`profile 매핑 SSOT 없음: ${LABELS_FILE}`);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8'));
  } catch (e) {
    fatal(`labels.json 파싱 실패: ${e.message || e}`);
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fatal(`labels.json 구조 비정상: object mapping 필요 (${LABELS_FILE})`);
  }

  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const label = String(k || '').trim();
    const profileId = String(v || '').trim();
    if (!label) continue;
    if (!profileId) {
      fatal(`labels.json profileId 비정상: label=${label}`);
    }
    out[label] = profileId;
  }

  return out;
}

const LABEL_TO_PROFILE_ID = loadLabelToProfileMapStrict();

function getProfileIdForLabel(label) {
  const pid = LABEL_TO_PROFILE_ID[label];
  return pid ? String(pid) : null;
}

/* ============================================================
 * today.json 로드 (입력 SSOT)
 * ============================================================ */
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
  if (!ALLOWED_LABELS.has(v)) fatal(`items[${idx}] label 비정상: ${v}`);
  try { assertAllowedLabel(v, `items[${idx}].label`); } catch (e) { fatal(e.message || String(e)); }
  return v;
}
function requireValidTitle(title, idx) {
  const t = String(title || '').trim();
  if (!t) fatal(`items[${idx}] title 누락`);
  return t;
}

/* ============================================================
 * 날짜 / 시간 정책 (운영 고정)
 * ============================================================ */
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
 * slug 보조
 * ============================================================ */
function pad3(n) {
  return String(n).padStart(3, '0');
}

/* ============================================================
 * ID 정책 (ULID)
 * ============================================================ */
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
 * ============================================================ */
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
 * (B안) issue 시퀀스(영속) 로드/세이브
 * ============================================================ */
function loadIssueSeq() {
  const base = { version: 1, updatedAt: null, byDate: {} };
  const raw = readJsonSafe(ISSUE_SEQ_FILE, null);
  if (!raw || typeof raw !== 'object') return base;

  const byDate = raw.byDate && typeof raw.byDate === 'object' ? raw.byDate : {};
  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    updatedAt: raw.updatedAt || null,
    byDate,
  };
}

function saveIssueSeq(seq) {
  ensureDir(MANIFESTS_DIR);
  const out = {
    version: seq.version || 1,
    updatedAt: new Date().toISOString(),
    byDate: seq.byDate || {},
  };
  fs.writeFileSync(ISSUE_SEQ_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
}

function nextIndexFor(dateYYYYMMDD, label, seq) {
  const d = String(dateYYYYMMDD || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) fatal(`issue-seq date invalid: ${d}`);
  if (!ALLOWED_LABELS.has(label)) fatal(`issue-seq label invalid: ${label}`);

  if (!seq.byDate[d]) seq.byDate[d] = {};
  const n = Number(seq.byDate[d][label] || 0);
  const next = n + 1;
  seq.byDate[d][label] = next;
  return next;
}

/* ============================================================
 * (재실행 안정화) 기존 post 재사용 탐색
 * - 같은 seed(id) + queueDate + label 이 이미 content/posts에 존재하면 slug/postId/reviewId를 그대로 사용
 * ============================================================ */
function findExistingPostBySeed(queueDate, label, seedId) {
  const qd = String(queueDate || '').slice(0, 10);
  const sid = String(seedId || '').trim();
  if (!sid) return null;

  let files;
  try {
    files = fs.readdirSync(CONTENT_DIR).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch {
    return null;
  }

  for (const f of files) {
    const full = path.join(CONTENT_DIR, f);
    const doc = readJsonSafe(full, null);
    if (!doc || typeof doc !== 'object') continue;

    const sm = doc.seedMeta && typeof doc.seedMeta === 'object' ? doc.seedMeta : {};
    const docQueueDate = String(sm.queueDate || '').slice(0, 10);
    const docLabel = String(sm.label || '').trim();
    const docSeedId = String(sm.id || sm.seedId || doc.seedId || '').trim();

    if (docQueueDate !== qd) continue;
    if (docLabel !== label) continue;
    if (docSeedId !== sid) continue;

    const slug = String(doc.slug || path.basename(f, '.json')).trim();
    if (!slug) continue;

    return {
      slug,
      postId: String(doc.postId || '').trim() || null,
      reviewId: String(doc.reviewId || '').trim() || null,
      file: full,
    };
  }

  return null;
}

/* ============================================================
 * 메인 처리
 * ============================================================ */
const queueCutoff = normalizeCutoff(queue.cutoff || '10:00');
const expandedItems = items.map((it) => (it && typeof it === 'object' ? { ...it } : it));

const issueSeq = loadIssueSeq();

let created = 0;
let skipped = 0;
let reused = 0;

for (let i = 0; i < items.length; i++) {
  const item = items[i] || {};
  const outItem = expandedItems[i] && typeof expandedItems[i] === 'object' ? expandedItems[i] : null;

  const label = requireValidLabel(item.label, i);
  requireValidTitle(item.title, i);

  const canonicalPrefix = getCanonicalPrefixByLabel(label);
  if (!canonicalPrefix) fatal(`prefix 매핑 누락: ${label}`);

  const queueDate = resolveQueueDate(item, queue);
  const ymd = queueDate.replace(/-/g, '');

  const existing = findExistingPostBySeed(queueDate, label, item.id);

  let slug = '';
  let postId = null;
  let reviewId = null;

  if (existing) {
    slug = existing.slug;
    postId = existing.postId || null;
    reviewId = existing.reviewId || null;
  } else {
    while (true) {
      const idx = nextIndexFor(queueDate, label, issueSeq);

      try {
        slug = buildSlug({label, yyyymmdd: ymd, index3: pad3(idx),});
      } catch {
        slug = `${canonicalPrefix}-${ymd}-${pad3(idx)}`;
      }

      const targetPath = path.join(CONTENT_DIR, `${slug}.json`);
      if (!fs.existsSync(targetPath)) break;
    }

    postId = String(item.postId || '').trim() ? String(item.postId).trim() : ulidNow();
    reviewId = isReviewLabel(label)
      ? (String(item.reviewId || '').trim() ? String(item.reviewId).trim() : ulidNow())
      : null;
  }

  if (outItem) {
    outItem.generatedSlug = slug;
    outItem.postId = postId || outItem.postId || null;
    if (isReviewLabel(label)) outItem.reviewId = reviewId || outItem.reviewId || null;
  }

  if (existing) {
    reused++;
    skipped++;
    continue;
  }

  const targetPath = path.join(CONTENT_DIR, `${slug}.json`);
  if (fs.existsSync(targetPath)) {
    skipped++;
    continue;
  }

  const profileId = getProfileIdForLabel(label);
  if (!profileId) fatal(`profileId 없음: ${label} (labels.json SSOT 확인 필요)`);

  const doc = {
    postId,
    reviewId,
    slug,
    title: String(item.title || '').trim(),
    labels: [label],
    updated: resolveUpdatedIsoKst(queueDate, queueCutoff),

    bodyPrompt: '',
    body: '',

    seedMeta: {
      queueDate,
      cutoff: queueCutoff,
      label,
      profileId,
      id: item.id || null,

      // [2-b-6] scheduler intent 의미 보존
      intent: Object.prototype.hasOwnProperty.call(item, 'intent')
        ? (item.intent == null ? null : String(item.intent).trim() || null)
        : null,

      postId,
      reviewId,
    },
  };

  fs.writeFileSync(targetPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  created++;
}

writeExpandedSnapshot(queue, expandedItems);
saveIssueSeq(issueSeq);

log(`완료: created=${created}, skipped=${skipped}, reused=${reused}`);
