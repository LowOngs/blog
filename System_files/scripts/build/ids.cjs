// System_files/scripts/build/ids.cjs
// content/posts/*.json 에 pageId가 없으면 자동 발급해 채워넣음 (no_live / live)
// ✅ 강화: ledger 손상/파싱 실패 시 1회 자동 복구(rebuild) 후 재시도
// ✅ 원칙: ids가 실패할 정도면 빌드가 멈추는 게 맞다(중요 키). 다만 1회 복구는 시도.

const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');

const { createAllocator, normalizeMode } = require('./lib/page-ids.cjs');

function log(...a) {
  console.log('[ids]', ...a);
}

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const MANIFESTS_DIR = path.join(ROOT, 'manifests');

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function nowCompact() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function getEffectiveMode() {
  // ✅ DRY_RUN과 분리: PAGE_ID_MODE가 곧 정답 (미설정이면 안전하게 no_live)
  const rawMode = (process.env.PAGE_ID_MODE || 'no_live').trim();
  return normalizeMode(rawMode);
}

function ledgerPathFor(mode) {
  fs.mkdirSync(MANIFESTS_DIR, { recursive: true });
  const livePath = path.join(MANIFESTS_DIR, 'page-ids.json');
  const noLivePath = path.join(MANIFESTS_DIR, 'page-ids.no_live.json');
  return mode === 'live' ? livePath : noLivePath;
}

