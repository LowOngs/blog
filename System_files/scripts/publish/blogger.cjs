/**
 * blogger.cjs — dist HTML → Blogger 발행 + LABEL / MAX_POSTS / DRY_RUN 지원
 */
const path = require('path');

// 루트(.env) 강제 로드: C:\google-blog\.env 기준
require('dotenv').config({
  path: path.resolve(__dirname, '../../../.env'),
});

const fs = require('fs');
const fg = require('fast-glob');

// ────────────────────────────────────
//  라벨 매핑: 내부 코드 → 사람이 보는 Blogger 라벨
// ────────────────────────────────────
const CODE_TO_LABEL = {
  'app-reviews':              'App Reviews',
  'device-reviews':           'Device Reviews',
  'subscription-services':    'Subscription & Services',
  'how-to-playbooks':         'How to Playbooks',
  'smart-savings':            'Smart Savings',
  'templates-checklists':     'Templates & Checklists'
};

// 파일명 prefix → 내부 라벨 코드
const PREFIX_TO_CODE = {
  app:          'app-reviews',
  device:       'device-reviews',
  sub:          'subscription-services',
  subs:         'subscription-services',
  subscription: 'subscription-services',
  howto:        'how-to-playbooks',
  'how-to':     'how-to-playbooks',
  smart:        'smart-savings',
  save:         'smart-savings',
  tpl:          'templates-checklists',
  tmpl:         'templates-checklists',
  template:     'templates-checklists'
};

// ────────────────────────────────────
//  경로·로그 설정
// ────────────────────────────────────
const ROOT   = path.resolve(__dirname, '..', '..');        // System_files
const OUTDIR = path.join(ROOT, 'dist', 'posts');
const LOGDIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOGDIR, { recursive: true });

const todayISODate = new Date().toISOString().slice(0, 10);
const DETAIL_LOG   = path.join(LOGDIR, `publish-blogger-${todayISODate}.log`);
const SUMMARY_LOG  = path.join(LOGDIR, `publish-summary-${todayISODate}.log`);

const append = (file, s) => fs.appendFileSync(file, s + '\n', 'utf8');
const log  = (...a) => { const s = a.join(' '); console.log(s); append(DETAIL_LOG, s); };
const warn = (...a) => log('[blogger][WARN]', ...a);
const fail = (m, c = 1) => { log('[blogger][FAIL]', m); process.exit(c); };

// ────────────────────────────────────
//  ENV 설정
// ────────────────────────────────────
const BLOG_ID       = process.env.BLOGGER_BLOG_ID;
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

if (!BLOG_ID || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  fail('환경변수 누락(BLOGGER_BLOG_ID / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN)');
}

// LABEL: 내부 코드(app-reviews 등), 빈 문자열이면 자동모드
const LABEL_FILTER = process.env.LABEL || '';
// MAX_POSTS: 숫자 또는 빈 문자열(제한 없음)
const MAX_POSTS_RAW = process.env.MAX_POSTS || '';
const MAX_POSTS_NUM = MAX_POSTS_RAW && !Number.isNaN(Number(MAX_POSTS_RAW))
  ? Number(MAX_POSTS_RAW)
  : 0; // 0 = 제한 없음

// DRY_RUN: "true"면 API 호출 없이 로그만
const DRY_RUN = (process.env.DRY_RUN || 'false').toLowerCase() === 'true';

// ────────────────────────────────────
//  유틸
// ────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function backoff(fn, { tries = 5, baseMs = 1000, label = 'task' } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      warn(`${label} attempt ${i + 1}/${tries} →`, e.message || e);
      if (i < tries - 1) await sleep(baseMs * Math.pow(2, i));
    }
  }
  throw last;
}

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type:    'refresh_token'
    })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token ${res.status} ${text}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('token parse error');
  }
  if (!json.access_token) throw new Error('no access_token');
  log('[blogger] token ok, expires_in=', json.expires_in);
  return json.access_token;
}

function extractTitle(html) {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  return m ? m[1].trim() : 'Untitled';
}

function extractBody(html) {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : html;
}

// 파일명 → 내부 라벨 코드(app-reviews 등)
function inferLabelCodeFromFilename(name) {
  const base = name.replace(/\.html$/i, '').toLowerCase();

  // ✅ firstgate-how-to-playbooks-... 형태 지원
  // base = firstgate-how-to-playbooks-ht-fg-001-2025-12-12
  if (base.startsWith('firstgate-')) {
    const rest = base.slice('firstgate-'.length); // how-to-playbooks-...
    const m = rest.match(/^(app-reviews|device-reviews|subscription-services|how-to-playbooks|smart-savings|templates-checklists)\b/);
    if (m && m[1]) return m[1];
  }

  // 기존: prefix 기반(app-..., howto-..., smart-...)
  const prefix = base.split(/[-_]/)[0];
  return PREFIX_TO_CODE[prefix] || null;
}

