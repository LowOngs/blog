#!/usr/bin/env node
/**
 * blogger.cjs — publish scope를 today.json(SSOT)로 고정
 * - 기본: dist/queue/today.json의 publishable slug만 발행
 * - 옵션: PUBLISH_SCOPE=all 일 때만 dist/posts/*.html 전체 발행(수동용)
 */
const path = require('path');

// 루트(.env) 강제 로드: C:\google-blog\.env 기준
require('dotenv').config({
  path: path.resolve(__dirname, '../../../.env'),
});

const fs = require('fs');
const fg = require('fast-glob');

// Seed Ledger (Minimal v1)
const { upsert: upsertSeedLedger } = require(path.join(__dirname, '..', 'build', 'lib', 'seed-ledger.cjs'));

// ────────────────────────────────────
//  라벨 매핑: 내부 코드 → Blogger 라벨
// ────────────────────────────────────
const CODE_TO_LABEL = {
  'app-reviews':              'App Reviews',
  'device-reviews':           'Device Reviews',
  'subscription-services':    'Subscription & Services',
  'how-to-playbooks':         'How to Playbooks',
  'smart-savings':            'Smart Savings',
  'templates-checklists':     'Templates & Checklists'
};

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
const TODAY_JSON = path.join(ROOT, 'dist', 'queue', 'today.json');

const LOGDIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOGDIR, { recursive: true });

function nowKstDate() {
  // 로그 파일명용(UTC 기준 0시 넘어가는 문제 완화)
  const d = new Date();
  const k = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return k.toISOString().slice(0, 10);
}

const todayISODate = nowKstDate();
const DETAIL_LOG   = path.join(LOGDIR, `publish-blogger-${todayISODate}.log`);
const SUMMARY_LOG  = path.join(LOGDIR, `publish-summary-${todayISODate}.log`);

const append = (file, s) => fs.appendFileSync(file, s + '\n', 'utf8');
const log  = (...a) => { const s = a.join(' '); console.log(s); append(DETAIL_LOG, s); };
const warn = (...a) => log('[blogger][WARN]', ...a);
const fail = (m, c = 1) => { log('[blogger][FAIL]', m); process.exit(c); };

// ────────────────────────────────────
//  ENV
// ────────────────────────────────────
const BLOG_ID       = process.env.BLOGGER_BLOG_ID;
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

if (!BLOG_ID || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  fail('환경변수 누락(BLOGGER_BLOG_ID / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN)');
}

// 최종 게이트
const PUBLISH_MODE = String(process.env.PUBLISH_MODE || 'disable').toLowerCase(); // enable|disable

// 스코프: 기본 today, 수동으로만 all 허용
const PUBLISH_SCOPE = String(process.env.PUBLISH_SCOPE || 'today').toLowerCase(); // today|all

// LABEL: 내부 코드(app-reviews 등), 빈 문자열이면 제한 없음
const LABEL_FILTER = String(process.env.LABEL || '').trim();

// MAX_POSTS: 숫자 또는 빈 문자열(제한 없음)
const MAX_POSTS_RAW = process.env.MAX_POSTS || '';
const MAX_POSTS_NUM = MAX_POSTS_RAW && !Number.isNaN(Number(MAX_POSTS_RAW))
  ? Number(MAX_POSTS_RAW)
  : 0; // 0 = 제한 없음

// DRY_RUN 단일 파서(규칙: false/0만 live, 그 외 전부 dry-run)
function parseDryRun(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return !(s === 'false' || s === '0');
}
const DRY_RUN_RAW = process.env.DRY_RUN;
const DRY_RUN = parseDryRun(DRY_RUN_RAW);

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
  try { json = JSON.parse(text); } catch { throw new Error('token parse error'); }
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

function extractPageId(html) {
  let m = html.match(/data-page-id\s*=\s*"?(page\d{6})"?/i);
  if (m && m[1]) return m[1];
  m = html.match(/id\s*=\s*"pageId"[^>]*>\s*(page\d{6})\s*</i);
  if (m && m[1]) return m[1];
  return '';
}

