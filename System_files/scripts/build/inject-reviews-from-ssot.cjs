// System_files/scripts/build/inject-reviews-from-ssot.cjs
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const DIST = path.join(ROOT, "dist/posts");
const SSOT = path.join(ROOT, "content/reviews/review-ratings.json");

console.log("[inject-reviews] ROOT =", ROOT);
console.log("[inject-reviews] DIST =", DIST);
console.log("[inject-reviews] SSOT =", SSOT);

if (!fs.existsSync(SSOT)) {
  console.error("[inject-reviews] SSOT not found");
  process.exit(1);
}

const ssot = JSON.parse(fs.readFileSync(SSOT, "utf8"));
const bySlug = ssot.bySlug || {};

const htmlFiles = fs.readdirSync(DIST).filter(f => f.endsWith(".html"));
console.log("[inject-reviews] HTML files =", htmlFiles.length);

let updated = 0;
let ratingMissing = 0;

for (const file of htmlFiles) {
  const slug = file.replace(/\.html$/, "");
  const data = bySlug[slug];

  const fullPath = path.join(DIST, file);
  let html = fs.readFileSync(fullPath, "utf8");

  // 슬롯 자체가 없으면 건너뜀
  if (!html.includes("SLOT:REVIEW_RATING") &&
      !html.includes("SLOT:REVIEW_INSIGHTS")) {
    continue;
  }

  if (!data) {
    ratingMissing++;
    continue;
  }

  /* ---------- Rating Block ---------- */
  let ratingHTML = "";
  if (data.rating) {
    ratingHTML = `
      <div class="review-block__title">Rating summary</div>
      <div class="review-block__meta">
        Updated ${data.updatedAt} · Source: ${data.source || "aggregated"}
      </div>
      <table class="review-rating-table">
        <tr><th>Score</th><td>${data.rating.score} / 5</td></tr>
        <tr><th>Reviews</th><td>${data.rating.count}</td></tr>
      </table>
    `;
  }

  /* ---------- Insights Block ---------- */
  let insightsHTML = "";
  if (Array.isArray(data.insights) && data.insights.length) {
    insightsHTML = `
      <div class="review-block__title">User insights</div>
      <ul class="review-insights-list">
        ${data.insights.map(i => `<li>${i}</li>`).join("")}
      </ul>
    `;
  }

  html = html
    .replace("<!--SLOT:REVIEW_RATING-->", ratingHTML)
    .replace("<!--SLOT:REVIEW_INSIGHTS-->", insightsHTML);

  fs.writeFileSync(fullPath, html, "utf8");
  updated++;
}

console.log("[inject-reviews] done:",
  "updated=", updated,
  "ratingMissing=", ratingMissing
);
