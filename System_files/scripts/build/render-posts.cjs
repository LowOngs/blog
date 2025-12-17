#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/render-posts.cjs
 * - content/posts/*.json → dist/posts/*.html 렌더러
 * - meta.cjs(buildMeta)로 canonical/OG/schema/pageBadge 생성
 * - TL;DR / Key Facts / FAQ / Sources / Hero 이미지까지 한 번에 주입
 *
 * + [ADD] 본문 이미지 1장(body image) 자동 삽입
 *   - "외부 URL 자동삽입" 금지: dist/images/body 에 실제 파일이 있을 때만 붙임
 *   - 리뷰 라벨은 "있으면 우선 삽입" (강제 성향)
 *   - 타 라벨은 "있으면 삽입, 없으면 스킵"
 *
 * 핵심(옹스 룰):
 * - pageId는 생명
 * - "새 발급 권한"은 ids.cjs에만 있다.
 * - render는 원칙적으로 JSON.pageId를 사용한다.
 * - 단, ledger/ensurePageId가 깨져도 pageId를 살리기 위해
 *   WAL 저널(manifests/pageid-journal.jsonl)에서 '회수'는 허용한다.
 */

const fs = require('fs');
const path = require('path');

const ROOT          = path.resolve(__dirname, '..', '..');   // System_files
const POSTS_DIR     = path.join(ROOT, 'content', 'posts');
const TEMPLATE_PATH = path.join(ROOT, 'templates', 'post.html');
const OUTPUT_DIR    = path.join(ROOT, 'dist', 'posts');

const MANIFESTS_DIR = path.join(ROOT, 'manifests');
const JOURNAL_FILE  = path.join(MANIFESTS_DIR, 'pageid-journal.jsonl');

// body images live here (local build artifacts)
const DIST_IMAGES_DIR = path.join(ROOT, 'dist', 'images');
const DIST_BODY_DIR   = path.join(DIST_IMAGES_DIR, 'body');

// meta.cjs
const { buildMeta } = require('./lib/meta.cjs');
// ledger (정상 루트)
const { ensurePageId } = require('./lib/page-ids.cjs');

/**
 * [PATCH] 신규 블록 모듈 (있으면 우선 사용)
 */
let contentBlocks = null;
try {
  contentBlocks = require('./lib/content-blocks.cjs');
} catch (_) {
  contentBlocks = null;
}

/* ───────────────────── 공통 유틸 ───────────────────── */

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

