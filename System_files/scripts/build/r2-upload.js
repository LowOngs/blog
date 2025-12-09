// google-blog/System_files/scripts/build/r2-upload.js
import 'dotenv/config';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import fg from 'fast-glob';
import fs from 'fs';
import path from 'path';

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_ENDPOINT,
  IMAGES_DIR,
} = process.env;

const root = process.cwd();
const LOCAL_IMAGES_DIR = IMAGES_DIR || 'assets/images';

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_ENDPOINT) {
  console.error('R2 환경변수(.env) 설정이 필요합니다.');
  process.exit(1);
}

const localImagesPath = path.join(root, LOCAL_IMAGES_DIR);
if (!fs.existsSync(localImagesPath)) {
  console.log(`[r2-upload] 이미지 폴더가 없습니다. (${LOCAL_IMAGES_DIR}) → 업로드할 항목 없음`);
  process.exit(0);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

function mimeGuess(name) {
  const ext = name.toLowerCase().split('.').pop();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

async function headObjectIfExists(Key) {
  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: R2_BUCKET,
        Key,
      }),
    );
    return true;
  } catch (err) {
    // 404/NotFound → 존재하지 않음
    if (err.$metadata?.httpStatusCode === 404 || err.name === 'NotFound') {
      return false;
    }
    console.warn(`[r2-upload] HeadObject 오류(${Key}):`, err.message);
    return false;
  }
}

async function uploadOne(relativePath) {
  const fullPath = path.join(root, relativePath);
  const relFromImages = path
    .relative(LOCAL_IMAGES_DIR, relativePath)
    .replace(/\\/g, '/'); // 윈도우 대비
  const key = `images/${relFromImages}`;

  const already = await headObjectIfExists(key);
  if (already) {
    console.log(`[SKIP] 이미 존재: ${key}`);
    return { uploaded: false, skipped: true };
  }

  const body = fs.readFileSync(fullPath);
  const ContentType = mimeGuess(fullPath);

  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType,
      ACL: 'public-read',
    }),
  );

  console.log(`[UP] ${relativePath} → ${key}`);
  return { uploaded: true, skipped: false };
}

async function main() {
  const pattern = path.posix.join(LOCAL_IMAGES_DIR.replace(/\\/g, '/'), '**/*.*');
  const files = await fg(pattern, {
    cwd: root,
    onlyFiles: true,
    dot: false,
  });

  if (!files.length) {
    console.log('[r2-upload] 업로드할 이미지가 없습니다.');
    return;
  }

  console.log(`[r2-upload] 대상 파일 수: ${files.length}`);
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    try {
      const result = await uploadOne(file);
      if (result.uploaded) uploaded++;
      if (result.skipped) skipped++;
    } catch (err) {
      failed++;
      console.error(`[FAIL] 업로드 실패: ${file}`, err.message);
    }
  }

  console.log('────────────────────────────────────────────');
  console.log(
    `[r2-upload] 완료: uploaded=${uploaded}, skipped=${skipped}, failed=${failed}, total=${files.length}`,
  );
  console.log('────────────────────────────────────────────');

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[r2-upload] 치명적 오류:', err);
  process.exit(1);
});
