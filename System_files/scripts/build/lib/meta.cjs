'use strict';

/**
 * meta.cjs
 * - 각 포스트에 들어갈 canonical / og:image / JSON-LD(Article, FAQPage, BreadcrumbList, WebSite) 생성
 * - render-posts.cjs 에서 buildMeta(post, { slug, pageId, siteBase, cdnBase }) 형태로 호출
 * - ✅ (회귀) meta가 "공장": meta head HTML(OG/Twitter/time/preload/schema)까지 생성
 */

/* ───────────────────── 헬퍼 ───────────────────── */

function toKSTISO(d) {
  // KST(+09:00) 기준 ISO8601
  const utc = d.getTime() + 9 * 60 * 60 * 1000;
  const k = new Date(utc);
  const yyyy = k.getUTCFullYear();
  const mm = String(k.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(k.getUTCDate()).padStart(2, '0');
  const hh = String(k.getUTCHours()).padStart(2, '0');
  const mi = String(k.getUTCMinutes()).padStart(2, '0');
  const ss = String(k.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+09:00`;
}

function safeDateISO(src) {
  // 이미 ISO 형태면 그대로 사용
  if (
    typeof src === 'string' &&
    src.includes('T') &&
    (src.endsWith('+09:00') || src.endsWith('Z'))
  ) {
    return src;
  }
  if (typeof src === 'string') {
    const d = new Date(src);
    if (!isNaN(d.getTime())) return toKSTISO(d);
  }
  if (src instanceof Date && !isNaN(src.getTime())) {
    return toKSTISO(src);
  }
  // fallback: 지금 시간
  return toKSTISO(new Date());
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

/* HTML escape (head meta 생성용) */
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

/* FAQ 데이터 정규화
   - aio.faq 가
     · [{q, a}, …] 이거나
     · [{question, answer}, …] 인 경우 모두 수용 */
function normalizeFaq(faqRaw) {
  const list = [];
  for (const item of asArray(faqRaw)) {
    if (!item) continue;
    let q = '';
    let a = '';
    if (typeof item === 'string') {
      // 문자열 단일 항목은 FAQ로 쓰기 애매해서 스킵
      continue;
    } else if (typeof item === 'object') {
      q = firstNonEmpty(item.q, item.question, '');
      a = firstNonEmpty(item.a, item.answer, '');
    }
    if (!q || !a) continue;
    list.push({ q, a });
  }
  return list;
}

/* label → article:section용 대분류 매핑 */
function labelToSection(mainLabel) {
  switch (mainLabel) {
    case 'app-reviews':
    case 'device-reviews':
    case 'subscription-services':
      return 'Reviews & Buying Guides';
    case 'how-to-playbooks':
      return 'Conquer Tech';
    case 'smart-savings':
      return 'Sophisticated Choice';
    case 'templates-checklists':
      return 'Practical Playbook';
    default:
      return 'Ongs Blog';
  }
}

/* ───────────────────── head meta 공장(HTML 생성) ───────────────────── */

function buildSchemaScript(schemaTags) {
  if (!Array.isArray(schemaTags) || schemaTags.length === 0) return '';
  const json = JSON.stringify(schemaTags.length === 1 ? schemaTags[0] : schemaTags);
  return `<script type="application/ld+json">${json}</script>`;
}

function buildHeadFromMetaResult(metaRes) {
  const og = (metaRes && metaRes.metaTags && metaRes.metaTags.og) ? metaRes.metaTags.og : {};
  const tw = (metaRes && metaRes.metaTags && metaRes.metaTags.twitter) ? metaRes.metaTags.twitter : {};
  const tm = (metaRes && metaRes.metaTags && metaRes.metaTags.timeMeta) ? metaRes.metaTags.timeMeta : {};

  const canonical = metaRes.canonicalUrl || og.url || '';
  const title = og.title || metaRes.resolvedTitle || '';
  const desc = og.description || metaRes.resolvedDescription || '';
  const ogImage = og.image || metaRes.ogImage || '';
  const ogAlt = og.imageAlt || metaRes.ogAlt || desc || title;

  const lines = [];

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

  lines.push(buildSchemaScript(metaRes.schemaTags));

  return lines.filter(Boolean).join('\n');
}

/* ───────────────────── 메인 빌더 ───────────────────── */

/**
 * buildMeta
 *
 * @param {Object} post          content/posts/*.json 내용 전체
 * @param {Object} ctx
 * @param {string} ctx.slug      슬러그 (예: howto-20251121-001)
 * @param {string} ctx.pageId    page#### 형식
 * @param {string} ctx.siteBase  CANONICAL_BASE (예: https://ongsblog.com)
 * @param {string} ctx.cdnBase   CDN_BASE (예: https://ongsblog.com/images)
 */
function buildMeta(post, ctx = {}) {
  if (!post || typeof post !== 'object') {
    throw new Error('buildMeta: invalid post data');
  }

  const SITE_BASE =
    ctx.siteBase ||
    process.env.SITE_BASE ||
    process.env.CANONICAL_BASE ||
    'https://ongsblog.com';

  const CDN_BASE =
    ctx.cdnBase ||
    process.env.CDN_BASE ||
    (SITE_BASE.replace(/\/+$/, '') + '/images');

  const slug = ctx.slug || post.slug || 'sample_post';
  const pageId = ctx.pageId || post.pageId || 'page000000';

  const title = firstNonEmpty(
    post.title,
    (post.aio && Array.isArray(post.aio.tldr) && post.aio.tldr[0]),
    slug
  );

  const description = firstNonEmpty(
    post.description,
    (post.aio && Array.isArray(post.aio.tldr) && post.aio.tldr[1]),
    post.seedMeta && post.seedMeta.angle,
    ''
  );

  const canonicalUrl =
    (SITE_BASE.replace(/\/+$/, '') + '/' + slug.replace(/\.html?$/i, '') + '.html');

  const ogImage =
    CDN_BASE.replace(/\/+$/, '') +
    `/og/${pageId}_${slug.replace(/\.html?$/i, '')}_1200x630.jpg`;

  // 대표 ALT 텍스트(히어로/OG/Twitter 공통 기준)
  // 우선순위: aio.heroImage.alt → description → title → slug
  const heroAlt = firstNonEmpty(
    post.aio && post.aio.heroImage && post.aio.heroImage.alt,
    description,
    title,
    slug
  );

  const updatedRaw = firstNonEmpty(
    post.updated,
    post.seedMeta && post.seedMeta.queueDate
  );
  const publishedRaw = firstNonEmpty(
    post.published,
    post.seedMeta && post.seedMeta.queueDate,
    updatedRaw
  );

  const updatedIso = safeDateISO(updatedRaw);
  const publishedIso = safeDateISO(publishedRaw);

  const mainLabel = asArray(post.labels || [])[0] || '';
  const section = labelToSection(mainLabel);

  /* ─ metaTags 구조 (render-posts.cjs 에서 사용) ─ */
  const metaTags = {
    og: {
      type: 'article',
      url: canonicalUrl,
      title,
      description: description || title,
      image: ogImage,
      imageAlt: heroAlt,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: description || title,
      image: ogImage,
      imageAlt: heroAlt,
    },
    timeMeta: {
      publishedTime: publishedIso,
      modifiedTime: updatedIso,
    },
  };

  /* ─ Article JSON-LD ─ */
  const articleJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description: description || title,
    datePublished: publishedIso,
    dateModified: updatedIso,
    mainEntityOfPage: canonicalUrl,
    image: [ogImage],
    author: {
      '@type': 'Person',
      name: 'Ongs',
    },
    publisher: {
      '@type': 'Organization',
      name: 'Ongs Blog',
      logo: {
        '@type': 'ImageObject',
        url: CDN_BASE.replace(/\/+$/, '') + '/og/logo_600x60.png',
      },
    },
    copyrightHolder: {
      '@type': 'Organization',
      name: 'Ongs Blog',
    },
    copyrightYear: String(new Date().getFullYear()),
    articleSection: section,
  };

  /* Sources → citation (선택) */
  const sources = asArray(post.aio && post.aio.sources);
  if (sources.length) {
    articleJsonLd.citation = sources
      .filter(
        (s) =>
          typeof s === 'string' ||
          (s && typeof s === 'object' && s.url)
      )
      .map((s) => (typeof s === 'string' ? s : s.url));
  }

  /* ─ FAQPage JSON-LD (있을 때만) ─ */
  const faqItems = normalizeFaq(post.aio && post.aio.faq);
  let faqJsonLd = null;
  if (faqItems.length) {
    faqJsonLd = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqItems.map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: {
          '@type': 'Answer',
          text: item.a,
        },
      })),
    };
  }

  /* ─ BreadcrumbList JSON-LD ─ */
  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Ongs Blog',
        item: SITE_BASE.replace(/\/+$/, ''),
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: title,
        item: canonicalUrl,
      },
    ],
  };

  /* ─ Authority WebSite JSON-LD (site-wide authorityRef) ─ */
  const authorityRef =
    process.env.AUTHORITY_REF_URL ||
    SITE_BASE.replace(/\/+$/, '') + '/ai/authority.json';

  const authorityJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    url: SITE_BASE.replace(/\/+$/, ''),
    authorityRef: authorityRef,
  };

  const schemaTags = [articleJsonLd, breadcrumbJsonLd, authorityJsonLd];
  if (faqJsonLd) schemaTags.push(faqJsonLd);

  // ✅ meta 공장에서 headHtml까지 만들어 반환
  const metaRes = {
    metaTags,
    schemaTags,
    canonicalUrl,
    ogImage,
    ogAlt: heroAlt,
    updatedIso,
    publishedIso,
    pageId,
    resolvedTitle: title,
    resolvedDescription: description || title,
  };
  metaRes.headHtml = buildHeadFromMetaResult(metaRes);

  return metaRes;
}

module.exports = {
  buildMeta,
};
