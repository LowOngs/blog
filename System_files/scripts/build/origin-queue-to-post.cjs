#!/usr/bin/env node
'use strict';

//origin-queue-to-post.cjs

require('./lib/env.cjs'); // .env 로드(있으면)

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const QUEUE_PATH = path.join(ROOT, 'dist', 'queue', 'origin-today.json');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const USED_PATH = path.join(ROOT, 'seedpool', 'origin', 'origin-used.json');

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

function writeJsonAtomic(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function resolveQueueDate(originQueue) {
  const direct = String(originQueue && originQueue.date || '').trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;

  const pickedAt = String(originQueue && originQueue.meta && originQueue.meta.pickedAt || '').trim();
  const pickedDate = pickedAt.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(pickedDate)) return pickedDate;

  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function normalizeCutoff(v) {
  const s = String(v || '').trim();
  return /^\d{2}:\d{2}$/.test(s) ? s : '10:00';
}

function resolveUpdatedIsoKst(queueDate, cutoffHHMM) {
  return `${queueDate}T${cutoffHHMM}:00+09:00`;
}

function patchExistingPostMinimum(outPath, queueDate, cutoffHHMM) {
  const post = readJsonSafe(outPath, null);
  if (!post || typeof post !== 'object') {
    return { patched: false, reason: 'no-existing-doc' };
  }

  let changed = false;

  if (!post.seedMeta || typeof post.seedMeta !== 'object') {
    post.seedMeta = {};
    changed = true;
  }

  if (!String(post.seedMeta.queueDate || '').trim()) {
    post.seedMeta.queueDate = queueDate;
    changed = true;
  }

  if (!String(post.seedMeta.cutoff || '').trim()) {
    post.seedMeta.cutoff = cutoffHHMM;
    changed = true;
  }

  if (!String(post.updated || '').trim()) {
    post.updated = resolveUpdatedIsoKst(queueDate, cutoffHHMM);
    changed = true;
  }

  if (!changed) {
    return { patched: false, reason: 'already-present' };
  }

  writeJsonAtomic(outPath, post);
  return { patched: true, reason: 'patched-operational-meta' };
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
  const queueDate = resolveQueueDate(q);
  const cutoffHHMM = normalizeCutoff(q.cutoff || '10:00');

  // ✅ main posts 축에 최대한 맞춘 최소 구조
  // - labels 배열 사용
  // - bodyPrompt 추가
  // - updated 추가
  // - pageId는 여전히 ids.cjs 책임이므로 여기서 넣지 않음
  const post = {
    slug,
    title: q.seed.title,
    labels: ['firstgate'],
    updated: resolveUpdatedIsoKst(queueDate, cutoffHHMM),

    bodyPrompt: '',
    body: '',

    description: '',
    aio: {
      tldr: q.seed.tldrHints || [],
      keyfacts: [],
      faq: [],
      sources: []
    },

    seedMeta: {
      kind: 'origin',
      label: 'firstgate',
      seedId: q.seed.seedId,
      id: q.seed.seedId,
      queueDate,
      cutoff: cutoffHHMM,
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
    const patchResult = patchExistingPostMinimum(outPath, queueDate, cutoffHHMM);
    console.log('[origin-queue-to-post] SKIP: post json already exists ->', outPath);
    console.log(`[origin-queue-to-post] patched=${patchResult.patched} reason=${patchResult.reason}`);
  } else {
    writeJson(outPath, post);
    console.log('[origin-queue-to-post] ✓ created ->', outPath);
  }

  // 사용 처리(재선정 방지) - "생성 성공/이미 존재" 모두 used 처리
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
