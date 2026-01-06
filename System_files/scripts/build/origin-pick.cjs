#!/usr/bin/env node
'use strict';

require('./lib/env.cjs'); // .env 로드(있으면)

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POOL_PATH = path.join(ROOT, 'seedpool', 'origin', 'origin-pool.json');
const USED_PATH = path.join(ROOT, 'logs', 'origin-used.json');
const OUT_DIR = path.join(ROOT, 'dist', 'queue');
const OUT_PATH = path.join(OUT_DIR, 'origin-today.json');

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

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'origin';
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[origin-pick] ROOT   =', ROOT);
  console.log('[origin-pick] POOL   =', POOL_PATH);
  console.log('[origin-pick] USED   =', USED_PATH);
  console.log('[origin-pick] OUT    =', OUT_PATH);
  console.log('────────────────────────────────────────────');

  const pool = readJsonSafe(POOL_PATH, null);
  if (!pool || !Array.isArray(pool.items)) {
    console.error('[origin-pick][FATAL] origin-pool.json missing or invalid:', POOL_PATH);
    process.exit(1);
  }

  const used = readJsonSafe(USED_PATH, { usedSeedIds: [] });
  const usedSet = new Set(Array.isArray(used.usedSeedIds) ? used.usedSeedIds : []);

  // 첫 미사용 1개(과기능 방지: 랜덤/가중치 없음)
  const pick = pool.items.find(it => it && it.seedId && !usedSet.has(it.seedId));
  if (!pick) {
    console.error('[origin-pick][FATAL] No unused origin seeds left.');
    process.exit(1);
  }

  // slug 없으면 안전하게 생성
  const slug = pick.slug && String(pick.slug).trim()
    ? String(pick.slug).trim()
    : `origin-${slugify(pick.seedId)}`;

  const out = {
    meta: {
      kind: 'origin',
      pickedAt: new Date().toISOString(),
      poolVersion: pool.meta && pool.meta.version ? pool.meta.version : 1
    },
    seed: {
      seedId: pick.seedId,
      title: pick.title,
      slug,
      labelHint: pick.labelHint || '',
      intent: pick.intent || '',
      tldrHints: Array.isArray(pick.tldrHints) ? pick.tldrHints : [],
      trustClaims: Array.isArray(pick.trustClaims) ? pick.trustClaims : [],
      proofLinks: Array.isArray(pick.proofLinks) ? pick.proofLinks : []
    }
  };

  writeJson(OUT_PATH, out);
  console.log(`[origin-pick] ✓ picked seedId=${pick.seedId} slug=${slug}`);
  console.log('────────────────────────────────────────────');
}

if (require.main === module) main();
