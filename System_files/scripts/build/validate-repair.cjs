#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/validate-repair.cjs
 * 역할:
 *  - dist/posts/*.html 을 돌면서
 *  - "이미 렌더된 HTML에 있는 pageId"를 최우선으로 사용
 *  - og:image / twitter:image 를
 *    {CDN_BASE}/og/{pageId}_{slug}_1200x630.jpg 규칙으로 강제 통일
 *
 * 중요:
 *  - pageId를 여기서 새로 발급하면 안 됩니다.
 *    (이미 ids.cjs 단계에서 JSON에 부여했고, 렌더러가 HTML에도 반영해야 함)
 */

const fs = require('fs');
const path = require('path');
const { ensurePageId } = require('./lib/page-ids.cjs');

// ✅ ROOT를 항상 System_files 기준으로 고정
const ROOT = path.resolve(__dirname, '..', '..');
const DIST_DIR = path.join(ROOT, 'dist', 'posts');

const SITE_BASE = process.env.SITE_BASE || 'https://ongsblog.com';
const CDN_BASE = (process.env.CDN_BASE || 'https://ongsblog.com/images').replace(/\/+$/,'');

function listHtmlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.html'))
    .map((f) => path.join(dir, f));
}

/**
 * 1) data-page-id="page000123" 우선
 * 2) page badge 텍스트 "page000123" 차선
 * 3) og:image URL에서 "page000123_" 역추출
 * 4) 전부 없으면 ensurePageId(slug) (최후 수단)
 */
function extractPageIdFromHtml(html) {
  // 1) data-page-id
  const m1 = html.match(/data-page-id=["'](page\d{6})["']/i);
  if (m1 && m1[1]) return m1[1];

  // 2) 배지 텍스트 (id="pageId" 포함 a 태그 내부)
  const m2 = html.match(/id=["']pageId["'][\s\S]*?>(page\d{6})<\/a>/i);
  if (m2 && m2[1]) return m2[1];

  // 3) og:image URL에서 역추출: .../og/page000123_slug_1200x630.jpg
  const m3 = html.match(/\/og\/(page\d{6})_/i);
  if (m3 && m3[1]) return m3[1];

  return '';
}

function upsertMetaTag(html, kind, nameOrProp, content) {
  // kind: 'property' or 'name'
  // nameOrProp: 'og:image' or 'twitter:image'
  const attr = kind === 'property' ? 'property' : 'name';
  const rx = new RegExp(
    `<meta\\s+${attr}=["']${escapeReg(nameOrProp)}["']\\s+content=["'][^"']*["']\\s*\\/?>`,
    'i'
  );

  const tag = `<meta ${attr}="${nameOrProp}" content="${content}">`;

  if (rx.test(html)) {
    return {
      html: html.replace(rx, tag),
      changed: true,
      action: 'replace'
    };
  }

  const headCloseIdx = html.toLowerCase().indexOf('</head>');
  if (headCloseIdx !== -1) {
    const insert = `  ${tag}\n`;
    return {
      html: html.slice(0, headCloseIdx) + insert + html.slice(headCloseIdx),
      changed: true,
      action: 'insert'
    };
  }

  return { html, changed: false, action: 'noop' };
}

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function updateOgAndTwitterImage(html, slugBase) {
  let changed = false;

  // ✅ HTML에서 pageId 먼저 읽는다
  let pageId = extractPageIdFromHtml(html);

  // ✅ 최후수단만 발급(정말 pageId가 HTML에 없을 때)
  if (!pageId) {
    pageId = ensurePageId(slugBase);
  }

  const ogUrl = `${CDN_BASE}/og/${pageId}_${slugBase}_1200x630.jpg`;

  const r1 = upsertMetaTag(html, 'property', 'og:image', ogUrl);
  html = r1.html; changed = changed || r1.changed;

  const r2 = upsertMetaTag(html, 'name', 'twitter:image', ogUrl);
  html = r2.html; changed = changed || r2.changed;

  return { html, changed, pageId, ogUrl };
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[validate] DIST =', DIST_DIR);
  console.log('[validate] SITE_BASE =', SITE_BASE);
  console.log('[validate] CDN_BASE  =', CDN_BASE);

  const files = listHtmlFiles(DIST_DIR);
  if (!files.length) {
    console.log('[validate] 대상 HTML 없음 → 종료');
    return;
  }

  let fixedCount = 0;

  for (const file of files) {
    const filename = path.basename(file);
    const slugBase = filename.replace(/\.html$/i, '');

    const html = fs.readFileSync(file, 'utf8');

    const { html: newHtml, changed, pageId, ogUrl } =
      updateOgAndTwitterImage(html, slugBase);

    if (changed) {
      fs.writeFileSync(file, newHtml, 'utf8');
      fixedCount += 1;
      console.log(`FIX ${filename} → pageId=${pageId}, og/twitter=${ogUrl}`);
    }
  }

  console.log(`✨ validate-repair 완료 — 수정: ${fixedCount}/${files.length}`);
}

main();
