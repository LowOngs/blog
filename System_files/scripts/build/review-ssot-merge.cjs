// System_files/scripts/build/review-ssot-merge.cjs
// 역할: review-ratings-next.json(bySlug)을 review-ratings.json(SSOT)에 안전 업서트한다.
// - GPT/API 사용 없음
// - next가 비면 SSOT 변경 없음
// - slug prefix(app/device/subscription)로 bucket을 보정해 넣음(없을 때만)

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", ".."); // System_files 기준
const REVIEWS_DIR = path.join(ROOT, "content", "reviews");

const NEXT_PATH = path.join(REVIEWS_DIR, "review-ratings-next.json");
const SSOT_PATH = path.join(REVIEWS_DIR, "review-ratings.json");

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
  return slug.startsWith("app-") || slug.startsWith("device-") || slug.startsWith("subscription-");
}

function bucketOf(slug) {
  if (slug.startsWith("app-")) return "app";
  if (slug.startsWith("device-")) return "device";
  return "subscription";
}

function ensureMaps(file) {
  const out = (file && typeof file === "object") ? file : {};
  if (!out.bySlug || typeof out.bySlug !== "object") out.bySlug = {};
  if (!out.updatedAt) out.updatedAt = nowYmdKst();
  return out;
}

function normalizeEntry(slug, entry) {
  const e = (entry && typeof entry === "object") ? { ...entry } : {};

  // bucket(없으면 보정)
  if (!e.bucket && isReviewSlug(slug)) e.bucket = bucketOf(slug);

  // 기본값
  if (!e.status) e.status = "unknown";
  if (!e.store) e.store = "unknown";
  if (!e.source) e.source = "manual";
  if (!e.lastChecked) e.lastChecked = nowYmdKst();

  // histogram 보정(키/숫자)
  const h = e.histogram && typeof e.histogram === "object" ? e.histogram : {};
  e.histogram = {
    "1": Number(h["1"] ?? 0),
    "2": Number(h["2"] ?? 0),
    "3": Number(h["3"] ?? 0),
    "4": Number(h["4"] ?? 0),
    "5": Number(h["5"] ?? 0)
  };

  // insights 보정
  if (!Array.isArray(e.insights)) e.insights = [];
  e.insights = e.insights.filter(v => typeof v === "string" && v.trim()).slice(0, 24);

  // votes/rating 숫자 보정(있을 때만)
  const numFields = [
    "ratingCurrent","ratingPrevious","ratingDiff",
    "votesCurrent","votesPrevious","votesDiff"
  ];
  for (const k of numFields) {
    if (e[k] !== undefined && e[k] !== null && e[k] !== "") e[k] = Number(e[k]) || 0;
  }

  // storeId는 null 허용
  if (e.storeId === undefined) e.storeId = null;

  return e;
}

function main() {
  const next = ensureMaps(readJson(NEXT_PATH, null));
  const ssot = ensureMaps(readJson(SSOT_PATH, null));

  const nextBySlug = next.bySlug || {};
  const keys = Object.keys(nextBySlug);

  if (keys.length === 0) {
    console.log("[review-ssot-merge] next is empty -> no changes");
    return;
  }

  let upserted = 0;
  for (const slug of keys) {
    if (!isReviewSlug(slug)) continue; // 오염 방지
    const merged = normalizeEntry(slug, nextBySlug[slug]);
    ssot.bySlug[slug] = merged; // next를 SSOT로 덮어쓰기(업서트)
    upserted++;
  }

  ssot.updatedAt = nowYmdKst();
  writeJson(SSOT_PATH, ssot);

  console.log(`[review-ssot-merge] upserted=${upserted} (from next=${keys.length}) -> review-ratings.json`);
}

main();
