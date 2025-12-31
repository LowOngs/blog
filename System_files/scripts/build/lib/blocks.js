// scripts/build/lib/blocks.js
// HTML block render helpers (TLDR / KeyFacts / FAQ / Sources / Review blocks)
// + body sanitization to prevent <main> nesting / duplicate sections

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderList(items = []) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return `<ul>\n${items.map(x => `  <li>${escapeHtml(x)}</li>`).join('\n')}\n</ul>`;
}

function renderTLDR(tldr = []) {
  return renderList(tldr);
}

function renderKeyFacts(keyfacts = []) {
  return renderList(keyfacts);
}

function renderFAQ(faq = []) {
  if (!Array.isArray(faq) || faq.length === 0) return '';
  const items = faq.map(it => {
    const q = escapeHtml(it?.question || it?.q || '');
    const a = escapeHtml(it?.answer || it?.a || '');
    if (!q && !a) return '';
    return `<article class="faq-item">
  <h4>${q || 'FAQ'}</h4>
  <p>${a}</p>
</article>`;
  }).filter(Boolean);

  if (items.length === 0) return '';
  return `<details class="collapsible" id="faq">
  <summary>FAQ</summary>
  <div class="panel">
    <section class="faq">
${items.join('\n')}
    </section>
  </div>
</details>`;
}

function renderSources(sources = []) {
  if (!Array.isArray(sources) || sources.length === 0) return '';
  const items = sources.map(src => {
    if (typeof src === 'string') {
      const u = src.trim();
      if (!u) return '';
      return `<li><a href="${escapeHtml(u)}" rel="nofollow noopener" target="_blank">${escapeHtml(u)}</a></li>`;
    }
    const label = (src?.label || src?.name || '').trim();
    const url = (src?.url || '').trim();
    if (!url) return '';
    const text = label || url;
    return `<li><a href="${escapeHtml(url)}" rel="nofollow noopener" target="_blank">${escapeHtml(text)}</a></li>`;
  }).filter(Boolean);

  if (items.length === 0) return '';
  return `<section id="sources" class="sources">
  <h3>Sources</h3>
  <ul>
    ${items.join('\n    ')}
  </ul>
</section>`;
}

// ===== Review blocks =====

function normalizeHistogram(hist = {}) {
  // keys "1".."5" counts or percents; sanitize to ints
  const out = { 5:0, 4:0, 3:0, 2:0, 1:0 };
  for (const k of [5,4,3,2,1]) {
    const v = hist?.[String(k)] ?? hist?.[k];
    const n = Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0;
    out[k] = n;
  }
  return out;
}

function renderHistogram(hist = {}) {
  const h = normalizeHistogram(hist);
  const total = Object.values(h).reduce((a,b)=>a+b,0) || 1;
  const rows = [5,4,3,2,1].map(star => {
    const v = h[star];
    const pct = Math.round((v / total) * 100);
    return `<div class="review-histogram-row">
  <div class="review-histogram-label">${star}★</div>
  <div class="review-histogram-bar-wrap"><div class="review-histogram-bar" style="width:${pct}%"></div></div>
  <div class="review-histogram-value">${pct}%</div>
</div>`;
  }).join('\n');
  return `<div class="review-histogram">${rows}</div>`;
}

/**
 * REVIEW DATA NORMALIZE
 * - render-posts.cjs 에서 reviewData로 넘어오는 형태가 여러 가지일 수 있어
 *   여기서 1개 형태로 통일해서 렌더를 안정화합니다.
 */
function normalizeReviewData(input) {
  if (!input || typeof input !== 'object') return null;

  // 1) 이미 dataset 형태(= review-solver 주입)
  //    { bucket, rating: {overall,votes,scale,lastChecked,nextCheck,...}, histogram, insights[] }
  if (input.rating && typeof input.rating === 'object' && typeof input.rating.overall === 'number') {
    return {
      bucket: input.bucket || '',
      rating: input.rating,
      histogram: input.histogram || null,
      insights: Array.isArray(input.insights) ? input.insights : [],
      source: input.source || input.rating.source || '',
    };
  }

  // 2) post.review.rating 형태(기존)
  if (input.rating && typeof input.rating === 'object') {
    const r = input.rating;
    const overall = Number(r.overall);
    if (Number.isFinite(overall)) {
      return {
        bucket: input.bucket || '',
        rating: {
          overall,
          votes: Number(r.votes || 0) || 0,
          scale: Number(r.scale || 5) || 5,
          lastChecked: r.lastUpdated || r.lastChecked || '',
          nextCheck: r.nextCheck || '',
          platform: r.platform || '',
          source: r.source || '',
          storeId: r.storeId || null
        },
        histogram: input.histogram || null,
        insights: Array.isArray(input.insights) ? input.insights : [],
        source: r.source || ''
      };
    }
  }

  // 3) dataset raw 한 덩어리(예: bySlug[slug] 그대로 들어온 경우)
  //    { ratingCurrent, votesCurrent, histogram, insights, lastChecked, nextCheck, ... }
  if (typeof input.ratingCurrent === 'number') {
    return {
      bucket: input.bucket || '',
      rating: {
        overall: Number(input.ratingCurrent),
        votes: Number(input.votesCurrent || 0) || 0,
        scale: 5,
        lastChecked: input.lastChecked || '',
        nextCheck: input.nextCheck || '',
        platform: input.store || input.platform || '',
        source: input.source || '',
        storeId: input.storeId || null
      },
      histogram: input.histogram || null,
      insights: Array.isArray(input.insights) ? input.insights : [],
      source: input.source || ''
    };
  }

  return null;
}

