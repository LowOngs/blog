#!/usr/bin/env node
'use strict';

/**
 * fill-updated-from-queuedate.cjs (manual recovery tool)
 * - content/posts/*.json에서 updated가 비어있는 항목을 채움
 * - 우선순위:
 *   1) seedMeta.queueDate (YYYY-MM-DD) -> updated: YYYY-MM-DDT00:00:00Z
 *
 * ✅ 제어 통일(옹스 룰)
 * - BODY_WRITE_MODE=local  : 로컬에서만 WRITE 허용(안전)
 * - BODY_WRITE_MODE=active : PUBLISH_MODE=enable일 때만 WRITE 허용
 * - 그 외는 DRY(로그만)
 *
 * 실행 예:
 *   BODY_WRITE_MODE=local  node .\System_files\scripts\build\fill-updated-from-queuedate.cjs  (WRITE)
 *   BODY_WRITE_MODE=active PUBLISH_MODE=enable node .\System_files\scripts\build\fill-updated-from-queuedate.cjs (WRITE)
 *   BODY_WRITE_MODE=active PUBLISH_MODE=disable node ... (DRY)
 */

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

const PUBLISH_MODE = (process.env.PUBLISH_MODE || 'disable').trim().toLowerCase(); // enable|disable
const BODY_WRITE_MODE = (process.env.BODY_WRITE_MODE || 'local').trim().toLowerCase(); // local|active

function canWrite({ bodyMode, publishMode }) {
  if (bodyMode === 'local') return true;
  if (bodyMode === 'active') return publishMode === 'enable';
  return false;
}

const CAN_WRITE = canWrite({ bodyMode: BODY_WRITE_MODE, publishMode: PUBLISH_MODE });

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
  log('BODY_WRITE_MODE =', BODY_WRITE_MODE);
  log('PUBLISH_MODE =', PUBLISH_MODE);
  log('EFFECTIVE =', CAN_WRITE ? 'WRITE' : 'DRY');

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

    if (!CAN_WRITE) {
      log(`[DRY] slug=${slug} updated -> ${newUpdated}`);
      filledSlugs.push(`${slug}(dry)`);
      continue;
    }

    data.updated = newUpdated;
    data.updatedFill = {
      source: 'seedMeta.queueDate',
      filledAt: new Date().toISOString(),
      mode: BODY_WRITE_MODE,
      publishMode: PUBLISH_MODE
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
