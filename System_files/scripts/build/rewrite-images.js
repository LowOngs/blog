// google-blog/System_files/scripts/build/rewrite-images.js
import 'dotenv/config';
import fg from 'fast-glob';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM 환경에서 __dirname 대체
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ROOT를 항상 System_files 기준으로
const root = path.resolve(__dirname, '../..');
const POSTS_DIR = process.env.POSTS_DIR || 'content/posts';
const CDN_BASE_RAW = process.env.CDN_BASE || '';

const CDN_BASE = CDN_BASE_RAW.replace(/\/+$/, ''); // 끝 슬래시 제거

if (!CDN_BASE) {
  console.error('CDN_BASE 설정이 필요합니다(.env).');
  process.exit(1);
}

function rewriteHtml(html) {
  if (typeof html !== 'string' || !html.includes('assets/images')) return html;

  // src="./assets/images/..." 또는 src="assets/images/..." 패턴 치환
  const re = /src=(["'])\.?\/?assets\/images\/([^"']+)\1/gi;

  const rewritten = html.replace(re, (_match, quote, relPath) => {
    const cleanRel = String(relPath).replace(/^\/+/, '');
    const url = `${CDN_BASE}/${cleanRel}`;
    return `src=${quote}${url}${quote}`;
  });

  return rewritten;
}

function processPostJson(jsonPath) {
  const full = path.join(root, jsonPath);
  let raw;
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch (e) {
    console.warn(`[rewrite-images] 파일 읽기 실패: ${jsonPath}`, e.message);
    return false;
  }

  let post;
  try {
    post = JSON.parse(raw);
  } catch (e) {
    console.warn(`[rewrite-images] JSON 파싱 실패: ${jsonPath}`, e.message);
    return false;
  }

  let mutated = false;

  // 1) body 문자열
  if (typeof post.body === 'string') {
    const rewrittenBody = rewriteHtml(post.body);
    if (rewrittenBody !== post.body) {
      post.body = rewrittenBody;
      mutated = true;
    }
  }

  // 2) blocks[].html (혹시 있을 경우 대비)
  if (Array.isArray(post.blocks)) {
    for (const block of post.blocks) {
      if (block && typeof block.html === 'string') {
        const rewrittenBlock = rewriteHtml(block.html);
        if (rewrittenBlock !== block.html) {
          block.html = rewrittenBlock;
          mutated = true;
        }
      }
    }
  }

  if (!mutated) {
    return false;
  }

  fs.writeFileSync(full, JSON.stringify(post, null, 2) + '\n', 'utf8');
  return true;
}

function main() {
  const pattern = path.posix.join(POSTS_DIR.replace(/\\/g, '/'), '**/*.json');
  const files = fg.sync(pattern, {
    cwd: root,
    onlyFiles: true,
  });

  if (!files.length) {
    console.log('[rewrite-images] 대상 JSON 파일이 없습니다.');
    return;
  }

  let changed = 0;
  for (const file of files) {
    const ok = processPostJson(file);
    if (ok) changed++;
  }

  console.log(
    `[rewrite-images] 이미지 경로 치환 완료: changed=${changed}, total=${files.length}`,
  );
}

main();
