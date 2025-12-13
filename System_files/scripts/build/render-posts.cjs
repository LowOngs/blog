#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/render-posts.cjs
 * - content/posts/*.json → dist/posts/*.html 렌더러
 * - buildMeta(meta.cjs)로 canonical/OG/schema(배열) 생성
 * - 템플릿(post.html)의 placeholder/slot에 정확히 주입
 *
 * 핵심 포인트:
 * 1) {{title}}, {{description}}, {{canonical}}, {{pageId}}, {{updated}} 치환
 * 2) <!--META--> 에 OG/Twitter/Schema/시간메타/프리로드 주입
 * 3) <!--SLOT:HERO_IMAGE--> 에 히어로 이미지 주입
 * 4) aio 데이터가 없거나(top-level에만 있거나) 섞여 있어도 흡수
 */

const fs = require('fs');
const path = require('path');

const ROOT          = path.resolve(__dirname, '..', '..');   // System_files
const POSTS_DIR     = path.join(ROOT, 'content', 'posts');
const TEMPLATE_PATH = path.join(ROOT, 'templates', 'post.html');
const OUTPUT_DIR    = path.join(ROOT, 'dist', 'posts');

const { buildMeta } = require('./lib/meta.cjs');

/* ───────────────────── 공통 유틸 ───────────────────── */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
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

