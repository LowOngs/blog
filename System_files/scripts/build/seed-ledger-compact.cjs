#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/seed-ledger-compact.cjs
 *
 * Seed Ledger Yearly Compaction (v1)
 * - 대상: System_files/logs/seed-ledger.jsonl
 * - 동작:
 *   1) ledger를 읽어서 recordKey 기준으로 마지막 레코드만 남김(중복 제거)
 *   2) updatedAt 기준으로 정렬 후 ledger를 "재작성"(용량 정리/일관성)
 *   3) 백업 파일 생성
 *   4) seed-ledger-query.cjs --rebuild-index 호출(인덱스 재생성)
 *
 * 옵션:
 *   --dry-run              : 실제 파일 수정 없이 요약만 출력
 *   --no-rebuild-index     : compaction 후 인덱스 재생성 생략
 *   --backup-suffix <str>  : 백업 파일 접미사(기본: ISO 타임스탬프)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const LOGS_DIR = path.join(ROOT, 'logs');
const LEDGER_FILE = path.join(LOGS_DIR, 'seed-ledger.jsonl');

function argHas(flag) {
  return process.argv.includes(flag);
}
function argValue(flag, def = '') {
  const i = process.argv.indexOf(flag);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : def;
}

const DRY_RUN = argHas('--dry-run');
const NO_REBUILD = argHas('--no-rebuild-index');
const BACKUP_SUFFIX = argValue('--backup-suffix', new Date().toISOString().replace(/[:.]/g, '-'));

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function safeParseJson(line) {
  try {
    const obj = JSON.parse(line);
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.recordKey !== 'string' || !obj.recordKey.trim()) return null;
    return obj;
  } catch {
    return null;
  }
}

function parseTime(s) {
  const t = Date.parse(s || '');
  return Number.isNaN(t) ? 0 : t;
}

async function loadLedgerToMap(filePath) {
  const map = new Map(); // recordKey -> record
  let totalLines = 0;
  let okLines = 0;
  let badLines = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const s = String(line || '').trim();
    if (!s) continue;
    totalLines++;
    const obj = safeParseJson(s);
    if (!obj) {
      badLines++;
      continue;
    }
    okLines++;
    // 같은 recordKey면 "마지막 레코드"가 이김
    map.set(obj.recordKey, obj);
  }

  return { map, totalLines, okLines, badLines };
}

function mapToSortedArray(map) {
  const arr = Array.from(map.values());
  // 가독성/일관성: updatedAt asc (없으면 뒤로)
  arr.sort((a, b) => parseTime(a.updatedAt) - parseTime(b.updatedAt));
  return arr;
}

function writeAtomic(targetPath, content) {
  const dir = path.dirname(targetPath);
  ensureDir(dir);
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, targetPath);
}

function fmtBytes(n) {
  if (!n || n <= 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 1 : 2)}${units[i]}`;
}

function rebuildIndex() {
  const queryScript = path.join(ROOT, 'scripts', 'build', 'seed-ledger-query.cjs');
  if (!fs.existsSync(queryScript)) {
    console.log('[compact][WARN] seed-ledger-query.cjs 없음 → 인덱스 재생성 스킵:', queryScript);
    return { ok: false, reason: 'query script missing' };
  }

  const r = spawnSync(process.execPath, [queryScript, '--rebuild-index'], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  if (r.status === 0) return { ok: true };
  return { ok: false, reason: `exit=${r.status}` };
}

async function main() {
  console.log('────────────────────────────────────────────');
  console.log('[compact] ROOT       =', ROOT);
  console.log('[compact] LEDGER     =', LEDGER_FILE);
  console.log('[compact] DRY_RUN    =', DRY_RUN);
  console.log('[compact] REBUILD    =', NO_REBUILD ? 'false' : 'true');
  console.log('[compact] BACKUP_TAG =', BACKUP_SUFFIX);

  if (!fs.existsSync(LEDGER_FILE)) {
    console.log('[compact] ledger 없음 → 종료');
    return;
  }

  const beforeBytes = fs.statSync(LEDGER_FILE).size;

  const { map, totalLines, okLines, badLines } = await loadLedgerToMap(LEDGER_FILE);
  const uniqueKeys = map.size;
  const arr = mapToSortedArray(map);

  const afterContent = arr.map((o) => JSON.stringify(o)).join('\n') + '\n';
  const afterBytes = Buffer.byteLength(afterContent, 'utf8');

  console.log('────────────────────────────────────────────');
  console.log('[compact] 요약(계산)');
  console.log('  lines(total)  =', totalLines);
  console.log('  lines(ok)     =', okLines);
  console.log('  lines(bad)    =', badLines);
  console.log('  unique(keys)  =', uniqueKeys);
  console.log('  bytes(before) =', fmtBytes(beforeBytes));
  console.log('  bytes(after)  =', fmtBytes(afterBytes));
  console.log('  delta         =', fmtBytes(beforeBytes - afterBytes));

  if (DRY_RUN) {
    console.log('[compact] --dry-run 이므로 파일 변경 없음');
    return;
  }

  // 백업
  ensureDir(LOGS_DIR);
  const backupFile = path.join(LOGS_DIR, `seed-ledger.backup.${BACKUP_SUFFIX}.jsonl`);
  fs.copyFileSync(LEDGER_FILE, backupFile);
  console.log('[compact] backup saved →', backupFile);

  // 재작성(원자적)
  writeAtomic(LEDGER_FILE, afterContent);
  console.log('[compact] ledger compacted →', LEDGER_FILE);

  // 인덱스 재생성(권장)
  if (!NO_REBUILD) {
    console.log('────────────────────────────────────────────');
    console.log('[compact] rebuild index...');
    const rr = rebuildIndex();
    if (!rr.ok) {
      console.log('[compact][WARN] index rebuild failed:', rr.reason || 'unknown');
    } else {
      console.log('[compact] index rebuilt OK');
    }
  }

  console.log('────────────────────────────────────────────');
  console.log('[compact] Done');
}

main().catch((e) => {
  console.error('[compact][FAIL]', e && (e.stack || e.message || e));
  process.exit(1);
});
