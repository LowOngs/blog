#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/validate-repair.cjs
 * 역할:
 *  - dist/posts/*.html을 돌면서
 *  - pageId 누락/불일치/OG 이미지 메타 누락을 자동 교정
 *
 * 핵심 원칙(옹스 룰):
 *  - validate 단계에서 "새 pageId 발급"은 금지.
 *  - pageId는 ids.cjs가 content/posts/*.json에 부여한 값이 '정답'이며,
 *    validate는 render 실수를 100% 커버(회수/삽입)해야 한다.
 *  - pageId를 끝까지 못 찾으면 빌드를 통과시키면 안 된다(생명).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

const SITE_BASE = process.env.SITE_BASE || 'https://ongsblog.com';
const CDN_BASE = (process.env.CDN_BASE || 'https://ongsblog.com/images').replace(/\/+$/, '');

function listHtmlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.html'))
    .map((f) => path.join(dir, f));
}

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 1) data-page-id="page000123" 우선
 * 2) page badge 텍스트 "page000123" 차선
 * 3) og:image URL에서 "page000123_" 역추출
 */
function extractPageIdFromHtml(html) {
  const m1 = html.match(/data-page-id=["'](page\d{6})["']/i);
  if (m1 && m1[1]) return m1[1];

  const m2 = html.match(/id=["']pageId["'][\s\S]*?>(page\d{6})<\/a>/i);
  if (m2 && m2[1]) return m2[1];

  const m3 = html.match(/\/og\/(page\d{6})_/i);
  if (m3 && m3[1]) return m3[1];

  return '';
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

function getPageIdFromPostJson(slugBase) {
  const file = path.join(POSTS_DIR, `${slugBase}.json`);
  const doc = readJsonSafe(file, null);
  if (!doc || typeof doc !== 'object') return '';
  const pid = doc.pageId;
  if (typeof pid === 'string' && /^page\d{6}$/.test(pid)) return pid;
  return '';
}

function runIdsOnceOrFail() {
  // validate 안에서 ids를 무한 재시도하면 위험(과열)이라 1회만.
  const script = path.join(ROOT, 'scripts', 'build', 'ids.cjs');
  const r = spawnSync('node', [script], {
    stdio: 'inherit',
    env: process.env,
  });
  if (r.status !== 0) {
    throw new Error('ids.cjs 실행 실패(복구 시도 실패)');
  }
}

function ensurePageIdRecovered(slugBase, html) {
  // ✅ 0) HTML에서 먼저 확인(이미 정상이라면 그대로)
  const fromHtml = extractPageIdFromHtml(html);
  if (fromHtml) return fromHtml;

  // ✅ 1) posts JSON에서 회수
  let pid = getPageIdFromPostJson(slugBase);
  if (pid) return pid;

  // ✅ 2) 그래도 없으면 ids 1회 호출(복구/재발급) 후 다시 회수
  runIdsOnceOrFail();
  pid = getPageIdFromPostJson(slugBase);
  if (pid) return pid;

  // ✅ 3) 최종 실패: 통과 금지
  throw new Error(`pageId 회수 실패: slug=${slugBase} (HTML/JSON 모두 없음)`);
}

function upsertMetaTag(html, kind, nameOrProp, content) {
  const attr = kind === 'property' ? 'property' : 'name';
  const rx = new RegExp(
    `<meta\\s+${attr}=["']${escapeReg(nameOrProp)}["']\\s+content=["'][^"']*["']\\s*\\/?>`,
    'i'
  );

  const tag = `<meta ${attr}="${nameOrProp}" content="${content}">`;

  if (rx.test(html)) {
    return { html: html.replace(rx, tag), changed: true };
  }

  const headCloseIdx = html.toLowerCase().indexOf('</head>');
  if (headCloseIdx !== -1) {
    const insert = `  ${tag}\n`;
    return { html: html.slice(0, headCloseIdx) + insert + html.slice(headCloseIdx), changed: true };
  }

  return { html, changed: false };
}

function upsertBadgeDataPageId(html, pageId) {
  // 템플릿: <a ... id="pageId" data-page-id="{{pageId}}" ...>page000123</a>
  // render가 실수하면 data-page-id가 비어있을 수 있으니 강제 교정(동일 pageId로)
  let changed = false;

  // data-page-id="page000123" 교체/삽입
  // id="pageId"가 있는 a 태그 안에서 data-page-id만 고칩니다.
  const rx = /(<a\b[^>]*\bid=["']pageId["'][^>]*)(>)/i;
  const m = html.match(rx);

  if (!m) return { html, changed: false };

  const aOpen = m[1];
  const restStart = m.index + aOpen.length;

  if (/data-page-id=["']page\d{6}["']/i.test(aOpen)) {
    const next = aOpen.replace(/data-page-id=["']page\d{6}["']/i, `data-page-id="${pageId}"`);
    html = html.slice(0, m.index) + next + html.slice(restStart);
    changed = true;
  } else if (/data-page-id=["'][^"']*["']/i.test(aOpen)) {
    const next = aOpen.replace(/data-page-id=["'][^"']*["']/i, `data-page-id="${pageId}"`);
    html = html.slice(0, m.index) + next + html.slice(restStart);
    changed = true;
  } else {
    const next = aOpen + ` data-page-id="${pageId}"`;
    html = html.slice(0, m.index) + next + html.slice(restStart);
    changed = true;
  }

  return { html, changed };
}

function updateOgAndTwitterImage(html, slugBase) {
  let changed = false;

  // ✅ pageId는 "회수"가 기본. 없으면 fail.
  const pageId = ensurePageIdRecovered(slugBase, html);
  const ogUrl = `${CDN_BASE}/og/${pageId}_${slugBase}_1200x630.jpg`;

  // page badge data-page-id 교정(선행)
  const b = upsertBadgeDataPageId(html, pageId);
  html = b.html;
  changed = changed || b.changed;

  const r1 = upsertMetaTag(html, 'property', 'og:image', ogUrl);
  html = r1.html; changed = changed || r1.changed;

  const r2 = upsertMetaTag(html, 'name', 'twitter:image', ogUrl);
  html = r2.html; changed = changed || r2.changed;

  return { html, changed, pageId, ogUrl };
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[validate] DIST      =', DIST_DIR);
  console.log('[validate] POSTS_DIR =', POSTS_DIR);
  console.log('[validate] SITE_BASE =', SITE_BASE);
  console.log('[validate] CDN_BASE  =', CDN_BASE);

  const files = listHtmlFiles(DIST_DIR);
  if (!files.length) {
    console.log('[validate] 대상 HTML 없음 → 종료');
    return;
  }

  let fixedCount = 0;
  let failCount = 0;

  for (const file of files) {
    const filename = path.basename(file);
    const slugBase = filename.replace(/\.html$/i, '');

    let html = fs.readFileSync(file, 'utf8');

    try {
      const out = updateOgAndTwitterImage(html, slugBase);
      if (out.changed) {
        fs.writeFileSync(file, out.html, 'utf8');
        fixedCount += 1;
        console.log(`FIX ${filename} → pageId=${out.pageId}, og/twitter=${out.ogUrl}`);
      }
    } catch (e) {
      failCount += 1;
      console.error(`[validate][FAIL] ${filename} →`, e.message || e);
    }
  }

  console.log(`✨ validate-repair 완료 — 수정: ${fixedCount}/${files.length}`);

  if (failCount > 0) {
    // ✅ pageId는 생명: 하나라도 회수 실패면 빌드 통과 금지
    console.error(`[validate][FAIL] pageId 회수 실패 ${failCount}건 → 빌드 중단`);
    process.exit(1);
  }
}

main();
