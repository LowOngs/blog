#!/usr/bin/env node
'use strict';

/**
 * fill-updated-from-queuedate.cjs
 * - content/posts/*.json에서 updated가 비어있는 항목을 채움
 * - 우선순위:
 *   1) seedMeta.queueDate (YYYY-MM-DD) -> updated: YYYY-MM-DDT00:00:00Z
 * - SCHEDULE_MODE:
 *   - live: 실제 저장
 *   - test: DRY-RUN (로그만)
 *
 * 실행:
 *   C:\google-blog> $env:SCHEDULE_MODE="test"; node .\System_files\scripts\build\fill-updated-from-queuedate.cjs
 *   C:\google-blog> $env:SCHEDULE_MODE="live"; node .\System_files\scripts\build\fill-updated-from-queuedate.cjs
 */

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

const SCHEDULE_MODE = process.env.SCHEDULE_MODE || 'test';
const IS_LIVE = SCHEDULE_MODE === 'live';

function log(...a) { console.log('[fill-updated]', ...a); }
function warn(...a) { console.warn('[fill-updated][WARN]', ...a); }

function readJsonSafe(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    warn('JSON parse failed:', p, e.message);
    return null;
  }
}

function writeJsonSafe(p, data) {
  const pretty = JSON.stringify(data, null, 2);
  fs.writeFileSync(p, pretty + '\n', 'utf8');
}

function isValidQueueDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

function makeUpdatedFromQueueDate(queueDate) {
  const d = queueDate.trim();
  return `${d}T00:00:00Z`;
}

function hasUpdated(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function main() {
  log('ROOT =', ROOT);
  log('POSTS =', POSTS_DIR);
  log('SCHEDULE_MODE =', SCHEDULE_MODE, IS_LIVE ? '(LIVE)' : '(DRY-RUN)');

  if (!fs.existsSync(POSTS_DIR)) {
    warn('content/posts 폴더가 없습니다.');
    process.exit(0);
  }

  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'));
  log('JSON files =', files.length);

  let targets = 0;
  let updatedFilled = 0;
  let updatedSkippedNoQueueDate = 0;
  const filledSlugs = [];
  const missingQueueDateSlugs = [];

  for (const f of files) {
    const p = path.join(POSTS_DIR, f);
    const data = readJsonSafe(p);
    if (!data) continue;

    const slug = data.slug || path.basename(f, '.json');

    if (hasUpdated(data.updated)) continue;

    targets += 1;

    const qd = data.seedMeta && data.seedMeta.queueDate;
    if (!isValidQueueDate(qd)) {
      updatedSkippedNoQueueDate += 1;
      missingQueueDateSlugs.push(slug);
      continue;
    }

    const newUpdated = makeUpdatedFromQueueDate(qd);

    if (!IS_LIVE) {
      log(`[DRY-RUN] slug=${slug} updated -> ${newUpdated}`);
      filledSlugs.push(`${slug}(dry-run)`);
      continue;
    }

    data.updated = newUpdated;
    data.updatedFill = {
      source: 'seedMeta.queueDate',
      filledAt: new Date().toISOString()
    };

    writeJsonSafe(p, data);
    updatedFilled += 1;
    filledSlugs.push(slug);
    log(`[OK] slug=${slug} updated filled -> ${newUpdated}`);
  }

  log('done:', `targets=${targets}`, `filled=${updatedFilled}`, `skippedNoQueueDate=${updatedSkippedNoQueueDate}`);
  if (filledSlugs.length) log('FILLED slugs:', filledSlugs.join(', '));
  if (missingQueueDateSlugs.length) log('NO_queueDate slugs:', missingQueueDateSlugs.join(', '));
}

main();