// Blogger API 호출
async function createPost(token, { title, content, labels }) {
  const url = `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(BLOG_ID)}/posts/?isDraft=false`;
  const body = {
    kind: 'blogger#post',
    blog: { id: BLOG_ID },
    title,
    content
  };
  if (labels && labels.length) body.labels = labels;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const t = await res.text();

  if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
    throw new Error(`POST ${res.status} ${t}`);
  }
  if (!res.ok) {
    warn('fatal', res.status, t);
    return null;
  }

  try {
    return JSON.parse(t);
  } catch {
    throw new Error('response parse error');
  }
}

// ────────────────────────────────────
//  메인
// ────────────────────────────────────
(async function main() {
  log('────────────────────────────────────────────');
  log('[blogger] OUTDIR =', OUTDIR);
  log('[blogger] CONFIG LABEL_FILTER =', LABEL_FILTER || '(자동모드, 라벨 제한 없음)');
  log('[blogger] CONFIG MAX_POSTS     =', MAX_POSTS_NUM || '(제한 없음)');
  log('[blogger] CONFIG DRY_RUN      =', DRY_RUN);

  if (!fs.existsSync(OUTDIR)) {
    warn('dist/posts 없음. 건너뜀');
    return;
  }

  const files = fg.sync('*.html', { cwd: OUTDIR }).sort();
  if (!files.length) {
    warn('게시할 HTML 없음');
    return;
  }
  log('[blogger] 대상 파일:', files.length);

  let token = null;
  if (!DRY_RUN) {
    token = await backoff(getAccessToken, { label: 'token' });
  } else {
    log('[blogger] DRY_RUN 모드 — Blogger API 호출 없이 로그만 남깁니다.');
  }

  let ok = 0;
  let bad = 0;
  let used = 0;

  for (const name of files) {
    if (MAX_POSTS_NUM > 0 && used >= MAX_POSTS_NUM) {
      log(`[blogger] MAX_POSTS=${MAX_POSTS_NUM} 도달, 이후 파일은 건너뜀 (총 시도 ${used}개)`);
      break;
    }

    const p = path.join(OUTDIR, name);

    const labelCode = inferLabelCodeFromFilename(name);
    const humanLabel = labelCode && CODE_TO_LABEL[labelCode] ? CODE_TO_LABEL[labelCode] : null;

    if (LABEL_FILTER && labelCode !== LABEL_FILTER) {
      log(`[blogger] skip ${name} (label mismatch: need="${LABEL_FILTER}", got="${labelCode || '-'}")`);
      continue;
    }

    try {
      const html = fs.readFileSync(p, 'utf8');
      const title = extractTitle(html);
      const body  = extractBody(html);

      const bloggerLabels = humanLabel ? [humanLabel] : [];

      if (DRY_RUN) {
        log(`[DRY_RUN] ${name} → title="${title}" labels=[${bloggerLabels.join(', ')}] (실제 발행 안 함)`);
        ok++;
        used++;
        continue;
      }

      const result = await backoff(
        () => createPost(token, { title, content: body, labels: bloggerLabels }),
        { label: `publish:${name}` }
      );

      if (result && result.id) {
        log(`POST OK ${name} → id=${result.id} url=${result.url || ''} labels=[${bloggerLabels.join(', ')}]`);
        ok++;
      } else {
        warn(`POST NG ${name}`);
        bad++;
      }
      used++;
    } catch (e) {
      warn(`POST FAIL ${name} →`, e.message || e);
      bad++;
      used++;
    }
  }

  const summaryLine = `[${new Date().toISOString()}] publish result ok=${ok} bad=${bad} used=${used} LABEL_FILTER="${LABEL_FILTER}" MAX_POSTS=${MAX_POSTS_NUM || 0} DRY_RUN=${DRY_RUN}`;
  append(SUMMARY_LOG, summaryLine);
  log('요약 로그 기록 →', SUMMARY_LOG);
  log(`✨ publish 완료: 성공 ${ok} / 실패 ${bad} | 로그: ${DETAIL_LOG}`);
})().catch((e) => {
  fail(e.message || e);
});
