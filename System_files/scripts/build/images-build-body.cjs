
#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/images-build-body.cjs
 *
 * 목적:
 * - 본문 관련 이미지 1장을 "안전하게" 준비하고 posts JSON에 bodyImageUrl/bodyImageAlt를 채운다.
 *
 * 안전 원칙(중요):
 * 1) 웹에서 임의 이미지 서칭/스크래핑 금지.
 * 2) "공식 이미지"는 오직 post.json에 사용자가 명시한 URL만 허용 + 도메인 allowlist 통과해야만 사용.
 * 3) 그 외는 OpenAI 이미지 생성(=저작권/출처 불명 실사 사진 사용 위험 제거).
 *
 * 동작 개요:
 * - 대상: content/posts/*.json
 * - 조건:
 *   - review 라벨(app-reviews/device-reviews/subscription-services): 공식 URL 있으면 우선 사용(allowlist), 없으면 생성
 *   - 그 외 라벨: 생성만
 * - 실패 시: 해당 포스트는 bodyImageUrl을 건드리지 않고 스킵(로그만)
 *
 * 산출:
 * - 로컬 파일: dist/images/body/{pageId}_{slug}_body_1200w.webp (및 .jpg 선택)
 * - posts JSON 업데이트:
 *   - bodyImageUrl: CDN_BASE + /body/{file}.webp (업로드는 별도 업로더 단계에서 수행)
 *   - bodyImageAlt: 짧고 사실적인 ALT
 *
 * 필요 환경변수:
 * - CANONICAL_BASE (기본 https://ongsblog.com)
 * - CDN_BASE       (기본 https://ongsblog.com/images)
 * - OPENAI_API_KEY (생성 모드에서 필요)
 *
 * 옵션 환경변수:
 * - DRY_RUN=true              : 파일/JSON 쓰기 없이 로그만
 * - BODY_IMAGE_MAX_WIDTH=1200 : 가로 최대(px)
 * - BODY_IMAGE_FORMAT=webp    : webp/jpg (기본 webp)
 * - OFFICIAL_IMAGE_ALLOWLIST  : 쉼표 구분 도메인(예: apple.com,sony.com,samsung.com)
 * - OPENAI_IMAGE_MODEL        : 예: gpt-image-1 (환경에 맞게)
 * - OPENAI_IMAGE_ENDPOINT     : 기본 https://api.openai.com/v1/images
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let sharp = null;
try { sharp = require('sharp'); } catch (_) { sharp = null; }

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const OUT_DIR = path.join(ROOT, 'dist', 'images', 'body');

const CANONICAL_BASE = (process.env.CANONICAL_BASE || process.env.SITE_BASE || 'https://ongsblog.com').replace(/\/+$/,'');
const CDN_BASE = (process.env.CDN_BASE || `${CANONICAL_BASE}/images`).replace(/\/+$/,'');

const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

const MAX_W = parseInt(process.env.BODY_IMAGE_MAX_WIDTH || '1200', 10) || 1200;
const FORMAT = String(process.env.BODY_IMAGE_FORMAT || 'webp').toLowerCase() === 'jpg' ? 'jpg' : 'webp';

const REVIEW_LABELS = new Set(['app-reviews','device-reviews','subscription-services']);

const OFFICIAL_ALLOWLIST = String(process.env.OFFICIAL_IMAGE_ALLOWLIST || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_IMAGE_MODEL || ''; // 비워도 동작(엔드포인트 기본 모델 사용)
const OPENAI_ENDPOINT = process.env.OPENAI_IMAGE_ENDPOINT || 'https://api.openai.com/v1/images';

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json')).map(f => path.join(dir, f));
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function isValidPageId(v) {
  return typeof v === 'string' && /^page\d{6}$/.test(v);
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    return v;
  }
  return '';
}

function safeSlugFromPath(jsonPath) {
  return path.basename(jsonPath, '.json');
}

function getLabel(post) {
  return String(firstNonEmpty(post.label, post.mainLabel, post.category, '') || '').trim();
}

function alreadyHasBodyImage(post) {
  const url = String(firstNonEmpty(post.bodyImageUrl, post.bodyImage, post.aio && post.aio.bodyImageUrl, post.aio && post.aio.bodyImage, '') || '').trim();
  return !!url;
}

function buildAlt(post) {
  const label = getLabel(post);
  const product = firstNonEmpty(post.productName, post.product, post.appName, post.serviceName, '');
  const title = firstNonEmpty(post.title, '');
  if (REVIEW_LABELS.has(label) && product) return `${String(product).trim()} product image`;
  if (title) return `${String(title).trim()} image`;
  return 'Article image';
}

function fileBaseName(post, slug) {
  const pid = isValidPageId(post.pageId) ? post.pageId : 'page000000';
  // 충돌 방지: slug + pageId 기반
  return `${pid}_${slug}_body_${MAX_W}w`;
}

function isHttpsUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:';
  } catch {
    return false;
  }
}

function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function inAllowlist(host) {
  if (!OFFICIAL_ALLOWLIST.length) return false; // allowlist 비어있으면 공식 이미지 사용 자체를 꺼둔 것
  return OFFICIAL_ALLOWLIST.some(d => host === d || host.endsWith(`.${d}`));
}

/**
 * post.json에 명시된 "공식 이미지 URL"만 허용
 * - keys: officialImageUrl, assets.officialImageUrl
 * - https + allowlist 필수
 */
