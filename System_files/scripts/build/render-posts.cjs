#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/render-posts.cjs
 * - content/posts/*.json → dist/posts/*.html 렌더러
 *
 * 중요(옹스 룰):
 * - PUBLISH_MODE=disable 이더라도 render 자체는 가능해야 함(로컬 검증)
 * - 단, disable 상태에서 active 발급 루트는 절대 타면 안 됨(결번 방지)
 * - BODY_WRITE_MODE=local 이면 로컬 ledger로 pageId 발급 가능
 * - BODY_WRITE_MODE=active 이면 PUBLISH_MODE=enable일 때만 발급 가능
 * - JSON.pageId가 이미 있으면 어떤 모드든 그대로 사용(정답)
 *
 * + 본문 이미지 1장(있을 때만) 자동 삽입:
 *   - manifests/images-body-manifest.json(or body-images-manifest.json) 조회
 *   - 허용 도메인만 삽입 (기본: ongsblog.com, CDN_BASE 도메인)
 */

const fs = require('fs');
const path = require('path');

const ROOT          = path.resolve(__dirname, '..', '..');   // System_files
const POSTS_DIR     = path.join(ROOT, 'content', 'posts');
const TEMPLATE_PATH = path.join(ROOT, 'templates', 'post.html');
const OUTPUT_DIR    = path.join(ROOT, 'dist', 'posts');

const MANIFESTS_DIR = path.join(ROOT, 'manifests');

// body image manifest 후보
const BODY_IMAGE_MANIFEST_CANDIDATES = [
  path.join(MANIFESTS_DIR, 'images-body-manifest.json'),
  path.join(MANIFESTS_DIR, 'body-images-manifest.json'),
];

// meta.cjs
const { buildMeta } = require('./lib/meta.cjs');
// pageId(ledger)
const { ensurePageId, isValidPageId } = require('./lib/page-ids.cjs');

// content-blocks(있으면 우선)
let contentBlocks = null;
try { contentBlocks = require('./lib/content-blocks.cjs'); } catch { contentBlocks = null; }

/* ───────────────────── 유틸 ───────────────────── */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
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

