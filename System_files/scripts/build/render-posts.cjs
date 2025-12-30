#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/render-posts.cjs
 * - content/posts/*.json → dist/posts/*.html 렌더러
 *
 * ✅ 정합 기준
 * - meta.cjs(buildMeta)가 반환하는 metaTags/schemaTags/canonicalUrl/ogImage/ogAlt/updatedIso/publishedIso 사용
 * - blocks.js 렌더러 사용(TLDR/KeyFacts/FAQ/Sources/Review + sanitizeBodyHTML)
 * - content-blocks.cjs 는 "검사용" (여기서는 렌더에 사용하지 않음)
 */

const fs = require('fs');
const path = require('path');

const ROOT          = path.resolve(__dirname, '..', '..');   // System_files
const POSTS_DIR     = path.join(ROOT, 'content', 'posts');
const TEMPLATE_PATH = path.join(ROOT, 'templates', 'post.html');
const OUTPUT_DIR    = path.join(ROOT, 'dist', 'posts');

const MANIFESTS_DIR = path.join(ROOT, 'manifests');

// body image manifest 후보 (있으면 1장만 prepend)
const BODY_IMAGE_MANIFEST_CANDIDATES = [
  path.join(MANIFESTS_DIR, 'images-body-manifest.json'),
  path.join(MANIFESTS_DIR, 'body-images-manifest.json'),
];

// meta + pageId
const { buildMeta } = require('./lib/meta.cjs');
const { ensurePageId, isValidPageId } = require('./lib/page-ids.cjs');

// ✅ 렌더 블록(필수)
const blocks = require('./lib/blocks.js');

/* ───────────────────── 유틸 ───────────────────── */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

/* ───────────────────── body image (선택) ───────────────────── */

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

/* ───────────────────── meta head 생성 (meta.cjs 반환값 기반) ───────────────────── */

function buildSchemaScript(schemaTags) {
  if (!Array.isArray(schemaTags) || schemaTags.length === 0) return '';
  const json = JSON.stringify(schemaTags.length === 1 ? schemaTags[0] : schemaTags);
  return `<script type="application/ld+json">${json}</script>`;
}

function buildHeadFromMeta(meta) {
  const og = (meta && meta.metaTags && meta.metaTags.og) ? meta.metaTags.og : {};
  const tw = (meta && meta.metaTags && meta.metaTags.twitter) ? meta.metaTags.twitter : {};
  const tm = (meta && meta.metaTags && meta.metaTags.timeMeta) ? meta.metaTags.timeMeta : {};

  const canonical = meta.canonicalUrl || og.url || '';
  const title = og.title || '';
  const desc = og.description || '';
  const ogImage = og.image || meta.ogImage || '';
  const ogAlt = og.imageAlt || meta.ogAlt || desc || title;

  const lines = [];
  if (canonical) lines.push(`<link rel="canonical" href="${escapeAttr(canonical)}">`);

  // OG
  lines.push(`<meta property="og:type" content="article">`);
  if (canonical) lines.push(`<meta property="og:url" content="${escapeAttr(canonical)}">`);
  if (title) lines.push(`<meta property="og:title" content="${escapeAttr(title)}">`);
  if (desc) lines.push(`<meta property="og:description" content="${escapeAttr(desc)}">`);
  if (ogImage) {
    lines.push(`<meta property="og:image" content="${escapeAttr(ogImage)}">`);
    lines.push(`<meta property="og:image:alt" content="${escapeAttr(ogAlt)}">`);
    lines.push(`<meta property="og:image:width" content="1200">`);
    lines.push(`<meta property="og:image:height" content="630">`);
  }

  // Twitter
  lines.push(`<meta name="twitter:card" content="${escapeAttr(tw.card || 'summary_large_image')}">`);
  if (tw.title || title) lines.push(`<meta name="twitter:title" content="${escapeAttr(tw.title || title)}">`);
  if (tw.description || desc) lines.push(`<meta name="twitter:description" content="${escapeAttr(tw.description || desc)}">`);
  if (tw.image || ogImage) {
    lines.push(`<meta name="twitter:image" content="${escapeAttr(tw.image || ogImage)}">`);
    lines.push(`<meta name="twitter:image:alt" content="${escapeAttr(tw.imageAlt || ogAlt)}">`);
  }

  // time
  if (tm.publishedTime) lines.push(`<meta property="article:published_time" content="${escapeAttr(tm.publishedTime)}">`);
  if (tm.modifiedTime) {
    lines.push(`<meta property="article:modified_time" content="${escapeAttr(tm.modifiedTime)}">`);
    lines.push(`<meta property="og:updated_time" content="${escapeAttr(tm.modifiedTime)}">`);
  }

  // LCP preload (OG 이미지 1장)
  if (ogImage) lines.push(`<link rel="preload" as="image" href="${escapeAttr(ogImage)}" fetchpriority="high">`);

  // schema (Article/Breadcrumb/WebSite/FAQ)
  lines.push(buildSchemaScript(meta.schemaTags));

  return lines.filter(Boolean).join('\n');
}

