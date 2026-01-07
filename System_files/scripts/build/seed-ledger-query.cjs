#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/seed-ledger-query.cjs
 *
 * 목적:
 * - Seed Ledger(append+index)에서 record를 빠르게 조회
 *
 * 사용 예:
 *  node scripts/build/seed-ledger-query.cjs --slug ledger_smoke
 *  node scripts/build/seed-ledger-query.cjs --pageId page000123
 *  node scripts/build/seed-ledger-query.cjs --key pid:page000123
 *  node scripts/build/seed-ledger-query.cjs --stats
 *  node scripts/build/seed-ledger-query.cjs --tail 20
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const LEDGER = require('./lib/seed-ledger.cjs');

const LEDGER_FILE = LEDGER._paths.LEDGER_FILE;
const INDEX_FILE  = LEDGER._paths.INDEX_FILE;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slug') out.slug = argv[++i] || '';
    else if (a === '--pageId') out.pageId = argv[++i] || '';
    else if (a === '--key') out.key = argv[++i] || '';
    else if (a === '--stats') out.stats = true;
    else if (a === '--rebuild-index') out.rebuildIndex = true;
    else if (a === '--tail') out.tail = Number(argv[++i] || '0') || 0;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function help() {
  console.log(`
seed-ledger-query.cjs

조회:
  --slug <slug>         slug로 조회
  --pageId <page000123> pageId로 조회
  --key <recordKey>     recordKey로 조회 (pid:..., slug:...)

유틸:
  --stats               ledger/index 상태 요약
  --tail <N>            ledger 마지막 N줄 출력(진단용)
  --rebuild-index       index 재구축(깨졌을 때만)
`);
}

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function readJsonSafe(p, fallback) {
  try {
    if (!exists(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/**
 * offset에서 한 줄 읽기(JSONL)
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

    try { return JSON.parse(line); } catch { return null; }
  } finally {
    fs.closeSync(fd);
  }
}

function resolveRecordKey({ slug, pageId, key }) {
  if (key) return key.trim();
  if (pageId) return `pid:${pageId.trim()}`;
  if (slug) return `slug:${slug.trim()}`;
  return '';
}

function loadIndex() {
  const idx = readJsonSafe(INDEX_FILE, null);
  if (!idx || typeof idx !== 'object') return null;
  if (!idx.offsetByKey || typeof idx.offsetByKey !== 'object') idx.offsetByKey = {};
  if (!idx.alias || typeof idx.alias !== 'object') idx.alias = {};
  return idx;
}

function getOffsetForKey(idx, rk) {
  if (!idx) return null;
  const aliasTo = idx.alias && idx.alias[rk] ? idx.alias[rk] : null;
  const realKey = aliasTo || rk;
  const off = typeof idx.offsetByKey[realKey] === 'number' ? idx.offsetByKey[realKey] : null;
  if (off === null) return null;
  return { offset: off, resolvedKey: realKey, aliasFrom: aliasTo ? rk : '' };
}

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function tailLines(filePath, n) {
  if (!exists(filePath)) return [];
  const data = fs.readFileSync(filePath, 'utf8').trimEnd();
  if (!data) return [];
  const lines = data.split('\n');
  return lines.slice(Math.max(0, lines.length - n));
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) return help();

  if (args.rebuildIndex) {
    const res = LEDGER.rebuildIndex();
    console.log('[rebuild-index] done');
    printJson({
      ledgerFile: LEDGER_FILE,
      indexFile: INDEX_FILE,
      keys: Object.keys(res.offsetByKey || {}).length,
      aliases: Object.keys(res.alias || {}).length
    });
    return;
  }

  if (args.stats) {
    const idx = loadIndex();
    const stats = {
      root: ROOT,
      ledgerFile: LEDGER_FILE,
      indexFile: INDEX_FILE,
      ledgerExists: exists(LEDGER_FILE),
      indexExists: exists(INDEX_FILE),
      ledgerBytes: fileSize(LEDGER_FILE),
      indexBytes: fileSize(INDEX_FILE),
      indexKeys: idx ? Object.keys(idx.offsetByKey || {}).length : 0,
      indexAliases: idx ? Object.keys(idx.alias || {}).length : 0,
      indexUpdatedAt: idx ? (idx.updatedAt || '') : ''
    };
    printJson(stats);
    return;
  }

  if (args.tail > 0) {
    const lines = tailLines(LEDGER_FILE, args.tail);
    for (const line of lines) console.log(line);
    return;
  }

  const rk = resolveRecordKey(args);
  if (!rk) {
    help();
    process.exitCode = 1;
    return;
  }

  if (!exists(LEDGER_FILE)) {
    console.error('[FAIL] ledger 파일이 없습니다:', LEDGER_FILE);
    process.exitCode = 1;
    return;
  }

  const idx = loadIndex();
  if (!idx) {
    console.error('[WARN] index가 없거나 깨졌습니다. --rebuild-index 를 실행하세요.');
    process.exitCode = 2;
    return;
  }

  const hit = getOffsetForKey(idx, rk);
  if (!hit) {
    console.error('[MISS] not found:', rk);
    process.exitCode = 3;
    return;
  }

  const rec = readLineAtOffset(LEDGER_FILE, hit.offset);
  if (!rec) {
    console.error('[FAIL] offset에서 레코드 읽기 실패:', hit);
    console.error('→ index가 오래되었을 수 있습니다. --rebuild-index 로 재생성하세요.');
    process.exitCode = 4;
    return;
  }

  printJson({
    query: { recordKey: rk },
    resolvedKey: hit.resolvedKey,
    aliasFrom: hit.aliasFrom,
    offset: hit.offset,
    record: rec
  });
}

if (require.main === module) main();
