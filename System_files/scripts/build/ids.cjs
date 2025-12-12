// System_files/scripts/build/ids.cjs
// content/posts/*.json 에 pageId가 없으면 자동 발급해 채워넣음 (no_live / live)

const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');

const { createAllocator, normalizeMode } = require('./lib/page-ids.cjs');

function log(...a) {
  console.log('[ids]', ...a);
}

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

function envBool(name, fallback = false) {
  const v = (process.env[name] || '').trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function getEffectiveMode() {
  // 강력 가드: DRY_RUN=true면 무조건 no_live
  const dryRun = envBool('DRY_RUN', false);
  const rawMode = (process.env.PAGE_ID_MODE || 'no_live').trim();
  const mode = normalizeMode(rawMode);
  return dryRun ? 'no_live' : mode;
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

(async function main() {
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

  for (const name of files) {
    const full = path.join(POSTS_DIR, name);

    let doc;
    try {
      doc = readJson(full);
    } catch (e) {
      log('JSON 파싱 실패:', name, e.message || e);
      continue;
    }

    const slug = doc.slug || name.replace(/\.json$/i, '');
    if (!doc.slug) doc.slug = slug;

    if (doc.pageId && typeof doc.pageId === 'string' && doc.pageId.startsWith('page')) {
      kept++;
      continue;
    }

    const pid = allocator.assign(slug);
    doc.pageId = pid;

    writeJson(full, doc);
    touched++;
    log('SET', name, '→', pid);
  }

  const s = allocator.getStateSummary();
  log('mode =', mode);
  log('ledger =', s.file);
  log('liveBaseline =', s.liveBaseline);
  log('lastIssued =', s.lastIssued, '| lastCommitted =', s.lastCommitted);
  log('updated posts =', touched, '| kept =', kept);
})().catch((e) => {
  console.error('[ids][FAIL]', e.message || e);
  process.exit(1);
});
