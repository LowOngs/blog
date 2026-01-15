// System_files/scripts/build/review-build-next.cjs
// 역할: bucket별 next/insights/sources를 합쳐 review-ratings-next.json(bySlug)을 생성한다. (GPT/API 사용 없음)

import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..", "..");
const REVIEWS_DIR = path.join(ROOT, "content", "reviews");

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function nowYmdKst() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function getBySlug(obj) {
  if (!obj || typeof obj !== "object") return {};
  if (!obj.bySlug || typeof obj.bySlug !== "object") return {};
  return obj.bySlug;
}

function mergeEntry(base, patch) {
  // patch 우선. 단, histogram/insights/sources는 안전하게 보정
  const out = { ...(base || {}), ...(patch || {}) };

  // histogram 키 보정
  const h = out.histogram || {};
  out.histogram = {
    "1": Number(h["1"] ?? 0),
    "2": Number(h["2"] ?? 0),
    "3": Number(h["3"] ?? 0),
    "4": Number(h["4"] ?? 0),
    "5": Number(h["5"] ?? 0)
  };

  // insights 배열 보정
  if (!Array.isArray(out.insights)) out.insights = [];
  out.insights = out.insights.filter(v => typeof v === "string" && v.trim()).slice(0, 24);

  // sources 배열 보정
  if (!Array.isArray(out.sources)) out.sources = [];
  out.sources = out.sources
    .filter(x => x && typeof x === "object" && typeof x.label === "string" && typeof x.url === "string")
    .slice(0, 20);

  // 기본값 보정
  if (!out.status) out.status = "unknown";
  if (!out.store) out.store = "unknown";
  if (!out.source) out.source = "manual";
  if (!out.lastChecked) out.lastChecked = nowYmdKst();

  return out;
}

function main() {
  const ymd = nowYmdKst();

  const appNext = readJson(path.join(REVIEWS_DIR, "app-ratings-next.json"), null);
  const deviceNext = readJson(path.join(REVIEWS_DIR, "device-ratings-next.json"), null);
  const subscriptionNext = readJson(path.join(REVIEWS_DIR, "subscription-ratings-next.json"), null);

  const appInsights = readJson(path.join(REVIEWS_DIR, "app-insights.json"), null);
  const deviceInsights = readJson(path.join(REVIEWS_DIR, "device-insights.json"), null);
  const subscriptionInsights = readJson(path.join(REVIEWS_DIR, "subsctiption-insights.json"), null);

  const sources = readJson(path.join(REVIEWS_DIR, "review-sources.json"), null);

  const bySlug = {};

  const inputs = [
    getBySlug(appNext),
    getBySlug(deviceNext),
    getBySlug(subscriptionNext)
  ];

  // 1) next 3종 병합
  for (const map of inputs) {
    for (const [slug, entry] of Object.entries(map)) {
      bySlug[slug] = mergeEntry(bySlug[slug], entry);
    }
  }

  // 2) insights 붙이기(없으면 빈 배열 유지)
  const insMaps = [
    getBySlug(appInsights),
    getBySlug(deviceInsights),
    getBySlug(subscriptionInsights)
  ];
  for (const m of insMaps) {
    for (const [slug, x] of Object.entries(m)) {
      const insights = Array.isArray(x?.insights) ? x.insights : [];
      bySlug[slug] = mergeEntry(bySlug[slug], { insights });
    }
  }

  // 3) sources 붙이기
  const sMap = getBySlug(sources);
  for (const [slug, arr] of Object.entries(sMap)) {
    const sourcesArr = Array.isArray(arr) ? arr : [];
    bySlug[slug] = mergeEntry(bySlug[slug], { sources: sourcesArr });
  }

  const out = { updatedAt: ymd, bySlug };
  writeJson(path.join(REVIEWS_DIR, "review-ratings-next.json"), out);

  console.log(`[review-build-next] slugs=${Object.keys(bySlug).length} -> review-ratings-next.json`);
}

main();
