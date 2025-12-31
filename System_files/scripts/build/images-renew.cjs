// System_files/scripts/build/images-renew.cjs
// dist/posts/*.html 을 스캔해서 manifests/images-manifest.json 을
// 새 스키마(version=1)로 "완전 재생성"하는 스크립트입니다.
//
// ─────────────────────────────────────────────
// [중요] OG Freshness 관련 오해 방지
// - 이 파일은 "이미지 픽셀/색상 변경"을 하지 않습니다.
// - HTML에 이미 박혀 있는 og:image URL, og:image:alt, width/height, modified_time 등을 읽어
//   manifest(인덱스)를 재생성합니다.
// - AOIA에서 말하는 프레시니스 신호는 'updatedAt(메타 시간)' 및 'og:image URL/파일 신규성'에 의해
//   상위 단계(meta/render/og 생성)에서 만들어집니다.
// ─────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
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

function buildRecordFromHtml(file) {
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

  // pageId: 1) data-page-id 2) page 배지 텍스트 3) og:image 파일명
  let pageId =
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

  // 템플릿 값이면 무시하고 og:image 기반으로 다시 추론
  if (!pageId || pageId === '{{pageId}}') {
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
    pageId: pageId || null,
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
  log(`[images-renew] MANIFEST  = ${MANIFEST_PATH}`);
  log('────────────────────────────────────────────');

  const files = readHtmlFiles(DIST_DIR);

  if (!files.length) {
    log('[images-renew] dist/posts 안에 HTML 파일이 없습니다. 종료합니다.');
    return;
  }

  const records = [];
  for (const file of files) {
    const rec = buildRecordFromHtml(file);
    if (rec) {
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
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');

  log(`[images-renew] 기록된 이미지 수 = ${records.length}`);
  log('────────────────────────────────────────────');
  log('[images-renew] 완료');
}

main();
