// System_files/scripts/build/review-stub-fill.cjs
// 역할: content/posts에서 리뷰 슬러그(app-/device-/subscription-)를 찾아,
// content/reviews/* 파일들에 최소 구조(stub)를 "없을 때만" 업서트한다.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", ".."); // System_files/scripts/build 기준
const POSTS_DIR = path.join(ROOT, "content", "posts");
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

function isReviewSlug(slug) {
  return (
    typeof slug === "string" &&
    (slug.startsWith("app-") || slug.startsWith("device-") || slug.startsWith("subscription-"))
  );
}

function bucketOf(slug) {
  if (slug.startsWith("app-")) return "app";
  if (slug.startsWith("device-")) return "device";
  return "subscription";
}

function ensureMaps(obj) {
  const base = { updatedAt: nowYmdKst(), bySlug: {} };
  if (!obj || typeof obj !== "object") return base;
  if (!obj.bySlug || typeof obj.bySlug !== "object") obj.bySlug = {};
  if (!obj.updatedAt) obj.updatedAt = nowYmdKst();
  return obj;
}

function ensureRatingEntry(bySlug, slug) {
  if (bySlug[slug]) return false;
  bySlug[slug] = {
    lastChecked: nowYmdKst(),
    status: "unknown",
    store: "unknown",
    source: "manual",
    storeId: null,
    ratingCurrent: 0,
    ratingPrevious: 0,
    ratingDiff: 0,
    votesCurrent: 0,
    votesPrevious: 0,
    votesDiff: 0,
    histogram: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
    insights: []
  };
  return true;
}

function ensureInsightsEntry(bySlug, slug) {
  if (bySlug[slug]) return false;
  bySlug[slug] = { insights: [] };
  return true;
}

function ensureSourcesEntry(bySlug, slug) {
  if (bySlug[slug]) return false;
  bySlug[slug] = [];
  return true;
}

function listPostSlugs() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  const files = fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith(".json"));
  const slugs = [];
  for (const f of files) {
    const p = path.join(POSTS_DIR, f);
    const j = readJson(p, null);
    const slug = (j && j.slug) ? j.slug : f.replace(/\.json$/, "");
    if (isReviewSlug(slug)) slugs.push(slug);
  }
  return Array.from(new Set(slugs)).sort();
}

function main() {
  const ymd = nowYmdKst();
  const slugs = listPostSlugs();

  const paths = {
    appRatings: path.join(REVIEWS_DIR, "app-ratings.json"),
    appRatingsNext: path.join(REVIEWS_DIR, "app-ratings-next.json"),
    appInsights: path.join(REVIEWS_DIR, "app-insights.json"),

    deviceRatings: path.join(REVIEWS_DIR, "device-ratings.json"),
    deviceRatingsNext: path.join(REVIEWS_DIR, "device-ratings-next.json"),
    deviceInsights: path.join(REVIEWS_DIR, "device-insights.json"),

    subscriptionRatings: path.join(REVIEWS_DIR, "subscription-ratings.json"),
    subscriptionRatingsNext: path.join(REVIEWS_DIR, "subscription-ratings-next.json"),

    // ⚠️ 파일명이 실제로 subsctiption-insights.json 라면 그 철자 그대로 유지
    subscriptionInsights: path.join(REVIEWS_DIR, "subsctiption-insights.json"),

    reviewSources: path.join(REVIEWS_DIR, "review-sources.json")
  };

  const appRatings = ensureMaps(readJson(paths.appRatings, null));
  const appRatingsNext = ensureMaps(readJson(paths.appRatingsNext, null));
  const appInsights = ensureMaps(readJson(paths.appInsights, null));

  const deviceRatings = ensureMaps(readJson(paths.deviceRatings, null));
  const deviceRatingsNext = ensureMaps(readJson(paths.deviceRatingsNext, null));
  const deviceInsights = ensureMaps(readJson(paths.deviceInsights, null));

  const subscriptionRatings = ensureMaps(readJson(paths.subscriptionRatings, null));
  const subscriptionRatingsNext = ensureMaps(readJson(paths.subscriptionRatingsNext, null));
  const subscriptionInsights = ensureMaps(readJson(paths.subscriptionInsights, null));

  const reviewSources = ensureMaps(readJson(paths.reviewSources, null));

  let created = 0;

  for (const slug of slugs) {
    const b = bucketOf(slug);

    if (b === "app") {
      if (ensureRatingEntry(appRatings.bySlug, slug)) created++;
      if (ensureRatingEntry(appRatingsNext.bySlug, slug)) created++;
      if (ensureInsightsEntry(appInsights.bySlug, slug)) created++;
    } else if (b === "device") {
      if (ensureRatingEntry(deviceRatings.bySlug, slug)) created++;
      if (ensureRatingEntry(deviceRatingsNext.bySlug, slug)) created++;
      if (ensureInsightsEntry(deviceInsights.bySlug, slug)) created++;
    } else {
      if (ensureRatingEntry(subscriptionRatings.bySlug, slug)) created++;
      if (ensureRatingEntry(subscriptionRatingsNext.bySlug, slug)) created++;
      if (ensureInsightsEntry(subscriptionInsights.bySlug, slug)) created++;
    }

    if (ensureSourcesEntry(reviewSources.bySlug, slug)) created++;
  }

  // updatedAt 갱신(이 스크립트 실행 시점 기록)
  const allObjs = [
    appRatings,
    appRatingsNext,
    appInsights,
    deviceRatings,
    deviceRatingsNext,
    deviceInsights,
    subscriptionRatings,
    subscriptionRatingsNext,
    subscriptionInsights,
    reviewSources
  ];
  for (const obj of allObjs) obj.updatedAt = ymd;

  writeJson(paths.appRatings, appRatings);
  writeJson(paths.appRatingsNext, appRatingsNext);
  writeJson(paths.appInsights, appInsights);

  writeJson(paths.deviceRatings, deviceRatings);
  writeJson(paths.deviceRatingsNext, deviceRatingsNext);
  writeJson(paths.deviceInsights, deviceInsights);

  writeJson(paths.subscriptionRatings, subscriptionRatings);
  writeJson(paths.subscriptionRatingsNext, subscriptionRatingsNext);
  writeJson(paths.subscriptionInsights, subscriptionInsights);

  writeJson(paths.reviewSources, reviewSources);

  console.log(`[review-stub-fill] slugs=${slugs.length} createdOrFilled=${created}`);
}

main();
