// System_files/scripts/build/lib/env.cjs
// 목적:
//  - 프로젝트 루트(.env)를 명시적으로 로드
//  - 실행 위치(CWD)에 상관없이 process.env 보장
//  - CJS(require) 기반 스크립트 전용

'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// env.cjs 위치:
//   System_files/scripts/build/lib/env.cjs
// 프로젝트 루트:
//   C:\google-blog
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// 후보 .env 경로 (우선순위)
const ENV_CANDIDATES = [
  path.join(PROJECT_ROOT, '.env'),          // C:\google-blog\.env  ← 정석
  path.join(PROJECT_ROOT, 'System_files', '.env'),
];

// 실제 로드
let loadedPath = null;
for (const p of ENV_CANDIDATES) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    loadedPath = p;
    break;
  }
}

// fallback (OS env만 사용)
if (!loadedPath) {
  dotenv.config();
}

// 로그는 한 번만 (중복 require 대비)
if (!global.__ONGS_ENV_LOADED__) {
  global.__ONGS_ENV_LOADED__ = true;

  console.log('[env] loaded =', loadedPath || '(process.env only)');
  console.log('[env] SITE_BASE =', process.env.SITE_BASE || process.env.CANONICAL_BASE || '(default)');
  console.log('[env] CDN_BASE  =', process.env.CDN_BASE || '(default)');
}

// export는 최소한만 (필요 시 사용)
module.exports = {
  PROJECT_ROOT,
  ENV_PATH: loadedPath,
};
