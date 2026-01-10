#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/publish/blogger.cjs
 * publish scope를 today.json(SSOT)로 고정 + 백오프/슬립/재시도 조건 정교화
 */

const path = require('path');

// ✅ 로컬/CI 공통: .env 로드(필수)
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
const ROOT      = path.resolve(__dirname, '..', '..');        // System_files
const OUTDIR    = path.join(ROOT, 'dist', 'posts');
const TODAY_JSON = path.join(ROOT, 'dist', 'queue', 'today.json');

const LOGDIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOGDIR, { recursive: true });

function nowKstDate() {
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

// 발행 템포(슬립)
const POST_SLEEP_MS = Number(process.env.POST_SLEEP_MS || '1200'); // 기본 1.2s
const MAX_BACKOFF_MS = Number(process.env.MAX_BACKOFF_MS || '30000'); // 백오프 상한(기본 30s)
const RETRY_TRIES = Number(process.env.RETRY_TRIES || '6'); // 재시도 횟수(기본 6)

// ────────────────────────────────────
//  유틸
// ────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function jitter(ms, ratio = 0.2) {
  const j = ms * ratio;
  const min = ms - j;
  const max = ms + j;
  return Math.max(0, Math.floor(min + Math.random() * (max - min)));
}

function parseRetryAfterMs(headers) {
  try {
    const v = headers && (headers.get ? headers.get('retry-after') : null);
    if (!v) return 0;
    const s = String(v).trim();
    if (!s) return 0;

    // seconds
    const sec = Number(s);
    if (!Number.isNaN(sec) && sec >= 0) return Math.floor(sec * 1000);

    // HTTP-date
    const t = Date.parse(s);
    if (!Number.isNaN(t)) {
      const diff = t - Date.now();
      return diff > 0 ? diff : 0;
    }
  } catch {}
  return 0;
}

async function backoff(fn, opts = {}) {
  const {
    tries = RETRY_TRIES,
    baseMs = 1000,
    label = 'task',
    maxMs = MAX_BACKOFF_MS,
    shouldRetry = () => true,
    onRetry = null,
  } = opts;

  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;

      const retryable = shouldRetry(e);
      warn(`${label} attempt ${i + 1}/${tries} →`, e && e.message ? e.message : String(e));

      if (!retryable || i === tries - 1) break;

      let waitMs = Math.min(maxMs, baseMs * Math.pow(2, i));
      if (e && typeof e.retryAfterMs === 'number' && e.retryAfterMs > 0) {
        waitMs = Math.min(maxMs, e.retryAfterMs);
      }
      waitMs = jitter(waitMs);

      if (typeof onRetry === 'function') onRetry(e, i + 1, waitMs);
      await sleep(waitMs);
    }
  }
  throw last;
}

function isRetryableHttpStatus(status) {
  // 429/5xx는 기본 retry
  if (status === 429) return true;
  if (status >= 500) return true;
  // 408(요청 타임아웃)도 retry 가치 있음
  if (status === 408) return true;
  return false;
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

// ────────────────────────────────────
//  Blogger API
// ────────────────────────────────────
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
  if (!res.ok) {
    const err = new Error(`token ${res.status} ${text}`);
    err.httpStatus = res.status;
    err.retryAfterMs = parseRetryAfterMs(res.headers);
    throw err;
  }

  let json;
  try { json = JSON.parse(text); } catch { throw new Error('token parse error'); }
  if (!json.access_token) throw new Error('no access_token');
  log('[blogger] token ok, expires_in=', json.expires_in);
  return json.access_token;
}

async function createPost(token, { title, content, labels }) {
  const url = `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(BLOG_ID)}/posts/?isDraft=false`;
  const body = { kind: 'blogger#post', blog: { id: BLOG_ID }, title, content };
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
  if (!res.ok) {
    const err = new Error(`POST ${res.status} ${t}`);
    err.httpStatus = res.status;
    err.retryAfterMs = parseRetryAfterMs(res.headers);
    throw err;
  }

  try { return JSON.parse(t); } catch { throw new Error('response parse error'); }
}

