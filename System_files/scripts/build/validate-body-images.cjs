#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/validate-body-images.cjs
 *
 * 목적:
 * - System_files/manifests/images-body-manifest.json (본문 이미지 SSOT)를 "빌드 전에" 검증
 * - 문제 있으면 즉시 실패(exit 1)로 CI에서 잡히게 만듭니다.
 *
 * 왜 필요한가:
 * - 파일명이 흔들리거나(경로 오타),
 * - items 구조가 깨지거나(키가 바뀌거나),
 * - url이 http/외부 도메인/빈값이거나,
 * - width/height가 비정상인데도 그대로 진행하면
 *   => 렌더 단계에서 “조용히 스킵”되어 원인 추적이 어렵습니다.
 *
 * 검증 범위(정책형):
 * - 파일 존재/JSON 파싱
 * - 최상위: meta, items 존재
 * - items[slug] 엔트리:
 *   - pageId(선택) / label(선택)
 *   - url(필수, https)
 *   - width/height(선택, 있으면 양수)
 *   - safe(선택, false면 경고)
 * - URL 도메인 allow:
 *   - 기본: CANONICAL_BASE host, CDN_BASE host
 *   - 추가: BODY_IMAGE_ALLOW_DOMAINS="a.com,b.com"
 *
 * 출력:
 * - [ERROR] 존재/파싱/필수필드/도메인 위반 → exit 1
 * - [WARN] safe=false, width/height 누락 등 → exit 0(경고만)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const MANIFESTS_DIR = path.join(ROOT, 'manifests');
const MANIFEST_PATH = path.join(MANIFESTS_DIR, 'images-body-manifest.json');

/* ───────────────────── 기본 유틸 ───────────────────── */

function readJsonSafe(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/* ───────────────────── 도메인 allow ───────────────────── */

function parseAllowedDomainsFromEnv(siteBase, cdnBase) {
  const list = (process.env.BODY_IMAGE_ALLOW_DOMAINS || '').trim();

  const defaults = [];
  try { defaults.push(new URL(siteBase).hostname); } catch {}
  try { defaults.push(new URL(cdnBase).hostname); } catch {}

  const envDomains = list ? list.split(',').map(s => s.trim()).filter(Boolean) : [];
  const set = new Set([...defaults, ...envDomains]);

  return Array.from(set).filter(Boolean);
}

function isAllowedImageUrl(url, allowedDomains) {
  if (!url || typeof url !== 'string') return false;

  let u;
  try { u = new URL(url); } catch { return false; }

  if (u.protocol !== 'https:') return false;

  const host = u.hostname;
  return allowedDomains.some(d => d === host || host.endsWith('.' + d));
}

/* ───────────────────── 검증 로직 ───────────────────── */

function main() {
  const siteBase = (process.env.CANONICAL_BASE || process.env.SITE_BASE || 'https://ongsblog.com').replace(/\/+$/,'');
  const cdnBase  = (process.env.CDN_BASE || (siteBase + '/images')).replace(/\/+$/,'');

  const allowedDomains = parseAllowedDomainsFromEnv(siteBase, cdnBase);

  console.log('────────────────────────────────────────────');
  console.log('[validate-body-images] ROOT         =', ROOT);
  console.log('[validate-body-images] MANIFEST     =', MANIFEST_PATH);
  console.log('[validate-body-images] SITE_BASE    =', siteBase);
  console.log('[validate-body-images] CDN_BASE     =', cdnBase);
  console.log('[validate-body-images] ALLOW_DOMAIN =', allowedDomains.join(', ') || '(none)');
  console.log('────────────────────────────────────────────');

  // 1) 파일 존재
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('[ERROR] manifest 파일이 없습니다:', MANIFEST_PATH);
    process.exit(1);
  }

  // 2) JSON 파싱
  let obj;
  try {
    obj = readJsonSafe(MANIFEST_PATH);
  } catch (e) {
    console.error('[ERROR] JSON 파싱 실패:', e.message);
    process.exit(1);
  }

  // 3) 구조 체크(meta/items)
  if (!isPlainObject(obj)) {
    console.error('[ERROR] manifest 최상위가 객체가 아닙니다.');
    process.exit(1);
  }

  if (!isPlainObject(obj.meta)) {
    console.error('[ERROR] manifest.meta 가 없습니다(또는 객체가 아님).');
    process.exit(1);
  }

  if (!isPlainObject(obj.items)) {
    console.error('[ERROR] manifest.items 가 없습니다(또는 객체가 아님).');
    process.exit(1);
  }

  const keys = Object.keys(obj.items);
  if (keys.length === 0) {
    // 빈 manifest는 “정책상 가능”하지만 운영 실수일 수 있으니 경고만
    console.warn('[WARN] manifest.items 가 비어 있습니다(이미지 삽입은 전부 skip).');
  }

  // 정책(meta.policy.maxImagesPerPost) 경고 체크(필수 아님)
  const maxImagesPerPost = obj.meta?.policy?.maxImagesPerPost;
  if (maxImagesPerPost !== undefined && Number(maxImagesPerPost) !== 1) {
    console.warn('[WARN] meta.policy.maxImagesPerPost가 1이 아닙니다:', maxImagesPerPost);
  }

  let errors = 0;
  let warns = 0;
  let checked = 0;

  for (const slug of keys) {
    const entry = obj.items[slug];
    checked++;

    // 엔트리 객체 여부
    if (!isPlainObject(entry)) {
      console.error(`[ERROR] items["${slug}"] 가 객체가 아닙니다.`);
      errors++;
      continue;
    }

    // url 필수
    const url = String(entry.url || '').trim();
    if (!url) {
      console.error(`[ERROR] items["${slug}"].url 이 비어있습니다.`);
      errors++;
      continue;
    }

    // https + 도메인 allow
    if (!isAllowedImageUrl(url, allowedDomains)) {
      console.error(`[ERROR] items["${slug}"].url 도메인/프로토콜 위반: ${url}`);
      errors++;
    }

    // width/height(선택, 있으면 양수 권장)
    if (entry.width !== undefined || entry.height !== undefined) {
      const w = Number(entry.width || 0);
      const h = Number(entry.height || 0);
      if (!(w > 0 && h > 0)) {
        console.warn(`[WARN] items["${slug}"] width/height가 비정상입니다: width=${entry.width} height=${entry.height}`);
        warns++;
      }
    } else {
      // 완전 누락도 허용하지만 경고(UX/CLS 측면)
      console.warn(`[WARN] items["${slug}"] width/height가 없습니다(권장: 넣기).`);
      warns++;
    }

    // safe=false는 “의도된 차단”일 수 있으니 경고만
    if (entry.safe === false) {
      console.warn(`[WARN] items["${slug}"].safe=false (렌더에서 삽입 스킵됩니다).`);
      warns++;
    }

    // alt 누락 경고(필수는 아님)
    const alt = String(entry.alt || '').trim();
    if (!alt) {
      console.warn(`[WARN] items["${slug}"].alt 가 비어있습니다(권장: 넣기).`);
      warns++;
    }
  }

  console.log('────────────────────────────────────────────');
  console.log(`[validate-body-images] checked=${checked} warnings=${warns} errors=${errors}`);
  console.log('────────────────────────────────────────────');

  if (errors > 0) process.exit(1);
  process.exit(0);
}

if (require.main === module) main();
