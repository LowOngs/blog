/**
 * validate-feed.cjs — dist/ai/feed.ndjson 검증기
 *  - 구조/필드/형식 기본 체크
 *  - 오류는 로그로 남기고, 치명적이지 않으면 exit 0 유지(발행 차단 금지 원칙)
 */

const fs = require('fs');
const path = require('path');

// 0) .env 선로딩
try {
  require('dotenv').config({
    path: path.join(__dirname, '..', '..', '.env'),
  });
} catch (_) {}

/* ───────────────────── 경로 고정 ───────────────────── */
// __dirname = System_files/scripts/build
const ROOT      = path.resolve(__dirname, '..', '..');              // System_files
const FEED_DIR  = path.join(ROOT, 'dist', 'ai');                    // dist/ai
const FEED_FILE = path.join(FEED_DIR, 'feed.ndjson');               // dist/ai/feed.ndjson

/* ───────────────────── 로그 ───────────────────── */
const LOGDIR  = path.join(ROOT, 'logs');
fs.mkdirSync(LOGDIR, { recursive: true });
const LOGFILE = path.join(
  LOGDIR,
  `feed-validate-${new Date().toISOString().slice(0, 10)}.log`
);

function append(line) {
  try {
    fs.appendFileSync(
      LOGFILE,
      `[${new Date().toISOString()}] ${line}\n`,
      'utf8'
    );
  } catch (_) {}
}
function log(...args) {
  const msg = args.join(' ');
  console.log(msg);
  append(msg);
}
function warn(...args) {
  const msg = 'WARN ' + args.join(' ');
  console.warn(msg);
  append(msg);
}
function fail(msg) {
  const out = 'FAIL ' + msg;
  console.error(out);
  append(out);
  process.exit(1);
}

/* ───────────────────── ENV ───────────────────── */

const ENV = {
  SITE_BASE: (process.env.SITE_BASE ||
    process.env.SITE_BASE_URL ||
    'https://ongsblog.com'
  ).replace(/\/+$/, ''),
};

const EXPECT_AUTHORITY_REF = `${ENV.SITE_BASE}/ai/authority.json`;

/* ───────────────────── 유틸 ───────────────────── */

const ISO_KST_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/;

const ALLOWED_INTENTS = new Set([
  'how-to',
  'review',
  'savings',
  'template',
  null,
]);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function validateItem(item, index) {
  let hasError = false;
  const pos = `line#${index + 1} slug=${item && item.slug}`;

  // slug
  if (!isNonEmptyString(item.slug)) {
    warn(pos, 'slug 누락 또는 빈 문자열');
    hasError = true;
  }

  // url
  if (!isNonEmptyString(item.url)) {
    warn(pos, 'url 누락 또는 빈 문자열');
    hasError = true;
  } else if (!/^https?:\/\//i.test(item.url)) {
    warn(pos, `url 형식 이상: ${item.url}`);
    hasError = true;
  }

  // updated
  if (!isNonEmptyString(item.updated)) {
    warn(pos, 'updated 누락');
    hasError = true;
  } else if (!ISO_KST_RE.test(item.updated)) {
    warn(pos, `updated ISO8601(+09:00) 형식 아님: ${item.updated}`);
    hasError = true;
  }

  // labels
  if (!Array.isArray(item.labels)) {
    warn(pos, 'labels 가 배열이 아님');
    hasError = true;
  }

  // intent
  const intent =
    item.intent === undefined ? null : item.intent;
  if (!ALLOWED_INTENTS.has(intent)) {
    warn(pos, `intent 값이 허용 범위 아님: ${intent}`);
    hasError = true;
  }

  // authorityRef
  if (!isNonEmptyString(item.authorityRef)) {
    warn(pos, 'authorityRef 누락');
    hasError = true;
  } else if (item.authorityRef !== EXPECT_AUTHORITY_REF) {
    warn(
      pos,
      `authorityRef 값 불일치: ${item.authorityRef} (expected ${EXPECT_AUTHORITY_REF})`
    );
    hasError = true;
  }

  // tldr/keyfacts/faq/sources 기본 구조
  if (!Array.isArray(item.tldr)) {
    warn(pos, 'tldr 가 배열이 아님');
    hasError = true;
  }
  if (!Array.isArray(item.keyfacts)) {
    warn(pos, 'keyfacts 가 배열이 아님');
    hasError = true;
  }
  if (!Array.isArray(item.faq)) {
    warn(pos, 'faq 가 배열이 아님');
    hasError = true;
  }
  if (!Array.isArray(item.sources)) {
    warn(pos, 'sources 가 배열이 아님');
    hasError = true;
  }

  return hasError;
}

/* ───────────────────── 메인 ───────────────────── */

(function main() {
  log('[feed-validate] start');
  log(`[feed-validate] ROOT = ${ROOT}`);
  log(`[feed-validate] FILE = ${FEED_FILE}`);

  if (!fs.existsSync(FEED_FILE)) {
    fail(`feed.ndjson 파일이 없습니다: ${FEED_FILE}`);
  }

  const raw = fs.readFileSync(FEED_FILE, 'utf8');
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length) {
    warn('feed.ndjson 내용이 비어 있습니다.');
    log(
      '✨ feed-validate 완료 | 항목 0개 | WARNING: empty feed'
    );
    process.exit(0);
  }

  let total = 0;
  let errorCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    try {
      const item = JSON.parse(line);
      total++;
      if (validateItem(item, i)) {
        errorCount++;
      }
    } catch (e) {
      warn(
        `line#${i + 1} JSON 파싱 실패 →`,
        e && e.message ? e.message : String(e)
      );
      errorCount++;
    }
  }

  if (errorCount > 0) {
    warn(
      `검증 경고: 총 ${total}개 중 ${errorCount}개 항목에서 문제가 발견되었습니다.`
    );
  } else {
    log(`모든 ${total}개 항목이 검증을 통과했습니다.`);
  }

  log(
    `✨ feed-validate 완료 | 총 ${total}개 | 오류 항목 ${errorCount}개 | LOGFILE=${LOGFILE}`
  );

  // 발행 차단 금지: 경고가 있어도 exit 0 유지
  process.exit(0);
})();