function replaceAllSafe(haystack, needle, replacement) {
  // Node 환경별 replaceAll 미지원 대비
  if (typeof haystack.replaceAll === 'function') return haystack.replaceAll(needle, replacement);
  return haystack.split(needle).join(replacement);
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

/* ───────────────────── AIO 데이터 흡수(중요) ───────────────────── */
/**
 * 케이스:
 * A) queue-to-posts가 만든 문서: aio: {tldr,keyfacts,faq,sources} 존재
 * B) 샘플처럼 top-level(tldr/keyfacts/faq/sources)만 있고 aio가 비어있을 수 있음
 * C) 둘 다 섞여 있어도 aio 우선, 없으면 top-level로 보완
 */
function getAio(postJson) {
  const aio = postJson.aio && typeof postJson.aio === 'object' ? postJson.aio : {};

  const tldr     = asArray(firstNonEmpty(aio.tldr, postJson.tldr, []));
  const keyfacts = asArray(firstNonEmpty(aio.keyfacts, postJson.keyfacts, []));
  const faq      = asArray(firstNonEmpty(aio.faq, postJson.faq, []));
  const sources  = asArray(firstNonEmpty(aio.sources, postJson.sources, []));

  return { tldr, keyfacts, faq, sources };
}

/* ───────────────────── HEAD 메타 블록 ───────────────────── */

function buildMetaHeadBlock(postJson, meta) {
  const title       = firstNonEmpty(postJson.title, meta?.metaTags?.og?.title, 'Untitled');
  const description = firstNonEmpty(postJson.description, meta?.metaTags?.og?.description, '');

  const canonical = meta.canonicalUrl || '';
  const ogImage   = meta.ogImage || '';
  const ogAlt     = meta.ogAlt || description || title;

  const OG_W = 1200;
  const OG_H = 630;

  const lines = [];

  // Canonical(안전상 한 번 더)
  if (canonical) lines.push(`<link rel="canonical" href="${escapeAttr(canonical)}">`);

  // OG/Twitter
  lines.push(`<meta property="og:type" content="article">`);
  if (canonical) lines.push(`<meta property="og:url" content="${escapeAttr(canonical)}">`);
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

  const siteBase = (process.env.CANONICAL_BASE || process.env.SITE_BASE || 'https://ongsblog.com')
    .replace(/\/+$/, '');
  lines.push(`<link rel="preconnect" href="${escapeAttr(siteBase)}" crossorigin>`);

  // JSON-LD 스키마(meta.cjs는 schemaTags 배열을 반환)
  if (meta.schemaTags && Array.isArray(meta.schemaTags) && meta.schemaTags.length) {
    for (const obj of meta.schemaTags) {
      try {
        const json = JSON.stringify(obj);
        lines.push(`<script type="application/ld+json">${json}</script>`);
      } catch (_) {
        // 스키마 직렬화 실패는 조용히 스킵(빌드 중단 방지)
      }
    }
  }

  return lines.join('\n');
}

/* ───────────────────── 개별 포스트 렌더링 ───────────────────── */

function renderOne(template, postJson) {
  const slug = postJson.slug || path.basename(postJson.__file || 'sample_post.json', '.json');

  // pageId 우선순위: JSON이 들고 있으면 그대로 사용
  const pageId =
    postJson.pageId ||
    postJson.page_id ||
    (postJson.seedMeta && postJson.seedMeta.pageId) ||
    `page${Math.floor(100000 + Math.random() * 900000)}`;

  const siteBase = process.env.CANONICAL_BASE || process.env.SITE_BASE || 'https://ongsblog.com';
  const cdnBase  = process.env.CDN_BASE || (siteBase.replace(/\/+$/, '') + '/images');

  const meta = buildMeta(postJson, { slug, pageId, siteBase, cdnBase });

  // 템플릿 기반 치환
  let html = template;

  const title       = firstNonEmpty(postJson.title, meta?.metaTags?.og?.title, slug);
  const description = firstNonEmpty(postJson.description, meta?.metaTags?.og?.description, '');
  const canonical   = meta.canonicalUrl || (siteBase.replace(/\/+$/, '') + '/' + slug + '.html');

  // 템플릿 placeholder 채우기
  html = replaceAllSafe(html, '{{title}}', escapeHtml(title));
  html = replaceAllSafe(html, '{{description}}', escapeAttr(description));
  html = replaceAllSafe(html, '{{canonical}}', escapeAttr(canonical));
  html = replaceAllSafe(html, '{{pageId}}', escapeHtml(pageId));

  // Updated {{updated}} (YYYY-MM-DD)
  const updatedDate = (meta.updatedIso || '').slice(0, 10) || '';
  html = replaceAllSafe(html, '{{updated}}', escapeHtml(updatedDate));

  // META 슬롯 주입
  const headBlock = buildMetaHeadBlock(postJson, meta);
  html = html.replace('<!--META-->', `<!--META-->\n${headBlock}`);

  // canonical 태그가 템플릿 외에도 있을 수 있으니 1회 더 교정
  html = html.replace(
    /<link\s+rel=["']canonical["'][^>]*>/i,
    `<link rel="canonical" href="${escapeAttr(canonical)}">`
  );

  // PAGE_BADGE 슬롯은 "추가 배지"가 있을 때만 (기본 배지는 템플릿이 이미 가짐)
  // (현재는 별도 pageBadge 생성 로직이 없으므로 SLOT 유지)

  // HERO_IMAGE 슬롯 주입
  const heroAlt = meta.ogAlt || description || title || slug;
  const heroImg = meta.ogImage
    ? [
        '<figure class="post-hero">',
        `  <img src="${escapeAttr(meta.ogImage)}" alt="${escapeAttr(heroAlt)}" loading="eager" fetchpriority="high" />`,
        '</figure>',
      ].join('\n')
    : '';

  html = html.replace('<!--SLOT:HERO_IMAGE-->', `<!--SLOT:HERO_IMAGE-->\n${heroImg}`);

  // AIO 블록(흡수)
  const aio = getAio(postJson);

  html = replaceAllSafe(html, '{{tldr}}', renderListItems(aio.tldr));
  html = replaceAllSafe(html, '{{keyfacts}}', renderListItems(aio.keyfacts));
  html = replaceAllSafe(html, '{{faq}}', renderFaq(aio.faq));
  html = replaceAllSafe(html, '{{sources}}', renderSources(aio.sources));

  // 본문
  html = replaceAllSafe(html, '{{body}}', postJson.body || '');

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
      const html = renderOne(template, json);
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
