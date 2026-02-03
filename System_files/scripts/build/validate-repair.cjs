#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/validate-repair.cjs
 *
 * 역할(응급처치/최후 안전망):
 *  - dist/posts/*.html을 순회하며
 *    1) pageId 회수(발급 금지) → badge(data-page-id) 동기화
 *    2) og:image / twitter:image 를 “정확히 1개”로 정규화(멱등)
 *  - 끝까지 pageId 회수 실패 시 빌드 통과 금지(생명)
 *
 * 원칙(옹스 룰):
 *  - validate 단계에서 ids.cjs 실행(발급/생성) 금지
 *  - pageId SSOT: content/posts/*.json
 *  - journal은 “이미 발급된 흔적” 회수 보조(없으면 무시)
 *  - HTML 비대화 유발 요소(전 img 인라인 주입 등) 제거
 */

require('./lib/env.cjs'); // ✅ 공통 규칙: env 로더 최우선

const fs = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '..', '..'); // System_files
const DIST_DIR  = path.join(ROOT, 'dist', 'posts');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

const MANIFESTS_DIR = path.join(ROOT, 'manifests');
const JOURNAL_FILE  = path.join(MANIFESTS_DIR, 'pageid-journal.jsonl');

const SITE_BASE = (process.env.SITE_BASE || process.env.CANONICAL_BASE || 'https://ongsblog.com').replace(/\/+$/, '');
const CDN_BASE  = (process.env.CDN_BASE || (SITE_BASE + '/images')).replace(/\/+$/, '');

function isValidPageId(v) {
  return typeof v === 'string' && /^page\d{6}$/.test(v);
}

function listHtmlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.html'))
    .map(f => path.join(dir, f));
}

function readFileSafe(p) {
  try {
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 1) data-page-id="page000123" 우선
 * 2) page badge 텍스트 "page000123" 차선
 * 3) og:image URL에서 "page000123_" 역추출(보조)
 */
