#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/render-posts.cjs
 * - content/posts/*.json → dist/posts/*.html 렌더러
 *
 * ✅ 핵심 정합 기준
 * - meta.cjs(buildMeta)가 반환하는 metaTags/schemaTags/canonicalUrl/ogImage/ogAlt/updatedIso/publishedIso 사용
 * - blocks.js 렌더러 사용(TLDR/KeyFacts/FAQ/Sources/Review + sanitizeBodyHTML)
 * - content-blocks.cjs 는 "검사용" (여기서는 렌더에 사용하지 않음)
 *
 * ✅ 본문 이미지(Body Image) SSOT 규칙 (중요)
 * - 본문 이미지 매니페스트는 "딱 1개 파일"로 고정합니다.
 *   => System_files/manifests/images-body-manifest.json
 * - JSON 구조: { meta:{...}, items:{ [slug]: { url, alt, width, height, safe, ... } } }
 * - 삽입 정책: 1포스트 1장 / 도메인 allow / safe=true 권장 / 없으면 skip
 *
 * ✅ [리뷰 연결 핵심]
 * - 리뷰 라벨 3종(app/device/subscription)의 ratings/insights 원천이 서로 다르므로
 *   resolveReviewData에서 라벨별 데이터셋을 읽고 공통 포맷으로 정규화해서 blocks에 전달합니다.
 */

const fs = require('fs');
const path = require('path');

const ROOT          = path.resolve(__dirname, '..', '..');   // System_files
const POSTS_DIR     = path.join(ROOT, 'content', 'posts');
const TEMPLATE_PATH = path.join(ROOT, 'templates', 'post.html');
const OUTPUT_DIR    = path.join(ROOT, 'dist', 'posts');

const MANIFESTS_DIR = path.join(ROOT, 'manifests');

// ✅ 본문 이미지 매니페스트(SSOT) 파일명/경로 "단일 고정"
const BODY_IMAGE_MANIFEST_PATH = path.join(MANIFESTS_DIR, 'images-body-manifest.json');

const { buildMeta } = require('./lib/meta.cjs');
const { ensurePageId, isValidPageId } = require('./lib/page-ids.cjs');
const blocks = require('./lib/blocks.js');

// ✅ 리뷰 데이터 정규화(라벨별 SSOT 연동)
const { resolveReviewData } = require('./lib/review-resolver.cjs');

/* ───────────────────── 파일/JSON 유틸 ───────────────────── */

/** 디렉터리 없으면 생성 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** JSON 읽기(에러는 throw) */
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** JSON 쓰기(예쁘게) */
function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/** HTML escape */
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** HTML attr escape(줄바꿈 제거 포함) */
function escapeAttr(str) {
  return escapeHtml(str).replace(/\n/g, ' ');
}

/** 값들 중 첫 유효값 */
function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    return v;
  }
  return '';
}

/** 배열 normalize */
function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/** split/join 기반 안전 replace */
function replaceAllSafe(html, needle, value) {
  return html.split(needle).join(value);
}

/** JSON 파일 존재하면 읽기, 아니면 null */
function tryReadJsonFile(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return readJson(p);
  } catch {
    return null;
  }
}

/* ───────────────────── 본문 이미지(Body Image) 로직 ───────────────────── */

/**
 * 본문 이미지 매니페스트를 1회만 로딩합니다.
 * - 파일이 없거나 파싱 실패면 null 처리(= 삽입 스킵)
 */
function loadBodyImageManifestOnce() {
  const obj = tryReadJsonFile(BODY_IMAGE_MANIFEST_PATH);
  if (!obj || typeof obj !== 'object') return { data: null, source: BODY_IMAGE_MANIFEST_PATH };

  // items가 없으면 실사용 불가이므로 null 취급(안전)
  if (!obj.items || typeof obj.items !== 'object') return { data: null, source: BODY_IMAGE_MANIFEST_PATH };

  return { data: obj, source: BODY_IMAGE_MANIFEST_PATH };
}

/**
 * 허용 도메인 목록 구성
 * - 기본: siteBase(host) + cdnBase(host)
 * - 추가: BODY_IMAGE_ALLOW_DOMAINS="a.com,b.com" (선택)
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

/**
 * 이미지 URL 허용 여부
 * - https 필수
 * - allowedDomains에 정확 일치 or 서브도메인 허용
 */
