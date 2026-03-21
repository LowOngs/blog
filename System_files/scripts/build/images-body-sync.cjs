
#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/images-body-sync.cjs
 *
 * 목적:
 * - content/posts/*.json 을 기준으로
 * - 본문(body, blocks) 내 이미지(src)를 추출하여
 * - manifests/images-body-manifest.json 을 "완전 재생성(SSOT)" 합니다.
 *
 * 핵심 규칙:
 * - append 금지 (항상 overwrite)
 * - posts가 유일한 source-of-truth
 * - manifest는 파생 데이터
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const MANIFEST_PATH = path.join(ROOT, 'manifests', 'images-body-manifest.json');

/* ───────────────────── utils ───────────────────── */

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function nowIso() {
  return new Date().toISOString();
}

/* ───────────────────── 이미지 추출 ───────────────────── */

function extractImagesFromHtml(html) {
  if (!html || typeof html !== 'string') return [];

  const results = [];

  // <img src="..." alt="..." width="..." height="...">
  const re = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;

  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const src = m[1];

    const altMatch = tag.match(/alt=["']([^"']*)["']/i);
    const widthMatch = tag.match(/width=["'](\d+)["']/i);
    const heightMatch = tag.match(/height=["'](\d+)["']/i);

    results.push({
      url: src,
      alt: altMatch ? altMatch[1] : '',
      width: widthMatch ? Number(widthMatch[1]) : undefined,
      height: heightMatch ? Number(heightMatch[1]) : undefined,
    });
  }

  return results;
}

/* ───────────────────── posts 스캔 ───────────────────── */

function scanPosts() {
  if (!fs.existsSync(POSTS_DIR)) return [];

  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'));

  const out = [];

  for (const f of files) {
    const full = path.join(POSTS_DIR, f);
    const post = readJsonSafe(full);
    if (!isPlainObject(post)) continue;

    const slug = String(post.slug || f.replace(/\.json$/i, '')).trim();
    if (!slug) continue;

    let images = [];

    // body
    if (typeof post.body === 'string') {
      images = images.concat(extractImagesFromHtml(post.body));
    }

    // blocks
    if (Array.isArray(post.blocks)) {
      for (const b of post.blocks) {
        if (b && typeof b.html === 'string') {
          images = images.concat(extractImagesFromHtml(b.html));
        }
      }
    }

    if (images.length > 0) {
      out.push({
        slug,
        pageId: post.pageId || null,
        label: post.label || null,
        images,
      });
    }
  }

  return out;
}

/* ───────────────────── manifest 생성 ───────────────────── */

function buildManifest(postImages) {
  const items = {};

  for (const p of postImages) {
    // 정책: 1 slug = 첫 번째 이미지만 사용
    const img = p.images[0];
    if (!img) continue;

    items[p.slug] = {
      pageId: p.pageId || null,
      label: p.label || null,
      url: img.url,
      alt: img.alt || '',
      width: img.width,
      height: img.height,
      safe: true,
      updatedAt: nowIso(),
    };
  }

  return {
    meta: {
      version: 1,
      generatedAt: nowIso(),
      policy: {
        maxImagesPerPost: 1,
      },
    },
    items,
  };
}

/* ───────────────────── main ───────────────────── */

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[images-body-sync] 시작');
  console.log('[images-body-sync] ROOT        =', ROOT);
  console.log('[images-body-sync] POSTS_DIR   =', POSTS_DIR);
  console.log('[images-body-sync] MANIFEST    =', MANIFEST_PATH);
  console.log('────────────────────────────────────────────');

  const postImages = scanPosts();

  const manifest = buildManifest(postImages);

  writeJson(MANIFEST_PATH, manifest);

  console.log(`[images-body-sync] posts with images = ${postImages.length}`);
  console.log(`[images-body-sync] manifest items    = ${Object.keys(manifest.items).length}`);
  console.log('────────────────────────────────────────────');
  console.log('[images-body-sync] 완료');
}

if (require.main === module) main();
