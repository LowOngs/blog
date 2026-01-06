#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/ids.cjs
 *
 * ✅ 원칙
 * - pageId 발급(+1) / 할당은 오직 이 파일(ids.cjs)만 담당
 * - "publishable" 대상만 발급: dist/queue/today.json 기준
 *
 * ✅ 안전장치
 * - BODY_WRITE_MODE=active + PUBLISH_MODE=disable => 0회 종료(이력 보존)
 * - publishable 목록이 없으면 => 0회 종료(폭주 방지)
 */

const fs = require('fs');
const path = require('path');

require('./lib/env.cjs'); // ✅ .env 로딩 (R2/PUBLISH/BODY_WRITE 등)

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const MANIFESTS_DIR = path.join(ROOT, 'manifests');

// publishable(스케줄 결과)
const TODAY_QUEUE = path.join(ROOT, 'dist', 'queue', 'today.json');

const PUBLISH_MODE = (process.env.PUBLISH_MODE || 'disable').toLowerCase(); // enable|disable
const BODY_WRITE_MODE = (process.env.BODY_WRITE_MODE || 'local').toLowerCase(); // local|active
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase(); // true|false (로깅용)

const { ensureDir, isValidPageId, ensurePageId, loadLedgerInfo } = require('./lib/page-ids.cjs');

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function extractPublishableSlugs(todayJson) {
  if (!todayJson) return [];

  // 1) 배열 형태: ["slug1", ...] or [{slug}, ...]
  if (Array.isArray(todayJson)) {
    return todayJson
      .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? x.slug : null))
      .filter(Boolean);
  }

  // 2) 객체 형태: { items: [...] } / { queue: [...] } / { posts: [...] }
  const arr =
    (Array.isArray(todayJson.items) && todayJson.items) ||
    (Array.isArray(todayJson.queue) && todayJson.queue) ||
    (Array.isArray(todayJson.posts) && todayJson.posts) ||
    [];

  return arr
    .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? x.slug : null))
    .filter(Boolean);
}

function buildSlugToFileMap(postsDir) {
  const map = new Map(); // slug -> filepath

  if (!fs.existsSync(postsDir)) return map;

  const files = fs.readdirSync(postsDir).filter(f => f.toLowerCase().endsWith('.json')).sort();
  for (const f of files) {
    const p = path.join(postsDir, f);
    const doc = readJsonSafe(p, null);
    if (!doc || typeof doc !== 'object') continue;

    const slug = doc.slug || path.basename(f, '.json');
    if (typeof slug === 'string' && slug) {
      // 동일 slug가 중복이면 첫 번째만 사용(중복은 별도 정책 영역)
      if (!map.has(slug)) map.set(slug, p);
    }
  }

  return map;
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[ids] ROOT            =', ROOT);
  console.log('[ids] POSTS_DIR       =', POSTS_DIR);
  console.log('[ids] TODAY_QUEUE     =', TODAY_QUEUE);
  console.log('[ids] MANIFESTS_DIR   =', MANIFESTS_DIR);
  console.log('[ids] PUBLISH_MODE    =', PUBLISH_MODE);
  console.log('[ids] BODY_WRITE_MODE =', BODY_WRITE_MODE);
  console.log('[ids] DRY_RUN         =', DRY_RUN || '(empty)');

  ensureDir(MANIFESTS_DIR);

  // ✅ 빠른 가드: active + publish disable이면 0회 종료(이력/카운터 보존)
  if (PUBLISH_MODE !== 'enable' && BODY_WRITE_MODE === 'active') {
    console.log('[ids] PAUSE: PUBLISH_MODE=disable 이므로 active 발급(+1) 금지 → 종료 (이력 보존)');
    return;
  }

  if (!fs.existsSync(POSTS_DIR)) {
    console.log('[ids] POSTS_DIR 없음 → 종료');
    return;
  }

  // ✅ publishable 목록 로딩(없으면 0회 종료: 폭주 방지)
  const today = readJsonSafe(TODAY_QUEUE, null);
  const publishableSlugs = extractPublishableSlugs(today);

  if (!publishableSlugs.length) {
    console.log('[ids] publishable slug 없음(today.json 비었거나 없음) → 0회 종료 (폭주 방지)');
    return;
  }

  console.log('[ids] publishable slugs =', publishableSlugs.length);

  const slugToFile = buildSlugToFileMap(POSTS_DIR);

  let assigned = 0;
  let skipped = 0;
  let failed = 0;
  let missing = 0;

  const ledgerInfo = loadLedgerInfo(); // 어떤 ledger를 쓰는지 로깅용
  console.log('[ids] LEDGER_FILE =', ledgerInfo.ledgerFile);

  for (const slug of publishableSlugs) {
    const p = slugToFile.get(slug);
    if (!p) {
      missing++;
      console.error(`[ids][MISS] posts에 slug 없음: ${slug}`);
      continue;
    }

    const doc = readJsonSafe(p, null);
    if (!doc || typeof doc !== 'object') {
      failed++;
      console.error('[ids][FAIL] JSON 파싱 실패:', path.basename(p));
      continue;
    }

    // 이미 있으면 스킵
    if (isValidPageId(doc.pageId)) {
      skipped++;
      continue;
    }

    try {
      const pid = ensurePageId(slug); // ✅ 발급 정책은 lib/page-ids.cjs가 최종 통제
      if (!isValidPageId(pid)) throw new Error('ensurePageId()가 유효한 pageId를 반환하지 않음');

      doc.pageId = pid;
      writeJson(p, doc);
      assigned++;
      console.log(`[ids][OK] ${slug} → ${pid}`);
    } catch (e) {
      failed++;
      console.error(`[ids][FAIL] ${slug} →`, e.message || e);
    }
  }

  console.log('────────────────────────────────────────────');
  console.log('[ids] 요약');
  console.log('  publishable  =', publishableSlugs.length);
  console.log('  할당(신규)   =', assigned);
  console.log('  SKIP         =', skipped);
  console.log('  MISS(slug없음)=', missing);
  console.log('  FAIL         =', failed);

  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();
