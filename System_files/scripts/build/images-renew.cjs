#!/usr/bin/env node
'use strict';

// System_files/scripts/build/images-renew.cjs
// dist/posts/*.html 을 스캔해서 manifests/images-manifest.json 을
// 새 스키마(version=1)로 재생성하는 스크립트입니다.
//
// ─────────────────────────────────────────────
// [중요] OG Freshness 관련 오해 방지
// - 이 파일은 "이미지 픽셀/색상 변경"을 하지 않습니다.
// - HTML에 이미 박혀 있는 og:image URL, og:image:alt, width/height, modified_time 등을 읽어
//   manifest(인덱스)를 재생성합니다.
// - AOIA에서 말하는 프레시니스 신호는 'updatedAt(메타 시간)' 및 'og:image URL/파일 신규성'에 의해
//   상위 단계(meta/render/og 생성)에서 만들어집니다.
// ─────────────────────────────────────────────
//
// ✅ 이번 수정(최소 수정)
// - pageId는 HTML보다 posts SSOT(content/posts/*.json)를 우선 신뢰
// - 기존 manifest의 same-slug pageId를 fallback으로 사용
// - 마지막 수단으로만 og:image URL에서 pageId를 추론
// - 완전 재생성은 유지하되, 잘못된 HTML이 manifest를 오염시키는 위험을 줄임

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const MANIFEST_PATH = path.join(ROOT, 'manifests', 'images-manifest.json');

function log(line = '') {
  console.log(line);
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readHtmlFiles(distDir) {
  if (!fs.existsSync(distDir)) {
    return [];
  }
  return fs
    .readdirSync(distDir)
    .filter((f) => f.endsWith('.html'))
    .map((filename) => ({
      filename,
      slug: filename.replace(/\.html$/i, ''),
      fullPath: path.join(distDir, filename),
    }));
}

function extractFirst(html, regex) {
  const m = html.match(regex);
  return m ? m[1] : null;
}

function inferPageIdFromOgUrl(ogUrl) {
  if (!ogUrl) return null;
  // 예: https://ongsblog.com/images/og/page183338_app-20251207-001_1200x630.jpg
  const m = ogUrl.match(/\/images\/og\/(page[0-9]+)_/i);
  return m ? m[1] : null;
}

function isValidPageId(v) {
  return typeof v === 'string' && /^page\d{6}$/i.test(v.trim());
}

function loadPostsPageIdMap() {
  const out = {};

  if (!fs.existsSync(POSTS_DIR)) {
    return out;
  }

  const files = fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.json'));
  for (const filename of files) {
    const fullPath = path.join(POSTS_DIR, filename);
    const json = safeReadJson(fullPath, null);
    if (!json || typeof json !== 'object') continue;

    const slug = String(json.slug || filename.replace(/\.json$/i, '')).trim();
    if (!slug) continue;

    const pageId =
      (typeof json.pageId === 'string' && json.pageId.trim()) ||
      (typeof json.page_id === 'string' && json.page_id.trim()) ||
      (json.seedMeta && typeof json.seedMeta.pageId === 'string' && json.seedMeta.pageId.trim()) ||
      null;

    if (isValidPageId(pageId)) {
      out[slug] = pageId;
    }
  }

  return out;
}

function loadManifestPageIdMap() {
  const out = {};
  const manifest = safeReadJson(MANIFEST_PATH, null);
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.images)) {
    return out;
  }

  for (const entry of manifest.images) {
    if (!entry || typeof entry !== 'object') continue;
    const slug = String(entry.slug || '').trim();
    const pageId = String(entry.pageId || '').trim();
    if (!slug) continue;
    if (!isValidPageId(pageId)) continue;
    out[slug] = pageId;
  }

  return out;
}

