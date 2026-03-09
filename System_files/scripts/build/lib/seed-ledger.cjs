'use strict';

/**
 * System_files/scripts/build/lib/seed-ledger.cjs
 *
 * Seed Ledger (Scalable v4: append-only + index)
 *
 * ✅ SSOT(ledger): System_files/logs/seed-ledger.jsonl      (append-only)
 * ✅ Index:        System_files/logs/seed-ledger.index.json (recordKey -> byteOffset + alias)
 *
 * 목표:
 * - 대용량에서도 upsert O(1)에 가깝게 유지
 * - recordKey 기준 "멱등 upsert" (기존 레코드 읽어서 병합 후 새 줄 append)
 * - slug 임시키 → pid 확정키 승격(merge) + slugKey alias 유지
 *
 * 변경:
 * - fingerprint 대량 조회/차단 책임은 fp-cache 계층으로 분리
 * - seed-ledger.index.json 에서는 usedFingerprints 책임 제거
 *
 * 호환성:
 * - 기존 ids.cjs / blogger.cjs / scheduler는 그대로 upsert() 호출 가능
 * - hasFingerprint() 는 하위 호환용으로 남기되, ledger 직접 조회 방식으로만 동작
 *   (빠른 조회는 fp-cache 사용 권장)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..'); // System_files
const LOGS_DIR = path.join(ROOT, 'logs');

const LEDGER_FILE = path.join(LOGS_DIR, 'seed-ledger.jsonl');      // append-only
const INDEX_FILE = path.join(LOGS_DIR, 'seed-ledger.index.json');  // small json (map+alias)
const TMP_INDEX_FILE = path.join(LOGS_DIR, 'seed-ledger.index.tmp.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function safeStr(v) {
  return typeof v === 'string' ? v : '';
}

function isValidPageId(v) {
  return typeof v === 'string' && /^page\d{6}$/.test(v);
}

function normalizeFingerprint(v) {
  const s = safeStr(v).trim();
  if (!s) return '';
  return s;
}

function normalizeMode(v) {
  const s = safeStr(v).trim().toLowerCase();
  if (!s) return '';
  if (s === 'trend' || s === 'evergreen' || s === 'firstgate') return s;
  return s;
}

function safeIsoOrNow(v) {
  const s = safeStr(v).trim();
  const t = Date.parse(s);
  return Number.isNaN(t) ? nowIso() : s;
}

/**
 * recordKey 규칙(확장, 기존 호환)
 * 1) pageId 있으면 pid 기반
 * 2) 없으면 slug 기반(임시)
 * 3) 둘 다 없으면 fingerprint 기반(내용 사용 SSOT)
 * 4) 그래도 없으면 seedId 기반(창고별 사용 추적용)
 */
function makeRecordKey({ pageId, slug, fingerprint, seedId }) {
  const s = safeStr(slug).trim();
  const pid = safeStr(pageId).trim();
  const fp = normalizeFingerprint(fingerprint);
  const sid = safeStr(seedId).trim();

  if (isValidPageId(pid)) return `pid:${pid}`;
  if (s) return `slug:${s}`;
  if (fp) return `fp:${fp}`;
  if (sid) return `seed:${sid}`;
  throw new Error('makeRecordKey: pageId/slug/fingerprint/seedId 모두 없음');
}

/**
 * Index 구조(경량)
 * {
 *   "version": 4,
 *   "updatedAt": "ISO",
 *   "offsetByKey": { "pid:page000123": 12345, "slug:abc": 67890, ... },
 *   "alias": { "slug:abc": "pid:page000123", ... }
 * }
 */
function loadIndex() {
  try {
    if (!fs.existsSync(INDEX_FILE)) {
      return {
        version: 4,
        updatedAt: null,
        offsetByKey: {},
        alias: {},
      };
    }
    const raw = fs.readFileSync(INDEX_FILE, 'utf8');
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object') throw new Error('bad index json');

    if (!json.offsetByKey || typeof json.offsetByKey !== 'object') json.offsetByKey = {};
    if (!json.alias || typeof json.alias !== 'object') json.alias = {};

    // 구버전 호환: usedFingerprints 필드는 무시
    delete json.usedFingerprints;

    json.version = 4;
    return json;
  } catch {
    return rebuildIndex();
  }
}

function saveIndex(index) {
  ensureDir(LOGS_DIR);
  index.updatedAt = nowIso();
  index.version = 4;
  delete index.usedFingerprints;
  fs.writeFileSync(TMP_INDEX_FILE, JSON.stringify(index, null, 2) + '\n', 'utf8');
  fs.renameSync(TMP_INDEX_FILE, INDEX_FILE);
}

