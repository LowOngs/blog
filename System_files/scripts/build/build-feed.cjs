/**
 * build-feed.cjs — /dist/ai/feed.ndjson 생성기 (lib/feed.cjs 사용)
 * 입력: System_files/content/posts/*.json
 * 출력: System_files/dist/ai/feed.ndjson
 */

const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');

// 0) .env 선로딩
try {
  require('dotenv').config({
    path: path.join(__dirname, '..', '..', '.env'),
  });
} catch (_) {}

/* ───────────────────── 경로 고정 ───────────────────── */
// __dirname = System_files/scripts/build
const ROOT        = path.resolve(__dirname, '..', '..');           // System_files
const CONTENT_DIR = path.join(ROOT, 'content', 'posts');           // JSON 입력
const OUT_DIR     = path.join(ROOT, 'dist', 'ai');                 // 피드 출력
const OUT_FILE    = path.join(OUT_DIR, 'feed.ndjson');             // /ai/feed.ndjson

/* ───────────────────── 로그 ───────────────────── */
const LOGDIR  = path.join(ROOT, 'logs');
fs.mkdirSync(LOGDIR, { recursive: true });
const LOGFILE = path.join(
  LOGDIR,
  `feed-${new Date().toISOString().slice(0, 10)}.log`
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
  SITE_NAME: process.env.SITE_NAME || 'Ongs Blog',
  SITE_BASE: (process.env.SITE_BASE ||
    process.env.SITE_BASE_URL ||
    'https://ongsblog.com'
  ).replace(/\/+$/, ''),
  CDN_BASE: (process.env.CDN_BASE || 'https://ongsblog.com/images').replace(
    /\/+$/,
    ''
  ),
};

const AUTHORITY_REF_URL = `${ENV.SITE_BASE}/ai/authority.json`;

/* ───────────────────── lib/feed.cjs 로더 ───────────────────── */

const FEED_LIB_PATH = path.join(__dirname, 'lib', 'feed.cjs');
let feedLib;
try {
  feedLib = require(FEED_LIB_PATH);
} catch (e) {
  fail(`feed 라이브러리 로드 실패: ${FEED_LIB_PATH} (${e && e.message ? e.message : e})`);
}

/* ───────────────────── 메인 로직 ───────────────────── */

(function main() {
  log('[feed] start');
  log(`[feed] ROOT    = ${ROOT}`);
  log(`[feed] CONTENT = ${CONTENT_DIR}`);
  log(`[feed] OUT     = ${OUT_FILE}`);

  if (!fs.existsSync(CONTENT_DIR)) {
    fail(`content/posts 디렉터리를 찾지 못했습니다: ${CONTENT_DIR}`);
  }

  const files = fg.sync(['*.json', '*.JSON'], {
    cwd: CONTENT_DIR,
    absolute: true,
  });
  log(
    '[feed] found JSON =',
    files.map((f) => path.basename(f)).join(', ') || '(none)'
  );
  if (!files.length) fail('JSON 없음. 위치/확장자 확인: ' + CONTENT_DIR);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const lines = [];
  let ok = 0;

  for (const abs of files) {
    const base = path.basename(abs);
    try {
      const raw = fs.readFileSync(abs, 'utf8');
      const json = JSON.parse(raw);

      const item = feedLib.buildFeedItem(json, ENV, AUTHORITY_REF_URL);
      lines.push(JSON.stringify(item));
      ok++;
      log(`OK ${base} → feed item (${item.slug})`);
    } catch (e) {
      warn(
        `FAIL ${base} →`,
        e && e.message ? e.message : String(e)
      );
    }
  }

  fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n', 'utf8');
  log(
    `✨ feed 생성 완료 | 성공 ${ok}/${files.length} | OUT=${OUT_FILE} | LOGFILE=${LOGFILE}`
  );
})();
