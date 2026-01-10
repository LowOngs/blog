#!/usr/bin/env node
/**
 * blogger.cjs
 * - dist/posts/*.html → Blogger publish
 * - CRIT: PUBLISH_MODE 최종 게이트 (enable 아니면 API 호출 자체 금지)
 *
 * Env:
 *  - PUBLISH_MODE=enable|disable  (default: disable)
 *  - DRY_RUN=true|false|0|1       (default: true)  // step2에서 더 강제 예정
 *  - BLOGGER_BLOG_ID, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *  - MAX_POSTS (optional)
 *  - LABEL_FILTER (optional)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const OUTDIR = path.join(ROOT, 'dist', 'posts');
const LOGDIR = path.join(ROOT, 'logs');

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function nowKstDate() {
  // 파일명용: YYYY-MM-DD (KST 기준)
  const d = new Date();
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function readEnv(name, fallback = '') {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  return String(v);
}

function parsePublishMode() {
  return readEnv('PUBLISH_MODE', 'disable').toLowerCase().trim(); // enable|disable
}

function parseDryRun() {
  // 원칙: false/0만 live, 나머지는 전부 dry-run
  const v = readEnv('DRY_RUN', 'true').toLowerCase().trim();
  return !(v === 'false' || v === '0');
}

function guardPublishModeOrExit() {
  const pm = parsePublishMode();
  const dry = parseDryRun();

  console.log('────────────────────────────────────────────');
  console.log('[blogger] OUTDIR        =', OUTDIR);
  console.log('[blogger] CONFIG PUBLISH_MODE =', pm);
  console.log('[blogger] CONFIG DRY_RUN      =', dry ? 'true (no_live)' : 'false (live)');
  console.log('────────────────────────────────────────────');

  if (pm !== 'enable') {
    console.log('[blogger] PAUSE: PUBLISH_MODE!=enable 이므로 Blogger API 호출 금지 → 즉시 종료 (일시정지, 상태 보존)');
    process.exit(0);
  }

  // ※ 1단계는 PUBLISH_MODE가 최종권자.
  // DRY_RUN 강제 차단은 2단계에서 더 세게 묶을 예정이지만,
  // 사고 방지를 위해 경고는 남깁니다.
  if (dry) {
    console.log('[blogger] NOTE: DRY_RUN=true 상태입니다. (2단계에서 POST 차단을 강제할 예정)');
  }
}

function requestJson(method, url, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers,
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const status = res.statusCode || 0;
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status, raw: data, json });
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getAccessToken() {
  const clientId = readEnv('GOOGLE_CLIENT_ID');
  const clientSecret = readEnv('GOOGLE_CLIENT_SECRET');
  const refreshToken = readEnv('GOOGLE_REFRESH_TOKEN');

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('OAuth env 누락: GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }).toString();

  const r = await requestJson(
    'POST',
    'https://oauth2.googleapis.com/token',
    { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    body
  );

  if (r.status < 200 || r.status >= 300 || !r.json || !r.json.access_token) {
    throw new Error(`token fail: status=${r.status} body=${r.raw}`);
  }
  return { accessToken: r.json.access_token, expiresIn: r.json.expires_in };
}

function listHtmlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.html'));
}

function writeSummaryLog(lines) {
  ensureDir(LOGDIR);
  const file = path.join(LOGDIR, `publish-summary-${nowKstDate()}.log`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  console.log('요약 로그 기록 →', file);
}

async function main() {
  // ✅ 1단계: 최종 게이트를 “제일 먼저” 실행
  guardPublishModeOrExit();

  // (여기부터는 PUBLISH_MODE=enable일 때만 진입)
  const dryRun = parseDryRun(); // true면 실제 POST는 2단계에서 확실히 차단 예정
  const blogId = readEnv('BLOGGER_BLOG_ID');

  if (!blogId) {
    console.error('[blogger][FAIL] BLOGGER_BLOG_ID 누락');
    process.exitCode = 1;
    return;
  }

  const files = listHtmlFiles(OUTDIR);
  console.log('[blogger] 대상 파일:', files.length);

  // 토큰 발급
  const tok = await getAccessToken();
  console.log('[blogger] token ok, expires_in=', tok.expiresIn);

  // ---- 현재 1단계는 “PUBLISH_MODE 게이트”만 확정 ----
  // 아래 POST 차단(=DRY_RUN true면 return)은 2단계에서 더 강제/통일할 예정입니다.
  // 하지만 이번 사고(실발행)를 막기 위해 임시로라도 방지하고 싶으면 여기서 바로 막아도 됩니다.
  if (dryRun) {
    console.log('[blogger] DRY_RUN=true → (임시 안전) 실제 POST를 수행하지 않고 종료합니다.');
    writeSummaryLog([
      `[${new Date().toISOString()}] DRY_RUN=true → publish skipped`,
      `files=${files.length}`,
    ]);
    return;
  }

  // === 실제 POST 로직(기존 프로젝트에 맞게 유지/확장 가능) ===
  // ※ 옹스님 환경에서는 step3에서 today.json 스코프 제한을 강제 예정.
  // 지금은 “실발행이 실행되지 않게”가 최우선이므로,
  // publish 스코프/백오프 개선은 다음 단계에서 다룹니다.

  const summary = [];
  let ok = 0;
  let fail = 0;

  for (const f of files) {
    const htmlPath = path.join(OUTDIR, f);
    const html = fs.readFileSync(htmlPath, 'utf8');

    // 제목 추출(간단): <title> 우선, 없으면 파일명
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = (m ? String(m[1]).replace(/\s+/g, ' ').trim() : f.replace(/\.html$/i, ''));

    // Blogger Posts.insert
    const payload = JSON.stringify({
      kind: "blogger#post",
      title,
      content: html,
    });

    const url = `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(blogId)}/posts/`;
    const r = await requestJson(
      'POST',
      url,
      {
        'Authorization': `Bearer ${tok.accessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
      },
      payload
    );

    if (r.status >= 200 && r.status < 300 && r.json && r.json.id) {
      ok += 1;
      const postUrl = r.json.url || '(no url)';
      console.log('POST OK', f, '→ id=', r.json.id, 'url=', postUrl);
      summary.push(`OK ${f} id=${r.json.id} url=${postUrl}`);
    } else {
      fail += 1;
      console.warn('[blogger][WARN] POST FAIL', f, `→ status=${r.status}`, r.raw?.slice(0, 500) || '');
      summary.push(`FAIL ${f} status=${r.status}`);
    }
  }

  summary.unshift(`[${new Date().toISOString()}] publish done ok=${ok} fail=${fail}`);
  writeSummaryLog(summary);

  console.log(`✨ publish 완료: 성공 ${ok} / 실패 ${fail}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[blogger][FATAL]', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
