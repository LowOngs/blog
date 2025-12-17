#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/r2-upload.js
 * - dist/images/og/* + dist/images/body/* 를 Cloudflare R2로 업로드
 * - R2 object key:
 *    og/<filename>
 *    body/<filename>
 *
 * 필수 ENV:
 *  - R2_ACCOUNT_ID
 *  - R2_ACCESS_KEY_ID
 *  - R2_SECRET_ACCESS_KEY
 *  - R2_BUCKET_PUBLIC   (또는 R2_BUCKET)
 *
 * 선택 ENV:
 *  - DRY_RUN=true            업로드 없이 로그만
 *  - R2_PREFIX=              기본 '' (예: 'images'로 두면 images/og/... 형태)
 *  - CACHE_CONTROL=          기본 'public, max-age=31536000, immutable'
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let S3Client, PutObjectCommand;
try {
  ({ S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'));
} catch (e) {
  console.error('[r2-upload] @aws-sdk/client-s3 가 필요합니다.');
  console.error('  npm i @aws-sdk/client-s3');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const DIST_IMAGES = path.join(ROOT, 'dist', 'images');
const OG_DIR = path.join(DIST_IMAGES, 'og');
const BODY_DIR = path.join(DIST_IMAGES, 'body');

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_PUBLIC,
  R2_BUCKET,
  R2_PREFIX,
  DRY_RUN,
  CACHE_CONTROL,
} = process.env;

const BUCKET = R2_BUCKET_PUBLIC || R2_BUCKET;

function die(msg) {
  console.error('[r2-upload][FATAL]', msg);
  process.exit(1);
}

if (!R2_ACCOUNT_ID) die('R2_ACCOUNT_ID 가 없습니다.');
if (!R2_ACCESS_KEY_ID) die('R2_ACCESS_KEY_ID 가 없습니다.');
if (!R2_SECRET_ACCESS_KEY) die('R2_SECRET_ACCESS_KEY 가 없습니다.');
if (!BUCKET) die('R2_BUCKET_PUBLIC (또는 R2_BUCKET) 가 없습니다.');

const isDryRun = String(DRY_RUN || '').toLowerCase() === 'true';
const prefix = (R2_PREFIX || '').replace(/^\/+|\/+$/g, ''); // 'images' 같은 prefix를 허용
const cacheControl = CACHE_CONTROL || 'public, max-age=31536000, immutable';

const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const s3 = new S3Client({
  region: 'auto',
  endpoint,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

function existsDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listFilesFlat(dir) {
  if (!existsDir(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

function contentTypeByExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.avif') return 'image/avif';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function makeKey(group, filename) {
  // group: 'og' | 'body'
  const base = `${group}/${filename}`.replace(/\\/g, '/');
  return prefix ? `${prefix}/${base}` : base;
}

function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

async function uploadOne({ filePath, group }) {
  const filename = path.basename(filePath);
  const key = makeKey(group, filename);
  const body = fs.readFileSync(filePath);
  const ct = contentTypeByExt(filePath);

  // 업로드 전 해시(로깅/디버그용, R2 ETag와 1:1 일치 보장은 아님)
  const hash = sha256File(filePath).slice(0, 12);

  if (isDryRun) {
    console.log(`[r2-upload][DRY] ${group}  ${filename}  ->  s3://${BUCKET}/${key}  (${ct}, sha=${hash})`);
    return { key, hash, skipped: true };
  }

  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: ct,
    CacheControl: cacheControl,
  });

  // 재시도(최대 3회, 간단 백오프)
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await s3.send(cmd);
      console.log(`[r2-upload] OK  ${group}  ${filename}  ->  ${key}  (sha=${hash})`);
      return { key, hash, skipped: false };
    } catch (e) {
      lastErr = e;
      const waitMs = 250 * attempt * attempt;
      console.warn(`[r2-upload] RETRY ${attempt}/3  ${filename}  (${waitMs}ms)  err=${e && e.message ? e.message : e}`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  throw lastErr || new Error('upload failed');
}

async function run() {
  console.log('────────────────────────────────────────────');
  console.log('[r2-upload] endpoint =', endpoint);
  console.log('[r2-upload] bucket   =', BUCKET);
  console.log('[r2-upload] prefix   =', prefix || '(none)');
  console.log('[r2-upload] dry_run  =', isDryRun);
  console.log('[r2-upload] og_dir   =', OG_DIR);
  console.log('[r2-upload] body_dir =', BODY_DIR);

  const ogFiles = listFilesFlat(OG_DIR);
  const bodyFiles = listFilesFlat(BODY_DIR);

  const tasks = [];
  for (const f of ogFiles) tasks.push({ filePath: f, group: 'og' });
  for (const f of bodyFiles) tasks.push({ filePath: f, group: 'body' });

  if (!tasks.length) {
    console.log('[r2-upload] 업로드 대상이 없습니다. (dist/images/og 또는 dist/images/body 비어있음)');
    return;
  }

  let ok = 0, fail = 0;

  // 과도한 동시 업로드로 실패하는 경우가 있어서 "순차"가 제일 안전합니다.
  for (const t of tasks) {
    try {
      await uploadOne(t);
      ok++;
    } catch (e) {
      fail++;
      console.error(`[r2-upload][FAIL] ${t.group} ${path.basename(t.filePath)} ->`, e && e.message ? e.message : e);
    }
  }

  console.log('────────────────────────────────────────────');
  console.log(`[r2-upload] done: ok=${ok}, fail=${fail}, total=${tasks.length}`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => {
  console.error('[r2-upload][FATAL]', e && e.message ? e.message : e);
  process.exit(1);
});