function pickOfficialImageUrlIfAllowed(post) {
  const label = getLabel(post);
  if (!REVIEW_LABELS.has(label)) return ''; // 리뷰 라벨에서만 공식 이미지 허용

  const u = String(firstNonEmpty(post.officialImageUrl, post.assets && post.assets.officialImageUrl, '') || '').trim();
  if (!u) return '';
  if (!isHttpsUrl(u)) return '';

  const host = hostOf(u);
  if (!inAllowlist(host)) return '';

  return u;
}

/**
 * 공식 이미지 다운로드(명시된 URL만)
 * - 임의 서칭/추측/스크래핑 없음
 */
async function downloadImageToBuffer(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`official image fetch failed: ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

async function normalizeAndSaveImage(buf, outBasePathNoExt) {
  if (!sharp) throw new Error('sharp not installed (cannot normalize images)');

  // 원본이 너무 커도 MAX_W로 제한
  const img = sharp(buf, { failOnError: false }).rotate();

  const meta = await img.metadata();
  const w = meta && meta.width ? meta.width : null;

  const pipeline = (w && w > MAX_W) ? img.resize({ width: MAX_W }) : img;

  if (FORMAT === 'jpg') {
    const outPath = outBasePathNoExt + '.jpg';
    const out = await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    if (!DRY_RUN) fs.writeFileSync(outPath, out);
    return { outPath, ext: 'jpg', bytes: out.length, hash: sha1(out) };
  } else {
    const outPath = outBasePathNoExt + '.webp';
    const out = await pipeline.webp({ quality: 82 }).toBuffer();
    if (!DRY_RUN) fs.writeFileSync(outPath, out);
    return { outPath, ext: 'webp', bytes: out.length, hash: sha1(out) };
  }
}

/**
 * OpenAI 이미지 생성
 * - 모델/엔드포인트는 환경에 맞게 지정 가능하게 둠
 */
async function generateImageBufferWithOpenAI(prompt) {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY missing');

  const body = {
    prompt,
    // 일부 환경은 model 필드가 필요/불필요할 수 있어 optional 처리
    ...(OPENAI_MODEL ? { model: OPENAI_MODEL } : {}),
    // 사이즈 힌트(실제 지원은 모델/엔드포인트에 따라 다름)
    size: '1024x1024'
  };

  const res = await fetch(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text().catch(()=> '');
    throw new Error(`OpenAI image gen failed: ${res.status} ${txt.slice(0,200)}`);
  }

  const data = await res.json();

  // 응답 형태는 환경에 따라 다를 수 있어 방어적으로 처리
  // 1) data.data[0].b64_json
  // 2) data.data[0].url (이 경우 추가 fetch 필요)
  const item = data && data.data && data.data[0] ? data.data[0] : null;
  if (!item) throw new Error('OpenAI image gen: empty response');

  if (item.b64_json) {
    return Buffer.from(item.b64_json, 'base64');
  }

  if (item.url) {
    const r2 = await fetch(item.url);
    if (!r2.ok) throw new Error(`OpenAI image url fetch failed: ${r2.status}`);
    const ab = await r2.arrayBuffer();
    return Buffer.from(ab);
  }

  throw new Error('OpenAI image gen: unsupported response shape');
}

function buildPrompt(post) {
  const label = getLabel(post);
  const title = String(firstNonEmpty(post.title, '') || '').trim();
  const product = String(firstNonEmpty(post.productName, post.product, post.appName, post.serviceName, '') || '').trim();

  // “실사처럼 보이는 생성”은 OK. 다만 로고/상표 복제는 피하는 톤으로 안전하게.
  if (REVIEW_LABELS.has(label) && product) {
    return [
      `Create a clean, realistic product-style image for "${product}".`,
      `No brand logos, no trademarks, no text on the image.`,
      `Neutral background, high clarity, looks like a studio product photo.`,
      `This image will be used as an illustrative body image for a review article.`
    ].join(' ');
  }

  return [
    `Create a clean, realistic illustrative image that matches this article topic: "${title}".`,
    `No logos, no trademarks, no text.`,
    `Neutral, minimal, blog-friendly.`
  ].join(' ');
}

function buildCdnUrlForSavedFile(savedFilename) {
  // body 폴더 업로드를 전제로 경로 고정
  return `${CDN_BASE}/body/${savedFilename}`;
}

async function processOne(jsonPath) {
  const slug = safeSlugFromPath(jsonPath);
  const post = readJson(jsonPath);

  // pageId는 있어야 이상적(없어도 파일은 생성하되 이름은 page000000로 떨어짐)
  const pageId = isValidPageId(post.pageId) ? post.pageId : '';

  // 이미 있으면 스킵
  if (alreadyHasBodyImage(post)) {
    return { slug, pageId, status: 'SKIP_ALREADY', reason: 'already has bodyImageUrl' };
  }

  // 본문이 비어 있으면 스킵(난잡 방지)
  const body = String(post.body || '').trim();
  if (!body) {
    return { slug, pageId, status: 'SKIP_EMPTY_BODY', reason: 'body is empty' };
  }

  const label = getLabel(post);

  // 타 라벨: 생성만
  const officialUrl = pickOfficialImageUrlIfAllowed(post);

  ensureDir(OUT_DIR);
  const base = fileBaseName(post, slug);
  const outBase = path.join(OUT_DIR, base);

  let buf = null;
  let mode = '';

  try {
    if (officialUrl) {
      buf = await downloadImageToBuffer(officialUrl);
      mode = 'official';
    } else {
      const prompt = buildPrompt(post);
      buf = await generateImageBufferWithOpenAI(prompt);
      mode = 'generated';
    }

    const saved = await normalizeAndSaveImage(buf, outBase);
    const savedFilename = path.basename(saved.outPath);

    // URL/ALT 주입
    const url = buildCdnUrlForSavedFile(savedFilename);
    const alt = buildAlt(post);

    post.bodyImageUrl = url;
    post.bodyImageAlt = alt;
    post.bodyImageMeta = {
      mode,
      sourceUrl: officialUrl || '',
      file: savedFilename,
      bytes: saved.bytes,
      hash: saved.hash,
      updatedAt: new Date().toISOString()
    };

    if (!DRY_RUN) writeJson(jsonPath, post);

    return { slug, pageId, status: 'OK', mode, file: savedFilename, url, bytes: saved.bytes };
  } catch (e) {
    // 실패 시 자동 스킵(포스트는 건드리지 않음)
    return { slug, pageId, status: 'FAIL_SKIP', error: e && e.message ? e.message : String(e) };
  }
}

async function main() {
  console.log('────────────────────────────────────────────');
  console.log('[images-build-body] POSTS_DIR =', POSTS_DIR);
  console.log('[images-build-body] OUT_DIR   =', OUT_DIR);
  console.log('[images-build-body] CDN_BASE  =', CDN_BASE);
  console.log('[images-build-body] FORMAT    =', FORMAT, `maxW=${MAX_W}`);
  console.log('[images-build-body] DRY_RUN   =', DRY_RUN);
  console.log('[images-build-body] OFFICIAL_ALLOWLIST =', OFFICIAL_ALLOWLIST.length ? OFFICIAL_ALLOWLIST.join(',') : '(disabled)');

  const files = listJsonFiles(POSTS_DIR);
  if (!files.length) {
    console.log('[images-build-body] 대상 JSON 없음 → 종료');
    return;
  }

  let ok = 0, skip = 0, fail = 0;
  const results = [];

  for (const p of files) {
    const r = await processOne(p);
    results.push(r);

    if (r.status === 'OK') {
      ok++;
      console.log(`OK   ${r.slug} → ${r.mode} ${r.file} (${r.bytes} bytes)`);
    } else if (r.status.startsWith('SKIP')) {
      skip++;
      console.log(`SKIP ${r.slug} → ${r.reason}`);
    } else {
      fail++;
      console.log(`FAIL ${r.slug} → ${r.error}`);
    }
  }

  console.log('────────────────────────────────────────────');
  console.log(`[images-build-body] done: OK=${ok}, SKIP=${skip}, FAIL=${fail}, TOTAL=${files.length}`);

  // FAIL이 있어도 전체 빌드 중단은 하지 않음(요구사항: 실패 시 자동 스킵)
  // 다만 원하시면 "리뷰 라벨은 FAIL이면 빌드 중단" 옵션을 다음 버전에 추가할 수 있습니다.
}

main().catch((e) => {
  console.error('[images-build-body] fatal:', e && e.message ? e.message : e);
  process.exit(1);
});
