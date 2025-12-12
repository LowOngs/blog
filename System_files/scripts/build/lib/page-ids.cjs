// System_files/scripts/build/lib/page-ids.cjs
// page id ledger (no_live / live)

const fs = require('fs');
const path = require('path');

function pad6(n) {
  return String(n).padStart(6, '0');
}

function formatPageId(n) {
  return `page${pad6(n)}`;
}

function nowISO() {
  return new Date().toISOString();
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

function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function normalizeMode(mode) {
  return (mode === 'live') ? 'live' : 'no_live';
}

function ledgerPathForMode(root, mode) {
  const manifestsDir = path.join(root, 'manifests');
  const livePath = path.join(manifestsDir, 'page-ids.json');
  const noLivePath = path.join(manifestsDir, 'page-ids.no_live.json');
  return mode === 'live' ? livePath : noLivePath;
}

function loadState(root, mode) {
  const m = normalizeMode(mode);
  const file = ledgerPathForMode(root, m);

  const state = readJsonSafe(file, null);
  if (state && typeof state === 'object') {
    if (!state.issued || typeof state.issued !== 'object') state.issued = {};
    if (!Number.isInteger(state.lastIssued)) state.lastIssued = 0;
    if (!Number.isInteger(state.lastCommitted)) state.lastCommitted = state.lastIssued;
    if (typeof state.mode !== 'string') state.mode = m;
    if (typeof state.updatedAt !== 'string') state.updatedAt = nowISO();
    return { file, mode: m, state };
  }

  return {
    file,
    mode: m,
    state: {
      mode: m,
      lastIssued: 0,
      lastCommitted: 0, // live 기준 “영구 기준점”
      issued: {},
      updatedAt: nowISO()
    }
  };
}

function saveState(ctx) {
  ctx.state.updatedAt = nowISO();
  atomicWriteJson(ctx.file, ctx.state);
}

function loadLiveBaseline(root) {
  const file = ledgerPathForMode(root, 'live');
  const s = readJsonSafe(file, null);
  const lastCommitted = s && Number.isInteger(s.lastCommitted) ? s.lastCommitted : 0;
  return lastCommitted;
}

// 핵심 규칙:
// - live: lastCommitted 기준으로 +1, 영구 저장
// - no_live: live의 lastCommitted 보다 큰 값만 사용(겹침 금지), no_live 파일에만 저장
function createAllocator(root, mode) {
  const m = normalizeMode(mode);
  const liveBaseline = loadLiveBaseline(root);

  const ctx = loadState(root, m);

  // 안전 가드: 어떤 모드든 liveBaseline 이하로는 절대 내려가지 않음
  if (ctx.state.lastIssued < liveBaseline) ctx.state.lastIssued = liveBaseline;
  if (ctx.state.lastCommitted < liveBaseline) ctx.state.lastCommitted = liveBaseline;

  function getExisting(slug) {
    return ctx.state.issued[slug] || null;
  }

  function allocateNextNumber() {
    const next = ctx.state.lastIssued + 1;
    // liveBaseline 이하 금지
    const safeNext = next <= liveBaseline ? (liveBaseline + 1) : next;
    ctx.state.lastIssued = safeNext;
    return safeNext;
  }

  function assign(slug) {
    if (!slug) throw new Error('slug is required');

    const exist = getExisting(slug);
    if (exist) return exist;

    const n = allocateNextNumber();
    const pid = formatPageId(n);
    ctx.state.issued[slug] = pid;

    if (m === 'live') {
      // live에서만 영구 커밋 기준점 갱신
      if (n > ctx.state.lastCommitted) ctx.state.lastCommitted = n;
    }

    // 두 모드 모두 파일에 기록(단, no_live는 no_live 파일에만)
    saveState(ctx);
    return pid;
  }

  function getStateSummary() {
    return {
      mode: m,
      file: ctx.file,
      liveBaseline,
      lastIssued: ctx.state.lastIssued,
      lastCommitted: ctx.state.lastCommitted,
      issuedCount: Object.keys(ctx.state.issued || {}).length
    };
  }

  return { assign, getExisting, getStateSummary };
}

module.exports = {
  createAllocator,
  formatPageId,
  normalizeMode
};
