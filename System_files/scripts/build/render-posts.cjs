#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/render-posts.cjs
 * - content/posts/*.json → dist/posts/*.html 렌더러
 * - meta.cjs(buildMeta)로 canonical/OG/schema/pageBadge 생성
 * - TL;DR / Key Facts / FAQ / Sources / Hero 이미지까지 한 번에 주입
 */

const fs   = require('fs');
const path = require('path');

const ROOT          = path.resolve(__dirname, '..', '..');   // System_files
const POSTS_DIR     = path.join(ROOT, 'content', 'posts');
const TEMPLATE_PATH = path.join(ROOT, 'templates', 'post.html');
const OUTPUT_DIR    = path.join(ROOT, 'dist', 'posts');

// meta.cjs (CJS 버전) 이용
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
  // 속성 전용
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
      // 문자열 단독 FAQ → "질문/답변 한 줄 요약" 형태로 처리
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

/**
 * FAQ HTML 렌더링
 * - [object Object] 문제를 여기서 해결
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

/* ───────────────────── 메타/헤드 블록 ───────────────────── */

function buildHeadMetaBlock(post, meta) {
  const title       = meta.title || post.title || 'Untitled';
  const description = meta.summary || post.description || '';
  const canonical   = meta.canonicalUrl;
  const ogImage     = meta.ogImage;
  const ogAlt       = meta.ogAlt || description || title;

  // og:image 기본 사이즈(규칙상 1200x630)
  const OG_W = 1200;
  const OG_H = 630;

  const lines = [];

  // Canonical
  lines.push(`<link rel="canonical" href="${escapeAttr(canonical)}">`);

  // OG / Twitter
  lines.push(`<meta property="og:type" content="article">`);
  lines.push(`<meta property="og:url" content="${escapeAttr(canonical)}">`);
  lines.push(`<meta property="og:title" content="${escapeAttr(title)}">`);
  if (description) {
    lines.push(`<meta property="og:description" content="${escapeAttr(description)}">`);
  }
  if (ogImage) {
    lines.push(`<meta property="og:image" content="${escapeAttr(ogImage)}">`);
    lines.push(`<meta property="og:image:alt" content="${escapeAttr(ogAlt)}">`);
    lines.push(`<meta property="og:image:width" content="${OG_W}">`);
    lines.push(`<meta property="og:image:height" content="${OG_H}">`);
  }

  lines.push(`<meta name="twitter:card" content="summary_large_image">`);
  lines.push(`<meta name="twitter:title" content="${escapeAttr(title)}">`);
  if (description) {
    lines.push(`<meta name="twitter:description" content="${escapeAttr(description)}">`);
  }
  if (ogImage) {
    lines.push(`<meta name="twitter:image" content="${escapeAttr(ogImage)}">`);
    lines.push(`<meta name="twitter:image:alt" content="${escapeAttr(ogAlt)}">`);
  }

  // 시간 메타
  if (meta.publishedIso) {
    lines.push(
      `<meta property="article:published_time" content="${escapeAttr(meta.publishedIso)}">`
    );
  }
  if (meta.updatedIso) {
    lines.push(
      `<meta property="article:modified_time" content="${escapeAttr(meta.updatedIso)}">`
    );
    lines.push(
      `<meta property="og:updated_time" content="${escapeAttr(meta.updatedIso)}">`
    );
  }

  // LCP 이미지 preload + preconnect
  if (ogImage) {
    lines.push(
      `<link rel="preload" as="image" href="${escapeAttr(
        ogImage
      )}" fetchpriority="high" imagesrcset="${escapeAttr(ogImage)}">`
    );
  }
  const siteBase = (process.env.CANONICAL_BASE || 'https://ongsblog.com').replace(/\/+$/,'');
  lines.push(`<link rel="preconnect" href="${escapeAttr(siteBase)}" crossorigin>`);

  // JSON-LD 스키마(Article, Breadcrumb, FAQ, WebSite/authorityRef)
  if (meta.schemaTag) {
    lines.push(meta.schemaTag);
  }
  if (meta.authorityScript) {
    lines.push(meta.authorityScript);
  }

  return lines.join('\n');
}

