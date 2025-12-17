#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/r2-upload-body.cjs
 * - dist/images/body → R2 업로드
 */

const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST_BODY_DIR = path.join(ROOT, 'dist', 'images', 'body');

const R2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  }
});

async function main(){
  const files = fs.readdirSync(DIST_BODY_DIR).filter(f=>/\.(webp|jpg)$/i.test(f));
  for(const f of files){
    const Body = fs.readFileSync(path.join(DIST_BODY_DIR,f));
    await R2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_PUBLIC,
      Key: `body/${f}`,
      Body,
      ContentType: f.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
      CacheControl: 'public, max-age=31536000, immutable'
    }));
  }
}
main();
