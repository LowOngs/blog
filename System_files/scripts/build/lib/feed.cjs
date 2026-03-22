/**
 * scripts/build/lib/feed.cjs
 * AI Feed용 공통 유틸 + feed item 빌더
 */

const stripHtml = (s) => {
  return String(s || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * TL;DR + 본문 혼합 summary
 */
function deriveSummary(json, max = 160) {
  const manual = (json.description || '').trim();
  if (manual) {
    return manual.length <= max
      ? manual
      : manual.slice(0, max).trim() + '…';
  }

  const tldrArr = Array.isArray(json?.aio?.tldr) ? json.aio.tldr : null;
  if (tldrArr && tldrArr.length) {
    const joined = tldrArr.slice(0, 2).map(String).join(' ');
    const clean = stripHtml(joined);
    if (clean) {
      return clean.length <= max
        ? clean
        : clean.slice(0, max).trim() + '…';
    }
  }

  const bodyHtml = String(json.body || '');
  const mP = bodyHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const pick = mP ? mP[1] : bodyHtml;
  const clean = stripHtml(pick);
  if (!clean) return '';
  return clean.length <= max
    ? clean
    : clean.slice(0, max).trim() + '…';
}

/**
 * labels 정규화
 */
function deriveLabels(json) {
  let labelsRaw = [];

  if (Array.isArray(json.labels)) {
    labelsRaw = json.labels;
  } else if (Array.isArray(json.label)) {
    labelsRaw = json.label;
  } else if (typeof json.labels === 'string') {
    labelsRaw = [json.labels];
  } else if (typeof json.label === 'string') {
    labelsRaw = [json.label];
  }

  return labelsRaw
    .map((x) => String(x).trim())
    .filter(Boolean);
}

/**
 * intent 추론
 */
function deriveIntent(json, labels) {
  if (json.intent) {
    return String(json.intent);
  }

  const lower = (labels || []).map((l) => String(l).toLowerCase());

  if (
    lower.includes('app-reviews') ||
    lower.includes('device-reviews') ||
    lower.includes('subscription-services')
  ) {
    return 'review';
  }

  if (lower.includes('how-to-playbooks')) {
    return 'how-to';
  }

  if (lower.includes('smart-savings')) {
    return 'savings';
  }

  if (lower.includes('templates-checklists')) {
    return 'template';
  }

  return null;
}

const pad = (n) => String(n).padStart(2, '0');

/* 🔥 수정 1: updated → post 기준 사용 */
function resolveUpdated(json) {
  if (json.updated) return String(json.updated);
  if (json.updatedAt) return String(json.updatedAt);
  if (json.updated_at) return String(json.updated_at);

  // fallback (최후 수단)
  const d = new Date();
  const t = d.getTime() + 9 * 3600 * 1000;
  const k = new Date(t);
  return `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(
    k.getUTCDate()
  )}T${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}:${pad(
    k.getUTCSeconds()
  )}+09:00`;
}

/**
 * citationId 생성
 */
function deriveCitationId(json, slug) {
  const rawPageId = json.pageId || json.page_id || null;
  if (rawPageId) {
    const cleaned = String(rawPageId).replace(/[^a-zA-Z0-9_-]/g, '');
    return `ongs-cite-${cleaned}`;
  }

  const baseSlug = (slug || json.slug || 'sample_post')
    .replace(/\.html?$/i, '')
    .toLowerCase();
  const cleanedSlug = baseSlug.replace(/[^a-z0-9_-]/g, '-');
  return `ongs-cite-${cleanedSlug}`;
}

/**
 * feed 아이템 1개 생성
 */
function buildFeedItem(json, env, authorityRefUrl) {
  const SITE_BASE = (env && env.SITE_BASE) || 'https://ongsblog.com';

  const slug = (json.slug || 'sample_post').replace(/\.html?$/i, '');
  const url = `${SITE_BASE}/${slug}.html`;

  const title = String(json.title || 'Untitled');
  const description = deriveSummary(json, 160);

  /* 🔥 수정 2: updated 정렬 */
  const updated = resolveUpdated(json);

  const labels = deriveLabels(json);
  const intent = deriveIntent(json, labels);

  const tldr = Array.isArray(json?.aio?.tldr) ? json.aio.tldr : [];

  /* 🔥 수정 3: keyfacts/keyFacts 통합 */
  const keyfacts = Array.isArray(json?.aio?.keyfacts)
    ? json.aio.keyfacts
    : Array.isArray(json?.aio?.keyFacts)
    ? json.aio.keyFacts
    : [];

  const faq = Array.isArray(json?.aio?.faq) ? json.aio.faq : [];
  const sources = Array.isArray(json?.aio?.sources)
    ? json.aio.sources
    : [];

  const citationId = deriveCitationId(json, slug);

  return {
    slug,
    url,
    title,
    description,
    labels,
    intent,
    updated,
    tldr,
    keyfacts,
    faq,
    sources,
    authorityRef: authorityRefUrl,
    citationId,
  };
}

module.exports = {
  stripHtml,
  deriveSummary,
  deriveLabels,
  deriveIntent,
  buildFeedItem,
  deriveCitationId,
};
