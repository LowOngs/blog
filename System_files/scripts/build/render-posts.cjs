#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/render-posts.cjs
 * - content/posts/*.json → dist/posts/*.html 렌더러
 *
 * ✅ 현재 post.html(SLOT 구조) + blocks.js(렌더러) 기준 정렬 버전
 * - blocks.js: TLDR/KeyFacts/FAQ/Sources/Review + sanitizeBodyHTML
 * - content-blocks.cjs: "검사기"이므로 여기서 렌더에 사용하지 않음
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

/* ───────────────────── SLOT 주입 헬퍼 ───────────────────── */

function injectAfterSlot(html, slotMarker, insertHtml) {
  if (!insertHtml) return html;
  const idx = html.indexOf(slotMarker);
  if (idx === -1) return html; // 슬롯이 없으면 조용히 스킵
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

  // title/description/canonical
  const title       = meta.title || postJson.title || slug;
  const description = meta.summary || postJson.description || '';
  const canonical   = meta.canonicalUrl || (siteBase + '/' + slug + '.html');

  // hero (post.html에 figure가 이미 있으므로 값만 채움)
  const heroImage = meta.ogImage || '';
  const heroAlt   = meta.ogAlt || description || title;

  // updated badge (YYYY-MM-DD)
  const updatedDate = (meta.updatedIso || '').slice(0, 10) || '';

  // blocks
  const aio = resolveAio(postJson);
  const tldrHtml = blocks.renderTLDR(asArray(aio.tldr));
  const kfHtml   = blocks.renderKeyFacts(asArray(aio.keyfacts));

  const faqHtml     = blocks.renderFAQ(asArray(aio.faq));
  const sourcesHtml = blocks.renderSources(asArray(aio.sources));

  // body sanitize (공통 안전망)
  let bodyHtml = blocks.sanitizeBodyHTML(postJson.body || '');

  // body image 1장 (있으면 prepend)
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
  const reviewRatingHtml  = reviewData ? blocks.renderReviewRatingBlock(reviewData) : '';
  const reviewInsightsHtml= reviewData ? blocks.renderReviewInsightsBlock(reviewData) : '';

  // apply template replacements
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

  if (updatedDate) {
    html = html.replace('Updated {{updated}}', `Updated ${escapeHtml(updatedDate)}`);
  }

  // META 주입 (post.html의 <!--META--> 자리에)
  if (meta.headHtml && typeof meta.headHtml === 'string') {
    html = html.replace('<!--META-->', meta.headHtml);
  } else if (meta.metaTag && typeof meta.metaTag === 'string') {
    html = html.replace('<!--META-->', meta.metaTag);
  } else if (meta.metaTags && typeof meta.metaTags === 'string') {
    html = html.replace('<!--META-->', meta.metaTags);
  } // meta 모듈 출력 형태가 다를 수 있어 3중 가드

  // FAQ/SOURCES/REVIEW 슬롯 삽입
  html = injectAfterSlot(html, '<!--SLOT:FAQ_WRAPPER-->', faqHtml);
  html = injectAfterSlot(html, '<!--SLOT:SOURCES_WRAPPER-->', sourcesHtml);
  html = injectAfterSlot(html, '<!--SLOT:REVIEW_RATING_WRAPPER-->', reviewRatingHtml);
  html = injectAfterSlot(html, '<!--SLOT:REVIEW_INSIGHTS_WRAPPER-->', reviewInsightsHtml);

  // body-image css는 figure를 실제 넣었을 때만
  if (bodyHtml.includes('class="post-body-image"')) {
    html = injectBodyImageCssOnce(html);
  }

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
