// System_files/scripts/build/lib/blocks.cjs
// HTML block render helpers (TLDR / KeyFacts / FAQ / Sources / Review blocks)
// - render-posts.cjs가 post.reviewData(SSOT) 를 그대로 넘기므로, 여기서 구조를 확정 렌더합니다.

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

/* ---------------- Review blocks ---------------- */

function normalizeHistogram(hist = {}) {
  // Expect keys "1".."5" counts; sanitize to ints
  const out = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  for (const k of [5, 4, 3, 2, 1]) {
    const v = hist?.[String(k)] ?? hist?.[k];
    const n = Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0;
    out[k] = n;
  }
  return out;
}

function renderHistogram(hist = {}) {
  const h = normalizeHistogram(hist);
  const total = Object.values(h).reduce((a, b) => a + b, 0) || 1;
  const rows = [5, 4, 3, 2, 1].map(star => {
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

function pickReviewRating(reviewData) {
  // ✅ render-posts가 넘기는 구조: reviewData.rating.overall / votes / lastChecked / nextCheck
  const r = reviewData?.rating && typeof reviewData.rating === 'object' ? reviewData.rating : null;
  if (!r) return null;

  const overall = Number(r.overall);
  if (!Number.isFinite(overall)) return null;

  return {
    overall,
    votes: Number(r.votes || 0) || 0,
    scale: Number(r.scale || 5) || 5,
    lastChecked: String(r.lastChecked || ''),
    nextCheck: String(r.nextCheck || ''),
    platform: String(r.platform || ''),
    source: String(r.source || reviewData?.source || ''),
    storeId: r.storeId ?? null,
  };
}

function renderReviewRatingBlock(reviewData) {
  const rating = pickReviewRating(reviewData);
  if (!rating) return '';

  const safeRating = Number.isFinite(rating.overall) ? rating.overall.toFixed(1) : 'N/A';
  const updatedAt = rating.lastChecked || '';
  const nextCheck = rating.nextCheck || '';
  const platform = rating.platform || (reviewData?.bucket || '');
  const source = rating.source || 'review dataset';

  const histogramHtml = reviewData?.histogram ? renderHistogram(reviewData.histogram) : '';

  return `<section id="review-rating-block" class="review-block">
  <div class="review-block__title">Rating snapshot</div>
  <div class="review-block__meta">
    Rating: <strong>${escapeHtml(safeRating)}</strong>
    · Votes: ${escapeHtml(String(rating.votes))}
    · Updated: ${escapeHtml(updatedAt || 'N/A')}
    · Next check: ${escapeHtml(nextCheck || 'N/A')}
    · Platform: ${escapeHtml(platform)}
    · Source: ${escapeHtml(source)}
  </div>

  <table class="review-rating-table" aria-label="Rating summary">
    <tbody>
      <tr><th>Overall</th><td>${escapeHtml(safeRating)} / ${escapeHtml(String(rating.scale))}</td></tr>
      <tr><th>Signal</th><td>${updatedAt ? 'Version-tagged snapshot' : 'No dataset'}</td></tr>
    </tbody>
  </table>

  ${histogramHtml}
</section>`;
}

function renderReviewInsightsBlock(reviewData) {
  const insights = Array.isArray(reviewData?.insights) ? reviewData.insights : [];
  const safe = insights.map(x => String(x || '').trim()).filter(Boolean).slice(0, 12);

  const list = safe.length
    ? `<ul class="review-insights-list">\n${safe.map(x => `  <li>${escapeHtml(x)}</li>`).join('\n')}\n</ul>`
    : `<p style="margin:0;color:#6b7280;font-size:14px;">데이터 수집/검증 후 업데이트 됩니다.</p>`;

  return `<section id="review-insights-block" class="review-block">
  <div class="review-block__title">User insights snapshot</div>
  <div class="review-block__meta">Short, practical signals you can trust at a glance.</div>
  ${list}
</section>`;
}

/* ---------------- Body sanitization ---------------- */

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
