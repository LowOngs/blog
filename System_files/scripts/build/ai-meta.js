// System_files/scripts/build/ai-meta.js
// 역할: content/posts SSOT를 기반으로 AIO/SEO 보조 메타를 생성·보강한다.
// 주의: OG/Twitter 최종 값은 render-posts.cjs + lib/meta.cjs가 책임진다.
//       본 파일은 임의 URL/이미지를 생성하지 않는다.

'use strict';

import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';

const ROOT = path.resolve(process.cwd(), 'System_files');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

/**
 * What: AIO 보조 메타 생성
 * Why : TL;DR / KeyFacts / FAQ / Sources를 SSOT에 정규화 저장
 * I/O : READ post JSON, WRITE post JSON(meta.aio)
 * Invariants:
 *  - OG/Twitter URL/이미지 생성 금지(render/meta 모듈 책임)
 *  - slug/canonical/pageId 생성 금지
 */
function buildAio(post) {
  const title = post.title || '';
  const desc =
    post.description ||
    post.summary ||
    '';

  const tldr = post.tldr || post.aio?.tldr || [];
  const keyfacts = post.keyfacts || post.aio?.keyfacts || [];
  const faq = post.faq || post.aio?.faq || [];
  const sources = post.sources || post.aio?.sources || [];

  return {
    tldr,
    keyfacts,
    faq,
    sources,
    _note: 'AIO blocks only. OG/Twitter handled by render-posts/meta.cjs'
  };
}

/**
 * What: SEO 보조 필드 정리
 * Why : description/headline 등 텍스트 SSOT 확보
 * I/O : READ post JSON, WRITE post JSON(meta.seo)
 * Invariants:
 *  - canonical/og:image/url 생성 금지
 */
function buildSeo(post) {
  return {
    title: post.title || '',
    description: post.description || post.summary || '',
  };
}

async function main() {
  if (!fs.existsSync(POSTS_DIR)) {
    console.log('[ai-meta] POSTS_DIR 없음 → 종료');
    return;
  }

  const files = await fg([`${POSTS_DIR}/*.json`]);
  let updated = 0;

  for (const file of files) {
    const post = readJson(file);

    post.meta = post.meta || {};

    // AIO 보조 메타
    post.meta.aio = buildAio(post);

    // SEO 보조 텍스트
    post.meta.seo = buildSeo(post);

    // 안전 표식
    post.meta._generatedBy = 'ai-meta.js';
    post.meta._policy = {
      og: 'handled-by-render-posts+meta.cjs',
      twitter: 'handled-by-render-posts+meta.cjs',
      canonical: 'handled-by-render-posts+meta.cjs'
    };

    writeJson(file, post);
    console.log(`✔️ ai-meta updated → ${path.basename(file)}`);
    updated++;
  }

  console.log(`✅ ai-meta 완료 (${updated} files)`);
}

main().catch((e) => {
  console.error('[ai-meta] FAIL:', e);
  process.exit(1);
});
