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
 *    render는 {{faq}} / {{sources}}만 치환한다.
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

/* ───────────────────── ids rerun ───────────────────── */

/**
 * What: pageId 누락 시 ids.cjs를 "최대 1회" 재실행한다.
 * Why : render가 pageId 발급을 담당하지 않지만, dist 산출물은 pageId가 필요하다.
 * I/O : READ/WRITE는 ids.cjs가 담당(render는 spawn만)
 * Invariants:
 *  - ids.cjs는 내부 가드(BODY_WRITE_MODE/ today publishable 스코프 등)를 따른다.
 *  - render는 ids를 반복 실행하지 않는다(1회만).
 */
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

/**
 * What: BODY_IMAGE_ALLOW_DOMAINS 파서(보안 가드)
 * Why : 본문 이미지 URL 허용 도메인을 제한해 악성/오염 링크 방지
 * I/O : READ env + siteBase/cdnBase
 * Invariants:
 *  - https만 허용
 *  - 기본 허용: siteBase/cdnBase host
 */
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
  ].filter(Boolean).join('\n');
}

/**
 * What: 본문 이미지용 CSS 1회 주입
 * Why : 템플릿 변경 없이 body-image 렌더 품질을 맞추기 위함
 * I/O : READ/WRITE dist HTML 문자열
 * Invariants:
 *  - 마커("/* body-image-css */")가 있으면 중복 주입 금지
 */
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

/* ───────────────────── meta head ───────────────────── */

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

  // canonical은 template에도 있지만, meta 모듈 결과를 우선으로 보강
  if (canonical) lines.push(`<link rel="canonical" href="${escapeAttr(canonical)}">`);

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

  lines.push(`<meta name="twitter:card" content="${escapeAttr(tw.card || 'summary_large_image')}">`);
  if (tw.title || title) lines.push(`<meta name="twitter:title" content="${escapeAttr(tw.title || title)}">`);
  if (tw.description || desc) lines.push(`<meta name="twitter:description" content="${escapeAttr(tw.description || desc)}">`);
  if (tw.image || ogImage) {
    lines.push(`<meta name="twitter:image" content="${escapeAttr(tw.image || ogImage)}">`);
    lines.push(`<meta name="twitter:image:alt" content="${escapeAttr(tw.imageAlt || ogAlt)}">`);
  }

  if (tm.publishedTime) lines.push(`<meta property="article:published_time" content="${escapeAttr(tm.publishedTime)}">`);
  if (tm.modifiedTime) {
    lines.push(`<meta property="article:modified_time" content="${escapeAttr(tm.modifiedTime)}">`);
    lines.push(`<meta property="og:updated_time" content="${escapeAttr(tm.modifiedTime)}">`);
  }

  // LCP 최적화: og:image preload
  if (ogImage) lines.push(`<link rel="preload" as="image" href="${escapeAttr(ogImage)}" fetchpriority="high">`);

  lines.push(buildSchemaScript(meta.schemaTags));

  return lines.filter(Boolean).join('\n');
}

/* ───────────────────── pageId policy ───────────────────── */

/**
 * What: post JSON에 pageId가 없으면 ids.cjs를 1회 돌린 뒤 다시 읽는다.
 * Why : dist 산출물은 pageId가 필요(무결성 #3), 발급은 ids.cjs만 담당.
 * I/O : READ content/posts/{slug}.json, (필요 시) ids.cjs 실행
 * Invariants:
 *  - pageId 포맷은 page\d{6}로만 인정
 *  - ids 재실행 후에도 없으면 FAIL(스코프/모드 문제 가능성)
 */
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

/**
 * What: AIO 블록(tldr/keyfacts/faq/sources) 입력을 통합
 * Why : postJson.aio / 최상위 키 혼재를 흡수
 * I/O : READ postJson
 * Invariants:
 *  - 없다면 빈 배열로 처리(템플릿/blocks가 책임)
 */
