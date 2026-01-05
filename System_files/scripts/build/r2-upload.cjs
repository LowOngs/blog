// System_files/scripts/build/r2-upload.cjs
// 역할:
//  - dist/images/og, dist/images/body 폴더의 이미지를 Cloudflare R2에 업로드
//  - 업로드 경로는 "images/og/*", "images/body/*" 로 고정 (루트 drift 방지)
//  - DRY_RUN=true면 업로드 대신 로그만 출력

require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let S3Client, PutObjectCommand;
try {
  ({ S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'));
} catch (e) {
  console.error('[r2-upload] @aws-sdk/client-s3 가 필요합니다.');
  console.error('  repo root에서: npm i @aws-sdk/client-s3');
  process.exit(1);
}

// ✅ ROOT = System_files
const ROOT = path.resolve(__dirname, '..', '..'); // .../System_files

// ✅ dist/images/* 기준
const DIST_IMAGES = path.join(ROOT, 'dist', 'images');
const OG_DIR = path.join(DIST_IMAGES, 'og');
const BODY_DIR = path.join(DIST_IMAGES, 'body');

// ✅ env
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;

// 버킷 키 이름이 혼재할 수 있어 둘 다 지원
const R2_BUCKET =
  process.env.R2_BUCKET_PUBLIC ||
  process.env.R2_BUCKET ||
  process.env.R2_BUCKET_NAME;

const R2_ENDPOINT =
  process.env.R2_ENDPOINT ||
  (R2_ACCOUNT_ID
    ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
    : '');

const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';

// ✅ “원래대로” 고정: 항상 images 하위로 업로드
// (R2_PREFIX가 비거나 다른 값이어도 업로드 경로는 images/*로 간다)
const FIXED_PREFIX = 'images';

// 옵션: Cache-Control
const CACHE_CONTROL =
  process.env.CACHE_CONTROL || 'public, max-age=31536000, immutable';

function fatal(msg) {
  console.error(`[r2-upload][FATAL] ${msg}`);
  process.exit(1);
}

function sha12(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

function listJpgFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.jpg') || f.toLowerCase().endsWith('.jpeg') || f.toLowerCase().endsWith('.webp') || f.toLowerCase().endsWith('.png'))
    .sort();
}

async function putObject(client, bucket, key, body, contentType) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: CACHE_CONTROL,
    })
  );
}

function contentTypeByExt(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

async function main() {
  if (!R2_ACCOUNT_ID) fatal('R2_ACCOUNT_ID 가 없습니다.');
  if (!R2_ACCESS_KEY_ID) fatal('R2_ACCESS_KEY_ID 가 없습니다.');
  if (!R2_SECRET_ACCESS_KEY) fatal('R2_SECRET_ACCESS_KEY 가 없습니다.');
  if (!R2_BUCKET) fatal('R2_BUCKET (또는 R2_BUCKET_PUBLIC) 가 없습니다.');
  if (!R2_ENDPOINT) fatal('R2_ENDPOINT 를 만들 수 없습니다.');

  console.log('────────────────────────────────────────────');
  console.log('[r2-upload] endpoint =', R2_ENDPOINT);
  console.log('[r2-upload] bucket   =', R2_BUCKET);
  console.log('[r2-upload] prefix   =', FIXED_PREFIX);
  console.log('[r2-upload] dry_run  =', DRY_RUN);
  console.log('[r2-upload] og_dir   =', OG_DIR);
  console.log('[r2-upload] body_dir =', BODY_DIR);
  console.log('────────────────────────────────────────────');

  const client = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  const ogFiles = listJpgFiles(OG_DIR);
  const bodyFiles = listJpgFiles(BODY_DIR);

  let ok = 0;
  let fail = 0;

  // ✅ OG 업로드: images/og/*
  for (const name of ogFiles) {
    const filePath = path.join(OG_DIR, name);
    const buf = fs.readFileSync(filePath);
    const sha = sha12(buf);
    const key = `${FIXED_PREFIX}/og/${name}`;
    const ct = contentTypeByExt(name);

    if (DRY_RUN) {
      console.log(
        `[r2-upload][DRY] og  ${name}  ->  s3://${R2_BUCKET}/${key}  (${ct}, sha=${sha})`
      );
      ok++;
      continue;
    }

    try {
      await putObject(client, R2_BUCKET, key, buf, ct);
      console.log(`[r2-upload] OK  og  ${name}  ->  ${key}  (sha=${sha})`);
      ok++;
    } catch (e) {
      console.error(`[r2-upload] FAIL og  ${name}  ->  ${key}`);
      console.error(e && e.message ? e.message : e);
      fail++;
    }
  }

  // ✅ BODY 업로드: images/body/*
  for (const name of bodyFiles) {
    const filePath = path.join(BODY_DIR, name);
    const buf = fs.readFileSync(filePath);
    const sha = sha12(buf);
    const key = `${FIXED_PREFIX}/body/${name}`;
    const ct = contentTypeByExt(name);

    if (DRY_RUN) {
      console.log(
        `[r2-upload][DRY] body ${name}  ->  s3://${R2_BUCKET}/${key}  (${ct}, sha=${sha})`
      );
      ok++;
      continue;
    }

    try {
      await putObject(client, R2_BUCKET, key, buf, ct);
      console.log(`[r2-upload] OK  body ${name}  ->  ${key}  (sha=${sha})`);
      ok++;
    } catch (e) {
      console.error(`[r2-upload] FAIL body ${name}  ->  ${key}`);
      console.error(e && e.message ? e.message : e);
      fail++;
    }
  }

  console.log('────────────────────────────────────────────');
  console.log(`[r2-upload] done: ok=${ok}, fail=${fail}, total=${ok + fail}`);
  console.log('────────────────────────────────────────────');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('────────────────────────────────────────────');
  console.error('[r2-upload] FATAL ERROR');
  console.error(e && e.stack ? e.stack : e);
  console.error('────────────────────────────────────────────');
  process.exit(1);
});
