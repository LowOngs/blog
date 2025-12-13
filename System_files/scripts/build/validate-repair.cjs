#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/validate-repair.cjs
 * 역할:
 *  - dist/posts/*.html을 돌면서
 *  - pageId 누락/불일치/OG 이미지 메타 누락을 자동 교정
 *
 * 옹스 룰(강제):
 *  - validate 단계에서 ids.cjs 호출 금지(발급/복구 금지)
 *  - pageId 정답은 content/posts/*.json 이다.
 *  - HTML은 JSON의 pageId로 100% 교정 대상이다.
 *  - HTML에도 없고 JSON에도 없으면 즉시 FAIL (통과 금지)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

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

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getPageIdFromPostJson(slugBase) {
  const file = path.join(POSTS_DIR, `${slugBase}.json`);
  const doc = readJsonSafe(file);
  if (!doc || typeof doc !== 'object') return '';
  const pid = doc.pageId;
  if (typeof pid === 'string' && /^page\d{6}$/.test(pid)) return pid;
  return '';
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
  let changed = false;

  const rx = /(<a\b[^>]*\bid=["']pageId["'][^>]*)(>)/i;
  const m = html.match(rx);
  if (!m) return { html, changed: false };

  const aOpen = m[1];
  const restStart = m.index + aOpen.length;

  // data-page-id가 있든 없든 "정답(pageId)"로 강제
  const cleaned = aOpen.replace(/data-page-id=["'][^"']*["']\s*/i, '');
  const next = `${cleaned} data-page-id="${pageId}"`;

  html = html.slice(0, m.index) + next + html.slice(restStart);
  changed = true;

  return { html, changed };
}

function updateOgAndTwitterImage(html, slugBase) {
  let changed = false;

  const fromJson = getPageIdFromPostJson(slugBase);
  const fromHtml = extractPageIdFromHtml(html);

  // ✅ JSON이 정답. JSON이 없으면 통과 금지.
  if (!fromJson) {
    throw new Error(`pageId missing in JSON: content/posts/${slugBase}.json`);
  }

  // badge data-page-id 교정(선행)
  const b = upsertBadgeDataPageId(html, fromJson);
  html = b.html;
  changed = changed || b.changed;

  // og/twitter 이미지 강제 규칙
  const ogUrl = `${CDN_BASE}/og/${fromJson}_${slugBase}_1200x630.jpg`;

  const r1 = upsertMetaTag(html, 'property', 'og:image', ogUrl);
  html = r1.html; changed = changed || r1.changed;

  const r2 = upsertMetaTag(html, 'name', 'twitter:image', ogUrl);
  html = r2.html; changed = changed || r2.changed;

  // 참고 로그용: HTML과 JSON이 달랐던 경우
  const mismatch = fromHtml && fromHtml !== fromJson;

  return { html, changed, pageId: fromJson, ogUrl, mismatch, fromHtml };
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[validate] DIST      =', DIST_DIR);
  console.log('[validate] POSTS_DIR =', POSTS_DIR);
  console.log('[validate] CDN_BASE  =', CDN_BASE);

  const files = listHtmlFiles(DIST_DIR);
  if (!files.length) {
    console.log('[validate] 대상 HTML 없음 → 종료');
    return;
  }

  let fixedCount = 0;
  let failCount = 0;
  let mismatchCount = 0;

  for (const file of files) {
    const filename = path.basename(file);
    const slugBase = filename.replace(/\.html$/i, '');

    const html = fs.readFileSync(file, 'utf8');

    try {
      const out = updateOgAndTwitterImage(html, slugBase);

      if (out.mismatch) {
        mismatchCount += 1;
        console.warn(`[validate][WARN] pageId mismatch ${filename}: html=${out.fromHtml} json=${out.pageId}`);
      }

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

  console.log(`✨ validate-repair 완료 — 수정: ${fixedCount}/${files.length}, mismatch=${mismatchCount}`);

  if (failCount > 0) {
    console.error(`[validate][FAIL] pageId 회수/검증 실패 ${failCount}건 → 빌드 중단`);
    process.exit(1);
  }
}

main();
