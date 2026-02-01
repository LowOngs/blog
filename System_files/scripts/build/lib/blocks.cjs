// scripts/build/lib/blocks.cjs
// HTML block render helpers (TLDR / KeyFacts / FAQ / Sources / Review blocks)
// ✅ Policy(SSOT):
//  - FAQ/Sources의 "섹션 뼈대(id/section)"는 templates/post.html이 담당한다.
//  - blocks는 {{faq}}/{{sources}}에 들어갈 "내용 조각"만 생성한다.
//  - Review 블록은 기존대로 blocks가 만들 수 있으나, render 단계에서 주입/생성 금지 정책은 render가 지킨다.

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

/**
 * ✅ FAQ: 템플릿이 <section id="faq"> 뼈대를 갖는다.
 * - blocks는 내부 컨텐츠만 만든다.
 * - id="faq" / <section ...> / <details id="faq"> 생성 금지
 */
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

  // ✅ id="faq" 금지(중복 방지). 템플릿이 섹션 id를 보유한다.
  return `<details class="collapsible">
  <summary>FAQ</summary>
  <div class="panel">
    <section class="faq">
${items.join('\n')}
    </section>
  </div>
</details>`;
}

/**
 * ✅ Sources: 템플릿이 <section id="sources"> 뼈대를 갖는다.
 * - blocks는 내부 컨텐츠(ul)만 만든다.
 * - id="sources" / <section ...> 생성 금지
 * - h3 헤더도 템플릿이 갖는 구조를 기본으로 한다(중복 방지)
 */
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

  return `<ul>
    ${items.join('\n    ')}
  </ul>`;
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
  // ✅ 1) 최신 형태: reviewData.rating.overall / votes / lastChecked / source
  const r = reviewData?.rating && typeof reviewData.rating === 'object' ? reviewData.rating : null;
  if (r) {
    const overall = Number(r.overall);
    if (!Number.isFinite(overall)) return null;

    return {
      overall,
      votes: Number(r.votes || 0) || 0,
      scale: Number(r.scale || 5) || 5,
      lastChecked: String(r.lastChecked || ''),
      source: String(r.source || reviewData?.source || ''),
      storeId: r.storeId ?? null,
    };
  }

  // ✅ 2) 스냅샷 형태(호환): ratingCurrent/votesCurrent/lastChecked/source
  const overall2 = Number(reviewData?.ratingCurrent);
  if (!Number.isFinite(overall2)) return null;

  return {
    overall: overall2,
    votes: Number(reviewData?.votesCurrent || 0) || 0,
    scale: 5,
    lastChecked: String(reviewData?.lastChecked || ''),
    source: String(reviewData?.source || ''),
    storeId: null,
  };
}

function renderReviewRatingBlock(reviewData) {
  const rating = pickReviewRating(reviewData);
  if (!rating) return '';

  const safeRating = Number.isFinite(rating.overall) ? rating.overall.toFixed(1) : 'N/A';
  const updatedAt = rating.lastChecked || '';
  const source = rating.source || 'review dataset';

  const histogramHtml = reviewData?.histogram ? renderHistogram(reviewData.histogram) : '';

  return `<section id="review-rating-block" class="review-block">
  <div class="review-block__title">Rating snapshot</div>
  <div class="review-block__meta">
    Rating: <strong>${escapeHtml(safeRating)}</strong>
    · Votes: ${escapeHtml(String(rating.votes))}
    · Updated: ${escapeHtml(updatedAt || 'N/A')}
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