/* ───────────────────── pageId 확보 ───────────────────── */

function ensurePageIdForPost(postJson, slug, jsonPath) {
  const existing = firstNonEmpty(
    postJson.pageId,
    postJson.page_id,
    postJson.seedMeta && postJson.seedMeta.pageId,
    ''
  );
  if (isValidPageId(existing)) return { pageId: existing, wroteJson: false, via: 'json' };

  const pid = ensurePageId(slug);
  if (!isValidPageId(pid)) throw new Error('pageId 발급 실패');

  postJson.pageId = pid;
  try {
    const obj = readJson(jsonPath);
    obj.pageId = pid;
    writeJson(jsonPath, obj);
  } catch {}
  return { pageId: pid, wroteJson: true, via: 'ledger' };
}

/* ───────────────────── AIO 데이터 선택 ───────────────────── */

function resolveAio(postJson) {
  const aio = postJson.aio && typeof postJson.aio === 'object' ? postJson.aio : {};
  return {
    tldr: firstNonEmpty(aio.tldr, postJson.tldr, []),
    keyfacts: firstNonEmpty(aio.keyfacts, postJson.keyfacts, []),
    faq: firstNonEmpty(aio.faq, postJson.faq, []),
    sources: firstNonEmpty(aio.sources, postJson.sources, []),
  };
}

/* ───────────────────── SLOT 주입 ───────────────────── */

function injectAfterSlot(html, slotMarker, insertHtml) {
  if (!insertHtml) return html;
  const idx = html.indexOf(slotMarker);
  if (idx === -1) return html;
  return html.slice(0, idx) + insertHtml + '\n' + html.slice(idx);
}

/* ───────────────────── 렌더 1개 ───────────────────── */

function renderOne(template, postJson, jsonPath, bodyImgCtx) {
  const slug = postJson.slug || path.basename(jsonPath, '.json');

  const pidRes = ensurePageIdForPost(postJson, slug, jsonPath);
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

  // TLDR / KeyFacts
  const aio = resolveAio(postJson);
  const tldrHtml = blocks.renderTLDR(asArray(aio.tldr));
  const kfHtml   = blocks.renderKeyFacts(asArray(aio.keyfacts));

  // FAQ / Sources
  const faqHtml     = blocks.renderFAQ(asArray(aio.faq));
  const sourcesHtml = blocks.renderSources(asArray(aio.sources));

  // body sanitize (공통)
  let bodyHtml = blocks.sanitizeBodyHTML(postJson.body || '');

  // body image 1장 prepend
  if (bodyImgCtx && bodyImgCtx.manifest) {
    const entry = pickBodyImageEntry(bodyImgCtx.manifest, slug, pageId);
    const img = normalizeBodyImage(entry);
    if (img && img.url && isAllowedImageUrl(img.url, bodyImgCtx.allowedDomains)) {
      const fallbackAlt = title ? `${title} related image` : `${slug} related image`;
      const fig = buildBodyImageFigure(img, fallbackAlt);
      bodyHtml = fig + '\n' + bodyHtml;
    }
  }

  // review blocks (있을 때만)
  const reviewData = postJson.reviewData || postJson.review || null;
  const reviewRatingHtml   = reviewData ? blocks.renderReviewRatingBlock(reviewData) : '';
  const reviewInsightsHtml = reviewData ? blocks.renderReviewInsightsBlock(reviewData) : '';

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

  if (updatedDate) html = html.replace('Updated {{updated}}', `Updated ${escapeHtml(updatedDate)}`);

  // ✅ meta head 주입
  const headBlock = buildHeadFromMeta(meta);
  html = html.replace('<!--META-->', headBlock);

  // SLOT 삽입
  html = injectAfterSlot(html, '<!--SLOT:FAQ_WRAPPER-->', faqHtml);
  html = injectAfterSlot(html, '<!--SLOT:SOURCES_WRAPPER-->', sourcesHtml);
  html = injectAfterSlot(html, '<!--SLOT:REVIEW_RATING_WRAPPER-->', reviewRatingHtml);
  html = injectAfterSlot(html, '<!--SLOT:REVIEW_INSIGHTS_WRAPPER-->', reviewInsightsHtml);

  // body-image css
  if (bodyHtml.includes('class="post-body-image"')) html = injectBodyImageCssOnce(html);

  html = html.replace(
    '</head>',
    `<!-- render-posts: pageId=${escapeHtml(pageId)} via=${escapeHtml(pidRes.via)} -->\n</head>`
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

  const siteBase = (process.env.CANONICAL_BASE || process.env.SITE_BASE || 'https://ongsblog.com').replace(/\/+$/,'');
  const cdnBase  = (process.env.CDN_BASE || (siteBase + '/images')).replace(/\/+$/,'');

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
