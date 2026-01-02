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
 *   이유: dist는 산출물, manifest는 파이프라인 전반이 공유하는 인덱스(SSOT)라서
 *        validate/업로드/로그 등 다른 단계에서도 안정 참조해야 합니다.
 *
 * [Freshness 신호]
 * - updatedAt은 article:modified_time 또는 og:updated_time(HTML 메타)로 기록합니다.
 * - 이 파일은 픽셀을 바꾸지 않고, "메타 시간/경로"를 구조화해서 신호를 제공합니다.
 * ─────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const DIST_POSTS_DIR = path.join(ROOT, 'dist', 'posts');

// ✅ SSOT: manifests 아래로 통일
const MANIFEST_DIR = path.join(ROOT, 'manifests');
const MANIFEST_FILE = path.join(MANIFEST_DIR, 'images-manifest.json');

// 도메인 베이스: .env / GitHub Secrets 기준(render-posts / validate-repair와 일치)
const SITE_BASE = (process.env.CANONICAL_BASE || 'https://ongsblog.com').replace(/\/+$/, '');

// (선택) CDN_BASE가 SITE_BASE와 다른 도메인으로 분리될 수 있으므로 같이 받아둠
// - 현 시점에는 SITE_BASE와 동일 도메인(/images)일 가능성이 높지만, 미래 대비용
const CDN_BASE = (process.env.CDN_BASE || (SITE_BASE + '/images')).replace(/\/+$/, '');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * manifest 로드
 * - 파일이 없으면 []
 * - 파싱 실패면 안전하게 새로 생성([])
 */