/**
 * 특정 offset에서 "한 줄" 읽기 (JSONL)
 */
function readLineAtOffset(filePath, offset) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (offset < 0 || offset >= stat.size) return null;

    const CHUNK = 64 * 1024;
    const buf = Buffer.alloc(CHUNK);

    let pos = offset;
    let acc = '';
    while (pos < stat.size) {
      const toRead = Math.min(CHUNK, stat.size - pos);
      const n = fs.readSync(fd, buf, 0, toRead, pos);
      if (n <= 0) break;

      const s = buf.toString('utf8', 0, n);
      const idx = s.indexOf('\n');
      if (idx >= 0) {
        acc += s.slice(0, idx);
        break;
      }
      acc += s;
      pos += n;

      if (acc.length > 2 * 1024 * 1024) break;
    }

    const line = acc.trim();
    if (!line) return null;

    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * recordKey로 "현재 최신 상태" 읽기
 * - alias 처리: slugKey가 pidKey로 연결되면 pidKey 우선
 */
function getLatestByKey(recordKey, index) {
  if (!recordKey) return null;
  const aliasTo = index.alias && index.alias[recordKey] ? index.alias[recordKey] : null;
  const rk = aliasTo || recordKey;

  const off = index.offsetByKey && typeof index.offsetByKey[rk] === 'number'
    ? index.offsetByKey[rk]
    : null;
  if (off === null) return null;
  if (!fs.existsSync(LEDGER_FILE)) return null;

  return readLineAtOffset(LEDGER_FILE, off);
}

/**
 * 하위 호환용 fingerprint 조회
 * - 더 이상 index.usedFingerprints 를 쓰지 않음
 * - ledger를 뒤에서부터 훑는 느린 방식
 * - 빠른 조회/중복 판정은 fp-cache 사용 권장
 */
function hasFingerprint(fingerprint) {
  const fp = normalizeFingerprint(fingerprint);
  if (!fp) return false;
  if (!fs.existsSync(LEDGER_FILE)) return false;

  const lines = fs.readFileSync(LEDGER_FILE, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (normalizeFingerprint(obj && obj.fingerprint) === fp) return true;
    } catch {}
  }
  return false;
}

/**
 * Ledger append (1줄)
 * - return: appended offset
 */
function appendRecord(obj) {
  ensureDir(LOGS_DIR);

  const line = JSON.stringify(obj) + '\n';
  const offset = fs.existsSync(LEDGER_FILE) ? fs.statSync(LEDGER_FILE).size : 0;
  fs.appendFileSync(LEDGER_FILE, line, 'utf8');
  return offset;
}

/**
 * 인덱스 재구축(최후 수단)
 * - ledger 전체 스캔하여 recordKey별 마지막 offset 저장
 * - alias만 재구축
 * - fingerprint 대량 인덱싱 책임은 여기서 제거
 */
function rebuildIndex() {
  ensureDir(LOGS_DIR);

  const index = {
    version: 4,
    updatedAt: nowIso(),
    offsetByKey: {},
    alias: {},
  };

  if (!fs.existsSync(LEDGER_FILE)) {
    saveIndex(index);
    return index;
  }

  const fd = fs.openSync(LEDGER_FILE, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const CHUNK = 256 * 1024;
    const buf = Buffer.alloc(CHUNK);

    let offset = 0;
    let carry = '';

    while (offset < stat.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, stat.size - offset), offset);
      if (n <= 0) break;

      const text = carry + buf.toString('utf8', 0, n);
      const parts = text.split('\n');
      carry = parts.pop() || '';

      let byteCursor = offset;
      for (let i = 0; i < parts.length; i++) {
        const rawLine = parts[i];
        const line = rawLine.trim();
        const lineBytes = Buffer.byteLength(rawLine + '\n', 'utf8');

        if (line) {
          try {
            const obj = JSON.parse(line);
            if (obj && typeof obj === 'object') {
              if (typeof obj.recordKey === 'string' && obj.recordKey) {
                index.offsetByKey[obj.recordKey] = byteCursor;
              }

              if (obj.alias && typeof obj.alias === 'object') {
                Object.assign(index.alias, obj.alias);
              }
            }
          } catch {}
        }

        byteCursor += lineBytes;
      }

      offset += n;
    }

    const last = carry.trim();
    if (last) {
      try {
        const obj = JSON.parse(last);
        if (obj && typeof obj === 'object') {
          const approxOff = Math.max(0, stat.size - Buffer.byteLength(last, 'utf8'));
          if (typeof obj.recordKey === 'string' && obj.recordKey) {
            index.offsetByKey[obj.recordKey] = approxOff;
          }
          if (obj.alias && typeof obj.alias === 'object') {
            Object.assign(index.alias, obj.alias);
          }
        }
      } catch {}
    }
  } finally {
    fs.closeSync(fd);
  }

  saveIndex(index);
  return index;
}