function shouldRetryPublishError(e) {
  const st = e && typeof e.httpStatus === 'number' ? e.httpStatus : 0;
  return isRetryableHttpStatus(st);
}

// 401/403은 “토큰 재발급 후 1회 재시도” 가치 있음(권한 자체 문제면 계속 실패)
async function publishWithTokenRefresh(tokenHolder, payload, labelForLog) {
  try {
    return await backoff(
      () => createPost(tokenHolder.token, payload),
      {
        label: labelForLog,
        shouldRetry: shouldRetryPublishError,
        onRetry: (e, attempt, waitMs) => {
          const st = e && e.httpStatus ? e.httpStatus : '';
          warn(`${labelForLog} retry scheduled: status=${st} wait=${waitMs}ms`);
        }
      }
    );
  } catch (e) {
    const st = e && typeof e.httpStatus === 'number' ? e.httpStatus : 0;
    if (st === 401 || st === 403) {
      warn(`${labelForLog} got ${st} → refresh token and retry once`);
      tokenHolder.token = await backoff(getAccessToken, { label: 'token(refresh)' });

      // refresh 후에는 1회만 “짧게” 다시 시도(반복 루프 방지)
      return await backoff(
        () => createPost(tokenHolder.token, payload),
        {
          tries: 2,
          baseMs: 1000,
          label: `${labelForLog}:afterRefresh`,
          shouldRetry: shouldRetryPublishError
        }
      );
    }
    throw e;
  }
}

// ────────────────────────────────────
//  메인
// ────────────────────────────────────
(async function main() {
  log('────────────────────────────────────────────');
  log('[blogger] OUTDIR               =', OUTDIR);
  log('[blogger] TODAY_JSON           =', TODAY_JSON);
  log('[blogger] CONFIG PUBLISH_MODE  =', PUBLISH_MODE);
  log('[blogger] CONFIG PUBLISH_SCOPE =', PUBLISH_SCOPE);
  log('[blogger] CONFIG LABEL_FILTER  =', LABEL_FILTER || '(none)');
  log('[blogger] CONFIG MAX_POSTS     =', MAX_POSTS_NUM || '(none)');
  log('[blogger] CONFIG POST_SLEEP_MS =', POST_SLEEP_MS);
  log('[blogger] CONFIG RETRY_TRIES   =', RETRY_TRIES);
  log('[blogger] CONFIG MAX_BACKOFF_MS=', MAX_BACKOFF_MS);
  log('[blogger] DRY_RUN(raw)         =', (DRY_RUN_RAW === undefined ? '(undefined)' : JSON.stringify(String(DRY_RUN_RAW))));
  log('[blogger] DRY_RUN(parsed)      =', DRY_RUN);

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
  const tokenHolder = { token: null };
  if (!DRY_RUN) {
    tokenHolder.token = await backoff(getAccessToken, {
      label: 'token',
      shouldRetry: (e) => {
        const st = e && typeof e.httpStatus === 'number' ? e.httpStatus : 0;
        return isRetryableHttpStatus(st) || st === 400; // 간헐적 토큰 문제 완충(과하게 넓히지 않음)
      }
    });
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

        // ✅ 템포 유지(드라이런이라도 로그 폭주 방지)
        if (POST_SLEEP_MS > 0) await sleep(jitter(POST_SLEEP_MS, 0.1));
        continue;
      }

      const result = await publishWithTokenRefresh(
        tokenHolder,
        { title, content: body, labels: bloggerLabels },
        `publish:${name}`
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

      // ✅ 기본 슬립(429/오탐 방지)
      if (POST_SLEEP_MS > 0) await sleep(jitter(POST_SLEEP_MS, 0.1));
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

      // ✅ 실패 후에도 템포 유지(연쇄 429 방지)
      if (POST_SLEEP_MS > 0) await sleep(jitter(POST_SLEEP_MS, 0.2));
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
