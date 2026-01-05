// System_files/scripts/build/lib/env.cjs
// CommonJS 고정: 모든 .cjs 스크립트에서 require()로 안정 로드

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// System_files 루트
const ROOT = path.resolve(__dirname, '../../');

// 1순위: System_files/.env, 2순위: 상위 폴더/.env, 마지막: dotenv 기본
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
if (!loaded) {
  dotenv.config();
}

const PATHS = {
  ROOT,
  POSTS_DIR: path.join(ROOT, process.env.POSTS_DIR || 'content/posts'),
  TEMPLATE_PATH: path.join(ROOT, 'templates/post.html'),
  OUTPUT_DIR: path.join(ROOT, 'dist/posts'),
};

// SITE/CDN 기본값 정규화
const rawSiteBase =
  process.env.SITE_BASE ||
  process.env.CANONICAL_BASE ||
  'https://ongsblog.com';

const SITE_BASE = String(rawSiteBase).replace(/\/+$/, '');

const rawCdnBase = String(process.env.CDN_BASE || `${SITE_BASE}/images`).replace(/\/+$/, '');

const ENV = {
  SITE_BASE,
  CDN_BASE: rawCdnBase,
  SITE_NAME: process.env.SITE_NAME || 'Ongs Blog',
  ARTICLE_AUTHOR: process.env.ARTICLE_AUTHOR || 'Ongs',
  PUBLISHER_NAME: process.env.PUBLISHER_NAME || 'Ongs Blog',
};

module.exports = { PATHS, ENV };