/* ───────────────────── 개별 포스트 렌더링 ───────────────────── */

function renderOne(template, postJson) {
  const slug = postJson.slug || path.basename(postJson.__file || 'sample_post.json', '.json');

  // pageId는 validate-repair 등에서 이미 부여되었으면 우선 사용
  const pageId =
    postJson.pageId ||
    postJson.page_id ||
    (postJson.seedMeta && postJson.seedMeta.pageId) ||
    `page${Math.floor(100000 + Math.random() * 900000)}`;

  const siteBase = process.env.CANONICAL_BASE || process.env.SITE_BASE || 'https://ongsblog.com';
  const cdnBase  = process.env.CDN_BASE || (siteBase.replace(/\/+$/,'') + '/images');

  const meta = buildMeta(postJson, { slug, pageId, siteBase, cdnBase });

  let html = template;

  // 제목 / description
  const title       = meta.title || postJson.title || 'Untitled';
  const description = meta.summary || postJson.description || '';

  html = html.replace(
    /<title>[\s\S]*?<\/title>/i,
    `<title>${escapeHtml(title)}</title>`
  );

  html = html.replace(
    /<meta\s+name=["']description["'][^>]*>/i,
    `<meta name="description" content="${escapeAttr(description)}" />`
  );

  // Canonical + OG/Twitter/Schema 블록 삽입
  const headBlock = buildHeadMetaBlock(postJson, meta);
  html = html.replace(
    '<!-- Schema & 동적 메타(OG/Twitter/Preload/hreflang)는 렌더러가 주입 -->',
    '<!-- Schema & 동적 메타(OG/Twitter/Preload/hreflang)는 렌더러가 주입 -->\n\n' +
      headBlock
  );

  // Canonical 기본 라인에도 href 교체(템플릿에 placeholder가 있을 수 있으므로 재보정)
  html = html.replace(
    /<link\s+rel=["']canonical["'][^>]*>/i,
    `<link rel="canonical" href="${escapeAttr(meta.canonicalUrl)}">`
  );

  // Updated 배지(YYYY-MM-DD)
  const updatedDate = (meta.updatedIso || '').slice(0, 10) || '';
  if (updatedDate) {
    html = html.replace(
      'Updated {{updated}}',
      `Updated ${escapeHtml(updatedDate)}`
    );
  }

  // 페이지 배지 삽입 (SLOT 유지)
  if (meta.pageBadge) {
    html = html.replace(
      '<!--SLOT:PAGE_BADGE-->',
      `${meta.pageBadge}\n  <!--SLOT:PAGE_BADGE-->`
    );
  }

  // 히어로 이미지
  const heroAlt = meta.ogAlt || description || title || slug;
  const heroImg = meta.ogImage
    ? [
        '<figure class="post-hero">',
        `  <img src="${escapeAttr(meta.ogImage)}" alt="${escapeAttr(
          heroAlt
        )}" loading="eager" fetchpriority="high" />`,
        '</figure>',
      ].join('\n')
    : '';

  // 템플릿 주석 위치에 주입
  html = html.replace(
    '<!-- 히어로 이미지 (자동 주입/교정) -->',
    `<!-- 히어로 이미지 (자동 주입/교정) -->\n  ${heroImg}`
  );

  // TL;DR / Key Facts / Body / FAQ / Sources
  const aio = postJson.aio || {};

  html = html.replace('{{tldr}}', renderListItems(aio.tldr));
  html = html.replace('{{keyfacts}}', renderListItems(aio.keyfacts));
  html = html.replace('{{body}}', postJson.body || '');
  html = html.replace('{{faq}}', renderFaq(aio.faq));
  html = html.replace('{{sources}}', renderSources(aio.sources));

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

