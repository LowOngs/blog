// System_files/scripts/build/images-build-og.cjs
// 역할:
//  - manifests/images-manifest.json 을 읽어서
//  - (중요) entry.pageId 가 있는 항목만 처리(새로 발급 금지)
//  - assets/images/og/base-1200x630.jpg 기반으로
//  - dist/images/og/{pageId}_{slug}_1200x630.jpg 생성
//  - manifest 내 url/filename/lastSeenAt 업데이트
//
// 옵션:
//  - CLEAN_OG_OUT=true|false (기본 true)
//    true면 dist/images/og 안의 base 제외 jpg를 정리 후 재생성 (불필요 백업 누적 방지)
//  - OG_JITTER=false|true (기본 false)
//    true면 아주 미세한 brightness 변형(랜덤). 재현성 필요하면 false 유지 권장.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// ✅ ROOT를 항상 System_files 기준으로 고정
const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const MANIFEST_PATH = path.join(ROOT, 'manifests', 'images-manifest.json');

// ✅ base는 assets에 고정 보관
const OG_ASSETS_DIR = path.join(ROOT, 'assets', 'images', 'og');
const BASE_FILENAME = 'base-1200x630.jpg';

// ✅ 산출물은 dist/images/og 로 고정 (r2-upload가 읽는 위치와 일치)
const DIST_IMAGES_DIR = path.join(ROOT, 'dist', 'images');
const OG_OUT_DIR = path.join(DIST_IMAGES_DIR, 'og');

// 환경변수에서 CDN_BASE를 받되, 없으면 기본값 사용
const CDN_BASE = (process.env.CDN_BASE || 'https://ongsblog.com/images').replace(/\/+$/, '');

// 기본 정책
const CLEAN_OG_OUT = String(process.env.CLEAN_OG_OUT || 'true').toLowerCase() === 'true';
const OG_JITTER = String(process.env.OG_JITTER || 'false').toLowerCase() === 'true';

function loadManifest() {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.images)) data.images = [];
    if (typeof data.version !== 'number') data.version = 1;
    return data;
  } catch (e) {
    return { version: 1, updatedAt: new Date().toISOString(), images: [] };
  }
}

function saveManifest(manifest) {
  manifest.version = 1;
  manifest.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

function getBaseImagePath() {
  const basePath = path.join(OG_ASSETS_DIR, BASE_FILENAME);
  if (!fs.existsSync(basePath)) {
    throw new Error(`base OG image not found: ${basePath}`);
  }
  return basePath;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function cleanOgOutDir() {
  // base는 assets에 있으므로 dist/images/og 에 base는 없음.
  // 여기서는 dist/images/og 내 jpg/webp만 정리(원하면 확장 가능)
  if (!fs.existsSync(OG_OUT_DIR)) return;
  const files = fs.readdirSync(OG_OUT_DIR);
  for (const f of files) {
    const full = path.join(OG_OUT_DIR, f);
    if (!fs.statSync(full).isFile()) continue;
    if (/\.(jpe?g|webp|png)$/i.test(f)) {
      fs.unlinkSync(full);
    }
  }
}

async function buildOgImage(entry, basePath) {
  const slug = entry.slug;
  if (!slug) throw new Error('manifest entry missing slug');

  // ✅ pageId 신규 발급 금지: 없으면 스킵(=images-renew가 SSOT로 채워야 함)
  const pageId = entry.pageId;
  if (!pageId) {
    return { skipped: true, reason: 'missing pageId (SSOT required)', slug };
  }

  const w = entry.width || 1200;
  const h = entry.height || 630;

  const filename = `${pageId}_${slug}_${w}x${h}.jpg`;
  const outPath = path.join(OG_OUT_DIR, filename);

  // 선택 옵션: 미세 jitter (원하면 true)
  const brightnessJitter = OG_JITTER ? (0.99 + Math.random() * 0.02) : 1.0;

  let pipeline = sharp(basePath).resize(w, h, { fit: 'cover' });
  if (brightnessJitter !== 1.0) {
    pipeline = pipeline.modulate({ brightness: brightnessJitter });
  }

  await pipeline.jpeg({ quality: 82, chromaSubsampling: '4:2:0' }).toFile(outPath);

  // manifest 엔트리 업데이트
  entry.filename = filename;
  entry.url = `${CDN_BASE}/og/${filename}`;
  entry.width = w;
  entry.height = h;
  entry.lastSeenAt = new Date().toISOString();

  if (!('etag' in entry)) entry.etag = null;
  if (!('hash' in entry)) entry.hash = null;

  return { skipped: false, pageId, filename, outPath, slug };
}

async function main() {
  console.log('────────────────────────────────────────────');
  console.log('[images-build-og] start');
  console.log('[images-build-og] ROOT        =', ROOT);
  console.log('[images-build-og] MANIFEST    =', MANIFEST_PATH);
  console.log('[images-build-og] OG_ASSETS   =', OG_ASSETS_DIR);
  console.log('[images-build-og] OG_OUT_DIR  =', OG_OUT_DIR);
  console.log('[images-build-og] CDN_BASE    =', CDN_BASE);
  console.log('[images-build-og] CLEAN_OG_OUT=', CLEAN_OG_OUT);
  console.log('[images-build-og] OG_JITTER   =', OG_JITTER);
  console.log('────────────────────────────────────────────');

  const basePath = getBaseImagePath();
  console.log('[images-build-og] base image  =', basePath);

  const manifest = loadManifest();
  const images = manifest.images || [];
  console.log('[images-build-og] manifest images =', images.length);

  ensureDir(OG_OUT_DIR);

  if (CLEAN_OG_OUT) {
    cleanOgOutDir();
    console.log('[images-build-og] cleaned dist og outputs');
  }

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of images) {
    try {
      const r = await buildOgImage(entry, basePath);
      if (r.skipped) {
        console.log(`[images-build-og] - skip: slug=${r.slug} (${r.reason})`);
        skipped += 1;
        continue;
      }
      console.log(`[images-build-og] ✓ build: slug=${r.slug} -> ${r.filename} (pageId=${r.pageId})`);
      created += 1;
    } catch (err) {
      console.error(`[images-build-og] ✗ fail: slug=${entry.slug || '(no-slug)'}: ${err.message}`);
      failed += 1;
    }
  }

  saveManifest(manifest);

  console.log('────────────────────────────────────────────');
  console.log(`[images-build-og] done: created=${created}, skipped=${skipped}, failed=${failed}, total=${images.length}`);
  console.log('────────────────────────────────────────────');

  // 실패가 있으면 CI에서 감지되도록 exit code (원하면 완화 가능)
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('────────────────────────────────────────────');
  console.error('[images-build-og] FATAL');
  console.error(err);
  console.error('────────────────────────────────────────────');
  process.exit(1);
});