function loadManifest() {
  if (!fs.existsSync(MANIFEST_FILE)) return [];
  try {
    const raw = fs.readFileSync(MANIFEST_FILE, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('[images-manifest] 기존 manifest 파싱 실패 → 새로 생성합니다.');
    return [];
  }
}

/**
 * manifest 저장
 * - 사람이 확인하기 좋게 pretty + trailing newline
 */
function saveManifest(data) {
  ensureDir(MANIFEST_DIR);

  // (선택) 정렬: pageId 기준으로 정렬하면 diff가 안정적입니다.
  // - pageId 형식이 page####라면 문자열 정렬도 안정적으로 동작
  const sorted = [...data].sort((a, b) => String(a.pageId || '').localeCompare(String(b.pageId || '')));

  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  console.log(`[images-manifest] 저장 완료: ${MANIFEST_FILE} (${sorted.length}개 엔트리)`);
}

/**
 * URL을 "사이트 상대 경로"로 변환
 * - 기본: SITE_BASE 또는 CDN_BASE로 시작하면 base 제거 후 path만 남김
 * - base에 안 걸리면:
 *   - 외부 도메인일 수도 있으니, 그대로 반환(나중에 추적/디버깅이 쉬움)
 */
function stripBase(url) {
  if (!url) return null;

  // 1) SITE_BASE 기준 제거
  if (url.startsWith(SITE_BASE)) return url.substring(SITE_BASE.length) || '/';

  // 2) CDN_BASE 기준 제거(미래 대비)
  if (url.startsWith(CDN_BASE)) return url.substring(CDN_BASE.length) || '/';

  // 3) 그 외는 절대 URL 그대로 유지(원천을 잃지 않음)
  return url;
}

/**
 * 첫 매치 1개 추출(단일 캡쳐 그룹)
 * - 정규식이 HTML 전체에 적용되므로, 패턴은 "최대한 좁게" 유지
 */
function extractFirstMatch(html, regex) {
  const m = html.match(regex);
  return m ? m[1] : null;
}

/**
 * canonical URL에서 slug를 추출(안정 버전)
 * - 문자열 자르기 대신 URL 파싱 후 pathname 사용
 * - 쿼리/해시/트레일링 슬래시/확장자 변형에 강함
 */
function slugFromCanonical(canonicalHref, fallbackFilename) {
  // fallback: 파일명 기반
  const fallback = path.basename(fallbackFilename).replace(/\.html$/i, '');

  if (!canonicalHref) return fallback;

  try {
    const u = new URL(canonicalHref);

    // 사이트 도메인만 신뢰(다른 도메인이면 fallback)
    // - SITE_BASE 기준 호스트 비교
    const siteHost = new URL(SITE_BASE).host;
    if (u.host !== siteHost) return fallback;

    // pathname에서 앞의 "/" 제거
    let p = u.pathname || '/';
    p = p.replace(/^\/+/, '');

    // 흔한 케이스:
    // - /slug
    // - /slug/
    // - /slug.html
    // - /posts/slug
    // => 마지막 세그먼트를 slug로 사용
    const segs = p.split('/').filter(Boolean);
    if (!segs.length) return fallback;

    let last = segs[segs.length - 1];
    last = last.replace(/\.html?$/i, ''); // .html 제거(있으면)

    return last || fallback;
  } catch {
    return fallback;
  }
}

/**
 * HTML에서 1개 엔트리 추출
 * - pageId / slug / og:image가 "필수"
 * - 없으면 null 반환 → 스킵
 */
function extractEntryFromHtml(html, filename) {
  // ─────────────────────────────────────────────
  // 1) pageId 추출(태그 종류에 의존하지 않도록 완화)
  // - id="pageId" AND data-page-id="page####" 를 가진 어떤 태그든 허용
  // ─────────────────────────────────────────────
  const pageId = extractFirstMatch(
    html,
    /<[^>]+id=["']pageId["'][^>]*data-page-id=["']([^"']+)["'][^>]*>/i
  );

  // ─────────────────────────────────────────────
  // 2) canonical → slug 추출(안정)
  // ─────────────────────────────────────────────
  const canonicalHref = extractFirstMatch(
    html,
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i
  );

  const slug = slugFromCanonical(canonicalHref, filename);

  // ─────────────────────────────────────────────
  // 3) og:image (대표 이미지)
  // ─────────────────────────────────────────────
  const ogImage = extractFirstMatch(
    html,
    /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i
  );

  // width/height(있으면 사용)
  const widthStr = extractFirstMatch(
    html,
    /<meta[^>]+property=["']og:image:width["'][^>]*content=["'](\d+)["'][^>]*>/i
  );
  const heightStr = extractFirstMatch(
    html,
    /<meta[^>]+property=["']og:image:height["'][^>]*content=["'](\d+)["'][^>]*>/i
  );
  const width = widthStr ? parseInt(widthStr, 10) : null;
  const height = heightStr ? parseInt(heightStr, 10) : null;

  // ─────────────────────────────────────────────
  // 4) ALT 추출(우선순위: hero img alt → meta description)
  // - hero alt 정규식은 구조 변동에 약하므로, 실패 시 meta description으로 fallback
  // ─────────────────────────────────────────────
  const heroAlt = extractFirstMatch(
    html,
    /<figure[^>]+class=["']post-hero["'][^>]*>[\s\S]*?<img[^>]*alt=["']([^"']*)["'][^>]*>[\s\S]*?<\/figure>/i
  );

  const metaDesc = extractFirstMatch(
    html,
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i
  );

  const alt = heroAlt || metaDesc || null;

  // ─────────────────────────────────────────────
  // 5) Freshness(updatedAt)
  // - article:modified_time 우선, 없으면 og:updated_time
  // ─────────────────────────────────────────────
  const modifiedTime =
    extractFirstMatch(
      html,
      /<meta[^>]+property=["']article:modified_time["'][^>]*content=["']([^"']+)["'][^>]*>/i
    ) ||
    extractFirstMatch(
      html,
      /<meta[^>]+property=["']og:updated_time["'][^>]*content=["']([^"']+)["'][^>]*>/i
    ) ||
    null;

  // ─────────────────────────────────────────────
  // 필수값 체크
  // - pageId / slug / og:image 중 하나라도 없으면 엔트리를 만들지 않음
  // ─────────────────────────────────────────────
  if (!pageId || !slug || !ogImage) {
    return null;
  }

  // og:image를 상대 경로로 변환(가능하면)
  const thumbnailPath = stripBase(ogImage);

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
      // 현 단계에서는 og:image와 동일하게 기록
      // - 나중에 hero와 thumbnail이 분리되면, 여기만 확장하면 됩니다.
      path: thumbnailPath,
    },
    etag: null,          // (확장용) 나중에 R2 업로드 단계에서 채울 수 있음
    updatedAt: modifiedTime,
  };
}

/**
 * upsert 정책
 * - pageId 또는 slug가 같으면 같은 포스트로 보고 갱신
 * - 기존 엔트리의 추가 필드가 있다면 최대한 유지(merge)
 */
function upsertEntry(manifest, entry) {
  const idx = manifest.findIndex((it) => it.pageId === entry.pageId || it.slug === entry.slug);
  if (idx === -1) {
    manifest.push(entry);
    return;
  }

  // 기존 값을 최대한 살려서 merge (특히 thumbnail/hero의 확장 필드 대비)
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

function main() {
  // dist/posts 없으면 실패(빌드 순서가 잘못된 것)
  if (!fs.existsSync(DIST_POSTS_DIR)) {
    console.error(`[images-manifest] dist/posts 디렉터리가 없습니다: ${DIST_POSTS_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(DIST_POSTS_DIR).filter((f) => f.toLowerCase().endsWith('.html'));
  if (!files.length) {
    console.log('[images-manifest] 처리할 HTML 파일이 없습니다.');
    process.exit(0);
  }

  let manifest = loadManifest();
  let updatedCount = 0;
  let skippedCount = 0;

  for (const file of files) {
    const fullPath = path.join(DIST_POSTS_DIR, file);
    const html = fs.readFileSync(fullPath, 'utf8');

    const entry = extractEntryFromHtml(html, file);
    if (!entry) {
      // 스킵 사유: pageId/slug/og:image 누락 또는 HTML 구조 변형
      console.warn(`[images-manifest] 스킵: pageId/slug/og:image 누락 (${file})`);
      skippedCount++;
      continue;
    }

    upsertEntry(manifest, entry);
    updatedCount++;
  }

  saveManifest(manifest);

  console.log(`[images-manifest] 갱신된 포스트 수: ${updatedCount}`);
  console.log(`[images-manifest] 스킵된 포스트 수: ${skippedCount}`);
}

if (require.main === module) {
  main();
}
