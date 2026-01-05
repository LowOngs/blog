#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/images-build-og.cjs
 *
 * ✅ 역할(정리본)
 * - manifests/images-manifest.json 을 읽어서
 * - 각 entry의 (slug + pageId)가 있는 것만 대상으로
 * - assets/images/og/base-1200x630.jpg 를 기반으로
 * - dist/images/og/{pageId}_{slug}_1200x630.jpg 생성
 * - entry.filename/url/lastBuiltAt 등을 갱신
 *
 * ✅ 핵심 정책
 * - 여기서 ensurePageId() 호출 금지 (pageId 발급은 ids.cjs / render 단계에서만)
 * - OG 산출물은 dist/images/og 로만 생성 (assets에는 base만 유지)
 * - 파일 누적 방지: assets의 생성 잔재 삭제 + dist에서 manifest에 없는 파일 삭제
 * - 변형(옵션)은 랜덤 금지, slug 기반 결정론적(deterministic)만 허용
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

// ✅ ROOT를 항상 System_files 기준으로 고정
const ROOT = path.resolve(__dirname, '..', '..'); // System_files

const MANIFEST_PATH = path.join(ROOT, 'manifests', 'images-manifest.json');

// base 이미지(원본) 위치는 assets에 고정
const ASSETS_OG_DIR = path.join(ROOT, 'assets', 'images', 'og');
const BASE_IMAGE_PATH = path.join(ASSETS_OG_DIR, 'base-1200x630.jpg');

// 산출물은 dist에 고정 (r2-upload도 이 경로를 업로드 대상으로 사용)
const DIST_IMAGES_DIR = path.join(ROOT, 'dist', 'images');
const DIST_OG_DIR = path.join(DIST_IMAGES_DIR, 'og');

// 환경변수에서 CDN_BASE를 받되, 없으면 기본값 사용
const CDN_BASE = (process.env.CDN_BASE || 'https://ongsblog.com/images').replace(/\/+$/, '');

// 변형 스위치 (기본: on). 원치 않으면 OG_DETERMINISTIC_JITTER=false
const ENABLE_JITTER = String(process.env.OG_DETERMINISTIC_JITTER || 'true').toLowerCase() === 'true';

// 파일 매칭(생성물)
const OG_FILE_RE = /^page\d{6}_.+_1200x630\.jpg$/i;

function die(msg) {
  console.error('[images-build-og][FATAL]', msg);
  process.exit(1);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function loadManifest() {
  try {
    const data = readJson(MANIFEST_PATH);
    if (!data || typeof data !== 'object') throw new Error('manifest invalid');
    if (!Array.isArray(data.images)) data.images = [];
    if (typeof data.version !== 'number') data.version = 1;
    return data;
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), images: [] };
  }
}

function saveManifest(manifest) {
  manifest.version = 1;
  manifest.updatedAt = new Date().toISOString();
  writeJson(MANIFEST_PATH, manifest);
}

function deterministicBrightnessFromSlug(slug) {
  // slug → sha256 → 0..255
  const h = crypto.createHash('sha256').update(String(slug || '')).digest();
  const b = h[0]; // 0..255

  // 0.995 ~ 1.005 범위(아주 미세), 결정론적
  const min = 0.995;
  const max = 1.005;
  const t = b / 255;
  return min + (max - min) * t;
}

function safeUnlink(filePath) {
  try { fs.unlinkSync(filePath); return true; } catch { return false; }
}

function cleanupAssetsGeneratedFilesKeepBase() {
  // assets/images/og 에 남아있는 생성 잔재를 삭제 (base-1200x630.jpg만 유지)
  if (!fs.existsSync(ASSETS_OG_DIR)) return { deleted: 0 };

  const files = fs.readdirSync(ASSETS_OG_DIR);
  let deleted = 0;

  for (const name of files) {
    if (name === 'base-1200x630.jpg') continue;
    if (!OG_FILE_RE.test(name)) continue;

    const fp = path.join(ASSETS_OG_DIR, name);
    if (safeUnlink(fp)) deleted++;
  }

  return { deleted };
}

function cleanupDistUnknownFiles(expectedSet) {
  // dist/images/og 에서 manifest에 없는 생성물을 삭제
  if (!fs.existsSync(DIST_OG_DIR)) return { deleted: 0, kept: 0 };

  const files = fs.readdirSync(DIST_OG_DIR);
  let deleted = 0;
  let kept = 0;

  for (const name of files) {
    if (!OG_FILE_RE.test(name)) continue;
    if (expectedSet.has(name)) { kept++; continue; }

    const fp = path.join(DIST_OG_DIR, name);
    if (safeUnlink(fp)) deleted++;
  }

  return { deleted, kept };
}

