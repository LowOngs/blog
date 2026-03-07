#!/usr/bin/env node
'use strict';

/**
 * ============================================================
 * System_files/scripts/build/lib/fp-cache.cjs
 * ============================================================
 *
 * 역할:
 * - fingerprint 전용 cache 계층
 * - "used" / "map" 2종 cache를 그룹 파일로 분리 저장
 *
 * 목적:
 * 1) 빠른 중복 확인
 *    - "이 fingerprint가 이미 사용되었는가?"
 * 2) 빠른 역추적
 *    - "이 fingerprint는 어떤 recordKey / label / mode / offset 인가?"
 *
 * 설계 원칙:
 * - seed-ledger.jsonl (원장)은 그대로 유지
 * - fingerprint 관련 빠른 조회만 이 cache 계층으로 분리
 * - 한 파일에 몰아넣지 않고 그룹 파일로 분산 저장
 * - append-only 원장이 아니라 cache이므로 "최신 상태 기준 덮어쓰기" 허용
 * - atomic write 사용
 *
 * 파일 구조:
 * System_files/logs/fp-cache/
 *   ├─ used/
 *   │   ├─ ab.json
 *   │   ├─ c1.json
 *   │   └─ ...
 *   └─ map/
 *       ├─ ab.json
 *       ├─ c1.json
 *       └─ ...
 *
 * 그룹 규칙:
 * - fingerprint 문자열에서 "fp1:" 접두 제거 후
 * - 해시 hex 앞 2글자를 group key로 사용
 * - 예: fp1:ab1234... -> group = "ab"
 *
 * used 파일 형식:
 * {
 *   "fp1:ab1234...": true,
 *   "fp1:ab9999...": true
 * }
 *
 * map 파일 형식:
 * {
 *   "fp1:ab1234...": {
 *     "recordKey": "seed:ht-tr-002",
 *     "label": "how-to-playbooks",
 *     "mode": "trend",
 *     "seedId": "ht-tr-002",
 *     "usedAt": "2026-03-04T13:26:59.870Z",
 *     "offset": 12345
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..'); // System_files
const LOGS_DIR = path.join(ROOT, 'logs');

const FP_CACHE_DIR = path.join(LOGS_DIR, 'fp-cache');
const USED_DIR = path.join(FP_CACHE_DIR, 'used');
const MAP_DIR = path.join(FP_CACHE_DIR, 'map');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeStr(v) {
  return typeof v === 'string' ? v : '';
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeFingerprint(v) {
  const s = safeStr(v).trim();
  if (!s) return '';
  return s;
}

function normalizeMode(v) {
  const s = safeStr(v).trim().toLowerCase();
  if (!s) return '';
  return s;
}

function safeIsoOrNow(v) {
  const s = safeStr(v).trim();
  const t = Date.parse(s);
  return Number.isNaN(t) ? nowIso() : s;
}

function readJsonSafe(filePath, fallbackObj) {
  if (!fs.existsSync(filePath)) return fallbackObj;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallbackObj;
  }
}

function writeJsonAtomic(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * fingerprint -> group key
 *
 * 규칙:
 * - "fp1:" 같은 버전 prefix 제거
 * - 나머지 문자열 앞 2글자를 사용
 * - 부족/비정상 시 "__"
 */
function getGroupKey(fingerprint) {
  const fp = normalizeFingerprint(fingerprint);
  if (!fp) return '__';

  const body = fp.includes(':')
    ? fp.slice(fp.indexOf(':') + 1)
    : fp;

  const key = body.slice(0, 2).toLowerCase();

  if (!/^[0-9a-z]{2}$/.test(key)) return '__';
  return key;
}

function usedFilePathByFingerprint(fingerprint) {
  const group = getGroupKey(fingerprint);
  return path.join(USED_DIR, `${group}.json`);
}

function mapFilePathByFingerprint(fingerprint) {
  const group = getGroupKey(fingerprint);
  return path.join(MAP_DIR, `${group}.json`);
}

function ensureBaseDirs() {
  ensureDir(LOGS_DIR);
  ensureDir(FP_CACHE_DIR);
  ensureDir(USED_DIR);
  ensureDir(MAP_DIR);
}

