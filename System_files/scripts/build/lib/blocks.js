// scripts/build/lib/blocks.cjs
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
    const q = escapeHtml(it?.question || '');
    const a = escapeHtml(it?.answer || '');
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
    // allow either {label,url} or plain string url
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
  // Expect keys "1".."5" counts; sanitize to ints
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

function renderReviewRatingBlock(reviewData) {
  if (!reviewData) return '';
  const rating = Number(reviewData.rating);
  const updatedAt = reviewData.updatedAt ? String(reviewData.updatedAt) : '';
  const source = reviewData.source ? String(reviewData.source) : 'Internal review dataset';
  const safeRating = Number.isFinite(rating) ? rating.toFixed(1) : 'N/A';

  const histogramHtml = reviewData.histogram ? renderHistogram(reviewData.histogram) : '';

  return `<section id="review-rating-block" class="review-block">
  <div class="review-block__title">Rating snapshot</div>
  <div class="review-block__meta">Rating: <strong>${escapeHtml(safeRating)}</strong> · Updated: ${escapeHtml(updatedAt || 'N/A')} · Source: ${escapeHtml(source)}</div>

  <table class="review-rating-table" aria-label="Rating summary">
    <tbody>
      <tr><th>Overall</th><td>${escapeHtml(safeRating)} / 5</td></tr>
      <tr><th>Signal</th><td>${updatedAt ? 'Version-tagged snapshot' : 'No dataset'}</td></tr>
    </tbody>
  </table>

  ${histogramHtml}
</section>`;
}

function renderReviewInsightsBlock(reviewData) {
  if (!reviewData) return '';
  const insights = Array.isArray(reviewData.insights) ? reviewData.insights : [];
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
  // remove any <main ...> wrappers to avoid nesting
  s = s.replace(/<\s*main[^>]*>/gi, '');
  s = s.replace(/<\s*\/\s*main\s*>/gi, '');
  return s;
}

function dedupeReviewBaseBlock(html = '') {
  // if body accidentally contains another <section id="review-base-block"> ... </section>, keep inner content only once
  let s = String(html || '');

  const matches = [...s.matchAll(/<section[^>]+id=["']review-base-block["'][^>]*>([\s\S]*?)<\/section>/gi)];
  if (matches.length >= 1) {
    // Keep the first occurrence content and remove all occurrences from body,
    // then return only the first content.
    const firstInner = matches[0][1] || '';
    return firstInner.trim();
  }
  return s;
}

function sanitizeBodyHTML(html = '') {
  let s = String(html || '').trim();
  s = stripOuterMain(s);
  s = dedupeReviewBaseBlock(s);

  // Hard guard: remove stray duplicated HTML comments that may break layout
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
