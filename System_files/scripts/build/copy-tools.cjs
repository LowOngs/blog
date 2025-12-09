/**
 * copy-tools.cjs
 * - 수정 요청 UI(html)를 dist/tools/로 복사하는 단순 스크립트
 * - src:  System_files/public/tools/edit-request.html
 * - dest: System_files/dist/tools/edit-request.html
 */

const fs = require('fs');
const path = require('path');

// __dirname = System_files/scripts/build
const ROOT = path.resolve(__dirname, '..', '..');

const SRC      = path.join(ROOT, 'public', 'tools', 'edit-request.html');
const DEST_DIR = path.join(ROOT, 'dist', 'tools');
const DEST     = path.join(DEST_DIR, 'edit-request.html');

// 로그 함수(선택)
function log(...args) {
  console.log('[copy-tools]', ...args);
}

(function main () {
  try {
    if (!fs.existsSync(SRC)) {
      log('SOURCE not found:', SRC);
      process.exit(0); // 실패로 안 보고 그냥 종료
    }

    fs.mkdirSync(DEST_DIR, { recursive: true });
    fs.copyFileSync(SRC, DEST);
    log('copied →', DEST);
  } catch (e) {
    console.error('[copy-tools][ERROR]', e && e.message ? e.message : e);
    process.exit(1);
  }
})();