function parsePageIdNumber(pid) {
  // page000123 -> 123
  const m = String(pid || '').match(/^page(\d{6})$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

function scanMaxPageIdFromPosts() {
  // content/posts/*.json의 pageId 중 최대값을 찾아 baseline으로 삼음
  if (!fs.existsSync(POSTS_DIR)) return 0;

  const files = fg.sync('*.json', { cwd: POSTS_DIR }).sort();
  let maxN = 0;

  for (const name of files) {
    const full = path.join(POSTS_DIR, name);
    const doc = readJsonSafe(full, null);
    if (!doc || typeof doc !== 'object') continue;

    const n = parsePageIdNumber(doc.pageId);
    if (n && n > maxN) maxN = n;
  }
  return maxN;
}

function scanMaxPageIdFromLedgerFile(filePath) {
  const state = readJsonSafe(filePath, null);
  if (!state || typeof state !== 'object') return null; // "손상/없음" 의미
  const lastCommitted = Number.isInteger(state.lastCommitted) ? state.lastCommitted : 0;
  const lastIssued = Number.isInteger(state.lastIssued) ? state.lastIssued : 0;
  return Math.max(lastCommitted, lastIssued, 0);
}

function backupCorruptLedger(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    // JSON 파싱 안 된다고 가정하더라도 원본 보존
    const bak = `${filePath}.corrupt.${nowCompact()}.bak`;
    fs.writeFileSync(bak, raw, 'utf8');
    log('ledger 백업(손상 추정):', path.basename(bak));
  } catch (e) {
    log('ledger 백업 실패(무시):', e.message || e);
  }
}

function rebuildLedger(mode) {
  // ✅ “새 발급”이 아니라 “기준점 복구”용
  // - live: lastCommitted = (posts + live ledger 중 최대)로 복구
  // - no_live: liveBaseline을 기준으로 lastIssued/lastCommitted를 liveBaseline으로 맞춤
  fs.mkdirSync(MANIFESTS_DIR, { recursive: true });

  const livePath = ledgerPathFor('live');
  const noLivePath = ledgerPathFor('no_live');

  // liveBaseline 계산(가능한 신뢰 순서):
  // 1) live ledger(정상 파싱 되는 경우)
  // 2) posts 스캔
  // 3) 0
  const liveFromLedger = scanMaxPageIdFromLedgerFile(livePath);
  const liveFromPosts = scanMaxPageIdFromPosts();
  const liveBaseline = Math.max(liveFromLedger || 0, liveFromPosts || 0, 0);

  const target = ledgerPathFor(mode);

  // 손상 의심이면 백업
  backupCorruptLedger(target);

  const rebuilt = {
    mode,
    lastIssued: liveBaseline,
    lastCommitted: liveBaseline,
    issued: {},
    updatedAt: new Date().toISOString(),
    rebuiltAt: new Date().toISOString(),
    rebuiltFrom: {
      liveFromLedger: liveFromLedger || 0,
      liveFromPosts: liveFromPosts || 0,
      liveBaseline
    }
  };

  // no_live는 live와 “겹치면 안 됨”이라 baseline만 복구하면 됨(issued는 빈 상태로 시작)
  // live도 issued를 0부터 다시 복구할 필요는 없음(핵심은 기준점)
  fs.writeFileSync(target, JSON.stringify(rebuilt, null, 2) + '\n', 'utf8');
  log('ledger 복구 완료:', path.basename(target), 'baseline=', liveBaseline);

  // (선택) no_live 모드 복구 시 live ledger도 손상되어 있을 가능성 대비:
  // livePath가 파싱 불가면 live도 최소 baseline으로 정리해둔다(단, mode가 live일 때만)
  if (mode === 'live') return;

  // no_live 복구인데 live ledger가 손상(null)이라면 live도 최소 복구
  if (liveFromLedger === null) {
    backupCorruptLedger(livePath);
    const liveRebuilt = {
      mode: 'live',
      lastIssued: liveBaseline,
      lastCommitted: liveBaseline,
      issued: {},
      updatedAt: new Date().toISOString(),
      rebuiltAt: new Date().toISOString(),
      rebuiltFrom: {
        liveFromLedger: 0,
        liveFromPosts: liveFromPosts || 0,
        liveBaseline
      }
    };
    fs.writeFileSync(livePath, JSON.stringify(liveRebuilt, null, 2) + '\n', 'utf8');
    log('live ledger도 최소 복구:', path.basename(livePath), 'baseline=', liveBaseline);
  }
}

function isLedgerHealthy(mode) {
  const file = ledgerPathFor(mode);
  const raw = readJsonSafe(file, null);
  if (!raw || typeof raw !== 'object') return false;
  if (!Number.isInteger(raw.lastIssued)) return false;
  if (!Number.isInteger(raw.lastCommitted)) return false;
  if (!raw.issued || typeof raw.issued !== 'object') return false;
  return true;
}

async function main() {
  if (!fs.existsSync(POSTS_DIR)) {
    log('POSTS_DIR 없음 → 건너뜀:', POSTS_DIR);
    process.exit(0);
  }

  const mode = getEffectiveMode();

  // ✅ ledger 보험: 손상 감지 시 1회 복구
  if (!isLedgerHealthy(mode)) {
    log('ledger 상태 비정상 감지 → 1회 복구 시도:', path.basename(ledgerPathFor(mode)));
    rebuildLedger(mode);
    if (!isLedgerHealthy(mode)) {
      throw new Error(`ledger 복구 실패: ${path.basename(ledgerPathFor(mode))}`);
    }
  }

  // allocator 생성(이 시점에서 ledger는 정상이어야 함)
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
      failed += 1;
      log('JSON 파싱 실패:', name, e.message || e);
      continue;
    }

    const slug = doc.slug || name.replace(/\.json$/i, '');
    if (!doc.slug) doc.slug = slug;

    if (doc.pageId && typeof doc.pageId === 'string' && /^page\d{6}$/.test(doc.pageId)) {
      kept++;
      continue;
    }

    try {
      const pid = allocator.assign(slug);
      doc.pageId = pid;
      writeJson(full, doc);
      touched++;
      log('SET', name, '→', pid);
    } catch (e) {
      failed += 1;
      log('ASSIGN FAIL', name, '→', e.message || e);
    }
  }

  const s = allocator.getStateSummary();
  log('mode =', mode);
  log('ledger =', s.file);
  log('liveBaseline =', s.liveBaseline);
  log('lastIssued =', s.lastIssued, '| lastCommitted =', s.lastCommitted);
  log('updated posts =', touched, '| kept =', kept, '| failed =', failed);

  if (failed > 0) {
    // ✅ pageId는 생명이라서, 실패가 있으면 성공으로 간주하면 안 됩니다.
    throw new Error(`ids 처리 중 실패 ${failed}건 발생`);
  }
}

main().catch((e) => {
  console.error('[ids][FAIL]', e.message || e);
  process.exit(1);
});