function isValidPageId(v) {
  return typeof v === 'string' && /^page\d{6}$/.test(v);
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

function readFileSafe(p) {
  try {
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function fileExists(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/* ───────────────────── WAL 저널 회수 ───────────────────── */

/**
 * 저널(JSONL)에서 slug에 해당하는 최신 pageId를 회수
 * - 파일 끝에 가까울수록 최신이므로 뒤에서부터 탐색
 */
function recoverPageIdFromJournal(slug) {
  const raw = readFileSafe(JOURNAL_FILE);
  if (!raw) return '';

  const lines = raw.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && rec.slug === slug && isValidPageId(rec.pageId)) {
        return rec.pageId;
      }
    } catch {
      // 깨진 라인은 무시
    }
  }
  return '';
}

/* ───────────────────── AIO 블록 렌더러 (기존 내장) ───────────────────── */

function renderListItems(list) {
  const arr = asArray(list)
    .map((s) => (s == null ? '' : String(s).trim()))
    .filter(Boolean);

  if (!arr.length) return '';
  return arr.map((s) => `<li>${escapeHtml(s)}</li>`).join('\n');
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

  return faqItems
    .map((item) => {
      const q = escapeHtml(item.q);
      const a = escapeHtml(item.a);
      return [
        '<article class="faq-item">',
        `  <h4>${q}</h4>`,
        `  <p>${a}</p>`,
        '</article>',
      ].join('\n');
    })
    .join('\n');
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
      const url   = s.url || s.href || '';
      const label = firstNonEmpty(s.label, s.name, url);
      const note  = s.note ? String(s.note).trim() : '';

      if (!url && !label) continue;

      if (url) {
        const safeUrl   = escapeAttr(url);
        const safeLabel = escapeHtml(label || url);
        const safeNote  = note ? ` — ${escapeHtml(note)}` : '';
        items.push(
          `<li><a href="${safeUrl}" target="_blank" rel="nofollow noopener noreferrer">${safeLabel}</a>${safeNote}</li>`
        );
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

/**
 * [ADD] 본문 이미지(1장) 오버플로 방지용 최소 CSS를 head에 주입
 * - 템플릿(post.html) 수정 없이 안전하게 처리
 */
function buildBodyImageSafetyCss() {
  return [
    '<style>',
    '  figure.post-body-image{margin:16px 0;}',
    '  figure.post-body-image img{display:block; width:100%; max-width:100%; height:auto;}',
    '  figure.post-body-image figcaption{font-size:12px; opacity:.8; margin-top:6px;}',
    '</style>'
  ].join('\n');
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
    lines.push(
      `<link rel="preload" as="image" href="${escapeAttr(ogImage)}" fetchpriority="high" imagesrcset="${escapeAttr(ogImage)}">`
    );
  }

  const siteBase = (process.env.CANONICAL_BASE || 'https://ongsblog.com').replace(/\/+$/,'');
  lines.push(`<link rel="preconnect" href="${escapeAttr(siteBase)}" crossorigin>`);

  // [ADD] body image safety CSS
  lines.push(buildBodyImageSafetyCss());

  if (meta.schemaTag) lines.push(meta.schemaTag);

  return lines.join('\n');
}

/* ───────────────────── pageId 확보(핵심) ───────────────────── */

/**
 * pageId 확보 순서:
 * 1) JSON.pageId (정답)
 * 2) ensurePageId(slug) (정상 ledger 루트, 실패 가능)
 * 3) journal 회수 (WAL 바이패스)
 *
 * 주의:
 * - journal 회수는 "새 발급"이 아니라 "이미 ids가 발급했던 흔적" 회수만 허용
 * - 3)까지 실패하면 렌더 통과 금지(생명)
 */
function ensurePageIdForPost(postJson, slug, jsonPath) {
  const existing = firstNonEmpty(postJson.pageId, postJson.page_id, postJson.seedMeta && postJson.seedMeta.pageId, '');
  if (isValidPageId(existing)) {
    return { pageId: existing, wroteJson: false, via: 'json' };
  }

  // 2) ledger 루트 시도
  try {
    const pid = ensurePageId(slug); // 내부적으로 ledger 기반
    if (isValidPageId(pid)) {
      postJson.pageId = pid;
      try {
        // 원본 JSON에 기록
        const obj = readJson(jsonPath);
        obj.pageId = pid;
        writeJson(jsonPath, obj);
      } catch (_) {}
      return { pageId: pid, wroteJson: true, via: 'ledger' };
    }
  } catch (_) {
    // 아래 journal로 회수
  }

  // 3) WAL journal 회수
  const jpid = recoverPageIdFromJournal(slug);
  if (isValidPageId(jpid)) {
    postJson.pageId = jpid;
    try {
      const obj = readJson(jsonPath);
      obj.pageId = jpid;
      writeJson(jsonPath, obj);
    } catch (_) {}
    return { pageId: jpid, wroteJson: true, via: 'journal' };
  }

  throw new Error(`pageId 확보 실패: slug=${slug} (JSON/ledger/journal 모두 실패)`);
}

/* ───────────────────── 본문 이미지 1장(Body Image) ───────────────────── */

function getLabels(postJson) {
  const labels = [];
  if (postJson.label) labels.push(String(postJson.label));
  if (postJson.labels) labels.push(...asArray(postJson.labels).map(String));
  if (postJson.tags) labels.push(...asArray(postJson.tags).map(String));
  return labels.map((s) => s.trim()).filter(Boolean);
}

function isReviewLabel(postJson) {
  const labels = getLabels(postJson);
  const set = new Set(labels.map((x) => x.toLowerCase()));
  return set.has('app-reviews') || set.has('device-reviews') || set.has('subscription-services');
}

/**
 * dist/images/body에 실제 파일이 있을 때만, CDN URL로 변환해 반환
 * - 외부 URL 자동 사용 금지(저작권/무단 이미지 리스크 차단)
 */
function resolveBodyImageFromLocal({ slug, pageId, cdnBase, postJson }) {
  // 1) JSON에 명시된 bodyImage(내부 파일명/상대키만 허용)
  //    - url 전체가 들어오면 거부(무단 외부 URL 방지)
  const bi = postJson && postJson.aio && postJson.aio.bodyImage ? postJson.aio.bodyImage : postJson.bodyImage;
  if (bi && typeof bi === 'object') {
    const file = firstNonEmpty(bi.file, bi.filename, '');
    if (file && !/^https?:\/\//i.test(file)) {
      const local = path.join(DIST_BODY_DIR, file);
      if (fileExists(local)) {
        return {
          url: `${cdnBase.replace(/\/+$/,'')}/body/${encodeURIComponent(file)}`.replace(/%2F/g,'/'),
          alt: firstNonEmpty(bi.alt, bi.caption, postJson.title, slug),
          caption: firstNonEmpty(bi.caption, '')
        };
      }
    }
  }

  // 2) 규칙 기반 자동 탐색(우선순위)
  const candidates = [
    `${pageId}_${slug}_800x800.webp`,
    `${pageId}_${slug}_800x800.jpg`,
    `${pageId}_${slug}_body_800x800.webp`,
    `${pageId}_${slug}_body_800x800.jpg`,
  ];

  for (const name of candidates) {
    const local = path.join(DIST_BODY_DIR, name);
    if (fileExists(local)) {
      return {
        url: `${cdnBase.replace(/\/+$/,'')}/body/${name}`,
        alt: firstNonEmpty(postJson.bodyImageAlt, postJson.title, slug),
        caption: ''
      };
    }
  }

  return null;
}

function buildBodyImageFigure(bodyImage) {
  if (!bodyImage || !bodyImage.url) return '';
  const alt = escapeAttr(bodyImage.alt || 'Related image');
  const cap = bodyImage.caption ? `<figcaption>${escapeHtml(bodyImage.caption)}</figcaption>` : '';
  return [
    '<figure class="post-body-image">',
    `  <img src="${escapeAttr(bodyImage.url)}" alt="${alt}" loading="lazy" decoding="async" />`,
    cap,
    '</figure>'
  ].join('\n');
}

/**
 * 본문에 1장만 “무해하게” 넣기:
 * - 본문에 이미 <img 가 있으면 추가 삽입 스킵(난잡 방지)
 * - 위치: 본문 최상단(리뷰/비리뷰 공통)
 */
function injectBodyImageOnce(rawBodyHtml, bodyImageFigure) {
  const body = String(rawBodyHtml || '');
  if (!bodyImageFigure) return body;

  // 이미 이미지가 있으면 추가 삽입 금지
  if (/<img\b/i.test(body)) return body;

  return `${bodyImageFigure}\n${body}`;
}

/* ───────────────────── 개별 포스트 렌더링 ───────────────────── */

function resolveAioLocal(postJson) {
  const aio = postJson.aio && typeof postJson.aio === 'object' ? postJson.aio : {};
  return {
    tldr: firstNonEmpty(aio.tldr, postJson.tldr, []),
    keyfacts: firstNonEmpty(aio.keyfacts, postJson.keyfacts, []),
    faq: firstNonEmpty(aio.faq, postJson.faq, []),
    sources: firstNonEmpty(aio.sources, postJson.sources, []),
    heroImage: aio.heroImage || null
  };
}

/**
 * blocks 우선순위:
 * - content-blocks.cjs가 있고, 거기에 함수가 있으면 그걸 사용
 * - 없으면 기존 내장 렌더러 사용
 */
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
    renderTldr: renderTldrFn
      ? (v) => renderTldrFn(v)
      : (v) => renderListItems(v),

    renderKeyFacts: renderKeyFactsFn
      ? (v) => renderKeyFactsFn(v)
      : (v) => renderListItems(v),

    renderFaq: renderFaqFn
      ? (v) => renderFaqFn(v)
      : (v) => renderFaq(v),

    renderSources: renderSourcesFn
      ? (v) => renderSourcesFn(v)
      : (v) => renderSources(v),
  };
}

