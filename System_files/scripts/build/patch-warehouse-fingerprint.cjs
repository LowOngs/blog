#!/usr/bin/env node
'use strict';

/**
 * ============================================================
 * System_files/scripts/build/patch-warehouse-fingerprint.cjs
 * ============================================================
 *
 * 목적:
 * - warehouse seed 중 fingerprint가 없는 항목에 fingerprint를 생성해 주입
 *
 * 대상:
 * - seedpool/warehouse/trend/*.json
 * - seedpool/warehouse/evergreen/*.json
 *
 * 규칙:
 * - 기존 fingerprint 존재하면 절대 변경하지 않음
 * - fingerprint 없는 seed만 생성
 * - JSON 구조/정렬 절대 변경하지 않음
 * - 파일은 atomic write
 *
 * 1회 실행 후 종료.
 */

const fs = require('fs');
const path = require('path');

const fpUtil = require('./lib/fingerprint.cjs');

const ROOT = path.resolve(__dirname, '..', '..');

const WAREHOUSE_DIR = path.join(ROOT, 'seedpool', 'warehouse');
const TREND_DIR = path.join(WAREHOUSE_DIR, 'trend');
const EVERGREEN_DIR = path.join(WAREHOUSE_DIR, 'evergreen');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function patchFile(file, mode) {
  const data = readJson(file);

  const arr = data[mode] || [];
  let patched = 0;

  for (const seed of arr) {

    if (!seed) continue;

    const fp = String(seed.fingerprint || '').trim();

    if (fp) continue;

    try {

      const newFp = fpUtil.buildFingerprintFromSeed(seed);

      if (!newFp) continue;

      seed.fingerprint = newFp;

      patched++;

    } catch (err) {

      console.warn(
        '[fingerprint][skip]',
        file,
        seed.id,
        err.message
      );

    }

  }

  if (patched > 0) {

    writeJsonAtomic(file, data);

  }

  return patched;
}

function scanDir(dir, mode) {

  if (!fs.existsSync(dir)) return 0;

  const files = fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.json'));

  let total = 0;

  for (const f of files) {

    const full = path.join(dir, f);

    const n = patchFile(full, mode);

    console.log(`[patch] ${f} patched=${n}`);

    total += n;

  }

  return total;
}

function main() {

  console.log('[patch-warehouse-fingerprint] start');

  const trend = scanDir(TREND_DIR, 'trend');
  const evergreen = scanDir(EVERGREEN_DIR, 'evergreen');

  console.log('-------------------------------------');
  console.log('trend patched     =', trend);
  console.log('evergreen patched =', evergreen);
  console.log('TOTAL patched     =', trend + evergreen);
  console.log('done');

}

main();