async function buildOne(entry) {
  const slug = entry.slug;
  const pageId = entry.pageId;

  if (!slug) return { status: 'skip', reason: 'missing slug' };
  if (!pageId || !/^page\d{6}$/.test(pageId)) return { status: 'skip', reason: 'missing/invalid pageId' };

  const w = 1200;
  const h = 630;
  const filename = `${pageId}_${slug}_${w}x${h}.jpg`;
  const outPath = path.join(DIST_OG_DIR, filename);

  let pipeline = sharp(BASE_IMAGE_PATH).resize(w, h, { fit: 'cover' });

  if (ENABLE_JITTER) {
    const brightness = deterministicBrightnessFromSlug(slug);
    pipeline = pipeline.modulate({ brightness });
  }

  await pipeline.jpeg({ quality: 82, chromaSubsampling: '4:2:0' }).toFile(outPath);

  // manifest 갱신
  entry.filename = filename;
  entry.url = `${CDN_BASE}/og/${filename}`;
  entry.width = w;
  entry.height = h;
  entry.lastBuiltAt = new Date().toISOString();

  return { status: 'ok', filename };
}

async function main() {
  console.log('────────────────────────────────────────────');
  console.log('[images-build-og] 시작');
  console.log('[images-build-og] ROOT            =', ROOT);
  console.log('[images-build-og] MANIFEST         =', MANIFEST_PATH);
  console.log('[images-build-og] ASSETS_OG_DIR    =', ASSETS_OG_DIR);
  console.log('[images-build-og] BASE_IMAGE_PATH  =', BASE_IMAGE_PATH);
  console.log('[images-build-og] DIST_OG_DIR      =', DIST_OG_DIR);
  console.log('[images-build-og] CDN_BASE         =', CDN_BASE);
  console.log('[images-build-og] JITTER           =', ENABLE_JITTER);
  console.log('────────────────────────────────────────────');

  if (!fs.existsSync(BASE_IMAGE_PATH)) die(`base OG image not found: ${BASE_IMAGE_PATH}`);

  ensureDir(DIST_OG_DIR);

  // ✅ 1) assets에 쌓인 “생성 잔재” 정리 (base만 남김)
  const assetsCleanup = cleanupAssetsGeneratedFilesKeepBase();
  if (assetsCleanup.deleted > 0) {
    console.log(`[images-build-og] assets cleanup: deleted=${assetsCleanup.deleted}`);
  }

  const manifest = loadManifest();
  const images = manifest.images || [];

  // ✅ 2) 이번 라운드에서 기대되는 파일 목록(= manifest 기준)
  const expected = new Set();
  for (const e of images) {
    if (!e || !e.slug || !e.pageId) continue;
    if (!/^page\d{6}$/.test(e.pageId)) continue;
    expected.add(`${e.pageId}_${e.slug}_1200x630.jpg`);
  }

  // ✅ 3) dist/images/og 에서 manifest에 없는 파일 제거
  const distCleanup = cleanupDistUnknownFiles(expected);
  if (distCleanup.deleted > 0) {
    console.log(`[images-build-og] dist cleanup: deleted=${distCleanup.deleted}, kept=${distCleanup.kept}`);
  }

  console.log('[images-build-og] manifest 내 엔트리 수 =', images.length);
  console.log('────────────────────────────────────────────');

  let ok = 0, skip = 0, fail = 0;

  for (const entry of images) {
    try {
      const r = await buildOne(entry);
      if (r.status === 'ok') {
        ok++;
        console.log(`[images-build-og] ✓ 생성: slug=${entry.slug} -> ${r.filename} (pageId=${entry.pageId})`);
      } else {
        skip++;
        // 조용히 넘기되, 원인 로그는 남김
        console.log(`[images-build-og] - skip: slug=${entry.slug || '(none)'} reason=${r.reason}`);
      }
    } catch (e) {
      fail++;
      console.error(`[images-build-og] ✗ 실패: slug=${entry && entry.slug ? entry.slug : '(none)'}`, e && e.message ? e.message : e);
    }
  }

  saveManifest(manifest);

  console.log('────────────────────────────────────────────');
  console.log(`[images-build-og] 완료: ok=${ok}, skip=${skip}, fail=${fail}, total=${images.length}`);
  console.log('────────────────────────────────────────────');

  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('────────────────────────────────────────────');
  console.error('[images-build-og] FATAL ERROR');
  console.error(err);
  console.error('────────────────────────────────────────────');
  process.exit(1);
});