function renderOne(template, postJson, jsonPath) {
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
  html = html.replace(
    /<meta\s+name=["']description["'][^>]*>/i,
    `<meta name="description" content="${escapeAttr(description)}" />`
  );

  const headBlock = buildHeadMetaBlock(postJson, meta);
  html = html.replace(
    '<!-- Schema & 동적 메타(OG/Twitter/Preload/hreflang)는 렌더러가 주입 -->',
    '<!-- Schema & 동적 메타(OG/Twitter/Preload/hreflang)는 렌더러가 주입 -->\n\n' + headBlock
  );

  html = html.replace(
    /<link\s+rel=["']canonical["'][^>]*>/i,
    `<link rel="canonical" href="${escapeAttr(meta.canonicalUrl)}">`
  );

  const updatedDate = (meta.updatedIso || '').slice(0, 10) || '';
  if (updatedDate) {
    html = html.replace('Updated {{updated}}', `Updated ${escapeHtml(updatedDate)}`);
  }

  const heroAlt = meta.ogAlt || description || title || slug;
  const heroImg = meta.ogImage
    ? [
        '<figure class="post-hero">',
        `  <img src="${escapeAttr(meta.ogImage)}" alt="${escapeAttr(heroAlt)}" loading="eager" fetchpriority="high" />`,
        '</figure>',
      ].join('\n')
    : '';

  html = html.replace(
    '<!--SLOT:HERO_IMAGE-->',
    heroImg ? `${heroImg}\n  <!--SLOT:HERO_IMAGE-->` : '<!--SLOT:HERO_IMAGE-->'
  );

  // AIO 블록 치환
  const blocks = pickBlocks(postJson);
  const aio = blocks.aio;

  html = html.replace('{{tldr}}', blocks.renderTldr(aio.tldr));
  html = html.replace('{{keyfacts}}', blocks.renderKeyFacts(aio.keyfacts));

  // [ADD] 본문 이미지 1장 삽입(파일이 있을 때만)
  const bodyImage = resolveBodyImageFromLocal({ slug, pageId, cdnBase, postJson });
  const figure = bodyImage ? buildBodyImageFigure(bodyImage) : '';

  // 리뷰 라벨: 있으면 우선 삽입, 없으면 그냥 스킵(여기서 “발급/생성”은 하지 않음)
  // 타 라벨: 동일(있으면 삽입, 없으면 스킵)
  // => 생성/확보는 images 단계에서 수행하고, render는 “부착만” 담당 (리스크 최소화)
  let bodyHtml = postJson.body || '';
  bodyHtml = injectBodyImageOnce(bodyHtml, figure);

  html = html.replace('{{body}}', bodyHtml);
  html = html.replace('{{faq}}', blocks.renderFaq(aio.faq));
  html = html.replace('{{sources}}', blocks.renderSources(aio.sources));

  // 디버그 주석
  const biNote = bodyImage ? `bodyImage=1` : `bodyImage=0`;
  html = html.replace(
    '</head>',
    `<!-- render-posts: pageId=${escapeHtml(pageId)} via=${escapeHtml(pidRes.via)} ${biNote} -->\n</head>`
  );

  return html;
}

/* ───────────────────── 메인 ───────────────────── */

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[render-posts] ROOT      =', ROOT);
  console.log('[render-posts] POSTS_DIR =', POSTS_DIR);
  console.log('[render-posts] TEMPLATE  =', TEMPLATE_PATH);
  console.log('[render-posts] OUTPUT    =', OUTPUT_DIR);
  console.log('[render-posts] JOURNAL   =', JOURNAL_FILE);
  console.log('[render-posts] BODY_DIR  =', DIST_BODY_DIR);

  ensureDir(OUTPUT_DIR);
  ensureDir(MANIFESTS_DIR);

  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error('[render-posts] post.html 템플릿을 찾을 수 없습니다:', TEMPLATE_PATH);
    process.exit(1);
  }

  if (!fs.existsSync(POSTS_DIR)) {
    console.warn('[render-posts] POSTS_DIR가 없습니다. (생성된 포스트 없음) → 종료');
    process.exit(0);
  }

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const files = fs
    .readdirSync(POSTS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .sort();

  console.log('[render-posts] 대상 JSON 수 =', files.length);

  let ok = 0;
  let fail = 0;

  for (const file of files) {
    const fullPath = path.join(POSTS_DIR, file);
    let json;

    try {
      json = readJson(fullPath);
    } catch (e) {
      console.error('[render-posts] JSON 파싱 실패:', file, e.message);
      fail++;
      continue;
    }

    const slug = json.slug || path.basename(file, '.json');
    const outPath = path.join(OUTPUT_DIR, `${slug}.html`);

    try {
      const html = renderOne(template, json, fullPath);
      fs.writeFileSync(outPath, html, 'utf8');
      console.log('[render-posts] ✓ 렌더 완료 →', path.basename(outPath));
      ok++;
    } catch (e) {
      console.error('[render-posts] 렌더 실패:', file, e.message);
      fail++;
    }
  }

  console.log('────────────────────────────────────────────');
  console.log(`[render-posts] 결과: 성공=${ok}, 실패=${fail}`);
  if (fail > 0) process.exitCode = 1;
}

if (require.main === module) {
  main();
}
