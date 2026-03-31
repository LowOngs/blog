#!/usr/bin/env node
'use strict';

require('./lib/env.cjs'); // ✅ 공통 규칙: env 로더 최우선

/** render-posts: content/posts → dist/posts 렌더 (pageId 직접 발급 금지, "뼈대 생성 금지") */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT          = path.resolve(__dirname, '..', '..');   // System_files
const POSTS_DIR     = path.join(ROOT, 'content', 'posts');
const TEMPLATE_PATH = path.join(ROOT, 'templates', 'post.html');
const OUTPUT_DIR    = path.join(ROOT, 'dist', 'posts');

const MANIFESTS_DIR = path.join(ROOT, 'manifests');
const BODY_IMAGE_MANIFEST_PATH = path.join(MANIFESTS_DIR, 'images-body-manifest.json');

const { buildMeta } = require('./lib/meta.cjs');
const { isValidPageId } = require('./lib/page-ids.cjs');
const blocks = require('./lib/blocks.cjs');

/* ─────────────────────────────────────────────
 * 역할 원칙(지도/합의 반영)
 *
 * What: render는 "템플릿 뼈대"에 데이터만 채운다.
 * Why : 템플릿(post.html)이 구조를 책임지고, render는 조립/치환만 해야 한다.
 * I/O : READ templates/post.html + content/posts/*.json
 *       WRITE dist/posts/*.html
 * Invariants:
 *  - render가 FAQ/Sources/Review 같은 "섹션 뼈대"를 새로 만들지 않는다.
 *  - 템플릿에 이미 존재하는 id를 render에서 중복 생성하지 않는다.
 *  - Review는 render 단계에서 절대 주입/생성/치환하지 않는다(후속 injector 책임).
 *  - ✅ FAQ/Sources는 템플릿에 <section id="faq|sources">가 존재한다는 전제(SSOT).
 *    render는 {{faq}} / {{sources}}에 "내용 조각"만 치환한다.
 *  - ✅ dist/posts 는 산출물 폴더이므로 렌더 직전 기존 *.html 을 초기화한다.
 *    과거 오염 산출물 잔존으로 QA가 깨지는 문제를 방지한다.
 * ───────────────────────────────────────────── */

/* ───────────────────── file/json ───────────────────── */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/\n/g, ' ');
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    return v;
  }
  return '';
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function replaceAllSafe(html, needle, value) {
  return html.split(needle).join(value);
}

function tryReadJsonFile(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return readJson(p);
  } catch {
    return null;
  }
}

/* ───────────────────── dist cleanup ───────────────────── */

/**
 * What: dist/posts 내부 기존 html 산출물을 렌더 직전 제거한다.
 * Why : dist/posts 는 SSOT가 아니라 산출물 폴더이므로,
 *       과거 오염 html 잔존으로 qa-check 가 현재 코드와 무관한 실패를 내는 문제를 차단한다.
 * I/O : READ/WRITE dist/posts 디렉터리
 * Invariants:
 *  - *.html 산출물만 제거
 *  - 디렉터리 자체는 유지
 *  - html 외 파일은 건드리지 않음
 */
function clearOutputHtmlFiles(dir) {
  if (!fs.existsSync(dir)) return { removed: 0 };

  const names = fs.readdirSync(dir);
  let removed = 0;

  for (const name of names) {
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }

    if (!stat.isFile()) continue;
    if (!name.toLowerCase().endsWith('.html')) continue;

    fs.unlinkSync(full);
    removed += 1;
  }

  return { removed };
}

/* ───────────────────── fragment normalizer ───────────────────── */

/**
 * What: sources가 래퍼(<section id="sources">)까지 들어오면 내부만 사용
 * Why : post.html 템플릿이 sources 섹션 뼈대를 SSOT로 갖고 있으므로 중복 생성 방지
 * I/O : READ fragment HTML, WRITE fragment HTML
 * Invariants:
 *  - <section id="sources"> 래퍼가 있으면 내부만 추출
 *  - 내부 추출 실패 시 원본을 그대로 반환(보수적)
 */