function isAllowedImageUrl(url, allowedDomains) {
  if (!url || typeof url !== 'string') return false;

  let u;
  try { u = new URL(url); } catch { return false; }

  if (u.protocol !== 'https:') return false;

  const host = u.hostname;
  return allowedDomains.some(d => d === host || host.endsWith('.' + d));
}

/**
 * ✅ 핵심: slug 기반으로 items[slug]를 찾습니다.
 * - 기본키: items[slug]
 * - 보조: items[pageId] (혹시 운영 중 섞여들어도 살려주는 안전망)
 */
function pickBodyImageEntry(manifestObj, slug, pageId) {
  if (!manifestObj || typeof manifestObj !== 'object') return null;

  const items = manifestObj.items;
  if (!items || typeof items !== 'object') return null;

  if (slug && items[slug]) return items[slug];
  if (pageId && items[pageId]) return items[pageId];

  return null;
}

/**
 * 매니페스트 엔트리를 내부 표준 포맷으로 정규화합니다.
 * - 필수: url
 * - 선택: alt, width, height, caption(=credit), safe
 */
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

/**
 * 본문 이미지 figure 생성
 * - lazy 로딩 / decoding async / width/height 옵션
 * - caption 있으면 figcaption 출력
 */
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
 * 본문 이미지 CSS를 <head>에 "1회만" 삽입합니다.
 * - 동일 마커 주석으로 중복 삽입 방지
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

/* ───────────────────── meta head 생성 ───────────────────── */

/** JSON-LD 스키마 스크립트 */
function buildSchemaScript(schemaTags) {
  if (!Array.isArray(schemaTags) || schemaTags.length === 0) return '';
  const json = JSON.stringify(schemaTags.length === 1 ? schemaTags[0] : schemaTags);
  return `<script type="application/ld+json">${json}</script>`;
}

/**
 * buildMeta 결과를 기반으로 head에 들어갈 OG/Twitter/Time/Canonical/Preload/Schema를 생성합니다.
 * - 템플릿 <!--META--> 슬롯에 그대로 박습니다.
 */
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

  // canonical
  if (canonical) lines.push(`<link rel="canonical" href="${escapeAttr(canonical)}">`);

  // OG
  lines.push(`<meta property="og:type" content="article">`);
  if (canonical) lines.push(`<meta property="og:url" content="${escapeAttr(canonical)}">`);
  if (title) lines.push(`<meta property="og:title" content="${escapeAttr(title)}">`);
  if (desc) lines.push(`<meta property="og:description" content="${escapeAttr(desc)}">`);

  // OG image
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

  // Time meta
  if (tm.publishedTime) lines.push(`<meta property="article:published_time" content="${escapeAttr(tm.publishedTime)}">`);
  if (tm.modifiedTime) {
    lines.push(`<meta property="article:modified_time" content="${escapeAttr(tm.modifiedTime)}">`);
    lines.push(`<meta property="og:updated_time" content="${escapeAttr(tm.modifiedTime)}">`);
  }

  // LCP preload (OG 이미지 1장)
  if (ogImage) lines.push(`<link rel="preload" as="image" href="${escapeAttr(ogImage)}" fetchpriority="high">`);

  // JSON-LD schema
  lines.push(buildSchemaScript(meta.schemaTags));

  return lines.filter(Boolean).join('\n');
}

/* ───────────────────── pageId 확보 ───────────────────── */

/**
 * postJson 내부에 pageId가 있으면 사용,
 * 없으면 ensurePageId(slug)로 발급 후 JSON에 기록합니다.
 */
function ensurePageIdForPost(postJson, slug, jsonPath) {
  const existing = firstNonEmpty(
    postJson.pageId,
    postJson.page_id,
    postJson.seedMeta && postJson.seedMeta.pageId,
    ''
  );

  if (isValidPageId(existing)) return { pageId: existing, wroteJson: false, via: 'json' };

  // ledger 기반 pageId 발급
  const pid = ensurePageId(slug);
  if (!isValidPageId(pid)) throw new Error('pageId 발급 실패');

  // postJson에도 반영
  postJson.pageId = pid;

  // 원본 JSON 파일에도 안전하게 기록(실패해도 전체 렌더는 계속)
  try {
    const obj = readJson(jsonPath);
    obj.pageId = pid;
    writeJson(jsonPath, obj);
  } catch {}

  return { pageId: pid, wroteJson: true, via: 'ledger' };
}

