// System_files/scripts/build/images-build-og.cjs
// 역할:
//  - manifests/images-manifest.json 을 읽어서
//  - 각 slug에 대해 pageId를 가져오고(ensurePageId)
//  - base-1200x630.jpg를 약간 변형해서
//  - {pageId}_{slug}_1200x630.jpg 형식으로 OG 이미지 생성
//  - manifest 내 url/filename/pageId/lastSeenAt 업데이트

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { ensurePageId } = require('./lib/page-ids.cjs');

// ✅ ROOT를 항상 System_files 기준으로 고정
const ROOT = path.resolve(__dirname, '..', '..'); // C:\google-blog\System_files
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
const MANIFEST_PATH = path.join(ROOT, 'manifests', 'images-manifest.json');
const OG_DIR = path.join(ROOT, 'assets', 'images', 'og');

// 환경변수에서 CDN_BASE를 받되, 없으면 기본값 사용
const CDN_BASE = process.env.CDN_BASE || 'https://ongsblog.com/images';

function loadManifest() {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const data = JSON.parse(raw);

    if (!Array.isArray(data.images)) {
      data.images = [];
    }
    if (typeof data.version !== 'number') {
      data.version = 1;
    }
    return data;
  } catch (e) {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      images: []
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
  const basePath = path.join(OG_DIR, 'base-1200x630.jpg');
  if (!fs.existsSync(basePath)) {
    throw new Error(`base OG image not found: ${basePath}`);
  }
  return basePath;
}

// OG 이미지 한 장 생성
async function buildOgImage(entry, basePath) {
  const { slug, width, height } = entry;
  if (!slug) {
    throw new Error('manifest entry missing slug');
  }

  const w = width || 1200;
  const h = height || 630;

  // ★ pageId 부여 (test 모드면 항상 page000001, live 모드면 순차 증가)
  const pageId = ensurePageId(slug);

  const filename = `${pageId}_${slug}_${w}x${h}.jpg`;
  const outPath = path.join(OG_DIR, filename);

  // 눈에 안 띄는 수준의 미세 밝기 조정 (SEO/AIO용 “서로 다른 이미지” 시그널)
  const brightnessJitter = 0.99 + (Math.random() * 0.02); // 0.99 ~ 1.01

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
  console.log('[images-build-og] ROOT      =', ROOT);
  console.log('[images-build-og] DIST_DIR  =', DIST_DIR);
  console.log('[images-build-og] MANIFEST  =', MANIFEST_PATH);
  console.log('[images-build-og] OG_DIR    =', OG_DIR);
  console.log('────────────────────────────────────────────');

  const basePath = getBaseImagePath();
  console.log('[images-build-og] base image =', basePath);
  console.log('────────────────────────────────────────────');

  const manifest = loadManifest();
  const images = manifest.images || [];
  console.log('[images-build-og] manifest 내 이미지 수 =', images.length);
  console.log('────────────────────────────────────────────');

  fs.mkdirSync(OG_DIR, { recursive: true });

  let created = 0;
  let kept = 0;

  for (const entry of images) {
    const slug = entry.slug;
    if (!slug) continue;

    try {
      const result = await buildOgImage(entry, basePath);
      console.log(
        `[images-build-og] ✓ 생성: slug=${slug} → ${result.filename} (pageId=${result.pageId})`
      );
      created += 1;
    } catch (err) {
      console.error(`[images-build-og] ✗ 실패: slug=${slug}`, err.message);
    }
  }

  saveManifest(manifest);

  console.log('────────────────────────────────────────────');
  console.log(
    `[images-build-og] 완료: 생성=${created}, 기존유지=${kept}, 총=${images.length}`
  );
  console.log('────────────────────────────────────────────');
}

main().catch((err) => {
  console.error('────────────────────────────────────────────');
  console.error('[images-build-og] FATAL ERROR');
  console.error(err);
  console.error('────────────────────────────────────────────');
  process.exit(1);
});
