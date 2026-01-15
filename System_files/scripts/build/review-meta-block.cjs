#!/usr/bin/env node
'use strict';

// System_files/scripts/build/review-meta-block.cjs
// 역할: review-ratings.json(SSOT) 기반으로 dist/posts/*.html의 리뷰 섹션 2개를 치환한다.
// 핵심: 리뷰 slug(app-/device-/subscription-)만 대상으로 처리한다(비리뷰 글은 스킵).

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const DIST_DIR = path.join(ROOT, "dist", "posts");
const SSOT_PATH = path.join(ROOT, "content", "reviews", "review-ratings.json");

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function isReviewSlug(slug) {
  return slug.startsWith("app-") || slug.startsWith("device-") || slug.startsWith("subscription-");
}

function replaceSection(html, sectionId, newInnerHtml) {
  const re = new RegExp(
    `<section\\s+id=["']${sectionId}["'][^>]*>[\\s\\S]*?<\\/section>`,
    "i"
  );
  if (!re.test(html)) return { ok: false, html };
  const replaced = html.replace(re, `<section id="${sectionId}">\n${newInnerHtml}\n</section>`);
  return { ok: true, html: replaced };
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function clampPct(n) {
  const x = Number(n) || 0;
  if (x < 0) return 0;
  if (x > 100) return 100;
  return x;
}

function buildRatingBlock(entry) {
  const lastChecked = esc(entry.lastChecked || "");
  const status = esc(entry.status || "unknown");
  const store = esc(entry.store || "unknown");
  const source = esc(entry.source || "manual");

  const rc = Number(entry.ratingCurrent || 0).toFixed(1);
  const rp = Number(entry.ratingPrevious || 0).toFixed(1);
  const rd = Number(entry.ratingDiff || 0).toFixed(1);

  const vc = Number(entry.votesCurrent || 0);
  const vp = Number(entry.votesPrevious || 0);
  const vd = Number(entry.votesDiff || 0);

  const h = entry.histogram || {};
  const rows = [5,4,3,2,1].map(star => {
    const pct = clampPct(h[String(star)]);
    return `
<div class="hist-row">
  <div class="hist-star">${star}★</div>
  <div class="hist-bar"><div class="hist-fill" style="width:${pct}%"></div></div>
  <div class="hist-pct">${pct}%</div>
</div>`.trim();
  }).join("\n");

  return `
<h3>User ratings snapshot (last 90 days)</h3>
<div class="review-meta">
  <div>Last checked: <strong>${lastChecked}</strong></div>
  <div>Status: <strong>${status}</strong></div>
  <div>Store: <strong>${store}</strong></div>
  <div>Source: <strong>${source}</strong></div>
</div>

<table class="review-table">
  <thead><tr><th></th><th>Current</th><th>3 months ago</th><th>Change</th></tr></thead>
  <tbody>
    <tr><td>Rating</td><td>${rc}</td><td>${rp}</td><td>${rd}</td></tr>
    <tr><td>Votes</td><td>${vc}</td><td>${vp}</td><td>${vd}</td></tr>
  </tbody>
</table>

<div class="histogram">
${rows}
</div>
`.trim();
}

function uniqLower(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const k = String(s).trim().toLowerCase();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(String(s).trim());
  }
  return out;
}

function buildInsightsBlock(entry) {
  const insights = Array.isArray(entry.insights) ? entry.insights : [];
  const cleaned = uniqLower(insights).slice(0, 12);

  // 기존 프로젝트 방향(positive/negative 분리)이 아니라도,
  // 지금 단계에서는 최소 “비어도 안내문구 1개”를 넣어 빈칸 방지.
  const list = cleaned.length
    ? cleaned.map(x => `<li>${esc(x)}</li>`).join("\n")
    : `<li>${esc("Insights are not available yet. This section will be updated after the next review refresh.")}</li>`;

  return `
<h3>What users mention most</h3>
<ul class="review-insights">
${list}
</ul>
`.trim();
}

function main() {
  console.log("────────────────────────────────────────────");
  console.log("[review-meta] start");
  console.log(`[review-meta] ROOT = ${ROOT}`);
  console.log(`[review-meta] DIST = ${DIST_DIR}`);
  console.log(`[review-meta] SSOT = ${SSOT_PATH}`);

  if (!fs.existsSync(DIST_DIR)) {
    console.log("[review-meta] dist/posts not found -> exit");
    return;
  }

  const ssot = readJson(SSOT_PATH, null);
  const bySlug = (ssot && ssot.bySlug && typeof ssot.bySlug === "object") ? ssot.bySlug : {};

  const files = fs.readdirSync(DIST_DIR).filter(f => f.endsWith(".html"));
  console.log(`[review-meta] posts loaded: ${files.length}`);
  console.log("────────────────────────────────────────────");

  let updated = 0;
  let ssotMissing = 0;
  let slotMissing = 0;
  let skippedNonReview = 0;

  for (const f of files) {
    const slug = f.replace(/\.html$/i, "");
    if (!isReviewSlug(slug)) {
      skippedNonReview++;
      continue;
    }

    const full = path.join(DIST_DIR, f);
    const html = fs.readFileSync(full, "utf8");

    const entry = bySlug[slug];
    if (!entry) {
      ssotMissing++;
      // 슬롯 자체는 유지(placeholder 유지)하고 건드리지 않음
      continue;
    }

    const ratingBlock = buildRatingBlock(entry);
    const insightsBlock = buildInsightsBlock(entry);

    let nextHtml = html;
    let changed = false;

    const r1 = replaceSection(nextHtml, "review-rating-block", ratingBlock);
    if (!r1.ok) slotMissing++;
    else { nextHtml = r1.html; changed = true; }

    const r2 = replaceSection(nextHtml, "review-insights-block", insightsBlock);
    if (!r2.ok) slotMissing++;
    else { nextHtml = r2.html; changed = true; }

    if (changed && nextHtml !== html) {
      fs.writeFileSync(full, nextHtml, "utf8");
      updated++;
    }
  }

  console.log(`[review-meta] done: updated=${updated}, ssot-missing=${ssotMissing}, slot-missing=${slotMissing}, skippedNonReview=${skippedNonReview}`);
  console.log("────────────────────────────────────────────");
}

main();
