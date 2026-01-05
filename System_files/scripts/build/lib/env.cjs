'use strict';

/**
 * System_files/scripts/build/lib/env.cjs
 * - .env 로드(1회) + 공통 경로/기본 ENV 정규화
 * - CJS(require) 전용 (render-posts.cjs / r2-upload.cjs / images-build-og.cjs에서 require로 사용)
 */

const fs = require('fs');
const path = require('path');

let dotenv;
try {
  dotenv = require('dotenv');
} catch (e) {
  console.error('[env] dotenv가 필요합니다.  npm i dotenv');
  process.exit(1);
}

// System_files 루트: .../scripts/build/lib → ROOT는 ../../..
const ROOT = path.resolve(__dirname, '..', '..', '..');

// 1순위: System_files/.env, 2순위: 상위 폴더/.env, 마지막: dotenv 기본 동작
const envCandidates = [
  path.join(ROOT, '.env'),
  path.resolve(ROOT, '..', '.env'),
];

let loaded = false;
for (const p of envCandidates) {
  if (!loaded && fs.existsSync(p)) {
    dotenv.config({ path: p });
    loaded = true;
  }
}
if (!loaded) dotenv.config();

// SITE/CDN 기본값 정규화
const rawSiteBase =
  process.env.SITE_BASE ||
  process.env.CANONICAL_BASE ||
  'https://ongsblog.com';

const SITE_BASE = String(rawSiteBase).replace(/\/+$/, '');

const rawCdnBase = String(process.env.CDN_BASE || `${SITE_BASE}/images`).replace(/\/+$/, '');

const PATHS = {
  ROOT,
  POSTS_DIR: path.join(ROOT, process.env.POSTS_DIR || 'content/posts'),
  TEMPLATE_PATH: path.join(ROOT, 'templates/post.html'),
  OUTPUT_DIR: path.join(ROOT, 'dist/posts'),
};

const ENV = {
  SITE_BASE,
  CDN_BASE: rawCdnBase,
  SITE_NAME: process.env.SITE_NAME || 'Ongs Blog',
  ARTICLE_AUTHOR: process.env.ARTICLE_AUTHOR || 'Ongs',
  PUBLISHER_NAME: process.env.PUBLISHER_NAME || 'Ongs Blog',
};

module.exports = { ROOT, PATHS, ENV };
