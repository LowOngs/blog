#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/render-posts.cjs
 * - content/posts/*.json → dist/posts/*.html 렌더러
 * - meta.cjs(buildMeta)로 canonical/OG/schema/pageBadge 생성
 * - TL;DR / Key Facts / FAQ / Sources / Hero 이미지까지 한 번에 주입
 *
 * 중요(강제):
 * - pageId는 랜덤 생성 금지
 * - pageId 누락 시: ledger(ensurePageId)로 발급 → 원본 JSON에 "반드시" 기록 성공해야 진행
 * - 기록 실패면 빌드 실패(중단) → 재시도/복구 루프에서 처리
 */

const fs = require('fs');
const path = require('path');

const ROOT          = path.resolve(__dirname, '..', '..');   // System_files
const POSTS_DIR     = path.join(ROOT, 'content', 'posts');
const TEMPLATE_PATH = path.join(ROOT, 'templates', 'post.html');
const OUTPUT_DIR    = path.join(ROOT, 'dist', 'posts');

// meta.cjs
const { buildMeta } = require('./lib/meta.cjs');
// page id ledger
const { ensurePageId } = require('./lib/page-ids.cjs');

/* ───────────────────── 공통 유틸 ───────────────────── */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function writeJsonAtomic(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
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

function isValidPageId(pid) {
  return typeof pid === 'string' && /^page\d{6}$/.test(pid);
}

function getEffectivePageIdMode() {
  // 우선순위: PAGE_ID_MODE > (DRY_RUN 기반 추론)
  // (publish.yml에서 DRY_RUN이 최종 안전 스위치이므로 여기서도 동일 추론 지원)
  const explicit = (process.env.PAGE_ID_MODE || '').trim();
  if (explicit) return explicit;

  const dry = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';
  return dry ? 'no_live' : 'live';
}

/* ───────────────────── AIO 블록 렌더러 ───────────────────── */

function renderListItems(list) {
  const arr = asArray(list)
    .map((s) => (s == null ? '' : String(s).trim()))
    .filter(Boolean);

  if (!arr.length) return '';
  return arr.map((s) => `<li>${escapeHtml(s)}</li>`).join('\n');
}

/**
 * FAQ 정규화
 * - [{q,a}] / [{question,answer}] / 문자열 섞여 있어도 수용
 */
function normalizeFaq(raw) {
  const out = [];
  for (const item of asArray(raw)) {
    if (!item) continue;

    if (typeof item === 'string') {
      const text = item.trim();
      if (!text) continue;
      // 문자열만 있는 FAQ는 최소 안전 변환(질문=답변)
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

/**
 * FAQ HTML 렌더링
 * - [object Object] 문제 해결
 */
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

/**
 * Sources 렌더링
 * - 문자열 / {label,url} / {name,url,note} 등 유연 대응
 */
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

/* ───────────────────── pageId 강제 보장(핵심) ───────────────────── */

/**
 * 반드시:
 * 1) JSON에 pageId가 있으면 그 값을 사용
 * 2) 없으면 ledger로 발급 (ensurePageId)
 * 3) 원본 JSON에 영구 기록 성공까지 강제
 * 4) 실패하면 throw (빌드 중단)
 */
function ensureAndPersistPageId(jsonPath, postJson, slug) {
  const existing = firstNonEmpty(postJson.pageId, postJson.page_id, '');
  if (isValidPageId(existing)) return { pageId: existing, assigned: false };

  const mode = getEffectivePageIdMode();
  const pid = ensurePageId(slug, mode);

  if (!isValidPageId(pid)) {
    throw new Error(`pageId ledger returned invalid value for slug=${slug}: ${String(pid)}`);
  }

  // 원본 JSON에 반드시 기록
  const fresh = readJson(jsonPath);
  fresh.slug = fresh.slug || slug;
  fresh.pageId = pid;
  writeJsonAtomic(jsonPath, fresh);

  // 재확인(저장/경로 문제 방지)
  const verify = readJson(jsonPath);
  if (!isValidPageId(verify.pageId) || verify.pageId !== pid) {
    throw new Error(`pageId persist verify failed: slug=${slug}, expected=${pid}, got=${String(verify.pageId)}`);
  }

  // 메모리 객체에도 반영
  postJson.pageId = pid;

  return { pageId: pid, assigned: true };
}

/* ───────────────────── 메타/헤드 블록 ───────────────────── */

function buildHeadMetaBlock(post, meta) {
  const title       = meta.title || post.title || 'Untitled';
  const description = meta.summary || post.description || '';
  const canonical   = meta.canonicalUrl;
  const ogImage     = meta.ogImage;
  const ogAlt       = meta.ogAlt || description || title;

  const OG_W = 1200;
  const OG_H = 630;

  const lines = [];

  // Canonical
  lines.push(`<link rel="canonical" href="${escapeAttr(canonical)}">`);

  // OG / Twitter
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

  // 시간 메타
  if (meta.publishedIso) {
    lines.push(`<meta property="article:published_time" content="${escapeAttr(meta.publishedIso)}">`);
  }
  if (meta.updatedIso) {
    lines.push(`<meta property="article:modified_time" content="${escapeAttr(meta.updatedIso)}">`);
    lines.push(`<meta property="og:updated_time" content="${escapeAttr(meta.updatedIso)}">`);
  }

  // LCP preload + preconnect
  if (ogImage) {
    lines.push(
      `<link rel="preload" as="image" href="${escapeAttr(ogImage)}" fetchpriority="high" imagesrcset="${escapeAttr(ogImage)}">`
    );
  }

  const siteBase = (process.env.CANONICAL_BASE || 'https://ongsblog.com').replace(/\/+$/,'');
  lines.push(`<link rel="preconnect" href="${escapeAttr(siteBase)}" crossorigin>`);

  if (meta.schemaTag) lines.push(meta.schemaTag);
  if (meta.authorityScript) lines.push(meta.authorityScript);

  return lines.join('\n');
}

/* ───────────────────── 스키마 태그 생성 ───────────────────── */

function buildSchemaScriptFromMeta(meta) {
  if (!meta || !Array.isArray(meta.schemaTags) || meta.schemaTags.length === 0) return '';
  const json = JSON.stringify(meta.schemaTags.length === 1 ? meta.schemaTags[0] : meta.schemaTags);
  return `<script type="application/ld+json">${json}</script>`;
}

/* ───────────────────── 개별 포스트 렌더링 ───────────────────── */

function resolveAio(postJson) {
  const aio = postJson.aio && typeof postJson.aio === 'object' ? postJson.aio : {};
  return {
    tldr: firstNonEmpty(aio.tldr, postJson.tldr, []),
    keyfacts: firstNonEmpty(aio.keyfacts, postJson.keyfacts, []),
    faq: firstNonEmpty(aio.faq, postJson.faq, []),
    sources: firstNonEmpty(aio.sources, postJson.sources, []),
    heroImage: aio.heroImage || null
  };
}

function injectDataPageIdAttr(html, pageId) {
  // id="pageId"가 있는 앵커/태그에 data-page-id를 강제로 붙여 validate 1순위 회수 안정화
  // 이미 있으면 덮어씀
  const rx = /(<a\b[^>]*\bid=["']pageId["'][^>]*)(>)/i;
  if (rx.test(html)) {
    // 기존 data-page-id가 있으면 제거 후 추가
    html = html.replace(/data-page-id=["']page\d{6}["']\s*/i, '');
    return html.replace(rx, `$1 data-page-id="${escapeAttr(pageId)}"$2`);
  }
  return html;
}

function renderOne(template, postJson, ctx) {
  const slug = ctx.slug;
  const pageId = ctx.pageId;

  const siteBase = process.env.CANONICAL_BASE || process.env.SITE_BASE || 'https://ongsblog.com';
  const cdnBase  = process.env.CDN_BASE || (siteBase.replace(/\/+$/,'') + '/images');

  const meta = buildMeta(postJson, { slug, pageId, siteBase, cdnBase });

  // meta.cjs 반환값 구조를 렌더러가 기대하는 형태로 맞춤(호환)
  meta.title = meta.metaTags && meta.metaTags.og ? meta.metaTags.og.title : (postJson.title || slug);
  meta.summary = meta.metaTags && meta.metaTags.og ? meta.metaTags.og.description : (postJson.description || '');
  meta.schemaTag = buildSchemaScriptFromMeta(meta);

  let html = template;

  // 제목 / description
  const title       = meta.title || postJson.title || 'Untitled';
  const description = meta.summary || postJson.description || '';

  // 템플릿 placeholder 치환(중요)
  html = replaceAllSafe(html, '{{title}}', escapeHtml(title));
  html = replaceAllSafe(html, '{{description}}', escapeAttr(description));
  html = replaceAllSafe(html, '{{pageId}}', escapeHtml(pageId));
  html = replaceAllSafe(html, '{{canonical}}', escapeAttr(meta.canonicalUrl));

  // <title> / meta description (중복 방어)
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  html = html.replace(
    /<meta\s+name=["']description["'][^>]*>/i,
    `<meta name="description" content="${escapeAttr(description)}" />`
  );

  // Canonical + OG/Twitter/Schema 블록 삽입
  const headBlock = buildHeadMetaBlock(postJson, meta);
  html = html.replace(
    '<!-- Schema & 동적 메타(OG/Twitter/Preload/hreflang)는 렌더러가 주입 -->',
    '<!-- Schema & 동적 메타(OG/Twitter/Preload/hreflang)는 렌더러가 주입 -->\n\n' + headBlock
  );

  // Canonical 라인 재보정
  html = html.replace(
    /<link\s+rel=["']canonical["'][^>]*>/i,
    `<link rel="canonical" href="${escapeAttr(meta.canonicalUrl)}">`
  );

  // Updated 배지(YYYY-MM-DD)
  const updatedDate = (meta.updatedIso || '').slice(0, 10) || '';
  if (updatedDate) {
    html = html.replace('Updated {{updated}}', `Updated ${escapeHtml(updatedDate)}`);
  }

  // 페이지 배지 삽입 (SLOT 유지)
  if (meta.pageBadge) {
    html = html.replace('<!--SLOT:PAGE_BADGE-->', `${meta.pageBadge}\n  <!--SLOT:PAGE_BADGE-->`);
  }

  // 히어로 이미지: 템플릿 슬롯에 정확히 주입
  const heroAlt = meta.ogAlt || description || title || slug;
  const heroImg = meta.ogImage
    ? [
        '<figure class="post-hero">',
        `  <img src="${escapeAttr(meta.ogImage)}" alt="${escapeAttr(heroAlt)}" loading="eager" fetchpriority="high" />`,
        '</figure>',
      ].join('\n')
    : '';

  html = html.replace('<!--SLOT:HERO_IMAGE-->', heroImg ? `${heroImg}\n  <!--SLOT:HERO_IMAGE-->` : '<!--SLOT:HERO_IMAGE-->');

  // AIO 데이터
  const aio = resolveAio(postJson);

  // TL;DR / Key Facts / Body / FAQ / Sources
  html = html.replace('{{tldr}}', renderListItems(aio.tldr));
  html = html.replace('{{keyfacts}}', renderListItems(aio.keyfacts));
  html = html.replace('{{body}}', postJson.body || '');
  html = html.replace('{{faq}}', renderFaq(aio.faq));
  html = html.replace('{{sources}}', renderSources(aio.sources));

  // ✅ validate가 가장 안전하게 회수하도록 data-page-id 강제 주입
  html = injectDataPageIdAttr(html, pageId);

  // 디버그 주석(assigned 된 경우만)
  if (ctx.assigned) {
    html = html.replace(
      '</head>',
      `<!-- render-posts: pageId was missing; assigned & persisted ${escapeHtml(pageId)} -->\n</head>`
    );
  }

  return html;
}

/* ───────────────────── 메인 ───────────────────── */

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[render-posts] ROOT      =', ROOT);
  console.log('[render-posts] POSTS_DIR =', POSTS_DIR);
  console.log('[render-posts] TEMPLATE  =', TEMPLATE_PATH);
  console.log('[render-posts] OUTPUT    =', OUTPUT_DIR);

  ensureDir(OUTPUT_DIR);

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
      json.__file = file;
    } catch (e) {
      console.error('[render-posts] JSON 파싱 실패:', file, e.message);
      fail++;
      continue;
    }

    const slug = json.slug || path.basename(file, '.json');
    const outPath = path.join(OUTPUT_DIR, `${slug}.html`);

    try {
      // ✅ pageId는 렌더 직전에 "반드시" 보장 + 원본 JSON에 영구 기록 강제
      const pidCtx = ensureAndPersistPageId(fullPath, json, slug);

      const html = renderOne(template, json, {
        slug,
        pageId: pidCtx.pageId,
        assigned: pidCtx.assigned
      });

      fs.writeFileSync(outPath, html, 'utf8');
      console.log('[render-posts] ✓ 렌더 완료 →', path.basename(outPath));
      ok++;
    } catch (e) {
      console.error('[render-posts] 렌더 실패:', file, e.message || e);
      fail++;
    }
  }

  console.log('────────────────────────────────────────────');
  console.log(`[render-posts] 결과: 성공=${ok}, 실패=${fail}`);

  // ✅ pageId는 생명줄이므로 fail>0이면 빌드 실패로 처리
  if (fail > 0) process.exitCode = 1;
}

if (require.main === module) {
  main();
}
