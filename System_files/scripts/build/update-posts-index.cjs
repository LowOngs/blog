// System_files/scripts/build/update-posts-index.cjs
// 목적: dist/ai/feed.ndjson(최종 산출물) 기준으로 dist/ai/posts-index.json을 재생성
// 규칙:
// A) 중복/과거 slug는 "content/posts에 존재하는 slug만" 남기고 나머지 제외
// B) posts-index는 feed의 url/updated를 사용 (최종 산출 기준)
// C) pageId는 content/posts의 pageId를 사용(포맷 통일: page000*** 계열)
// D) updated는 feed의 updated(최종 파이프라인 산출값)로 동기화

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", ".."); // System_files
const POSTS_DIR = path.join(ROOT, "content", "posts");
const FEED_PATH = path.join(ROOT, "dist", "ai", "feed.ndjson");
const OUT_PATH = path.join(ROOT, "dist", "ai", "posts-index.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function safeIsoTime(s) {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

function listPostFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(dir, f));
}

function buildPostsMap() {
  const files = listPostFiles(POSTS_DIR);
  const map = new Map(); // slug -> { pageId, title, description, labels }
  for (const fp of files) {
    const p = readJson(fp);
    if (!p || !p.slug) continue;

    // labels 정규화(단일 label과 배열 labels 혼재 대비)
    const labels = Array.isArray(p.labels)
      ? p.labels
      : p.label
        ? [p.label]
        : [];

    map.set(p.slug, {
      slug: p.slug,
      pageId: p.pageId || "",
      title: p.title || "",
      description: p.description || "",
      labels,
    });
  }
  return map;
}

function readFeedNdjson(feedPath) {
  if (!fs.existsSync(feedPath)) {
    throw new Error(`feed.ndjson not found: ${feedPath}`);
  }
  const lines = fs
    .readFileSync(feedPath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const items = [];
  for (const line of lines) {
    try {
      items.push(JSON.parse(line));
    } catch (e) {
      console.warn("[WARN] bad ndjson line (skip):", line.slice(0, 120));
    }
  }
  return items;
}

function main() {
  const postsMap = buildPostsMap();
  const feedItems = readFeedNdjson(FEED_PATH);

  // slug별로 "content/posts에 존재하는 slug만" 유지 + 중복이면 updated 최신 1개만
  const bestBySlug = new Map(); // slug -> feedItem
  let skippedNotInPosts = 0;

  for (const it of feedItems) {
    if (!it || !it.slug) continue;

    // A) content/posts에 없는 slug는 인덱스에서 제외
    if (!postsMap.has(it.slug)) {
      skippedNotInPosts++;
      continue;
    }

    const prev = bestBySlug.get(it.slug);
    if (!prev) {
      bestBySlug.set(it.slug, it);
      continue;
    }

    // 중복이면 updated 최신을 채택
    const tPrev = safeIsoTime(prev.updated);
    const tNow = safeIsoTime(it.updated);
    if (tNow >= tPrev) bestBySlug.set(it.slug, it);
  }

  const out = [];
  let missingPageId = 0;

  for (const [slug, feed] of bestBySlug.entries()) {
    const post = postsMap.get(slug);

    // C) pageId는 content/posts 기준(통일)
    const pageId = post.pageId || "";
    if (!pageId) missingPageId++;

    out.push({
      slug,
      pageId,
      url: feed.url || `https://ongsblog.com/${slug}.html`,
      labels: Array.isArray(post.labels) && post.labels.length ? post.labels : (feed.labels || []),
      title: post.title || feed.title || "",
      description: post.description || feed.description || "",
      // D) updated는 feed.ndjson(최종 산출) 기준으로 동기화
      updated: feed.updated || "",
    });
  }

  // 정렬(권장): updated 내림차순 → slug 오름차순
  out.sort((a, b) => {
    const tb = safeIsoTime(b.updated);
    const ta = safeIsoTime(a.updated);
    if (tb !== ta) return tb - ta;
    return String(a.slug).localeCompare(String(b.slug));
  });

  // 백업(있으면)
  if (fs.existsSync(OUT_PATH)) {
    const bak = OUT_PATH.replace(/\.json$/, `.bak-${Date.now()}.json`);
    fs.copyFileSync(OUT_PATH, bak);
    console.log("[OK] backup:", path.relative(ROOT, bak));
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");

  console.log("[OK] posts-index updated:", path.relative(ROOT, OUT_PATH));
  console.log("[INFO] kept slugs:", out.length);
  console.log("[INFO] skipped (not in content/posts):", skippedNotInPosts);
  if (missingPageId) console.warn("[WARN] missing pageId count:", missingPageId);
}

main();