function extractPageIdFromHtml(html) {
  const h = String(html || '');
  let m = h.match(/data-page-id=["'](page\d{6})["']/i);
  if (m && m[1]) return m[1];

  m = h.match(/id=["']pageId["'][\s\S]*?>(page\d{6})<\/a>/i);
  if (m && m[1]) return m[1];

  m = h.match(/\/og\/(page\d{6})_/i);
  if (m && m[1]) return m[1];

  return '';
}

function getPageIdFromPostJson(slugBase) {
  const file = path.join(POSTS_DIR, `${slugBase}.json`);
  const doc = readJsonSafe(file, null);
  if (!doc || typeof doc !== 'object') return '';
  const pid = doc.pageId;
  return isValidPageId(pid) ? pid : '';
}

function recoverPageIdFromJournal(slug) {
  const raw = readFileSafe(JOURNAL_FILE);
  if (!raw) return '';

  const lines = raw.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && rec.slug === slug && isValidPageId(rec.pageId)) return rec.pageId;
    } catch {}
  }
  return '';
}

/**
 * pageId 회수 로직(발급 금지)
 * 0) HTML에서 이미 있으면 사용
 * 1) posts JSON에서 회수(정답)
 * 2) journal에서 회수(이미 발급된 흔적)
 * 3) 최종 실패: 통과 금지
 */
function ensurePageIdRecovered(slugBase, html) {
  const fromHtml = extractPageIdFromHtml(html);
  if (isValidPageId(fromHtml)) return { pageId: fromHtml, via: 'html' };

  const fromJson = getPageIdFromPostJson(slugBase);
  if (isValidPageId(fromJson)) return { pageId: fromJson, via: 'json' };

  const fromJournal = recoverPageIdFromJournal(slugBase);
  if (isValidPageId(fromJournal)) return { pageId: fromJournal, via: 'journal' };

  throw new Error(`pageId 회수 실패: slug=${slugBase} (HTML/JSON/journal 모두 실패)`);
}

/**
 * page badge(<a id="pageId" ...>)의 data-page-id를 “정답 pageId”로 동기화
 * - 없으면 삽입까지는 하지 않고 FAIL 처리(계약 파손으로 간주)
 */
function syncBadgePageId(html, pageId) {
  const h = String(html || '');
  const re = /<a\b([^>]*\bid=["']pageId["'][^>]*)>([\s\S]*?)<\/a>/i;
  const m = h.match(re);
  if (!m) {
    return { html: h, changed: false, ok: false, reason: 'page badge missing' };
  }

  const full = m[0];
  const attrs = m[1];
  const inner = m[2];

  // 1) data-page-id 속성 교체/추가
  let newAttrs = attrs;
  if (/data-page-id\s*=\s*["'][^"']*["']/i.test(newAttrs)) {
    newAttrs = newAttrs.replace(/data-page-id\s*=\s*["'][^"']*["']/i, `data-page-id="${pageId}"`);
  } else {
    newAttrs = newAttrs + ` data-page-id="${pageId}"`;
  }

  // 2) inner 텍스트에 pageId가 있으면 교체(없어도 강제 삽입은 안 함)
  let newInner = inner;
  if (/\bpage\d{6}\b/i.test(newInner)) {
    newInner = newInner.replace(/\bpage\d{6}\b/i, pageId);
  }

  const replaced = `<a${newAttrs}>${newInner}</a>`;
  if (replaced === full) {
    return { html: h, changed: false, ok: true };
  }
  return { html: h.replace(full, replaced), changed: true, ok: true };
}

/* ───────────────────── 멱등 메타 정규화 ───────────────────── */

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeAttr(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, ' ');
}

function normalizeAttrValue(s) {
  return String(s || '').trim();
}

/**
 * 메타 태그를 “정확히 1개”로 정규화(멱등)
 * - 이미 1개이고 content가 동일하면 변경하지 않음(=write 안 함)
 * - 그 외(0개/복수/값 불일치)는 전부 제거 후 head 닫기 직전에 1개 삽입
 */
function setSingleMeta(html, kind, key, content) {
  const original = String(html || '');
  const attr = kind === 'property' ? 'property' : 'name';
  const desired = normalizeAttrValue(content);

  // 1) 현재 존재하는 동일 key 메타들의 content 수집
  const findRe = new RegExp(
    `<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${escapeReg(key)}["'][^>]*>`,
    'gi'
  );
  const contentRe = /\bcontent\s*=\s*["']([^"']*)["']/i;

  const found = [];
  let m;
  while ((m = findRe.exec(original))) {
    const tag = m[0];
    const cm = tag.match(contentRe);
    const v = cm && cm[1] ? normalizeAttrValue(cm[1]) : '';
    found.push({ tag, content: v });
  }

  // ✅ 멱등 fast-path:
  // - 정확히 1개 존재
  // - 그 content가 desired와 동일
  // - 그 경우 아무 것도 하지 않음
  if (found.length === 1 && found[0].content === desired) {
    return { html: original, changed: false, inserted: false };
  }

  // 2) 제거(멱등) 후 1개 삽입
  const removeRe = new RegExp(
    `<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${escapeReg(key)}["'][^>]*>\\s*`,
    'gi'
  );
  let out = original.replace(removeRe, '');

  const headCloseIdx = out.toLowerCase().indexOf('</head>');
  if (headCloseIdx === -1) {
    // head가 없으면 삽입 자체 불가. 제거만 수행될 수도 있으니 diff로 판단.
    return { html: out, changed: (out !== original), inserted: false };
  }

  const tag = `<meta ${attr}="${key}" content="${escapeAttr(desired)}">`;
  const insert = `  ${tag}\n`;
  out = out.slice(0, headCloseIdx) + insert + out.slice(headCloseIdx);

  return { html: out, changed: (out !== original), inserted: true };
}

function buildOgUrl(pageId, slugBase) {
  return `${CDN_BASE}/og/${pageId}_${slugBase}_1200x630.jpg`;
}

/**
 * og:image & twitter:image 응급 교정(멱등)
 */
function repairOgAndTwitter(html, pageId, slugBase) {
  const ogUrl = buildOgUrl(pageId, slugBase);

  let changed = false;

  const r1 = setSingleMeta(html, 'property', 'og:image', ogUrl);
  html = r1.html; changed = changed || r1.changed;

  const r2 = setSingleMeta(html, 'name', 'twitter:image', ogUrl);
  html = r2.html; changed = changed || r2.changed;

  return { html, changed, ogUrl };
}

/* ───────────────────── main ───────────────────── */

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[validate-repair] ROOT      =', ROOT);
  console.log('[validate-repair] DIST      =', DIST_DIR);
  console.log('[validate-repair] POSTS_DIR =', POSTS_DIR);
  console.log('[validate-repair] JOURNAL   =', JOURNAL_FILE);
  console.log('[validate-repair] SITE_BASE =', SITE_BASE);
  console.log('[validate-repair] CDN_BASE  =', CDN_BASE);
  console.log('────────────────────────────────────────────');

  const files = listHtmlFiles(DIST_DIR);
  if (!files.length) {
    console.log('[validate-repair] 대상 HTML 없음 → 종료');
    return;
  }

  let fixedCount = 0;
  let failCount = 0;

  for (const file of files) {
    const filename = path.basename(file);
    const slugBase = filename.replace(/\.html$/i, '');

    const html0 = readFileSafe(file);
    if (!html0) {
      console.error(`[validate-repair][FAIL] ${filename} → HTML 읽기 실패`);
      failCount++;
      continue;
    }

    let html = html0;
    let changed = false;

    try {
      // 1) pageId 회수(발급 금지)
      const rec = ensurePageIdRecovered(slugBase, html);
      const pageId = rec.pageId;

      // 2) badge 동기화(없으면 계약 파손 → FAIL)
      const b = syncBadgePageId(html, pageId);
      html = b.html;
      changed = changed || b.changed;

      if (!b.ok) {
        throw new Error(`page badge(id="pageId") 누락 → 계약 파손(응급처치 불가)`);
      }

      // 3) og/twitter 메타를 “정확히 1개”로 정규화(멱등)
      const m = repairOgAndTwitter(html, pageId, slugBase);
      html = m.html;
      changed = changed || m.changed;

      if (changed) {
        fs.writeFileSync(file, html, 'utf8');
        fixedCount++;
        console.log(`FIX ${filename} → pageId=${pageId} via=${rec.via}`);
      }
    } catch (e) {
      failCount++;
      console.error(`[validate-repair][FAIL] ${filename} →`, e && e.message ? e.message : String(e));
    }
  }

  console.log('────────────────────────────────────────────');
  console.log(`✨ validate-repair 완료 — 수정: ${fixedCount}/${files.length}`);
  console.log(`✨ validate-repair 완료 — 실패: ${failCount}/${files.length}`);
  console.log('────────────────────────────────────────────');

  if (failCount > 0) process.exit(1);
}

main();
