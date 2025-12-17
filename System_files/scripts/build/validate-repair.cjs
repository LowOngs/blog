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
 *  - pageId 정답은 content/posts/*.json 이다.
 *  - validate는 render 실수를 100% 커버(회수/삽입)해야 한다.
 *  - 끝까지 못 찾으면 빌드 통과 금지(생명).
 *
 * [PATCH v2]
 *  - "이미지 본문 뚫고 나옴" 방지: hero figure/img + 모든 img에 max-width/height 보정
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

const MANIFESTS_DIR = path.join(ROOT, 'manifests');
const JOURNAL_FILE  = path.join(MANIFESTS_DIR, 'pageid-journal.jsonl');

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

function isValidPageId(v) {
  return typeof v === 'string' && /^page\d{6}$/.test(v);
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
  return isValidPageId(pid) ? pid : '';
}

function readFileSafe(p) {
  try {
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
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

function runIdsOnceOrFail() {
  // validate 안에서 무한 재시도 금지(과열). 1회만 시도.
  const script = path.join(ROOT, 'scripts', 'build', 'ids.cjs');
  const r = spawnSync('node', [script], {
    stdio: 'inherit',
    env: process.env,
  });
  if (r.status !== 0) {
    throw new Error('ids.cjs 실행 실패(복구 시도 실패)');
  }
}

/**
 * pageId 회수 로직(발급 금지)
 * 0) HTML에서 이미 있으면 사용
 * 1) posts JSON에서 회수(정답)
 * 2) 그래도 없으면 ids 1회 복구 시도 후 JSON 재조회
 * 3) 그래도 없으면 journal 회수(이미 발급된 흔적)
 * 4) 최종 실패: 통과 금지
 */
function ensurePageIdRecovered(slugBase, html) {
  const fromHtml = extractPageIdFromHtml(html);
  if (isValidPageId(fromHtml)) return fromHtml;

  let pid = getPageIdFromPostJson(slugBase);
  if (pid) return pid;

  runIdsOnceOrFail();
  pid = getPageIdFromPostJson(slugBase);
  if (pid) return pid;

  pid = recoverPageIdFromJournal(slugBase);
  if (pid) return pid;

  throw new Error(`pageId 회수 실패: slug=${slugBase} (HTML/JSON/ids/journal 모두 실패)`);
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

  const pageId = ensurePageIdRecovered(slugBase, html);
  const ogUrl = `${CDN_BASE}/og/${pageId}_${slugBase}_1200x630.jpg`;

  const b = upsertBadgeDataPageId(html, pageId);
  html = b.html;
  changed = changed || b.changed;

  const r1 = upsertMetaTag(html, 'property', 'og:image', ogUrl);
  html = r1.html; changed = changed || r1.changed;

  const r2 = upsertMetaTag(html, 'name', 'twitter:image', ogUrl);
  html = r2.html; changed = changed || r2.changed;

  return { html, changed, pageId, ogUrl };
}

/* ───────────────────── [PATCH v2] 이미지 뚫고 나옴 방지 ───────────────────── */

function ensureHeroFigureOverflowHidden(html) {
  // figure.post-hero가 있으면 overflow:hidden을 인라인으로 강제(중복 삽입 방지)
  let changed = false;
  html = html.replace(/<figure\b([^>]*\bclass=["'][^"']*\bpost-hero\b[^"']*["'][^>]*)>/gi, (m, attrs) => {
    if (/style\s*=/.test(attrs)) {
      // style이 있으면 overflow:hidden만 합치기
      const out = m.replace(/style\s*=\s*["']([^"']*)["']/i, (mm, css) => {
        if (/overflow\s*:\s*hidden/i.test(css)) return mm;
        const next = (css.trim().endsWith(';') ? css.trim() : (css.trim() ? css.trim() + ';' : '')) + 'overflow:hidden;';
        changed = true;
        return `style="${next}"`;
      });
      return out;
    }
    changed = true;
    return `<figure${attrs} style="overflow:hidden;">`;
  });
  return { html, changed };
}

function ensureAllImagesResponsive(html) {
  // 모든 img에 max-width:100%;height:auto;를 인라인으로 강제(이미 있으면 합침)
  let changed = false;

  html = html.replace(/<img\b([^>]*?)>/gi, (m, attrs) => {
    // style 있으면 합치기
    if (/style\s*=/.test(attrs)) {
      let did = false;
      const out = m.replace(/style\s*=\s*["']([^"']*)["']/i, (mm, css) => {
        let nextCss = css || '';
        if (!/max-width\s*:\s*100%/i.test(nextCss)) { nextCss += (nextCss.trim().endsWith(';') || nextCss.trim()==='' ? '' : ';') + 'max-width:100%;'; did = true; }
        if (!/height\s*:\s*auto/i.test(nextCss))    { nextCss += (nextCss.trim().endsWith(';') || nextCss.trim()==='' ? '' : ';') + 'height:auto;'; did = true; }
        if (!did) return mm;
        changed = true;
        return `style="${nextCss}"`;
      });
      return out;
    }

    // style 없으면 새로 추가
    changed = true;
    return `<img${attrs} style="max-width:100%;height:auto;">`;
  });

  return { html, changed };
}

function applyImageOverflowFix(html) {
  let changed = false;

  const a = ensureHeroFigureOverflowHidden(html);
  html = a.html; changed = changed || a.changed;

  const b = ensureAllImagesResponsive(html);
  html = b.html; changed = changed || b.changed;

  return { html, changed };
}

/* ───────────────────── main ───────────────────── */

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[validate] DIST      =', DIST_DIR);
  console.log('[validate] POSTS_DIR =', POSTS_DIR);
  console.log('[validate] JOURNAL   =', JOURNAL_FILE);
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

    const html0 = fs.readFileSync(file, 'utf8');
    let html = html0;
    let changed = false;

    try {
      // 1) 기존 OG/twitter/pageId 교정
      const out = updateOgAndTwitterImage(html, slugBase);
      html = out.html;
      changed = changed || out.changed;

      // 2) ✅ [PATCH v2] 이미지 overflow 방지(최종 안전망)
      const imgFix = applyImageOverflowFix(html);
      html = imgFix.html;
      changed = changed || imgFix.changed;

      if (changed) {
        fs.writeFileSync(file, html, 'utf8');
        fixedCount += 1;
        // out.pageId/out.ogUrl은 out.changed가 false일 수도 있으니 안전하게 표시
        const pid = extractPageIdFromHtml(html) || '(unknown)';
        console.log(`FIX ${filename} → pageId=${pid}`);
      }
    } catch (e) {
      failCount += 1;
      console.error(`[validate][FAIL] ${filename} →`, e.message || e);
    }
  }

  console.log(`✨ validate-repair 완료 — 수정: ${fixedCount}/${files.length}`);

  if (failCount > 0) {
    console.error(`[validate][FAIL] pageId 회수 실패 ${failCount}건 → 빌드 중단`);
    process.exit(1);
  }
}

main();
