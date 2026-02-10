'use strict';

/**
 * System_files/scripts/build/lib/seed-ledger.cjs
 *
 * Seed Ledger (Scalable v3: append-only + index + fingerprint)
 *
 * ✅ SSOT(ledger): System_files/logs/seed-ledger.jsonl              (append-only)
 * ✅ Index:        System_files/logs/seed-ledger.index.json         (recordKey -> byteOffset + alias + usedFingerprints)
 *
 * 목표:
 * - 대용량에서도 upsert O(1)에 가깝게 유지
 * - recordKey 기준 "멱등 upsert" (기존 레코드 읽어서 병합 후 새 줄 append)
 * - slug 임시키 → pid 확정키 승격(merge) + slugKey alias 유지
 *
 * (추가) Fingerprint 기반 "내용 중복 방지"
 * - 같은 fingerprint(내용 지문)는 재사용 금지
 * - index.usedFingerprints 를 SSOT로 사용(빠른 조회)
 *
 * 호환성:
 * - 기존 ids.cjs / blogger.cjs는 그대로 upsert() 호출만 하면 됨
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..'); // System_files
const LOGS_DIR = path.join(ROOT, 'logs');

const LEDGER_FILE = path.join(LOGS_DIR, 'seed-ledger.jsonl');              // append-only
const INDEX_FILE = path.join(LOGS_DIR, 'seed-ledger.index.json');          // small json (map+alias+fingerprint)
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
  // 최소 방어: "fpX:" 형태면 그대로, 아니면 허용(향후 포맷 바뀔 수 있음)
  // 권장 포맷: fp1:<hex>
  return s;
}

function normalizeMode(v) {
  const s = safeStr(v).trim().toLowerCase();
  if (!s) return '';
  if (s === 'trend' || s === 'evergreen' || s === 'firstgate') return s;
  return s; // 확장 가능(최소 개입)
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
 *   "version": 3,
 *   "updatedAt": "ISO",
 *   "offsetByKey": { "pid:page000123": 12345, "slug:abc": 67890, "fp:fp1:...": 111, ... },
 *   "alias": { "slug:abc": "pid:page000123", ... },
 *   "usedFingerprints": { "fp1:....": true, ... }   // ✅ 빠른 중복 조회
 * }
 */
function loadIndex() {
  try {
    if (!fs.existsSync(INDEX_FILE)) {
      return {
        version: 3,
        updatedAt: null,
        offsetByKey: {},
        alias: {},
        usedFingerprints: {}
      };
    }
    const raw = fs.readFileSync(INDEX_FILE, 'utf8');
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object') throw new Error('bad index json');

    if (!json.offsetByKey || typeof json.offsetByKey !== 'object') json.offsetByKey = {};
    if (!json.alias || typeof json.alias !== 'object') json.alias = {};
    if (!json.usedFingerprints || typeof json.usedFingerprints !== 'object') json.usedFingerprints = {};

    json.version = 3;
    return json;
  } catch {
    // 인덱스가 깨졌으면 재구축(안전)
    return rebuildIndex();
  }
}

