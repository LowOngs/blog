#!/usr/bin/env node
'use strict';

require('./lib/env.cjs'); // .env 로드(있으면)

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const QUEUE_PATH = path.join(ROOT, 'dist', 'queue', 'origin-today.json');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const USED_PATH = path.join(ROOT, 'logs', 'origin-used.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[origin-queue-to-post] ROOT  =', ROOT);
  console.log('[origin-queue-to-post] QUEUE =', QUEUE_PATH);
  console.log('[origin-queue-to-post] POSTS =', POSTS_DIR);
  console.log('[origin-queue-to-post] USED  =', USED_PATH);
  console.log('────────────────────────────────────────────');

  const q = readJsonSafe(QUEUE_PATH, null);
  if (!q || !q.seed || !q.seed.seedId || !q.seed.slug || !q.seed.title) {
    console.error('[origin-queue-to-post][FATAL] origin-today.json missing/invalid:', QUEUE_PATH);
    process.exit(1);
  }

  ensureDir(POSTS_DIR);

  const slug = String(q.seed.slug).trim();
  const outPath = path.join(POSTS_DIR, `${slug}.json`);

  // ✅ 최소 필드만 생성 (과기능 제거)
  // - body는 generate-body.cjs가 채우는 전제
  const post = {
    slug,
    title: q.seed.title,
    label: 'firstgate', // 명함전략 고정 (라벨 힌트는 seedMeta로 보관)
    description: '',
    body: '',
    aio: {
      tldr: q.seed.tldrHints || [],
      keyfacts: [],
      faq: [],
      sources: []
    },
    seedMeta: {
      kind: 'origin',
      seedId: q.seed.seedId,
      labelHint: q.seed.labelHint || '',
      intent: q.seed.intent || '',
      trustClaims: q.seed.trustClaims || [],
      proofLinks: q.seed.proofLinks || [],
      pickedAt: q.meta && q.meta.pickedAt ? q.meta.pickedAt : new Date().toISOString()
    }
    // pageId는 절대 여기서 넣지 않음 (ids.cjs가 책임)
  };

  // 이미 있으면 덮어쓰기 금지(사고 방지)
  if (fs.existsSync(outPath)) {
    console.log('[origin-queue-to-post] SKIP: post json already exists ->', outPath);
  } else {
    writeJson(outPath, post);
    console.log('[origin-queue-to-post] ✓ created ->', outPath);
  }

  // 사용 처리(재선정 방지) - "생성 성공/이미 존재" 모두 used 처리(오리진은 고정자산이므로)
  const used = readJsonSafe(USED_PATH, { usedSeedIds: [] });
  const arr = Array.isArray(used.usedSeedIds) ? used.usedSeedIds : [];
  if (!arr.includes(q.seed.seedId)) arr.push(q.seed.seedId);
  used.usedSeedIds = arr;
  used.updatedAt = new Date().toISOString();
  writeJson(USED_PATH, used);

  console.log(`[origin-queue-to-post] ✓ marked used seedId=${q.seed.seedId}`);
  console.log('────────────────────────────────────────────');
}

if (require.main === module) main();