function buildRecordFromHtml(file, pageIdHints) {
  const html = fs.readFileSync(file.fullPath, 'utf8');

  // og:image 절대 URL
  const ogUrl = extractFirst(
    html,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i
  );

  if (!ogUrl) {
    // og:image 없는 파일은 스킵
    return null;
  }

  // pageId 우선순위
  // 1) posts SSOT
  // 2) 기존 manifest 같은 slug
  // 3) HTML page badge/data-page-id
  // 4) og:image 파일명
  let pageId =
    pageIdHints.postsBySlug[file.slug] ||
    pageIdHints.manifestBySlug[file.slug] ||
    extractFirst(
      html,
      /id=["']pageId["'][^>]*data-page-id=["']([^"']+)["'][^>]*>/
    ) ||
    extractFirst(
      html,
      /data-page-id=["']([^"']+)["'][^>]*id=["']pageId["'][^>]*>/
    ) ||
    extractFirst(
      html,
      /id=["']pageId["'][^>]*>\s*(page[0-9]+)\s*<\/a>/
    );

  // 템플릿 값/비정상값이면 og:image 기반으로 다시 추론
  if (!isValidPageId(pageId) || pageId === '{{pageId}}') {
    pageId = inferPageIdFromOgUrl(ogUrl);
  }

  const filename = ogUrl.split('/').pop() || '';

  // width/height: 메타 태그에서 우선 추출
  const ogWidthStr = extractFirst(
    html,
    /<meta[^>]+property=["']og:image:width["'][^>]+content=["'](\d+)["'][^>]*>/i
  );
  const ogHeightStr = extractFirst(
    html,
    /<meta[^>]+property=["']og:image:height["'][^>]+content=["'](\d+)["'][^>]*>/i
  );

  const width = ogWidthStr ? parseInt(ogWidthStr, 10) : 1200;
  const height = ogHeightStr ? parseInt(ogHeightStr, 10) : 630;

  // alt: og:image:alt 우선, 없으면 hero 이미지 alt
  let alt =
    extractFirst(
      html,
      /<meta[^>]+property=["']og:image:alt["'][^>]+content=["']([^"']+)["'][^>]*>/i
    ) || null;

  if (!alt) {
    alt = extractFirst(
      html,
      /<figure[^>]+class=["']post-hero["'][^>]*>[\s\S]*?<img[^>]+alt=["']([^"']+)["'][^>]*>[\s\S]*?<\/figure>/i
    );
  }

  const now = new Date().toISOString();

  return {
    slug: file.slug,
    pageId: isValidPageId(pageId) ? pageId : null,
    type: 'og',
    url: ogUrl,
    filename,
    width,
    height,
    alt: alt || null,
    etag: null,
    hash: null,
    lastSeenAt: now,
  };
}

function main() {
  log('────────────────────────────────────────────');
  log('[images-renew] 시작');
  log(`[images-renew] ROOT      = ${ROOT}`);
  log(`[images-renew] DIST_DIR  = ${DIST_DIR}`);
  log(`[images-renew] POSTS_DIR = ${POSTS_DIR}`);
  log(`[images-renew] MANIFEST  = ${MANIFEST_PATH}`);
  log('────────────────────────────────────────────');

  const files = readHtmlFiles(DIST_DIR);

  if (!files.length) {
    log('[images-renew] dist/posts 안에 HTML 파일이 없습니다. 종료합니다.');
    return;
  }

  const postsBySlug = loadPostsPageIdMap();
  const manifestBySlug = loadManifestPageIdMap();

  log(`[images-renew] posts pageId map       = ${Object.keys(postsBySlug).length}`);
  log(`[images-renew] previous manifest map  = ${Object.keys(manifestBySlug).length}`);

  const records = [];
  let inferredFromPosts = 0;
  let inferredFromManifest = 0;
  let inferredFromHtmlOrOg = 0;
  let pageIdMissing = 0;

  for (const file of files) {
    const rec = buildRecordFromHtml(file, { postsBySlug, manifestBySlug });
    if (rec) {
      if (rec.pageId && postsBySlug[file.slug] && rec.pageId === postsBySlug[file.slug]) {
        inferredFromPosts++;
      } else if (rec.pageId && manifestBySlug[file.slug] && rec.pageId === manifestBySlug[file.slug]) {
        inferredFromManifest++;
      } else if (rec.pageId) {
        inferredFromHtmlOrOg++;
      } else {
        pageIdMissing++;
      }
      records.push(rec);
    } else {
      log(`[images-renew] 스킵: og:image 없음 → ${file.filename}`);
    }
  }

  const manifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    images: records,
  };

  ensureDir(MANIFEST_PATH);
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  log(`[images-renew] 기록된 이미지 수 = ${records.length}`);
  log(`[images-renew] pageId source: posts=${inferredFromPosts}, manifest=${inferredFromManifest}, html/og=${inferredFromHtmlOrOg}, missing=${pageIdMissing}`);
  log('────────────────────────────────────────────');
  log('[images-renew] 완료');
}

main();