function saveIndex(index) {
  ensureDir(LOGS_DIR);
  index.updatedAt = nowIso();
  fs.writeFileSync(TMP_INDEX_FILE, JSON.stringify(index, null, 2) + '\n', 'utf8');
  // atomic-ish replace
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

    const CHUNK = 64 * 1024; // 64KB
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

      // 안전: 1줄이 비정상적으로 길어지는 경우 방어
      if (acc.length > 2 * 1024 * 1024) break; // 2MB
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
 * Fingerprint 사용 여부(빠른 조회)
 * - index.usedFingerprints 기반
 */
function hasFingerprint(fingerprint) {
  const fp = normalizeFingerprint(fingerprint);
  if (!fp) return false;
  const index = loadIndex();
  return !!(index.usedFingerprints && index.usedFingerprints[fp]);
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
 * - fingerprint 사용 여부도 함께 재구축
 */
function rebuildIndex() {
  ensureDir(LOGS_DIR);

  const index = {
    version: 3,
    updatedAt: nowIso(),
    offsetByKey: {},
    alias: {},
    usedFingerprints: {}
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

      // 라인 시작 offset 추적
      let byteCursor = offset;
      for (let i = 0; i < parts.length; i++) {
        const rawLine = parts[i];
        const line = rawLine.trim();
        const lineBytes = Buffer.byteLength(rawLine + '\n', 'utf8');

        if (line) {
          try {
            const obj = JSON.parse(line);
            if (obj && typeof obj === 'object') {
              // recordKey 기준 offset 저장
              if (typeof obj.recordKey === 'string' && obj.recordKey) {
                index.offsetByKey[obj.recordKey] = byteCursor;
              }

              // alias 흡수
              if (obj.alias && typeof obj.alias === 'object') {
                Object.assign(index.alias, obj.alias);
              }

              // fingerprint 사용 여부 흡수
              const fp = normalizeFingerprint(obj.fingerprint);
              if (fp) {
                index.usedFingerprints[fp] = true;
                // fpKey가 있다면 최신 offset도 저장(디버깅/추적에 유용)
                index.offsetByKey[`fp:${fp}`] = byteCursor;
              }
            }
          } catch {
            // ignore broken line
          }
        }

        byteCursor += lineBytes;
      }

      offset += n;
    }

    // carry(마지막 줄) 처리
    const last = carry.trim();
    if (last) {
      try {
        const obj = JSON.parse(last);
        if (obj && typeof obj === 'object') {
          const approxOff = Math.max(0, stat.size - Buffer.byteLength(last, 'utf8'));
          if (typeof obj.recordKey === 'string' && obj.recordKey) {
            index.offsetByKey[obj.recordKey] = approxOff;
          }
          if (obj.alias && typeof obj.alias === 'object') Object.assign(index.alias, obj.alias);

          const fp = normalizeFingerprint(obj.fingerprint);
          if (fp) {
            index.usedFingerprints[fp] = true;
            index.offsetByKey[`fp:${fp}`] = approxOff;
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
 * - recordKey는 pid/slug/fp/seed 우선순위로 생성(기존 호출 영향 없음)
 */
function upsert(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('upsert: patch object 필요');

  const slug = safeStr(patch.slug).trim();
  const pageId = safeStr(patch.pageId).trim();
  const seedId = safeStr(patch.seedId).trim();
  const fingerprint = normalizeFingerprint(patch.fingerprint);

  // recordKey 생성(확장)
  const rk = makeRecordKey({ pageId, slug, fingerprint, seedId });

  // 인덱스 로드
  const index = loadIndex();

  // alias 처리(기존 규칙 유지): slugKey가 pidKey로 승격되면 slugKey를 pidKey로 연결
  const slugKey = slug ? `slug:${slug}` : '';
  if (rk.startsWith('pid:') && slugKey) {
    index.alias[slugKey] = rk;
  }

  // base 로드(현재 최신 상태)
  // - rk가 pid라면, 기존 slug 임시 레코드도 읽어서 병합 후보로 사용
  const baseFromRk = getLatestByKey(rk, index) || {};
  const baseFromSlug = (rk.startsWith('pid:') && slugKey)
    ? (getLatestByKey(slugKey, index) || {})
    : {};

  // 둘 중 더 정보 많은 쪽을 기반으로(간단 기준: updatedAt 비교)
  const base = (() => {
    const ta = Date.parse(baseFromRk.updatedAt || '') || 0;
    const tb = Date.parse(baseFromSlug.updatedAt || '') || 0;
    return ta >= tb ? baseFromRk : baseFromSlug;
  })();

  const merged = {
    // 고정 필드
    recordKey: rk,
    slug: slug || base.slug || '',
    pageId: isValidPageId(pageId) ? pageId : (base.pageId || ''),
    label: patch.label || base.label || '',
    seedId: seedId || base.seedId || '',
    source: patch.source || base.source || '',

    // ✅ 내용 중복 방지 필드
    fingerprint: fingerprint || normalizeFingerprint(base.fingerprint) || '',
    mode: normalizeMode(patch.mode) || normalizeMode(base.mode) || '',
    usedAt: patch.usedAt
      ? safeIsoOrNow(patch.usedAt)
      : (base.usedAt ? safeIsoOrNow(base.usedAt) : ''),

    // 상태/단계
    status: patch.status || base.status || '',
    stage: patch.stage || base.stage || '',
    dryRun: (typeof patch.dryRun === 'boolean')
      ? patch.dryRun
      : (typeof base.dryRun === 'boolean' ? base.dryRun : false),

    // publish 결과
    postId: patch.postId || base.postId || '',
    url: patch.url || base.url || '',

    // 타임
    createdAt: base.createdAt || patch.createdAt || nowIso(),
    updatedAt: nowIso(),

    // 기타
    notes: patch.notes || base.notes || ''
  };

  // alias를 레코드에 “참고 정보”로도 넣어둠(재구축 시 흡수 가능)
  if (rk.startsWith('pid:') && slugKey) {
    merged.alias = merged.alias && typeof merged.alias === 'object' ? merged.alias : {};
    merged.alias[slugKey] = rk;
  }

  // append + index update
  const off = appendRecord(merged);
  index.offsetByKey[rk] = off;

  // slugKey 자체도 “현재 레코드 위치”로 매핑(기존 유지)
  if (slugKey) {
    index.offsetByKey[slugKey] = off;
    if (rk.startsWith('pid:')) index.alias[slugKey] = rk;
  }

  // ✅ fingerprint 인덱스 업데이트(즉시 반영)
  if (merged.fingerprint) {
    index.usedFingerprints[merged.fingerprint] = true;
    index.offsetByKey[`fp:${merged.fingerprint}`] = off;
  }

  saveIndex(index);

  return { ledgerFile: LEDGER_FILE, indexFile: INDEX_FILE, recordKey: rk, offset: off };
}

/**
 * fingerprint 사용 처리(편의 함수)
 * - pageId/slug 없이도 기록 가능 (recordKey = fp:... 또는 seed:...)
 * - 이 호출이 "내용 사용 SSOT"의 표준 엔트리포인트가 될 수 있음
 */
function markFingerprintUsed({ fingerprint, seedId, label, mode, usedAt, notes = '' }) {
  const fp = normalizeFingerprint(fingerprint);
  if (!fp) throw new Error('markFingerprintUsed: fingerprint missing');

  const sid = safeStr(seedId).trim();

  return upsert({
    // recordKey 생성용(확장)
    fingerprint: fp,
    seedId: sid,

    // 저장 필드
    label: safeStr(label).trim(),
    mode: normalizeMode(mode),
    usedAt: usedAt ? safeIsoOrNow(usedAt) : nowIso(),

    // stage/status는 seed 소비 기록으로 고정(원하면 호출자가 덮어쓸 수 있음)
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
