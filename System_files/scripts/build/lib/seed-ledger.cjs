'use strict';

/**
 * System_files/scripts/build/lib/seed-ledger.cjs
 *
 * Seed Ledger (Scalable v2: append-only + index)
 *
 * ✅ SSOT(ledger): System_files/logs/seed-ledger.jsonl   (append-only)
 * ✅ Index:        System_files/logs/seed-ledger.index.json  (recordKey -> byteOffset)
 *
 * 목표:
 * - 대용량에서도 upsert O(1)에 가깝게 유지
 * - recordKey 기준 "멱등 upsert" (기존 레코드 읽어서 병합 후 새 줄 append)
 * - slug 임시키 → pid 확정키 승격(merge) + slugKey alias 유지
 *
 * 호환성:
 * - 기존 ids.cjs / blogger.cjs는 그대로 upsert() 호출만 하면 됨
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..'); // System_files
const LOGS_DIR = path.join(ROOT, 'logs');

const LEDGER_FILE = path.join(LOGS_DIR, 'seed-ledger.jsonl');          // append-only
const INDEX_FILE  = path.join(LOGS_DIR, 'seed-ledger.index.json');     // small json (map+alias)
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

/**
 * recordKey 규칙(고정)
 * - pageId 있으면 pid 기반
 * - 없으면 slug 기반(임시)
 */
function makeRecordKey({ pageId, slug }) {
  const s = safeStr(slug).trim();
  const pid = safeStr(pageId).trim();
  if (isValidPageId(pid)) return `pid:${pid}`;
  if (s) return `slug:${s}`;
  throw new Error('makeRecordKey: pageId/slug 둘 다 없음');
}

/**
 * Index 구조(경량)
 * {
 *   "version": 2,
 *   "updatedAt": "ISO",
 *   "offsetByKey": { "pid:page000123": 12345, "slug:abc": 67890, ... },
 *   "alias": { "slug:abc": "pid:page000123", ... }
 * }
 */
function loadIndex() {
  try {
    if (!fs.existsSync(INDEX_FILE)) {
      return {
        version: 2,
        updatedAt: null,
        offsetByKey: {},
        alias: {}
      };
    }
    const raw = fs.readFileSync(INDEX_FILE, 'utf8');
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object') throw new Error('bad index json');
    if (!json.offsetByKey || typeof json.offsetByKey !== 'object') json.offsetByKey = {};
    if (!json.alias || typeof json.alias !== 'object') json.alias = {};
    json.version = 2;
    return json;
  } catch {
    // 인덱스가 깨졌으면 재구축 유도(안전)
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

    // 적당한 버퍼로 개행까지 읽기(대부분 레코드 1~2KB 수준 예상)
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
 */
function rebuildIndex() {
  ensureDir(LOGS_DIR);

  const index = {
    version: 2,
    updatedAt: nowIso(),
    offsetByKey: {},
    alias: {}
  };

  if (!fs.existsSync(LEDGER_FILE)) {
    // ledger가 없으면 빈 인덱스로 생성
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

      // parts는 완전한 라인들
      let localOff = offset - Buffer.byteLength(carry, 'utf8'); // 대충이지만 여기서는 “정확 offset”이 필요함
      // 위 계산이 정확하지 않아도 되도록, 아래에서 "라인 시작 offset"을 직접 추적
      // => 안전하게 다시 구현: 텍스트를 순회하며 개행 기준으로 offset을 갱신
      // (가독성 위해 별도 루프)
      let byteCursor = offset;
      for (let i = 0; i < parts.length; i++) {
        const line = parts[i].trim();
        const lineBytes = Buffer.byteLength(parts[i] + '\n', 'utf8');
        if (line) {
          try {
            const obj = JSON.parse(line);
            if (obj && typeof obj === 'object' && typeof obj.recordKey === 'string') {
              index.offsetByKey[obj.recordKey] = byteCursor;
              // alias가 같이 기록되어 있으면 흡수
              if (obj && obj.alias && typeof obj.alias === 'object') {
                Object.assign(index.alias, obj.alias);
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
        if (obj && typeof obj === 'object' && typeof obj.recordKey === 'string') {
          // 마지막 줄 시작 offset은 stat.size - bytes(last+'\n') 이지만 마지막 줄은 \n 없을 수 있음
          // 대략 정확도를 위해 다시 탐색하지 않고 stat.size - bytes(last) 사용
          const approxOff = Math.max(0, stat.size - Buffer.byteLength(last, 'utf8'));
          index.offsetByKey[obj.recordKey] = approxOff;
          if (obj.alias && typeof obj.alias === 'object') Object.assign(index.alias, obj.alias);
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
 */
function upsert(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('upsert: patch object 필요');

  const slug = safeStr(patch.slug).trim();
  const pageId = safeStr(patch.pageId).trim();

  // 기본 recordKey
  const rk = makeRecordKey({ pageId, slug });

  // 인덱스 로드
  const index = loadIndex();

  // alias 처리: slugKey가 pidKey로 승격되면 slugKey를 pidKey로 연결
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
    seedId: patch.seedId || base.seedId || '',
    source: patch.source || base.source || '',

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

  // slugKey 자체도 “현재 레코드 위치”로 매핑해두면,
  // pid를 몰라도 slug로 즉시 찾을 수 있음(alias가 깨져도 탐색 가능)
  if (slugKey) {
    index.offsetByKey[slugKey] = off;
    // slugKey는 pidKey로 alias(있으면) 유지
    if (rk.startsWith('pid:')) index.alias[slugKey] = rk;
  }

  saveIndex(index);

  return { ledgerFile: LEDGER_FILE, indexFile: INDEX_FILE, recordKey: rk, offset: off };
}

module.exports = {
  upsert,
  makeRecordKey,
  rebuildIndex,
  _paths: { ROOT, LOGS_DIR, LEDGER_FILE, INDEX_FILE }
};