function inferLabelCodeFromFilename(name) {
  const base = name.replace(/\.html$/i, '').toLowerCase();

  if (base.startsWith('firstgate-')) {
    const rest = base.slice('firstgate-'.length);
    const m = rest.match(/^(app-reviews|device-reviews|subscription-services|how-to-playbooks|smart-savings|templates-checklists)\b/);
    if (m && m[1]) return m[1];
  }

  const prefix = base.split(/[-_]/)[0];
  return PREFIX_TO_CODE[prefix] || null;
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

// today.json에서 publishable slug 추출(유연)
function loadPublishableSlugs() {
  const raw = safeReadJson(TODAY_JSON, null);
  const out = new Set();
  if (!raw) return { loaded: false, slugs: out };

  const asArray = (v) => (Array.isArray(v) ? v : (v ? [v] : []));

  if (Array.isArray(raw)) {
    for (const it of raw) {
      if (typeof it === 'string' && it.trim()) out.add(it.trim());
      if (it && typeof it === 'object' && typeof it.slug === 'string' && it.slug.trim()) out.add(it.slug.trim());
    }
    return { loaded: true, slugs: out };
  }

  const candidates = []
    .concat(asArray(raw.items))
    .concat(asArray(raw.posts))
    .concat(asArray(raw.queue))
    .concat(asArray(raw.publishables));

  for (const it of candidates) {
    if (!it) continue;
    if (typeof it === 'string' && it.trim()) out.add(it.trim());
    if (typeof it === 'object' && typeof it.slug === 'string' && it.slug.trim()) out.add(it.slug.trim());
  }

  return { loaded: true, slugs: out };
}

async function createPost(token, { title, content, labels }) {
  const url = `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(BLOG_ID)}/posts/?isDraft=false`;
  const body = { kind: 'blogger#post', blog: { id: BLOG_ID }, title, content };
  if (labels && labels.length) body.labels = labels;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
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
  try { return JSON.parse(t); } catch { throw new Error('response parse error'); }
}

// ────────────────────────────────────
//  메인
// ────────────────────────────────────
(async function main() {
  log('────────────────────────────────────────────');
  log('[blogger] OUTDIR            =', OUTDIR);
  log('[blogger] TODAY_JSON        =', TODAY_JSON);
  log('[blogger] CONFIG PUBLISH_MODE  =', PUBLISH_MODE);
  log('[blogger] CONFIG PUBLISH_SCOPE =', PUBLISH_SCOPE);
  log('[blogger] CONFIG LABEL_FILTER  =', LABEL_FILTER || '(none)');
  log('[blogger] CONFIG MAX_POSTS     =', MAX_POSTS_NUM || '(none)');
  log('[blogger] DRY_RUN(raw)      =', (DRY_RUN_RAW === undefined ? '(undefined)' : JSON.stringify(String(DRY_RUN_RAW))));
  log('[blogger] DRY_RUN(parsed)   =', DRY_RUN);

  // ✅ 최종 게이트: enable 아니면 “API 호출 자체 금지”
  if (PUBLISH_MODE !== 'enable') {
    log('[blogger] STOP: PUBLISH_MODE!=enable (publish blocked)');
    append(SUMMARY_LOG, `[${new Date().toISOString()}] STOP publish blocked (PUBLISH_MODE!=enable)`);
    return;
  }

  if (!fs.existsSync(OUTDIR)) {
    warn('dist/posts 없음. render 단계가 선행되어야 합니다.');
    return;
  }

  // ✅ 발행 대상 SSOT: today.json
  let publishableSet = null;
  if (PUBLISH_SCOPE !== 'all') {
    const pub = loadPublishableSlugs();
    log('[blogger] publishable loaded =', pub.loaded);
    log('[blogger] publishable count  =', pub.slugs.size);

    if (!pub.loaded || pub.slugs.size === 0) {
      log('[blogger] STOP: today.json publishable 비어있음 → 발행 0회 (안전 종료)');
      append(SUMMARY_LOG, `[${new Date().toISOString()}] STOP no publishables in today.json`);
      return;
    }
    publishableSet = pub.slugs;
  } else {
    log('[blogger] WARN: PUBLISH_SCOPE=all (manual 위험 옵션) — dist/posts 전체를 대상으로 합니다.');
  }

  // 파일 목록(기본은 today.json slug만)
  let files = fg.sync('*.html', { cwd: OUTDIR }).sort();
  if (!files.length) {
    warn('게시할 HTML 없음');
    return;
  }

  if (publishableSet) {
    files = files.filter((name) => publishableSet.has(name.replace(/\.html$/i, '')));
  }

  log('[blogger] 대상 파일(스코프 적용 후):', files.length);
  if (!files.length) {
    log('[blogger] STOP: 스코프 적용 결과 0개');
    append(SUMMARY_LOG, `[${new Date().toISOString()}] STOP scoped files=0`);
    return;
  }

  // DRY_RUN이면 토큰 발급/POST 없음
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

    const slug = name.replace(/\.html$/i, '');
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
      const pageId = extractPageId(html);

      const bloggerLabels = humanLabel ? [humanLabel] : [];

      if (DRY_RUN) {
        log(`[DRY_RUN] ${name} → title="${title}" labels=[${bloggerLabels.join(', ')}]`);
        try {
          upsertSeedLedger({
            stage: 'publish',
            status: 'dryrun',
            slug,
            pageId,
            label: labelCode || '',
            source: slug.startsWith('firstgate-') ? 'firstgate' : '',
            dryRun: true,
            notes: 'DRY_RUN=true (no publish)',
          });
        } catch (e) {
          warn('seed-ledger upsert fail:', e.message || e);
        }
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
        try {
          upsertSeedLedger({
            stage: 'publish',
            status: 'published',
            slug,
            pageId,
            label: labelCode || '',
            source: slug.startsWith('firstgate-') ? 'firstgate' : '',
            dryRun: false,
            postId: String(result.id || ''),
            url: String(result.url || ''),
          });
        } catch (e) {
          warn('seed-ledger upsert fail:', e.message || e);
        }
        ok++;
      } else {
        warn(`POST NG ${name}`);
        try {
          upsertSeedLedger({
            stage: 'publish',
            status: 'failed',
            slug,
            pageId,
            label: labelCode || '',
            source: slug.startsWith('firstgate-') ? 'firstgate' : '',
            dryRun: false,
            notes: 'POST result missing id',
          });
        } catch (e) {
          warn('seed-ledger upsert fail:', e.message || e);
        }
        bad++;
      }

      used++;
    } catch (e) {
      warn(`POST FAIL ${name} →`, e.message || e);
      try {
        const html = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
        const pageId = html ? extractPageId(html) : '';
        upsertSeedLedger({
          stage: 'publish',
          status: 'failed',
          slug,
          pageId,
          label: inferLabelCodeFromFilename(name) || '',
          source: slug.startsWith('firstgate-') ? 'firstgate' : '',
          dryRun: false,
          notes: String(e && (e.message || e)) || 'unknown error',
        });
      } catch (ee) {
        warn('seed-ledger upsert fail:', ee.message || ee);
      }
      bad++;
      used++;
    }
  }

  const summaryLine =
    `[${new Date().toISOString()}] publish result ok=${ok} bad=${bad} used=${used}` +
    ` PUBLISH_SCOPE=${PUBLISH_SCOPE} LABEL_FILTER="${LABEL_FILTER}" MAX_POSTS=${MAX_POSTS_NUM || 0}` +
    ` DRY_RUN=${DRY_RUN}`;
  append(SUMMARY_LOG, summaryLine);
  log('요약 로그 기록 →', SUMMARY_LOG);
  log(`✨ publish 완료: 성공 ${ok} / 실패 ${bad} | 로그: ${DETAIL_LOG}`);
})().catch((e) => {
  fail(e.message || e);
});