function stripOuterSourcesSection(fragmentHtml) {
  const s = String(fragmentHtml || '').trim();
  if (!s) return '';
  const re = /^\s*<section\b[^>]*\bid=["']sources["'][^>]*>([\s\S]*?)<\/section>\s*$/i;
  const m = s.match(re);
  if (!m) return s;
  return String(m[1] || '').trim();
}

/* ───────────────────── canonical dedupe (핵심) ───────────────────── */

/**
 * What: 템플릿에 이미 존재하는 canonical <link>를 제거한다.
 * Why : meta.headHtml이 canonical을 생성하므로, dist head에서 canonical은 1개만 남겨야 한다.
 * I/O : READ/WRITE dist HTML 문자열
 * Invariants:
 *  - <link rel="canonical" ...>는 head에 1개만 존재
 *  - SSOT canonical은 meta.cjs(buildHeadFromMetaResult) 결과를 따른다.
 */
function stripAllCanonicalLinks(html) {
  return String(html || '').replace(/<link\b[^>]*\brel=["']canonical["'][^>]*>\s*/gi, '');
}

/* ───────────────────── hidden toggle helper ───────────────────── */

function isBlankHtmlFragment(s) {
  const t = String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .trim();
  return t.length === 0;
}

function toggleSectionHidden(html, sectionId, shouldHide) {
  const reOpen = new RegExp(`(<section[^>]*id=["']${sectionId}["'][^>]*)(>)`, 'i');
  const reHidden = new RegExp(`(<section[^>]*id=["']${sectionId}["'][^>]*?)\\s+hidden\\b`, 'i');

  if (shouldHide) {
    return html.replace(reOpen, (m, a, b) => (/\shidden\b/i.test(a) ? m : `${a} hidden${b}`));
  }
  return html.replace(reHidden, '$1');
}

/* ───────────────────── ids rerun ───────────────────── */

function runIdsOnce() {
  const idsPath = path.join(__dirname, 'ids.cjs');
  const r = spawnSync(process.execPath, [idsPath], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  return r.status === 0;
}

/* ───────────────────── body image ───────────────────── */

function loadBodyImageManifestOnce() {
  const obj = tryReadJsonFile(BODY_IMAGE_MANIFEST_PATH);
  if (!obj || typeof obj !== 'object') return { data: null, source: BODY_IMAGE_MANIFEST_PATH };
  if (!obj.items || typeof obj.items !== 'object') return { data: null, source: BODY_IMAGE_MANIFEST_PATH };
  return { data: obj, source: BODY_IMAGE_MANIFEST_PATH };
}

function parseAllowedDomainsFromEnv(siteBase, cdnBase) {
  const list = (process.env.BODY_IMAGE_ALLOW_DOMAINS || '').trim();

  const defaults = [];
  try { defaults.push(new URL(siteBase).hostname); } catch {}
  try { defaults.push(new URL(cdnBase).hostname); } catch {}

  const envDomains = list ? list.split(',').map(s => s.trim()).filter(Boolean) : [];
  const set = new Set([...defaults, ...envDomains]);

  return Array.from(set).filter(Boolean);
}

function isAllowedImageUrl(url, allowedDomains) {
  if (!url || typeof url !== 'string') return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname;
  return allowedDomains.some(d => d === host || host.endsWith('.' + d));
}

function pickBodyImageEntry(manifestObj, slug, pageId) {
  if (!manifestObj || typeof manifestObj !== 'object') return null;
  const items = manifestObj.items;
  if (!items || typeof items !== 'object') return null;
  if (slug && items[slug]) return items[slug];
  if (pageId && items[pageId]) return items[pageId];
  return null;
}

function normalizeBodyImage(entry) {
  if (!entry) return null;

  if (typeof entry === 'string') {
    return { url: entry, alt: '', w: 0, h: 0, caption: '', safe: true };
  }

  if (typeof entry === 'object') {
    const url = entry.url || entry.href || '';
    const alt = entry.alt || entry.altText || '';
    const w = Number(entry.w || entry.width || 0) || 0;
    const h = Number(entry.h || entry.height || 0) || 0;
    const caption = entry.caption || entry.credit || '';
    const safe = (entry.safe === undefined) ? true : !!entry.safe;
    return { url, alt, w, h, caption, safe };
  }

  return null;
}

function buildBodyImageFigure(img, fallbackAlt) {
  const url = escapeAttr(img.url);
  const alt = escapeAttr(img.alt || fallbackAlt || 'Related image');

  const wAttr = img.w > 0 ? ` width="${img.w}"` : '';
  const hAttr = img.h > 0 ? ` height="${img.h}"` : '';

  const caption = img.caption
    ? `<figcaption><small>${escapeHtml(img.caption)}</small></figcaption>`
    : '';

  return [
    `<figure class="post-body-image">`,
    `  <img src="${url}" alt="${alt}" loading="lazy" decoding="async"${wAttr}${hAttr} />`,
    caption ? `  ${caption}` : '',
    `</figure>`,
    '',
  ].filter(Boolean).join('\n');
}

function injectBodyImageCssOnce(html) {
  if (html.includes('/* body-image-css */')) return html;

  const css = [
    '<style>',
    '  /* body-image-css */',
    '  .post-body-image{ margin:16px 0; }',
    '  .post-body-image img{ display:block; width:100%; max-width:100%; height:auto; border-radius:var(--radius,10px); }',
    '  .post-body-image figcaption{ margin-top:6px; font-size:12px; opacity:.75; }',
    '</style>',
    '',
  ].join('\n');

  const headCloseIdx = html.toLowerCase().indexOf('</head>');
  if (headCloseIdx !== -1) {
    return html.slice(0, headCloseIdx) + css + html.slice(headCloseIdx);
  }
  return html;
}

/* ───────────────────── pageId policy ───────────────────── */

function ensurePageIdForPost(postJson, slug, jsonPath, idsCtx) {
  const existing = firstNonEmpty(
    postJson.pageId,
    postJson.page_id,
    postJson.seedMeta && postJson.seedMeta.pageId,
    ''
  );

  if (isValidPageId(existing)) return { pageId: existing, wroteJson: false, via: 'json' };

  if (!idsCtx.reran) {
    console.log(`[render-posts] pageId 누락(slug=${slug}) → ids.cjs 1회 재실행`);
    const ok = runIdsOnce();
    idsCtx.reran = true;
    if (!ok) throw new Error('ids.cjs 실행 실패');
  }

  const fresh = readJson(jsonPath);
  const pid = firstNonEmpty(
    fresh.pageId,
    fresh.page_id,
    fresh.seedMeta && fresh.seedMeta.pageId,
    ''
  );

  if (!isValidPageId(pid)) {
    throw new Error('pageId 누락: ids 재실행 후에도 생성되지 않음(today publishable 대상이 아닐 가능성)');
  }

  return { pageId: pid, wroteJson: false, via: 'ids.cjs' };
}

/* ✅ 국부 수정: meta.aio 우선 사용, 없으면 기존 fallback 유지 */
function resolveAio(postJson, meta) {
  if (meta && meta.aio) {
    return {
      tldr: firstNonEmpty(meta.aio.tldr, []),
      keyfacts: firstNonEmpty(meta.aio.keyfacts, []),
      faq: firstNonEmpty(meta.aio.faq, []),
      sources: firstNonEmpty(meta.aio.sources, []),
    };
  }

  const aio = postJson.aio && typeof postJson.aio === 'object' ? postJson.aio : {};
  return {
    tldr: firstNonEmpty(aio.tldr, postJson.tldr, []),
    keyfacts: firstNonEmpty(aio.keyfacts, postJson.keyfacts, []),
    faq: firstNonEmpty(aio.faq, postJson.faq, []),
    sources: firstNonEmpty(aio.sources, postJson.sources, []),
  };
}

/* ───────────────────── render one ───────────────────── */

function renderOne(template, postJson, jsonPath, bodyImgCtx, idsCtx) {
  const slug = postJson.slug || path.basename(jsonPath, '.json');

  const pidRes = ensurePageIdForPost(postJson, slug, jsonPath, idsCtx);
  const pageId = pidRes.pageId;

  const siteBase = (process.env.CANONICAL_BASE || process.env.SITE_BASE || 'https://ongsblog.com').replace(/\/+$/,'');
  const cdnBase  = (process.env.CDN_BASE || (siteBase + '/images')).replace(/\/+$/,'');

  const meta = buildMeta(postJson, { slug, pageId, siteBase, cdnBase });

  const og = meta.metaTags && meta.metaTags.og ? meta.metaTags.og : {};
  const title       = og.title || postJson.title || slug;
  const description = og.description || postJson.description || '';
  const canonical   = meta.canonicalUrl;
  const heroImage   = meta.ogImage;
  const heroAlt     = meta.ogAlt || description || title;

  const updatedDate = (meta.updatedIso || '').slice(0, 10) || '';

  /* ✅ 국부 수정: meta.aio 연결 */
  const aio = resolveAio(postJson, meta);

  const tldrHtml    = blocks.renderTLDR(asArray(aio.tldr));
  const kfHtml      = blocks.renderKeyFacts(asArray(aio.keyfacts));
  const faqHtml     = blocks.renderFAQ(asArray(aio.faq));          // ✅ {{faq}} = "내용 조각"

  const rawSources  = blocks.renderSources(asArray(aio.sources));  // ✅ {{sources}} = "내용 조각"
  const sourcesHtml = stripOuterSourcesSection(rawSources);

  let bodyHtml = blocks.sanitizeBodyHTML(postJson.body || '');

  if (bodyImgCtx && bodyImgCtx.manifestObj) {
    const entry = pickBodyImageEntry(bodyImgCtx.manifestObj, slug, pageId);
    const img = normalizeBodyImage(entry);

    if (img && img.url) {
      if (img.safe === false) {
        // skip
      } else if (isAllowedImageUrl(img.url, bodyImgCtx.allowedDomains)) {
        const fallbackAlt = title ? `${title} related image` : `${slug} related image`;
        bodyHtml = buildBodyImageFigure(img, fallbackAlt) + '\n' + bodyHtml;
      }
    }
  }

  let html = template;

  html = replaceAllSafe(html, '{{title}}', escapeHtml(title));
  html = replaceAllSafe(html, '{{description}}', escapeAttr(description));
  html = replaceAllSafe(html, '{{pageId}}', escapeHtml(pageId));
  html = replaceAllSafe(html, '{{canonical}}', escapeAttr(canonical));

  html = replaceAllSafe(html, '{{heroImage}}', escapeAttr(heroImage));
  html = replaceAllSafe(html, '{{heroAlt}}', escapeAttr(heroAlt));

  html = replaceAllSafe(html, '{{tldr}}', tldrHtml);
  html = replaceAllSafe(html, '{{keyfacts}}', kfHtml);
  html = replaceAllSafe(html, '{{body}}', bodyHtml);

  html = replaceAllSafe(html, '{{faq}}', faqHtml);
  html = replaceAllSafe(html, '{{sources}}', sourcesHtml);

  html = toggleSectionHidden(html, 'faq', isBlankHtmlFragment(faqHtml));
  html = toggleSectionHidden(html, 'sources', isBlankHtmlFragment(sourcesHtml));

  if (updatedDate) html = html.replace('Updated {{updated}}', `Updated ${escapeHtml(updatedDate)}`);

  if (!meta.headHtml || typeof meta.headHtml !== 'string') {
    throw new Error('meta.headHtml 누락: head 생성 책임은 meta.cjs 단일 공장이어야 함');
  }

  // ✅ canonical 중복 제거: 템플릿 canonical은 제거하고 meta.headHtml만 남긴다.
  html = stripAllCanonicalLinks(html);
  html = html.replace('<!--META-->', meta.headHtml);

  if (bodyHtml.includes('class="post-body-image"')) html = injectBodyImageCssOnce(html);

  html = html.replace(
    '</head>',
    `<!-- render-posts: pageId=${escapeHtml(pageId)} via=${escapeHtml(pidRes.via)} bodyImage=${bodyImgCtx && bodyImgCtx.manifestLoaded ? 'on' : 'off'} -->\n</head>`
  );

  return html;
}

/* ───────────────────── main ───────────────────── */

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[render-posts] ROOT      =', ROOT);
  console.log('[render-posts] POSTS_DIR =', POSTS_DIR);
  console.log('[render-posts] TEMPLATE  =', TEMPLATE_PATH);
  console.log('[render-posts] OUTPUT    =', OUTPUT_DIR);
  console.log('────────────────────────────────────────────');

  ensureDir(OUTPUT_DIR);
  ensureDir(MANIFESTS_DIR);

  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error('[render-posts] post.html 템플릿 없음:', TEMPLATE_PATH);
    process.exit(1);
  }
  if (!fs.existsSync(POSTS_DIR)) {
    console.warn('[render-posts] POSTS_DIR 없음 → 종료');
    process.exit(0);
  }

  // ✅ 국부 추가: dist/posts 산출물 초기화
  const cleared = clearOutputHtmlFiles(OUTPUT_DIR);
  console.log('[render-posts] OUTPUT_HTML_CLEARED =', cleared.removed);

  const siteBase = (process.env.CANONICAL_BASE || process.env.SITE_BASE || 'https://ongsblog.com').replace(/\/+$/,'');
  const cdnBase  = (process.env.CDN_BASE || (siteBase + '/images')).replace(/\/+$/,'');

  const allowedDomains = parseAllowedDomainsFromEnv(siteBase, cdnBase);

  const m = loadBodyImageManifestOnce();
  const bodyImgCtx = {
    manifestObj: m.data,
    manifestSource: m.source,
    manifestLoaded: !!m.data,
    allowedDomains,
  };

  console.log('[render-posts] BODY_IMAGE_MANIFEST =', bodyImgCtx.manifestSource);
  console.log('[render-posts] BODY_IMAGE_MANIFEST_LOADED =', bodyImgCtx.manifestLoaded);

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  const files = fs.readdirSync(POSTS_DIR).filter(f => f.toLowerCase().endsWith('.json')).sort();
  console.log('[render-posts] 대상 JSON 수 =', files.length);

  let ok = 0;
  let fail = 0;
  const idsCtx = { reran: false };

  for (const file of files) {
    const fullPath = path.join(POSTS_DIR, file);

    let json;
    try { json = readJson(fullPath); }
    catch (e) {
      console.error('[render-posts] JSON 파싱 실패:', file, e.message);
      fail++; continue;
    }

    const slug = json.slug || path.basename(file, '.json');
    const outPath = path.join(OUTPUT_DIR, `${slug}.html`);

    try {
      const html = renderOne(template, json, fullPath, bodyImgCtx, idsCtx);
      fs.writeFileSync(outPath, html, 'utf8');
      console.log('[render-posts] ✓', path.basename(outPath));
      ok++;
    } catch (e) {
      console.error('[render-posts] FAIL:', file, e.message);
      fail++;
    }
  }

  console.log('────────────────────────────────────────────');
  console.log(`[render-posts] 결과: 성공=${ok}, 실패=${fail}`);
  console.log('────────────────────────────────────────────');

  if (fail > 0) process.exitCode = 1;
}

if (require.main === module) main();
