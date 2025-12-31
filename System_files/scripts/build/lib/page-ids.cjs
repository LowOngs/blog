'use strict';

/**
 * System_files/scripts/build/lib/page-ids.cjs
 *
 * [SSOT] slug → pageId 매핑(ledger) 관리 모듈
 *
 * ─────────────────────────────────────────────
 * AOIA ID 정책(옹스 룰, 최신 정리)
 *
 * 1) BODY_WRITE_MODE=local
 *    - 로컬 테스트/무한 렌더링용 번호.
 *    - PUBLISH_MODE / DRY_RUN 과 무관하게 +1(발급) 허용.
 *    - 실발행과 분리 (로컬 번호가 늘어도 실발행 +1과 무관)
 *
 * 2) BODY_WRITE_MODE=active
 *    - "실발행을 허용할 수 있는 상태"를 의미하는 신호 모드.
 *    - 하지만 실번호(=active ledger) 소모(+1)는 아래를 모두 만족할 때만 허용:
 *        - PUBLISH_MODE=enable  (깃허브 시크릿 2중 안전장치)
 *        - DRY_RUN != true      (no_live/테스트에서 실번호 소모 방지)
 *
 * 3) PUBLISH_MODE=disable
 *    - '일시정지(PAUSE)' 개념.
 *    - active ledger 발급 금지, 카운터/이력 보존, 리셋 금지.
 *
 * ─────────────────────────────────────────────
 * 파일:
 * - manifests/page-ids.json        (active, 실번호 ledger)
 * - manifests/page-ids.local.json  (local, 로컬 테스트 번호 ledger)
 * - manifests/pageid-journal.jsonl (WAL: 발급 로그, 실패해도 치명 아님)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..'); // System_files
const MANIFESTS_DIR = path.join(ROOT, 'manifests');

const ACTIVE_LEDGER = path.join(MANIFESTS_DIR, 'page-ids.json');
const LOCAL_LEDGER  = path.join(MANIFESTS_DIR, 'page-ids.local.json');
const JOURNAL_FILE  = path.join(MANIFESTS_DIR, 'pageid-journal.jsonl');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isValidPageId(v) {
  return typeof v === 'string' && /^page\d{6}$/.test(v);
}

function nowIso() {
  return new Date().toISOString();
}

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

function appendJournal(rec) {
  try {
    ensureDir(MANIFESTS_DIR);
    fs.appendFileSync(JOURNAL_FILE, JSON.stringify(rec) + '\n', 'utf8');
  } catch {
    // journal 실패는 치명으로 보지 않음(ledger가 정답)
  }
}

function pad6(n) {
  const s = String(n);
  return s.length >= 6 ? s : ('0'.repeat(6 - s.length) + s);
}

function pickMode() {
  const BODY_WRITE_MODE = (process.env.BODY_WRITE_MODE || 'local').toLowerCase(); // local|active
  return BODY_WRITE_MODE === 'active' ? 'active' : 'local';
}

function isPublishEnabled() {
  const PUBLISH_MODE = (process.env.PUBLISH_MODE || 'disable').toLowerCase(); // enable|disable
  return PUBLISH_MODE === 'enable';
}

function isDryRun() {
  return String(process.env.DRY_RUN || '').toLowerCase() === 'true';
}

function loadLedgerInfo() {
  const mode = pickMode();
  const ledgerFile = mode === 'active' ? ACTIVE_LEDGER : LOCAL_LEDGER;
  return { mode, ledgerFile };
}

function loadLedger() {
  ensureDir(MANIFESTS_DIR);

  const { mode, ledgerFile } = loadLedgerInfo();

  // ✅ 실번호(active ledger) 소모 방지 가드
  // - publish enable + dry_run=false 에서만 active 발급 허용
  if (mode === 'active') {
    if (!isPublishEnabled()) {
      const err = new Error('PAUSE: PUBLISH_MODE=disable 이므로 active pageId 발급 금지');
      err.code = 'PAUSE_ACTIVE';
      throw err;
    }
    if (isDryRun()) {
      const err = new Error('PAUSE: DRY_RUN=true 이므로 active pageId 발급 금지 (실번호 소모 방지)');
      err.code = 'PAUSE_DRYRUN';
      throw err;
    }
  }

  const base = readJsonSafe(ledgerFile, null);
  if (base && typeof base === 'object') return { ledger: base, mode, ledgerFile };

  // 최초 생성(리셋과 다름: 파일이 없을 때만 생성)
  const init = {
    mode,
    next: 1,
    map: {}, // slug -> pageId
    updatedAt: nowIso(),
  };
  writeJson(ledgerFile, init);
  return { ledger: init, mode, ledgerFile };
}

/**
 * ensurePageId(slug)
 * - 존재하면 기존 값 반환
 * - 없으면 next로 새 pageId 할당(+1), ledger 저장, journal 기록
 */
function ensurePageId(slug) {
  if (!slug || typeof slug !== 'string') throw new Error('ensurePageId: slug 필요');

  const { ledger, mode, ledgerFile } = loadLedger();

  ledger.map = ledger.map && typeof ledger.map === 'object' ? ledger.map : {};

  const existing = ledger.map[slug];
  if (isValidPageId(existing)) return existing;

  const n = Number(ledger.next || 1);
  if (!Number.isFinite(n) || n < 1) {
    // 절대 0 리셋 금지. 이상치면 최소 1로만 복구.
    ledger.next = 1;
  }

  const pageId = `page${pad6(ledger.next)}`;
  ledger.map[slug] = pageId;
  ledger.next += 1;
  ledger.updatedAt = nowIso();

  writeJson(ledgerFile, ledger);

  appendJournal({
    ts: nowIso(),
    mode,
    slug,
    pageId,
    ledger: path.basename(ledgerFile),
  });

  return pageId;
}

module.exports = {
  ensureDir,
  isValidPageId,
  ensurePageId,
  loadLedgerInfo,
  _paths: {
    ROOT,
    MANIFESTS_DIR,
    ACTIVE_LEDGER,
    LOCAL_LEDGER,
    JOURNAL_FILE,
  },
};