/**
 * 업서트(멱등)
 * - 기존 record를 index로 O(1) 읽고, 병합한 "최신 상태"를 append
 * - slugKey -> pidKey 승격 시: alias(slugKey -> pidKey) 저장
 *
 * 확장:
 * - fingerprint/mode/usedAt 저장 가능
 * - recordKey는 pid/slug/fp/seed 우선순위로 생성
 */
function upsert(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('upsert: patch object 필요');

  const slug = safeStr(patch.slug).trim();
  const pageId = safeStr(patch.pageId).trim();
  const seedId = safeStr(patch.seedId).trim();
  const fingerprint = normalizeFingerprint(patch.fingerprint);

  const rk = makeRecordKey({ pageId, slug, fingerprint, seedId });

  const index = loadIndex();

  const slugKey = slug ? `slug:${slug}` : '';
  if (rk.startsWith('pid:') && slugKey) {
    index.alias[slugKey] = rk;
  }

  const baseFromRk = getLatestByKey(rk, index) || {};
  const baseFromSlug = (rk.startsWith('pid:') && slugKey)
    ? (getLatestByKey(slugKey, index) || {})
    : {};

  const base = (() => {
    const ta = Date.parse(baseFromRk.updatedAt || '') || 0;
    const tb = Date.parse(baseFromSlug.updatedAt || '') || 0;
    return ta >= tb ? baseFromRk : baseFromSlug;
  })();

  const merged = {
    recordKey: rk,
    slug: slug || base.slug || '',
    pageId: isValidPageId(pageId) ? pageId : (base.pageId || ''),
    label: patch.label || base.label || '',
    seedId: seedId || base.seedId || '',
    source: patch.source || base.source || '',

    fingerprint: fingerprint || normalizeFingerprint(base.fingerprint) || '',
    mode: normalizeMode(patch.mode) || normalizeMode(base.mode) || '',
    usedAt: patch.usedAt
      ? safeIsoOrNow(patch.usedAt)
      : (base.usedAt ? safeIsoOrNow(base.usedAt) : ''),

    status: patch.status || base.status || '',
    stage: patch.stage || base.stage || '',
    dryRun: (typeof patch.dryRun === 'boolean')
      ? patch.dryRun
      : (typeof base.dryRun === 'boolean' ? base.dryRun : false),

    postId: patch.postId || base.postId || '',
    url: patch.url || base.url || '',

    createdAt: base.createdAt || patch.createdAt || nowIso(),
    updatedAt: nowIso(),

    notes: patch.notes || base.notes || ''
  };

  if (rk.startsWith('pid:') && slugKey) {
    merged.alias = merged.alias && typeof merged.alias === 'object' ? merged.alias : {};
    merged.alias[slugKey] = rk;
  }

  const off = appendRecord(merged);
  index.offsetByKey[rk] = off;

  if (slugKey) {
    index.offsetByKey[slugKey] = off;
    if (rk.startsWith('pid:')) index.alias[slugKey] = rk;
  }

  saveIndex(index);

  return { ledgerFile: LEDGER_FILE, indexFile: INDEX_FILE, recordKey: rk, offset: off };
}

/**
 * fingerprint 사용 처리(편의 함수)
 * - pageId/slug 없이도 기록 가능
 * - 실제 빠른 중복 조회 책임은 fp-cache 사용 권장
 */
function markFingerprintUsed({ fingerprint, seedId, label, mode, usedAt, notes = '' }) {
  const fp = normalizeFingerprint(fingerprint);
  if (!fp) throw new Error('markFingerprintUsed: fingerprint missing');

  const sid = safeStr(seedId).trim();

  return upsert({
    fingerprint: fp,
    seedId: sid,

    label: safeStr(label).trim(),
    mode: normalizeMode(mode),
    usedAt: usedAt ? safeIsoOrNow(usedAt) : nowIso(),

    stage: 'seed',
    status: 'used',
    dryRun: true,

    notes: safeStr(notes).trim()
  });
}

module.exports = {
  upsert,
  makeRecordKey,
  hasFingerprint,
  markFingerprintUsed,
  rebuildIndex,
  _paths: { ROOT, LOGS_DIR, LEDGER_FILE, INDEX_FILE }
};
