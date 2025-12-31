#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/images-manifest.cjs
 *
 * 역할:
 * - dist/posts/*.html 을 스캔하여 "이미지 인덱스(manifest)"를 생성/갱신
 *
 * ─────────────────────────────────────────────
 * [SSOT 규칙]
 * - images-manifest.json은 dist가 아니라 System_files/manifests/ 아래에 둡니다.
 *   이유: dist는 빌드 산출물이고, manifest는 파이프라인 전반이 공유하는 인덱스(SSOT 성격)라서
 *        validate/업로드/로그 등 다른 단계에서도 안정적으로 참조해야 합니다.
 *
 * [Freshness 신호]
 * - updatedAt은 article:modified_time 또는 og:updated_time(HTML 메타)로 기록합니다.
 * - 이 파일은 픽셀을 바꾸지 않고, "메타 시간/경로"를 구조화해서 신호를 제공합니다.
 * ─────────────────────────────────────────────
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", ".."); // System_files 기준
const DIST_POSTS_DIR = path.join(ROOT, "dist", "posts");

// ✅ SSOT: manifests 아래로 통일
const MANIFEST_DIR = path.join(ROOT, "manifests");
const MANIFEST_FILE = path.join(MANIFEST_DIR, "images-manifest.json");

// 도메인 베이스: .env / GitHub Secrets 기준 (render-posts / validate-repair 와 일치)
const SITE_BASE = (process.env.CANONICAL_BASE || "https://ongsblog.com").replace(/\/+$/, "");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST_FILE)) return [];
  try {
    const raw = fs.readFileSync(MANIFEST_FILE, "utf8").trim();
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (e) {
    console.warn("[images-manifest] 기존 manifest 파싱 실패, 새로 생성합니다.");
    return [];
  }
}

function saveManifest(data) {
  ensureDir(MANIFEST_DIR);
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(data, null, 2), "utf8");
  console.log(`[images-manifest] 저장 완료: ${MANIFEST_FILE} (${data.length}개 엔트리)`);
}

function stripSiteBase(url) {
  if (!url) return null;
  if (url.startsWith(SITE_BASE)) {
    return url.substring(SITE_BASE.length);
  }
  return url;
}

function extractFirstMatch(html, regex) {
  const m = html.match(regex);
  return m ? m[1] : null;
}

function extractEntryFromHtml(html, filename) {
  // pageId
  const pageId = extractFirstMatch(
    html,
    /<a[^>]+id=["']pageId["'][^>]*data-page-id=["']([^"']+)["'][^>]*>/
  );

  // canonical → slug 추출
  const canonicalHref = extractFirstMatch(
    html,
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/
  );
  let slug = null;
  if (canonicalHref && canonicalHref.startsWith(SITE_BASE + "/")) {
    slug = canonicalHref.substring((SITE_BASE + "/").length);
  } else {
    // canonical 없으면 파일명 기반 slug (fallback)
    slug = path.basename(filename).replace(/\.html$/i, "");
  }

  // og:image
  const ogImage = extractFirstMatch(
    html,
    /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/
  );

  // width/height (있으면 사용, 없으면 null)
  const widthStr = extractFirstMatch(
    html,
    /<meta[^>]+property=["']og:image:width["'][^>]*content=["'](\d+)["'][^>]*>/
  );
  const heightStr = extractFirstMatch(
    html,
    /<meta[^>]+property=["']og:image:height["'][^>]*content=["'](\d+)["'][^>]*>/
  );
  const width = widthStr ? parseInt(widthStr, 10) : null;
  const height = heightStr ? parseInt(heightStr, 10) : null;

  // hero img ALT (post-hero figure 내)
  const heroAlt = extractFirstMatch(
    html,
    /<figure[^>]+class=["']post-hero["'][^>]*>[\s\S]*?<img[^>]*alt=["']([^"']*)["'][^>]*>[\s\S]*?<\/figure>/i
  );

  // 메타 description (fallback ALT 후보)
  const metaDesc = extractFirstMatch(
    html,
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/
  );

  const alt = heroAlt || metaDesc || null;

  // updatedAt (article:modified_time 우선, 없으면 og:updated_time)
  const modifiedTime =
    extractFirstMatch(
      html,
      /<meta[^>]+property=["']article:modified_time["'][^>]*content=["']([^"']+)["'][^>]*>/
    ) ||
    extractFirstMatch(
      html,
      /<meta[^>]+property=["']og:updated_time["'][^>]*content=["']([^"']+)["'][^>]*>/
    );

  // 필수값 없으면 스킵
  if (!pageId || !slug || !ogImage) {
    return null;
  }

  const thumbnailPath = stripSiteBase(ogImage);

  return {
    pageId,
    slug,
    thumbnail: {
      path: thumbnailPath,
      width,
      height,
      alt,
    },
    hero: {
      path: thumbnailPath,
    },
    etag: null,
    updatedAt: modifiedTime || null,
  };
}

function upsertEntry(manifest, entry) {
  const idx = manifest.findIndex(
    (it) => it.pageId === entry.pageId || it.slug === entry.slug
  );
  if (idx === -1) {
    manifest.push(entry);
  } else {
    manifest[idx] = {
      ...manifest[idx],
      ...entry,
      thumbnail: {
        ...(manifest[idx].thumbnail || {}),
        ...(entry.thumbnail || {}),
      },
      hero: {
        ...(manifest[idx].hero || {}),
        ...(entry.hero || {}),
      },
    };
  }
}

function main() {
  if (!fs.existsSync(DIST_POSTS_DIR)) {
    console.error(`[images-manifest] dist/posts 디렉터리가 없습니다: ${DIST_POSTS_DIR}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(DIST_POSTS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".html"));

  if (!files.length) {
    console.log("[images-manifest] 처리할 HTML 파일이 없습니다.");
    process.exit(0);
  }

  let manifest = loadManifest();
  let count = 0;

  for (const file of files) {
    const fullPath = path.join(DIST_POSTS_DIR, file);
    const html = fs.readFileSync(fullPath, "utf8");
    const entry = extractEntryFromHtml(html, file);
    if (!entry) {
      console.warn(`[images-manifest] 스킵: pageId/slug/og:image 누락 (${file})`);
      continue;
    }
    upsertEntry(manifest, entry);
    count++;
  }

  saveManifest(manifest);
  console.log(`[images-manifest] 갱신된 포스트 수: ${count}`);
}

if (require.main === module) {
  main();
}