function resolveAio(postJson) {
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

  const aio = resolveAio(postJson);

  // ✅ 템플릿(뼈대) + 치환만: blocks는 HTML "조각"만 생성
  const tldrHtml    = blocks.renderTLDR(asArray(aio.tldr));
  const kfHtml      = blocks.renderKeyFacts(asArray(aio.keyfacts));
  const faqHtml     = blocks.renderFAQ(asArray(aio.faq));         // ✅ {{faq}} 치환용
  const sourcesHtml = blocks.renderSources(asArray(aio.sources)); // ✅ {{sources}} 치환용

  // 본문은 sanitize 후 사용
  let bodyHtml = blocks.sanitizeBodyHTML(postJson.body || '');

  /* ─────────────────────────────────────────────
   * 본문 이미지(선택) — manifest 기반 prepend
   *
   * What: body 이미지 1장을 본문 앞에 추가(허용 도메인만)
   * Why : 글의 시각적 품질/체류시간/SEO 보강
   * I/O : READ manifests/images-body-manifest.json
   * Invariants:
   *  - https + allowDomains 통과만
   *  - entry.safe===false면 스킵
   * ───────────────────────────────────────────── */
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

  /* ─────────────────────────────────────────────
   * REVIEW POLICY (중요/강제)
   *
   * What: render 단계에서 review 섹션을 추가 생성/주입/치환하지 않는다.
   * Why : 템플릿(post.html)에 review placeholder 섹션이 존재하는 구조이며,
   *       render가 추가 생성하면 동일 id가 2개가 되어 무결성(#DOM) 파손.
   * I/O : READ templates/post.html, WRITE dist/posts/*.html
   * Invariants:
   *  - id="review-rating-block", id="review-insights-block"는 dist에서 최대 1개
   *  - 실데이터 치환은 inject-reviews-from-ssot.cjs / review-meta-block.cjs가 담당
   * ───────────────────────────────────────────── */

  let html = template;

  // 기본 placeholder 치환(템플릿이 뼈대, render는 채우기)
  html = replaceAllSafe(html, '{{title}}', escapeHtml(title));
  html = replaceAllSafe(html, '{{description}}', escapeAttr(description));
  html = replaceAllSafe(html, '{{pageId}}', escapeHtml(pageId));
  html = replaceAllSafe(html, '{{canonical}}', escapeAttr(canonical));

  html = replaceAllSafe(html, '{{heroImage}}', escapeAttr(heroImage));
  html = replaceAllSafe(html, '{{heroAlt}}', escapeAttr(heroAlt));

  html = replaceAllSafe(html, '{{tldr}}', tldrHtml);
  html = replaceAllSafe(html, '{{keyfacts}}', kfHtml);
  html = replaceAllSafe(html, '{{body}}', bodyHtml);

  // ✅ FAQ/Sources는 템플릿 섹션 뼈대가 SSOT
  //    - render는 "주입"이 아니라 {{faq}}/{{sources}} 치환만 수행한다.
  //    - blocks.renderFAQ/renderSources는 입력이 비면 ''(빈 문자열)로 내려가도록 설계되어 있어
  //      시각적으로 빈칸 노출을 최소화(템플릿/CSS 정책과 결합).
  html = replaceAllSafe(html, '{{faq}}', faqHtml);
  html = replaceAllSafe(html, '{{sources}}', sourcesHtml);

  // updated 배지 치환(템플릿 구조 유지)
  if (updatedDate) html = html.replace('Updated {{updated}}', `Updated ${escapeHtml(updatedDate)}`);

  // head meta 슬롯 치환
  html = html.replace('<!--META-->', buildHeadFromMeta(meta));

  // body image CSS는 실제 사용 시에만 1회 주입
  if (bodyHtml.includes('class="post-body-image"')) html = injectBodyImageCssOnce(html);

  // 디버그용 주석(산출물에 1줄) — 안전/가벼움
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
```0