function loadBodyImageManifestOnce() {
  for (const p of BODY_IMAGE_MANIFEST_CANDIDATES) {
    const obj = tryReadJsonFile(p);
    if (obj && typeof obj === 'object') return { data: obj, source: p };
  }
  return { data: null, source: '' };
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

function pickBodyImageEntry(manifest, slug, pageId) {
  if (!manifest || typeof manifest !== 'object') return null;
  if (manifest[slug]) return manifest[slug];
  if (pageId && manifest[pageId]) return manifest[pageId];
  if (Array.isArray(manifest.items)) {
    const found = manifest.items.find(x => x && (x.slug === slug || x.pageId === pageId));
    if (found) return found;
  }
  return null;
}

function normalizeBodyImage(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return { url: entry, alt: '', w: 0, h: 0, caption: '' };
  if (typeof entry === 'object') {
    const url = entry.url || entry.href || '';
    const alt = entry.alt || entry.altText || '';
    const w = Number(entry.w || entry.width || 0) || 0;
    const h = Number(entry.h || entry.height || 0) || 0;
    const caption = entry.caption || entry.credit || '';
    return { url, alt, w, h, caption };
  }
  return null;
}

function buildBodyImageFigure(img, fallbackAlt) {
  const url = escapeAttr(img.url);
  const alt = escapeAttr(img.alt || fallbackAlt || 'Related image');
  const wAttr = img.w > 0 ? ` width="${img.w}"` : '';
  const hAttr = img.h > 0 ? ` height="${img.h}"` : '';
  const caption = img.caption ? `<figcaption><small>${escapeHtml(img.caption)}</small></figcaption>` : '';

  return [
    `<figure class="post-body-image">`,
    `  <img src="${url}" alt="${alt}" loading="lazy" decoding="async"${wAttr}${hAttr} />`,
    caption ? `  ${caption}` : '',
    `</figure>`,
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

/* ───────────────────── AIO fallback 렌더러 ───────────────────── */

function renderListItems(list) {
  const arr = asArray(list).map(s => (s == null ? '' : String(s).trim())).filter(Boolean);
  if (!arr.length) return '';
  return arr.map(s => `<li>${escapeHtml(s)}</li>`).join('\n');
}

function normalizeFaq(raw) {
  const out = [];
  for (const item of asArray(raw)) {
    if (!item) continue;
    if (typeof item === 'string') {
      const text = item.trim();
      if (!text) continue;
      out.push({ q: text, a: text });
      continue;
    }
    if (typeof item === 'object') {
      const q = firstNonEmpty(item.q, item.question, '');
      const a = firstNonEmpty(item.a, item.answer, '');
      if (!q || !a) continue;
      out.push({ q: String(q), a: String(a) });
    }
  }
  return out;
}

function renderFaq(rawFaq) {
  const faqItems = normalizeFaq(rawFaq);
  if (!faqItems.length) return '';
  return faqItems.map(item => {
    const q = escapeHtml(item.q);
    const a = escapeHtml(item.a);
    return [
      '<article class="faq-item">',
      `  <h4>${q}</h4>`,
      `  <p>${a}</p>`,
      '</article>',
    ].join('\n');
  }).join('\n');
}

function renderSources(rawSources) {
  const sources = asArray(rawSources);
  if (!sources.length) return '';

  const items = [];
  for (const s of sources) {
    if (!s) continue;

    if (typeof s === 'string') {
      const txt = s.trim();
      if (!txt) continue;
      items.push(`<li>${escapeHtml(txt)}</li>`);
      continue;
    }

    if (typeof s === 'object') {
      const url = s.url || s.href || '';
      const label = firstNonEmpty(s.label, s.name, url);
      const note = s.note ? String(s.note).trim() : '';

      if (!url && !label) continue;

      if (url) {
        const safeUrl = escapeAttr(url);
        const safeLabel = escapeHtml(label || url);
        const safeNote = note ? ` — ${escapeHtml(note)}` : '';
        items.push(`<li><a href="${safeUrl}" target="_blank" rel="nofollow noopener noreferrer">${safeLabel}</a>${safeNote}</li>`);
      } else {
        items.push(`<li>${escapeHtml(label)}</li>`);
      }
    }
  }
  return items.join('\n');
}

/* ───────────────────── 메타/헤드 블록 ───────────────────── */

function buildSchemaScriptFromMeta(meta) {
  if (!meta || !Array.isArray(meta.schemaTags) || meta.schemaTags.length === 0) return '';
  const json = JSON.stringify(meta.schemaTags.length === 1 ? meta.schemaTags[0] : meta.schemaTags);
  return `<script type="application/ld+json">${json}</script>`;
}

function buildHeadMetaBlock(post, meta) {
  const title       = meta.title || post.title || 'Untitled';
  const description = meta.summary || post.description || '';
  const canonical   = meta.canonicalUrl;
  const ogImage     = meta.ogImage;
  const ogAlt       = meta.ogAlt || description || title;

  const OG_W = 1200;
  const OG_H = 630;

  const lines = [];
  lines.push(`<link rel="canonical" href="${escapeAttr(canonical)}">`);
  lines.push(`<meta property="og:type" content="article">`);
  lines.push(`<meta property="og:url" content="${escapeAttr(canonical)}">`);
  lines.push(`<meta property="og:title" content="${escapeAttr(title)}">`);
  if (description) lines.push(`<meta property="og:description" content="${escapeAttr(description)}">`);

  if (ogImage) {
    lines.push(`<meta property="og:image" content="${escapeAttr(ogImage)}">`);
    lines.push(`<meta property="og:image:alt" content="${escapeAttr(ogAlt)}">`);
    lines.push(`<meta property="og:image:width" content="${OG_W}">`);
    lines.push(`<meta property="og:image:height" content="${OG_H}">`);
  }

  lines.push(`<meta name="twitter:card" content="summary_large_image">`);
  lines.push(`<meta name="twitter:title" content="${escapeAttr(title)}">`);
  if (description) lines.push(`<meta name="twitter:description" content="${escapeAttr(description)}">`);
  if (ogImage) {
    lines.push(`<meta name="twitter:image" content="${escapeAttr(ogImage)}">`);
    lines.push(`<meta name="twitter:image:alt" content="${escapeAttr(ogAlt)}">`);
  }

  if (meta.publishedIso) {
    lines.push(`<meta property="article:published_time" content="${escapeAttr(meta.publishedIso)}">`);
  }
  if (meta.updatedIso) {
    lines.push(`<meta property="article:modified_time" content="${escapeAttr(meta.updatedIso)}">`);
    lines.push(`<meta property="og:updated_time" content="${escapeAttr(meta.updatedIso)}">`);
  }

  if (ogImage) {
    lines.push(`<link rel="preload" as="image" href="${escapeAttr(ogImage)}" fetchpriority="high" imagesrcset="${escapeAttr(ogImage)}">`);
  }

  const siteBase = (process.env.CANONICAL_BASE || 'https://ongsblog.com').replace(/\/+$/,'');
  lines.push(`<link rel="preconnect" href="${escapeAttr(siteBase)}" crossorigin>`);

  if (meta.schemaTag) lines.push(meta.schemaTag);
  return lines.join('\n');
}

/* ───────────────────── pageId 확보 ───────────────────── */

function ensurePageIdForPost(postJson, slug, jsonPath) {
  const existing = firstNonEmpty(postJson.pageId, postJson.page_id, postJson.seedMeta && postJson.seedMeta.pageId, '');
  if (isValidPageId(existing)) return { pageId: existing, wroteJson: false, via: 'json' };

  // 여기서부터는 발급 루트. BODY_WRITE_MODE/local/active 규칙은 page-ids.cjs가 통제.
  const pid = ensurePageId(slug); // local이면 허용, active면 publish enable일 때만 허용
  if (!isValidPageId(pid)) throw new Error('pageId 발급 실패');

  postJson.pageId = pid;
  try {
    const obj = readJson(jsonPath);
    obj.pageId = pid;
    writeJson(jsonPath, obj);
  } catch {}
  return { pageId: pid, wroteJson: true, via: 'ledger' };
}

/* ───────────────────── 블록 선택 ───────────────────── */

function resolveAioLocal(postJson) {
  const aio = postJson.aio && typeof postJson.aio === 'object' ? postJson.aio : {};
  return {
    tldr: firstNonEmpty(aio.tldr, postJson.tldr, []),
    keyfacts: firstNonEmpty(aio.keyfacts, postJson.keyfacts, []),
    faq: firstNonEmpty(aio.faq, postJson.faq, []),
    sources: firstNonEmpty(aio.sources, postJson.sources, []),
    heroImage: aio.heroImage || null,
  };
}

function pickBlocks(postJson) {
  const aio = (contentBlocks && typeof contentBlocks.resolveAio === 'function')
    ? contentBlocks.resolveAio(postJson)
    : resolveAioLocal(postJson);

  const renderTldrFn = (contentBlocks && (contentBlocks.renderTldr || contentBlocks.renderListItems)) || null;
  const renderKeyFactsFn = (contentBlocks && (contentBlocks.renderKeyFacts || contentBlocks.renderListItems)) || null;
  const renderFaqFn = (contentBlocks && contentBlocks.renderFaq) || null;
  const renderSourcesFn = (contentBlocks && contentBlocks.renderSources) || null;

  return {
    aio,
    renderTldr: renderTldrFn ? (v) => renderTldrFn(v) : (v) => renderListItems(v),
    renderKeyFacts: renderKeyFactsFn ? (v) => renderKeyFactsFn(v) : (v) => renderListItems(v),
    renderFaq: renderFaqFn ? (v) => renderFaqFn(v) : (v) => renderFaq(v),
    renderSources: renderSourcesFn ? (v) => renderSourcesFn(v) : (v) => renderSources(v),
  };
}

/* ───────────────────── 렌더 ───────────────────── */

function renderOne(template, postJson, jsonPath, bodyImgCtx) {
  const slug = postJson.slug || path.basename(jsonPath, '.json');

  const pidRes = ensurePageIdForPost(postJson, slug, jsonPath);
  const pageId = pidRes.pageId;

  const siteBase = process.env.CANONICAL_BASE || process.env.SITE_BASE || 'https://ongsblog.com';
  const cdnBase  = process.env.CDN_BASE || (siteBase.replace(/\/+$/,'') + '/images');

  const meta = buildMeta(postJson, { slug, pageId, siteBase, cdnBase });
  meta.title = meta.metaTags && meta.metaTags.og ? meta.metaTags.og.title : (postJson.title || slug);
  meta.summary = meta.metaTags && meta.metaTags.og ? meta.metaTags.og.description : (postJson.description || '');
  meta.schemaTag = buildSchemaScriptFromMeta(meta);

  let html = template;

  const title       = meta.title || postJson.title || 'Untitled';
  const description = meta.summary || postJson.description || '';

  html = replaceAllSafe(html, '{{title}}', escapeHtml(title));
  html = replaceAllSafe(html, '{{description}}', escapeAttr(description));
  html = replaceAllSafe(html, '{{pageId}}', escapeHtml(pageId));
  html = replaceAllSafe(html, '{{canonical}}', escapeAttr(meta.canonicalUrl));

  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  html = html.replace(/<meta\s+name=["']description["'][^>]*>/i, `<meta name="description" content="${escapeAttr(description)}" />`);

  const headBlock = buildHeadMetaBlock(postJson, meta);
  html = html.replace(
    '<!-- Schema & 동적 메타(OG/Twitter/Preload/hreflang)는 렌더러가 주입 -->',
    '<!-- Schema & 동적 메타(OG/Twitter/Preload/hreflang)는 렌더러가 주입 -->\n\n' + headBlock
  );

  html = html.replace(/<link\s+rel=["']canonical["'][^>]*>/i, `<link rel="canonical" href="${escapeAttr(meta.canonicalUrl)}">`);

  const updatedDate = (meta.updatedIso || '').slice(0, 10) || '';
  if (updatedDate) html = html.replace('Updated {{updated}}', `Updated ${escapeHtml(updatedDate)}`);

  const heroAlt = meta.ogAlt || description || title || slug;
  const heroImg = meta.ogImage
    ? [
        '<figure class="post-hero">',
        `  <img src="${escapeAttr(meta.ogImage)}" alt="${escapeAttr(heroAlt)}" loading="eager" fetchpriority="high" />`,
        '</figure>',
      ].join('\n')
    : '';

  html = html.replace('<!--SLOT:HERO_IMAGE-->', heroImg ? `${heroImg}\n  <!--SLOT:HERO_IMAGE-->` : '<!--SLOT:HERO_IMAGE-->');

  const blocks = pickBlocks(postJson);
  const aio = blocks.aio;

  html = html.replace('{{tldr}}', blocks.renderTldr(aio.tldr));
  html = html.replace('{{keyfacts}}', blocks.renderKeyFacts(aio.keyfacts));
  html = html.replace('{{faq}}', blocks.renderFaq(aio.faq));
  html = html.replace('{{sources}}', blocks.renderSources(aio.sources));

  // 본문 + (있으면) 본문 이미지 1장
  let bodyHtml = postJson.body || '';

  if (bodyImgCtx && bodyImgCtx.manifest) {
    const entry = pickBodyImageEntry(bodyImgCtx.manifest, slug, pageId);
    const img = normalizeBodyImage(entry);

    if (img && img.url) {
      const allowed = isAllowedImageUrl(img.url, bodyImgCtx.allowedDomains);
      if (allowed) {
        const fallbackAlt = title ? `${title} related image` : `${slug} related image`;
        const fig = buildBodyImageFigure(img, fallbackAlt);
        bodyHtml = fig + '\n' + bodyHtml;
        html = injectBodyImageCssOnce(html);
      }
    }
  }

  html = html.replace('{{body}}', bodyHtml);

  html = html.replace('</head>', `<!-- render-posts: pageId=${escapeHtml(pageId)} via=${escapeHtml(pidRes.via)} -->\n</head>`);
  return html;
}

/* ───────────────────── main ───────────────────── */

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[render-posts] ROOT      =', ROOT);
  console.log('[render-posts] POSTS_DIR =', POSTS_DIR);
  console.log('[render-posts] TEMPLATE  =', TEMPLATE_PATH);
  console.log('[render-posts] OUTPUT    =', OUTPUT_DIR);
  console.log('[render-posts] BODY_WRITE_MODE =', (process.env.BODY_WRITE_MODE || 'local'));
  console.log('[render-posts] PUBLISH_MODE    =', (process.env.PUBLISH_MODE || 'disable'));

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

  // body image manifest
  const siteBase = process.env.CANONICAL_BASE || process.env.SITE_BASE || 'https://ongsblog.com';
  const cdnBase  = process.env.CDN_BASE || (siteBase.replace(/\/+$/,'') + '/images');
  const allowedDomains = parseAllowedDomainsFromEnv(siteBase, cdnBase);

  const m = loadBodyImageManifestOnce();
  const bodyImgCtx = { manifest: m.data, manifestSource: m.source, allowedDomains };

  console.log('[render-posts] BODY_IMAGE_MANIFEST =', bodyImgCtx.manifestSource || '(none)');
  console.log('[render-posts] BODY_IMAGE_ALLOW_DOMAINS =', allowedDomains.join(', ') || '(none)');

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.toLowerCase().endsWith('.json')).sort();

  console.log('[render-posts] 대상 JSON 수 =', files.length);

  let ok = 0;
  let fail = 0;

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
      const html = renderOne(template, json, fullPath, bodyImgCtx);
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
  if (fail > 0) process.exitCode = 1;
}

if (require.main === module) main();