function renderReviewRatingBlock(reviewDataRaw) {
  const rd = normalizeReviewData(reviewDataRaw);
  if (!rd) return '';

  const rating = rd.rating;
  const overall = Number(rating.overall);
  const votes = Number(rating.votes || 0) || 0;
  const scale = Number(rating.scale || 5) || 5;

  const updatedAt = rating.lastChecked || '';
  const nextCheck = rating.nextCheck || '';
  const source = rd.source || rating.source || 'review dataset';

  const safeOverall = Number.isFinite(overall) ? overall.toFixed(1) : 'N/A';
  const histogramHtml = rd.histogram ? renderHistogram(rd.histogram) : '';

  return `<section id="review-rating-block" class="review-block">
  <div class="review-block__title">Rating snapshot</div>
  <div class="review-block__meta">
    Rating: <strong>${escapeHtml(safeOverall)}</strong> / ${escapeHtml(String(scale))}
    · Votes: ${escapeHtml(String(votes))}
    · Updated: ${escapeHtml(updatedAt || 'N/A')}
    ${nextCheck ? `· Next: ${escapeHtml(nextCheck)}` : ''}
    · Source: ${escapeHtml(source)}
  </div>

  <table class="review-rating-table" aria-label="Rating summary">
    <tbody>
      <tr><th>Overall</th><td>${escapeHtml(safeOverall)} / ${escapeHtml(String(scale))}</td></tr>
      <tr><th>Votes</th><td>${escapeHtml(String(votes))}</td></tr>
      <tr><th>Freshness</th><td>${updatedAt ? '90-day refresh model' : 'No snapshot'}</td></tr>
    </tbody>
  </table>

  ${histogramHtml}
</section>`;
}

function renderReviewInsightsBlock(reviewDataRaw) {
  const rd = normalizeReviewData(reviewDataRaw);
  if (!rd) return '';

  const insights = Array.isArray(rd.insights) ? rd.insights : [];
  const safe = insights.map(x => String(x || '').trim()).filter(Boolean).slice(0, 8);

  const list = safe.length
    ? `<ul class="review-insights-list">\n${safe.map(x => `  <li>${escapeHtml(x)}</li>`).join('\n')}\n</ul>`
    : `<p style="margin:0;color:#6b7280;font-size:14px;">No insights available yet for this post.</p>`;

  return `<section id="review-insights-block" class="review-block">
  <div class="review-block__title">User insights snapshot</div>
  <div class="review-block__meta">Short, practical signals you can trust at a glance.</div>
  ${list}
</section>`;
}

// ===== Body sanitization (공통 문제 해결 핵심) =====

function stripOuterMain(html = '') {
  let s = String(html || '');
  s = s.replace(/<\s*main[^>]*>/gi, '');
  s = s.replace(/<\s*\/\s*main\s*>/gi, '');
  return s;
}

function dedupeReviewBaseBlock(html = '') {
  let s = String(html || '');
  const matches = [...s.matchAll(/<section[^>]+id=["']review-base-block["'][^>]*>([\s\S]*?)<\/section>/gi)];
  if (matches.length >= 1) {
    const firstInner = matches[0][1] || '';
    return firstInner.trim();
  }
  return s;
}

function sanitizeBodyHTML(html = '') {
  let s = String(html || '').trim();
  s = stripOuterMain(s);
  s = dedupeReviewBaseBlock(s);
  s = s.replace(/<!--\s*본문:\s*자동\s*렌더링\s*영역\s*-->/g, '');
  return s.trim();
}

module.exports = {
  renderTLDR,
  renderKeyFacts,
  renderFAQ,
  renderSources,
  renderReviewRatingBlock,
  renderReviewInsightsBlock,
  sanitizeBodyHTML,
};
