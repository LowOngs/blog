// System_files/scripts/build/ids.cjs
// content/posts/*.json 에 pageId가 없으면 자동 발급해 채워넣음 (no_live / live)
// + WAL(저널) 기록: manifests/pageid-journal.jsonl

'use strict';

const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');

const { createAllocator, normalizeMode } = require('./lib/page-ids.cjs');

function log(...a) {
  console.log('[ids]', ...a);
}

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

// WAL journal (append-only)
const MANIFESTS_DIR = path.join(ROOT, 'manifests');
const JOURNAL_FILE = path.join(MANIFESTS_DIR, 'pageid-journal.jsonl');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function isValidPageId(v) {
  return typeof v === 'string' && /^page\d{6}$/.test(v);
}

function getEffectiveMode() {
  // ✅ DRY_RUN과 분리: PAGE_ID_MODE가 곧 정답 (미설정이면 안전하게 no_live)
  const rawMode = (process.env.PAGE_ID_MODE || 'no_live').trim();
  return normalizeMode(rawMode);
}

function appendJournal({ ts, mode, slug, pageId, op, file }) {
  ensureDir(MANIFESTS_DIR);
  const rec = {
    ts: ts || new Date().toISOString(),
    op: op || 'assign',
    mode: mode || '',
    slug: slug || '',
    pageId: pageId || '',
    file: file || ''
  };
  try {
    fs.appendFileSync(JOURNAL_FILE, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {
    // 저널 실패는 치명적이진 않지만, 반드시 로그로 남긴다.
    log('[WARN] journal append failed:', e.message || e);
  }
}

(async function main() {
  ensureDir(MANIFESTS_DIR);

  if (!fs.existsSync(POSTS_DIR)) {
    log('POSTS_DIR 없음 → 건너뜀:', POSTS_DIR);
    process.exit(0);
  }

  const mode = getEffectiveMode();
  const allocator = createAllocator(ROOT, mode);

  const files = fg.sync('*.json', { cwd: POSTS_DIR }).sort();
  if (!files.length) {
    log('대상 포스트 JSON 없음');
    process.exit(0);
  }

  let touched = 0;
  let kept = 0;
  let failed = 0;

  for (const name of files) {
    const full = path.join(POSTS_DIR, name);

    let doc;
    try {
      doc = readJson(full);
    } catch (e) {
      log('JSON 파싱 실패:', name, e.message || e);
      failed++;
      continue;
    }

    const slug = doc.slug || name.replace(/\.json$/i, '');
    if (!doc.slug) doc.slug = slug;

    // 이미 정상 pageId가 있으면 유지(저널 기록은 optional이라 안함)
    if (isValidPageId(doc.pageId)) {
      kept++;
      continue;
    }

    // ✅ 발급 (권한은 ids에만 있음)
    let pid = '';
    try {
      pid = allocator.assign(slug);
    } catch (e) {
      log('[FAIL] allocator.assign 실패:', name, e.message || e);
      failed++;
      continue;
    }

    doc.pageId = pid;

    try {
      writeJson(full, doc);
      touched++;
      log('SET', name, '→', pid);

      // ✅ WAL 기록(append-only)
      appendJournal({
        ts: new Date().toISOString(),
        mode,
        slug,
        pageId: pid,
        op: 'assign',
        file: name
      });
    } catch (e) {
      log('[FAIL] JSON write 실패:', name, e.message || e);
      failed++;
    }
  }

  const s = allocator.getStateSummary();
  log('mode =', mode);
  log('ledger =', s.file);
  log('liveBaseline =', s.liveBaseline);
  log('lastIssued =', s.lastIssued, '| lastCommitted =', s.lastCommitted);
  log('journal =', JOURNAL_FILE);
  log('updated posts =', touched, '| kept =', kept, '| failed =', failed);

  // ids는 생명: 실패가 있으면 exitCode=1로 남겨 워크플로가 재시도/중단 판단 가능
  if (failed > 0) process.exitCode = 1;
})().catch((e) => {
  console.error('[ids][FAIL]', e.message || e);
  process.exit(1);
});