/**
 * AIO 섹션(tldr/keyfacts/faq/sources)은
 * postJson.aio.* 우선 → 없으면 postJson.* 사용
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

/**
 * 템플릿 내 SLOT 위치(marker)를 찾아 marker "앞"에 insertHtml을 삽입합니다.
 * - marker가 없으면 그대로 통과(안전)
 */
function injectAfterSlot(html, slotMarker, insertHtml) {
  if (!insertHtml) return html;
  const idx = html.indexOf(slotMarker);
  if (idx === -1) return html;
  return html.slice(0, idx) + insertHtml + '\n' + html.slice(idx);
}

/* ───────────────────── 렌더 1개 ───────────────────── */

function renderOne(template, postJson, jsonPath, bodyImgCtx) {
  // slug 결정: json.slug 우선, 없으면 파일명 fallback
  const slug = postJson.slug || path.basename(jsonPath, '.json');

  // pageId 확보(없으면 발급)
  const pidRes = ensurePageIdForPost(postJson, slug, jsonPath);
  const pageId = pidRes.pageId;

  // site/cdn base는 env 우선
  const siteBase = (process.env.CANONICAL_BASE || process.env.SITE_BASE || 'https://ongsblog.com').replace(/\/+$/,'');
  const cdnBase  = (process.env.CDN_BASE || (siteBase + '/images')).replace(/\/+$/,'');

  // meta 생성
  const meta = buildMeta(postJson, { slug, pageId, siteBase, cdnBase });

  // OG/기본 메타
  const og = meta.metaTags && meta.metaTags.og ? meta.metaTags.og : {};
  const title       = og.title || postJson.title || slug;
  const description = og.description || postJson.description || '';
  const canonical   = meta.canonicalUrl;
  const heroImage   = meta.ogImage;
  const heroAlt     = meta.ogAlt || description || title;

  // Updated badge(YYYY-MM-DD)
  const updatedDate = (meta.updatedIso || '').slice(0, 10) || '';

  // AIO 렌더
  const aio = resolveAio(postJson);
  const tldrHtml    = blocks.renderTLDR(asArray(aio.tldr));
  const kfHtml      = blocks.renderKeyFacts(asArray(aio.keyfacts));
  const faqHtml     = blocks.renderFAQ(asArray(aio.faq));
  const sourcesHtml = blocks.renderSources(asArray(aio.sources));

  // body sanitize(중복 main 제거 등)
  let bodyHtml = blocks.sanitizeBodyHTML(postJson.body || '');

  /**
   * ✅ 본문 이미지 삽입(선택)
   * - 매니페스트가 없거나 해당 slug 엔트리 없으면 스킵
   * - safe=false면 스킵(운영자가 위험으로 마킹한 경우)
   * - 도메인 allow 통과해야 삽입
   */
  if (bodyImgCtx && bodyImgCtx.manifestObj) {
    const entry = pickBodyImageEntry(bodyImgCtx.manifestObj, slug, pageId);
    const img = normalizeBodyImage(entry);

    if (img && img.url) {
      // 운영자가 safe=false로 둔 경우 삽입 금지
      if (img.safe === false) {
        // 안전 정책상 조용히 스킵
      } else if (isAllowedImageUrl(img.url, bodyImgCtx.allowedDomains)) {
        const fallbackAlt = title ? `${title} related image` : `${slug} related image`;
        const fig = buildBodyImageFigure(img, fallbackAlt);

        // ✅ 위치: 본문 맨 앞(중제목 구조가 이미 존재하므로, 본문 시작에 1장 고정)
        bodyHtml = fig + '\n' + bodyHtml;
      }
    }
  }

  /**
   * ✅ 리뷰 연결(라벨별 SSOT → 공통 포맷)
   * - render 단계에서는 post.review 같은 임의 구조를 믿지 않습니다.
   */
  const reviewData = resolveReviewData({ ROOT, postJson });

  const reviewRatingHtml   = reviewData ? blocks.renderReviewRatingBlock(reviewData) : '';
  const reviewInsightsHtml = reviewData ? blocks.renderReviewInsightsBlock(reviewData) : '';

  // 템플릿 치환 시작
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

  // Updated badge 치환(템플릿 구조 유지: "Updated {{updated}}"를 실제 날짜로 바꿈)
  if (updatedDate) html = html.replace('Updated {{updated}}', `Updated ${escapeHtml(updatedDate)}`);

  // <!--META--> 슬롯
  const headBlock = buildHeadFromMeta(meta);
  html = html.replace('<!--META-->', headBlock);

  // SLOT 주입(템플릿의 고정 SLOT 이름을 유지해야 함)
  html = injectAfterSlot(html, '<!--SLOT:FAQ_WRAPPER-->', faqHtml);
  html = injectAfterSlot(html, '<!--SLOT:SOURCES_WRAPPER-->', sourcesHtml);
  html = injectAfterSlot(html, '<!--SLOT:REVIEW_RATING_WRAPPER-->', reviewRatingHtml);
  html = injectAfterSlot(html, '<!--SLOT:REVIEW_INSIGHTS_WRAPPER-->', reviewInsightsHtml);

  // 본문 이미지가 삽입되었다면 CSS도 1회 주입
  if (bodyHtml.includes('class="post-body-image"')) {
    html = injectBodyImageCssOnce(html);
  }

  // 디버그 주석(추후 사고 추적용)
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
  console.log('[render-posts] BODY_WRITE_MODE =', (process.env.BODY_WRITE_MODE || 'local'));
  console.log('[render-posts] PUBLISH_MODE    =', (process.env.PUBLISH_MODE || 'disable'));
  console.log('────────────────────────────────────────────');

  // 출력/메타 디렉터리 확보
  ensureDir(OUTPUT_DIR);
  ensureDir(MANIFESTS_DIR);

  // 템플릿/포스트 폴더 체크
  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error('[render-posts] post.html 템플릿 없음:', TEMPLATE_PATH);
    process.exit(1);
  }
  if (!fs.existsSync(POSTS_DIR)) {
    console.warn('[render-posts] POSTS_DIR 없음 → 종료');
    process.exit(0);
  }

  // site/cdn base
  const siteBase = (process.env.CANONICAL_BASE || process.env.SITE_BASE || 'https://ongsblog.com').replace(/\/+$/,'');
  const cdnBase  = (process.env.CDN_BASE || (siteBase + '/images')).replace(/\/+$/,'');

  // 도메인 allow 세트
  const allowedDomains = parseAllowedDomainsFromEnv(siteBase, cdnBase);

  // ✅ 본문 이미지 매니페스트 로딩(SSOT 단일)
  const m = loadBodyImageManifestOnce();
  const bodyImgCtx = {
    manifestObj: m.data,               // { meta, items } 전체
    manifestSource: m.source,
    manifestLoaded: !!m.data,
    allowedDomains,
  };

  console.log('[render-posts] BODY_IMAGE_MANIFEST =', bodyImgCtx.manifestSource);
  console.log('[render-posts] BODY_IMAGE_MANIFEST_LOADED =', bodyImgCtx.manifestLoaded);
  console.log('[render-posts] BODY_IMAGE_ALLOW_DOMAINS =', allowedDomains.join(', ') || '(none)');

  // 템플릿 로드
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  // 대상 JSON 목록
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.toLowerCase().endsWith('.json')).sort();
  console.log('[render-posts] 대상 JSON 수 =', files.length);

  let ok = 0;
  let fail = 0;

  for (const file of files) {
    const fullPath = path.join(POSTS_DIR, file);
    let json;

    // JSON 파싱
    try { json = readJson(fullPath); }
    catch (e) {
      console.error('[render-posts] JSON 파싱 실패:', file, e.message);
      fail++; continue;
    }

    // slug 결정 및 출력 경로
    const slug = json.slug || path.basename(file, '.json');
    const outPath = path.join(OUTPUT_DIR, `${slug}.html`);

    // 렌더
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
  console.log('────────────────────────────────────────────');

  if (fail > 0) process.exitCode = 1;
}

if (require.main === module) main();
