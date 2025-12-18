#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/ids.cjs
 *
 * 목적:
 * - content/posts/*.json 중 pageId 없는 문서들에 pageId를 "발급(=할당)"하여 기록
 *
 * 핵심 규칙(옹스 룰):
 * - PUBLISH_MODE=disable 인 경우: "일시정지(PAUSE)" → 발급(+1) 금지, 기존 이력/카운터 보존(리셋 절대 금지)
 * - BODY_WRITE_MODE=local 인 경우: 로컬 전용 pageId 카운터로 +1 허용 (실발행과 분리)
 * - BODY_WRITE_MODE=active 인 경우: PUBLISH_MODE=enable 일 때만 +1 허용 (disable이면 발급 자체가 0회)
 *
 * 출력:
 * - manifests/page-ids.json (active)
 * - manifests/page-ids.local.json (local)
 * - manifests/pageid-journal.jsonl (WAL, mode 기록)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const MANIFESTS_DIR = path.join(ROOT, 'manifests');

const PUBLISH_MODE = (process.env.PUBLISH_MODE || 'disable').toLowerCase(); // enable|disable
const BODY_WRITE_MODE = (process.env.BODY_WRITE_MODE || 'local').toLowerCase(); // local|active

const { ensureDir, isValidPageId, ensurePageId, loadLedgerInfo } = require('./lib/page-ids.cjs');

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[ids] ROOT          =', ROOT);
  console.log('[ids] POSTS_DIR     =', POSTS_DIR);
  console.log('[ids] MANIFESTS_DIR =', MANIFESTS_DIR);
  console.log('[ids] PUBLISH_MODE  =', PUBLISH_MODE);
  console.log('[ids] BODY_WRITE_MODE =', BODY_WRITE_MODE);

  ensureDir(MANIFESTS_DIR);

  // ✅ PAUSE: disable이면 "발급 0회"로 즉시 종료 (리셋/수정 없음)
  if (PUBLISH_MODE !== 'enable' && BODY_WRITE_MODE === 'active') {
    console.log('[ids] PAUSE: PUBLISH_MODE=disable 이므로 active 발급(+1) 금지 → 종료 (이력 보존)');
    return;
  }

  if (!fs.existsSync(POSTS_DIR)) {
    console.log('[ids] POSTS_DIR 없음 → 종료');
    return;
  }

  const files = fs.readdirSync(POSTS_DIR).filter(f => f.toLowerCase().endsWith('.json')).sort();
  console.log('[ids] 대상 JSON 수 =', files.length);

  let assigned = 0;
  let skipped = 0;
  let failed = 0;

  const ledgerInfo = loadLedgerInfo(); // 어떤 ledger를 쓰는지 로깅용
  console.log('[ids] LEDGER_FILE =', ledgerInfo.ledgerFile);

  for (const f of files) {
    const p = path.join(POSTS_DIR, f);
    const doc = readJsonSafe(p, null);
    if (!doc || typeof doc !== 'object') {
      failed++;
      console.error('[ids][FAIL] JSON 파싱 실패:', f);
      continue;
    }

    const slug = doc.slug || path.basename(f, '.json');

    // 이미 있으면 스킵
    if (isValidPageId(doc.pageId)) {
      skipped++;
      continue;
    }

    // 발급/할당
    try {
      const pid = ensurePageId(slug);
      if (!isValidPageId(pid)) throw new Error('ensurePageId()가 유효한 pageId를 반환하지 않음');

      doc.pageId = pid;
      writeJson(p, doc);
      assigned++;

      console.log(`[ids][OK] ${slug} → ${pid}`);
    } catch (e) {
      failed++;
      console.error(`[ids][FAIL] ${slug} →`, e.message || e);
    }
  }

  console.log('────────────────────────────────────────────');
  console.log('[ids] 요약');
  console.log('  할당(신규) =', assigned);
  console.log('  SKIP       =', skipped);
  console.log('  FAIL       =', failed);

  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();
