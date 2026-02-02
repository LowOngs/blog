// FILE: System_files/scripts/build/validate-repair.cjs
#!/usr/bin/env node
'use strict';

require('./lib/env.cjs'); // ✅ 공통 규칙: env 로더 최우선

/**
 * System_files/scripts/build/validate-repair.cjs
 * 역할:
 *  - dist/posts/*.html 순회
 *  - pageId 회수(발급 금지) + OG/Twitter image meta 교정
 *  - [PATCH v2] 이미지 overflow 방지: hero figure/img + 모든 img 반응형 보정
 *
 * 핵심 원칙(옹스 룰):
 *  - validate 단계에서 "새 pageId 발급/할당(ids 실행)" 금지.
 *  - pageId 정답은 content/posts/*.json 이다.
 *  - validate는 render 실수를 100% 커버(회수/삽입)해야 한다.
 *  - 끝까지 못 찾으면 빌드 통과 금지(생명).
 */

const fs = require('fs');
const path = require('path');

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

/**
 * pageId 회수 로직(발급 금지)
 * 0) HTML에서 이미 있으면 사용
 * 1) posts JSON에서 회수(정답)
 * 2) 그래도 없으면 journal 회수(이미 발급된 흔적)
 * 3) 최종 실패: 통과 금지
 */
function ensurePageIdRecovered(slugBase, html) {
  const fromHtml = extractPageIdFromHtml(html);
  if (isValidPageId(fromHtml)) return fromHtml;

  let pid = getPageIdFromPostJson(slugBase);
  if (pid) return pid;

  pid = recoverPageIdFromJournal(slugBase);
  if (pid) return pid;

  throw new Error(`pageId 회수 실패: slug=${slugBase} (HTML/JSON/journal 모두 실패)`);
}

/**
 * meta upsert(속성 순서/추가속성 무관 매칭)
 * - 기존 meta가 있으면 해당 태그를 교체
 * - 없으면 </head> 직전에 삽입
 */
function upsertMetaTag(html, kind, nameOrProp, content) {
  const attr = kind === 'property' ? 'property' : 'name';
  const key = escapeReg(nameOrProp);

  // ✅ 속성 순서 무관 + 다른 속성 있어도 매칭되게
  const rx = new RegExp(
    `<meta\\b(?=[^>]*\\b${attr}=["']${key}["'])(?=[^>]*\\bcontent=["'][^"']*["'])[^>]*\\/?>`,
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
  let changed = false;
  html = html.replace(/<figure\b([^>]*\bclass=["'][^"']*\bpost-hero\b[^"']*["'][^>]*)>/gi, (m, attrs) => {
    if (/style\s*=/.test(attrs)) {
      const out = m.replace(/style\s*=\s*["']([^"']*)["']/i, (mm, css) => {
        if (/overflow\s*:\s*hidden/i.test(css)) return mm;
        const base = (css || '').trim();
        const next = (base ? (base.endsWith(';') ? base : base + ';') : '') + 'overflow:hidden;';
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
  let changed = false;

  html = html.replace(/<img\b([^>]*?)>/gi, (m, attrs) => {
    if (/style\s*=/.test(attrs)) {
      let did = false;
      const out = m.replace(/style\s*=\s*["']([^"']*)["']/i, (mm, css) => {
        let nextCss = css || '';
        const needSemi = () => (nextCss.trim() === '' || nextCss.trim().endsWith(';')) ? '' : ';';
        if (!/max-width\s*:\s*100%/i.test(nextCss)) { nextCss += needSemi() + 'max-width:100%;'; did = true; }
        if (!/height\s*:\s*auto/i.test(nextCss))    { nextCss += needSemi() + 'height:auto;'; did = true; }
        if (!did) return mm;
        changed = true;
        return `style="${nextCss}"`;
      });
      return out;
    }

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
      // 1) OG/twitter/pageId 교정(발급 금지: 회수만)
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
