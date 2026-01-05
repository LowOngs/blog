// System_files/scripts/build/images-build-og.cjs
// 역할:
//  - manifests/images-manifest.json 을 읽어서
//  - 각 slug에 대해 pageId를 가져오고(없으면 ensurePageId)
//  - base-1200x630.jpg를 약간 변형해서
//  - {pageId}_{slug}_1200x630.jpg 형식으로 OG 이미지 생성
//  - manifest 내 url/filename/pageId/lastSeenAt 업데이트
//
// ✅ 변경(2026-01-05):
//  - OG 산출물은 assets/가 아니라 dist/images/og/ 로 생성(캐시 성격)
//  - 실행 시 dist/images/og/*.jpg 를 전부 삭제 후 재생성(누적 방지)
//  - pageId는 "없을 때만" 발급(이미 있으면 재발급 금지)

require('./lib/env.cjs'); // ✅ .env 로드(필수)

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { ensurePageId, isValidPageId } = require('./lib/page-ids.cjs');

// ✅ ROOT를 항상 System_files 기준으로 고정
const ROOT = path.resolve(__dirname, '..', '..'); // C:\google-blog\System_files
const DIST_POSTS_DIR = path.join(ROOT, 'dist', 'posts');
const MANIFEST_PATH = path.join(ROOT, 'manifests', 'images-manifest.json');

// ✅ base는 assets에 "고정 보관"
const OG_ASSETS_DIR = path.join(ROOT, 'assets', 'images', 'og');

// ✅ 산출물은 dist/images/og 로 "매번 갈아끼움"
const DIST_IMAGES_DIR = path.join(ROOT, 'dist', 'images');
const OG_OUT_DIR = path.join(DIST_IMAGES_DIR, 'og');

// 환경변수에서 CDN_BASE를 받되, 없으면 기본값 사용
const CDN_BASE = process.env.CDN_BASE || 'https://ongsblog.com/images';

// 실행 시 누적 파일 제거(기본 true)
const CLEAN_OG_OUT = String(process.env.CLEAN_OG_OUT || 'true').toLowerCase() === 'true';

// 약간의 변형(미세 밝기) 사용 여부(기본 true)
const OG_JITTER = String(process.env.OG_JITTER || 'true').toLowerCase() === 'true';

function loadManifest() {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const data = JSON.parse(raw);

    if (!Array.isArray(data.images)) data.images = [];
    if (typeof data.version !== 'number') data.version = 1;

    return data;
  } catch (e) {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      images: [],
    };
  }
}

function saveManifest(manifest) {
  manifest.version = 1;
  manifest.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

// base 이미지 경로
function getBaseImagePath() {
  const basePath = path.join(OG_ASSETS_DIR, 'base-1200x630.jpg');
  if (!fs.existsSync(basePath)) {
    throw new Error(`base OG image not found: ${basePath}`);
  }
  return basePath;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ✅ dist/images/og 누적 제거(assets는 건드리지 않음)
function cleanOgOutDir() {
  ensureDir(OG_OUT_DIR);
  const files = fs.readdirSync(OG_OUT_DIR).filter((n) => n.toLowerCase().endsWith('.jpg'));
  for (const f of files) {
    try {
      fs.unlinkSync(path.join(OG_OUT_DIR, f));
    } catch {}
  }
  console.log(`[images-build-og] cleaned OG_OUT_DIR: removed ${files.length} jpg files`);
}

// pageId: 이미 있으면 그대로 사용, 없으면 발급
function getOrEnsurePageId(entry, slug) {
  const existing = entry && entry.pageId ? String(entry.pageId) : '';
  if (isValidPageId(existing)) return existing;
  return ensurePageId(slug);
}

// OG 이미지 한 장 생성
async function buildOgImage(entry, basePath) {
  const { slug, width, height } = entry;
  if (!slug) throw new Error('manifest entry missing slug');

  const w = width || 1200;
  const h = height || 630;

  // ✅ pageId는 "없을 때만" 발급
  const pageId = getOrEnsurePageId(entry, slug);

  const filename = `${pageId}_${slug}_${w}x${h}.jpg`;
  const outPath = path.join(OG_OUT_DIR, filename);

  // “서로 다른 이미지” 시그널(선택)
  // ※ 필요 없으면 OG_JITTER=false 로 끄면 됨
  const brightnessJitter = OG_JITTER ? (0.99 + (Math.random() * 0.02)) : 1.0; // 0.99 ~ 1.01

  await sharp(basePath)
    .resize(w, h, { fit: 'cover' })
    .modulate({ brightness: brightnessJitter })
    .jpeg({ quality: 82, chromaSubsampling: '4:2:0' })
    .toFile(outPath);

  // manifest 엔트리 업데이트
  entry.pageId = pageId;
  entry.filename = filename;
  entry.url = `${CDN_BASE}/og/${filename}`;
  entry.width = w;
  entry.height = h;
  entry.lastSeenAt = new Date().toISOString();

  if (!('etag' in entry)) entry.etag = null;
  if (!('hash' in entry)) entry.hash = null;

  return { pageId, filename, outPath };
}

async function main() {
  console.log('────────────────────────────────────────────');
  console.log('[images-build-og] 시작');
  console.log('[images-build-og] ROOT          =', ROOT);
  console.log('[images-build-og] DIST_POSTS_DIR =', DIST_POSTS_DIR);
  console.log('[images-build-og] MANIFEST      =', MANIFEST_PATH);
  console.log('[images-build-og] OG_ASSETS_DIR  =', OG_ASSETS_DIR);
  console.log('[images-build-og] OG_OUT_DIR     =', OG_OUT_DIR);
  console.log('[images-build-og] CLEAN_OG_OUT   =', CLEAN_OG_OUT);
  console.log('[images-build-og] OG_JITTER      =', OG_JITTER);
  console.log('────────────────────────────────────────────');

  const basePath = getBaseImagePath();
  console.log('[images-build-og] base image =', basePath);
  console.log('────────────────────────────────────────────');

  const manifest = loadManifest();
  const images = manifest.images || [];
  console.log('[images-build-og] manifest 내 이미지 수 =', images.length);
  console.log('────────────────────────────────────────────');

  ensureDir(DIST_IMAGES_DIR);
  ensureDir(OG_OUT_DIR);

  if (CLEAN_OG_OUT) cleanOgOutDir();

  let created = 0;
  let failed = 0;

  for (const entry of images) {
    const slug = entry.slug;
    if (!slug) continue;

    try {
      const result = await buildOgImage(entry, basePath);
      console.log(`[images-build-og] ✓ 생성: slug=${slug} → ${result.filename} (pageId=${result.pageId})`);
      created += 1;
    } catch (err) {
      failed += 1;
      console.error(`[images-build-og] ✗ 실패: slug=${slug}`, err && err.message ? err.message : err);
    }
  }

  saveManifest(manifest);

  console.log('────────────────────────────────────────────');
  console.log(`[images-build-og] 완료: 생성=${created}, 실패=${failed}, 총=${images.length}`);
  console.log('────────────────────────────────────────────');

  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('────────────────────────────────────────────');
  console.error('[images-build-og] FATAL ERROR');
  console.error(err);
  console.error('────────────────────────────────────────────');
  process.exit(1);
});
