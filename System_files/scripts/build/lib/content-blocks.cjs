// System_files/scripts/build/lib/blocks.cjs
// CommonJS (CJS) only: require/module.exports
// 목적:
// - FAQ / Sources / Review 슬롯을 "항상 같은 DOM 구조"로 렌더링
// - 데이터가 없으면 섹션 자체를 숨김(=출력하지 않음)
// - 입력 스키마가 흔들려도(배열/객체/문자열) 안전하게 정규화

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function normalizeFaq(faq) {
  // 허용:
  // - [{q, a}] / [{question, answer}]
  // - { q1: a1, q2: a2 }
  // - ["Q?::A", ...] (최후 폴백)
  if (!faq) return [];
  const out = [];

  if (Array.isArray(faq)) {
    for (const item of faq) {
      if (!item) continue;
      if (typeof item === "object") {
        const q = item.q ?? item.question ?? item.Q ?? item.title;
        const a = item.a ?? item.answer ?? item.A ?? item.body;
        if (isNonEmptyString(q) && isNonEmptyString(a)) out.push({ q: String(q), a: String(a) });
      } else if (isNonEmptyString(item)) {
        const s = String(item);
        const parts = s.split("::");
        if (parts.length >= 2) out.push({ q: parts[0].trim(), a: parts.slice(1).join("::").trim() });
      }
    }
    return out;
  }

  if (typeof faq === "object") {
    for (const [k, v] of Object.entries(faq)) {
      if (isNonEmptyString(k) && isNonEmptyString(v)) out.push({ q: String(k), a: String(v) });
    }
    return out;
  }

  return out;
}

function normalizeSources(sources) {
  // 허용:
  // - [{title,name,label, url, href}]
  // - ["https://...", ...]
  // - { "Microsoft Support": "https://..." }
  if (!sources) return [];

  const out = [];

  if (Array.isArray(sources)) {
    for (const item of sources) {
      if (!item) continue;
      if (typeof item === "object") {
        const title = item.title ?? item.name ?? item.label ?? item.text ?? "";
        const url = item.url ?? item.href ?? item.link ?? "";
        if (isNonEmptyString(url)) out.push({ title: isNonEmptyString(title) ? String(title) : "", url: String(url) });
      } else if (isNonEmptyString(item)) {
        out.push({ title: "", url: String(item) });
      }
    }
    return out;
  }

  if (typeof sources === "object") {
    for (const [k, v] of Object.entries(sources)) {
      if (isNonEmptyString(v)) out.push({ title: isNonEmptyString(k) ? String(k) : "", url: String(v) });
    }
    return out;
  }

  if (isNonEmptyString(sources)) {
    out.push({ title: "", url: String(sources) });
  }

  return out;
}

function renderFaqHTML(faq) {
  const items = normalizeFaq(faq);
  if (items.length === 0) return ""; // 섹션 자체 숨김

  const inner = items
    .map(({ q, a }) => {
      return [
        `<article class="faq-item">`,
        `  <h4>${esc(q)}</h4>`,
        `  <p>${esc(a)}</p>`,
        `</article>`,
      ].join("\n");
    })
    .join("\n");

  // ⚠️ 템플릿의 ID 구조 유지: id="faq", 내부 .faq
  return [
    `<details class="collapsible" id="faq">`,
    `  <summary>FAQ</summary>`,
    `  <div class="panel">`,
    `    <section class="faq">`,
    inner,
    `    </section>`,
    `  </div>`,
    `</details>`,
  ].join("\n");
}

function renderSourcesHTML(sources) {
  const items = normalizeSources(sources);
  if (items.length === 0) return ""; // 섹션 자체 숨김

  const li = items
    .map(({ title, url }) => {
      const safeUrl = esc(url);
      const label = isNonEmptyString(title) ? esc(title) : safeUrl;
      // 정책: nofollow noopener 유지(기존 규칙)
      return `  <li><a href="${safeUrl}" rel="nofollow noopener" target="_blank">${label}</a></li>`;
    })
    .join("\n");

  // ⚠️ 템플릿의 ID 구조 유지: id="sources", 내부 h3 + ul
  return [
    `<section id="sources" class="sources">`,
    `  <h3>Sources</h3>`,
    `  <ul>`,
    li,
    `  </ul>`,
    `</section>`,
  ].join("\n");
}

function renderReviewSlotsHTML(label) {
  // Review 슬롯은 "리뷰 라벨 3개만" 유지하고,
  // 해당 라벨이 아니면 아예 출력하지 않게(=DOM 안정 + 불필요 블록 제거)
  const reviewLabels = new Set(["app-reviews", "device-reviews", "subscription-services"]);
  if (!reviewLabels.has(String(label || ""))) return "";

  return [
    `<section id="review-rating-block" class="review-block">`,
    `  <!--SLOT:REVIEW_RATING-->`,
    `</section>`,
    ``,
    `<section id="review-insights-block" class="review-block">`,
    `  <!--SLOT:REVIEW_INSIGHTS-->`,
    `</section>`,
  ].join("\n");
}

function assertNoObjectObject(html, slug) {
  if (html.includes("[object Object]")) {
    const msg = `[blocks][FAIL] ${slug}: found "[object Object]" in output (FAQ/Sources renderer not applied)`;
    const err = new Error(msg);
    err.code = "BLOCKS_OBJECT_OBJECT";
    throw err;
  }
}

module.exports = {
  normalizeFaq,
  normalizeSources,
  renderFaqHTML,
  renderSourcesHTML,
  renderReviewSlotsHTML,
  assertNoObjectObject,
};