/**
 * used cache 읽기
 */
function loadUsedGroupByFingerprint(fingerprint) {
  ensureBaseDirs();
  const file = usedFilePathByFingerprint(fingerprint);
  const json = readJsonSafe(file, {});
  return (json && typeof json === 'object') ? json : {};
}

/**
 * map cache 읽기
 */
function loadMapGroupByFingerprint(fingerprint) {
  ensureBaseDirs();
  const file = mapFilePathByFingerprint(fingerprint);
  const json = readJsonSafe(file, {});
  return (json && typeof json === 'object') ? json : {};
}

/**
 * used cache 저장
 */
function saveUsedGroupByFingerprint(fingerprint, obj) {
  ensureBaseDirs();
  const file = usedFilePathByFingerprint(fingerprint);
  writeJsonAtomic(file, obj);
}

/**
 * map cache 저장
 */
function saveMapGroupByFingerprint(fingerprint, obj) {
  ensureBaseDirs();
  const file = mapFilePathByFingerprint(fingerprint);
  writeJsonAtomic(file, obj);
}

/**
 * fingerprint 사용 여부 확인
 */
function hasUsedFingerprint(fingerprint) {
  const fp = normalizeFingerprint(fingerprint);
  if (!fp) return false;

  const group = loadUsedGroupByFingerprint(fp);
  return group[fp] === true;
}

/**
 * used cache 기록
 * - 값은 true 고정
 */
function markUsedFingerprint(fingerprint) {
  const fp = normalizeFingerprint(fingerprint);
  if (!fp) throw new Error('markUsedFingerprint: fingerprint missing');

  const group = loadUsedGroupByFingerprint(fp);
  group[fp] = true;
  saveUsedGroupByFingerprint(fp, group);

  return {
    fingerprint: fp,
    file: usedFilePathByFingerprint(fp),
    group: getGroupKey(fp),
  };
}

/**
 * map cache 조회
 */
function getFingerprintMap(fingerprint) {
  const fp = normalizeFingerprint(fingerprint);
  if (!fp) return null;

  const group = loadMapGroupByFingerprint(fp);
  const row = group[fp];

  if (!row || typeof row !== 'object') return null;
  return row;
}

/**
 * map cache 기록
 */
function setFingerprintMap({
  fingerprint,
  recordKey = '',
  label = '',
  mode = '',
  seedId = '',
  usedAt = '',
  offset = null,
}) {
  const fp = normalizeFingerprint(fingerprint);
  if (!fp) throw new Error('setFingerprintMap: fingerprint missing');

  const group = loadMapGroupByFingerprint(fp);

  group[fp] = {
    recordKey: safeStr(recordKey).trim(),
    label: safeStr(label).trim(),
    mode: normalizeMode(mode),
    seedId: safeStr(seedId).trim(),
    usedAt: usedAt ? safeIsoOrNow(usedAt) : nowIso(),
    offset: typeof offset === 'number' ? offset : null,
  };

  saveMapGroupByFingerprint(fp, group);

  return {
    fingerprint: fp,
    file: mapFilePathByFingerprint(fp),
    group: getGroupKey(fp),
    value: group[fp],
  };
}

/**
 * used + map 동시 기록
 */
function markUsedAndMap({
  fingerprint,
  recordKey = '',
  label = '',
  mode = '',
  seedId = '',
  usedAt = '',
  offset = null,
}) {
  const fp = normalizeFingerprint(fingerprint);
  if (!fp) throw new Error('markUsedAndMap: fingerprint missing');

  const used = markUsedFingerprint(fp);
  const map = setFingerprintMap({
    fingerprint: fp,
    recordKey,
    label,
    mode,
    seedId,
    usedAt,
    offset,
  });

  return { used, map };
}

module.exports = {
  hasUsedFingerprint,
  markUsedFingerprint,
  getFingerprintMap,
  setFingerprintMap,
  markUsedAndMap,
  getGroupKey,
  usedFilePathByFingerprint,
  mapFilePathByFingerprint,
  _paths: {
    ROOT,
    LOGS_DIR,
    FP_CACHE_DIR,
    USED_DIR,
    MAP_DIR,
  },
};
