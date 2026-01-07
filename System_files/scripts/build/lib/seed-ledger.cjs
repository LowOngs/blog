
'use strict';

/**
 * System_files/scripts/build/lib/seed-ledger.cjs
 *
 * Seed Ledger (Minimal v1)
 * - SSOT: System_files/logs/seed-ledger.jsonl
 * - recordKey 기준으로 "멱등 upsert" (같은 키면 덮어쓰기 병합)
 *
 * 목적:
 * - pageId ↔ seedId ↔ slug ↔ label ↔ source ↔ status 를 1레코드로 장기 추적
 * - ids 단계(발급)와 publish 단계(발행 결과)에서 같은 recordKey로 업데이트
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..'); // System_files
const LOGS_DIR = path.join(ROOT, 'logs');
const LEDGER_FILE = path.join(LOGS_DIR, 'seed-ledger.jsonl');

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
 * recordKey 규칙 (고정)
 * - pageId가 있으면 pageId 기반으로 고정(추천)
 * - 없으면 slug 기반(임시) — 이후 pageId 생기면 같은 slug로도 찾을 수 있게 병합 로직 포함
 */
function makeRecordKey({ pageId, slug }) {
  const s = safeStr(slug).trim();
  const pid = safeStr(pageId).trim();
  if (isValidPageId(pid)) return `pid:${pid}`;
  if (s) return `slug:${s}`;
  throw new Error('makeRecordKey: pageId/slug 둘 다 없음');
}

function readAllLines() {
  if (!fs.existsSync(LEDGER_FILE)) return [];
  const raw = fs.readFileSync(LEDGER_FILE, 'utf8');
  return raw.split('\n').map(s => s.trim()).filter(Boolean);
}

function parseLedgerToMap() {
  const lines = readAllLines();
  const map = new Map(); // recordKey -> record(obj)
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (!obj || typeof obj !== 'object') continue;
      if (!obj.recordKey || typeof obj.recordKey !== 'string') continue;
      map.set(obj.recordKey, obj);
    } catch {
      // 깨진 라인은 무시(장부가 정답, 1줄 손상은 치명X)
    }
  }
  return map;
}

function writeMapToLedger(map) {
  ensureDir(LOGS_DIR);
  const arr = Array.from(map.values());
  // 가독성: updatedAt asc 정렬(없으면 뒤로)
  arr.sort((a, b) => {
    const ta = Date.parse(a.updatedAt || '') || 0;
    const tb = Date.parse(b.updatedAt || '') || 0;
    return ta - tb;
  });
  const out = arr.map(o => JSON.stringify(o)).join('\n') + '\n';
  fs.writeFileSync(LEDGER_FILE, out, 'utf8');
}

/**
 * 업서트(멱등)
 * - 같은 recordKey면 병합
 * - slug 기반 임시 키가 있고, pageId 키로 확정되면 자동 병합(중복 방지)
 */
function upsert(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('upsert: patch object 필요');

  const slug = safeStr(patch.slug).trim();
  const pageId = safeStr(patch.pageId).trim();
  const rk = makeRecordKey({ pageId, slug });

  const map = parseLedgerToMap();

  // slug 임시 키 ↔ pid 확정 키 병합
  // 예: 기존 slug:abc 레코드가 있고 이번에 pid:page000123로 들어오면 slug 레코드를 pid로 승격
  if (rk.startsWith('pid:') && slug) {
    const slugKey = `slug:${slug}`;
    const oldSlugRec = map.get(slugKey);
    const oldPidRec = map.get(rk);

    // pid 레코드가 없고 slug 레코드가 있으면 slug 레코드를 pid 키로 옮김
    if (!oldPidRec && oldSlugRec) {
      map.delete(slugKey);
      oldSlugRec.recordKey = rk;
      oldSlugRec.pageId = pageId;
      oldSlugRec.updatedAt = nowIso();
      map.set(rk, oldSlugRec);
    }
  }

  const existing = map.get(rk) || null;
  const base = existing && typeof existing === 'object' ? existing : {};

  const merged = {
    // 고정 필드
    recordKey: rk,
    slug: slug || base.slug || '',
    pageId: isValidPageId(pageId) ? pageId : (base.pageId || ''),
    label: patch.label || base.label || '',
    seedId: patch.seedId || base.seedId || '',
    source: patch.source || base.source || '',

    // 상태/단계
    status: patch.status || base.status || '',      // assigned | published | failed | ...
    stage: patch.stage || base.stage || '',         // ids | publish | ...
    dryRun: (typeof patch.dryRun === 'boolean') ? patch.dryRun : (base.dryRun || false),

    // publish 결과
    postId: patch.postId || base.postId || '',
    url: patch.url || base.url || '',

    // 타임
    createdAt: base.createdAt || patch.createdAt || nowIso(),
    updatedAt: nowIso(),

    // 기타
    notes: patch.notes || base.notes || '',
  };

  map.set(rk, merged);
  writeMapToLedger(map);

  return { ledgerFile: LEDGER_FILE, recordKey: rk };
}

module.exports = {
  upsert,
  makeRecordKey,
  _paths: { ROOT, LOGS_DIR, LEDGER_FILE }
};
