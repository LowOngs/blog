#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/images-build-body.cjs
 * - 본문 이미지 1장 생성/확보 전용 단계
 * - render는 "붙이기만" 한다 (리스크 분리)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const DIST_BODY_DIR = path.join(ROOT, 'dist', 'images', 'body');
const MANIFEST = path.join(ROOT, 'manifests', 'images-body-manifest.json');

const OPENAI_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1'; // 생성용
const IMAGE_SIZE = '800x800';
const IMAGE_FORMAT = 'webp'; // 비용/용량 절감

function ensureDir(d){ if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); }
function readJson(p){ return JSON.parse(fs.readFileSync(p,'utf8')); }
function writeJson(p,o){ fs.writeFileSync(p, JSON.stringify(o,null,2)); }
function isReviewLabel(j){
  const s=new Set([j.label,...(j.labels||[]),...(j.tags||[])].map(v=>String(v).toLowerCase()));
  return s.has('app-reviews')||s.has('device-reviews')||s.has('subscription-services');
}
function exists(p){ try{return fs.existsSync(p)&&fs.statSync(p).isFile();}catch{return false;} }

// (A) 공식 이미지 확보 훅(옵션)
// 실제로는 사전 수집/화이트리스트 파일을 여기에 연결
function tryOfficialImage({pageId,slug}){
  // 예: dist/images/body/official/{slug}.webp 가 있으면 사용
  const p = path.join(DIST_BODY_DIR,'official',`${slug}.webp`);
  if(exists(p)){
    return { path:p, alt:`Official product image for ${slug}` };
  }
  return null;
}

// (B) 생성 이미지 (DALLE/이미지 API)
async function generateImage({prompt,outPath}){
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const img = await client.images.generate({
    model: OPENAI_MODEL,
    prompt,
    size: IMAGE_SIZE
  });

  const b64 = img.data[0].b64_json;
  const buf = Buffer.from(b64,'base64');
  fs.writeFileSync(outPath, buf);
}

async function main(){
  ensureDir(DIST_BODY_DIR);
  const posts = fs.readdirSync(POSTS_DIR).filter(f=>f.endsWith('.json'));
  const manifest = exists(MANIFEST) ? readJson(MANIFEST) : {};

  for(const f of posts){
    const j = readJson(path.join(POSTS_DIR,f));
    const slug = j.slug || f.replace(/\.json$/,'');
    const pageId = j.pageId;
    if(!pageId) continue;

    const outName = `${pageId}_${slug}_800x800.${IMAGE_FORMAT}`;
    const outPath = path.join(DIST_BODY_DIR,outName);
    if(exists(outPath)) continue; // 이미 있으면 스킵

    let alt = j.title || slug;

    // 1) 리뷰 라벨: 공식 → 생성
    if(isReviewLabel(j)){
      const official = tryOfficialImage({pageId,slug});
      if(official){
        fs.copyFileSync(official.path, outPath);
        alt = official.alt;
        manifest[slug]={file:outName,alt};
        continue;
      }
    }

    // 2) 생성(타 라벨 포함)
    try{
      const prompt = isReviewLabel(j)
        ? `Product-style neutral studio photo, realistic lighting, no logos, white background`
        : `Illustrative but realistic explanatory image related to the article topic, neutral style`;
      await generateImage({prompt,outPath});
      alt = j.title || `Related image for ${slug}`;
      manifest[slug]={file:outName,alt};
    }catch{
      // 실패 시 스킵
    }
  }

  writeJson(MANIFEST, manifest);
}

main();
