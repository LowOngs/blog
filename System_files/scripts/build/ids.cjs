#!/usr/bin/env node
'use strict';

require('./lib/env.cjs'); // ✅ .env 로드(필수)

/**
 * System_files/scripts/build/ids.cjs
 *
 * 목적:
 * - content/posts/*.json 중 pageId 없는 문서들에 pageId를 "발급(=할당)"하여 기록
 *
 * ✅ 구조 고정(핵심):
 * - BODY_WRITE_MODE=active 일 때는 "publishable(=today queue)" slug만 발급한다.
 * - publishable 목록은 dist/queue/today.json 기반(SSOT).
 * - today.json에 없으면 active 발급은 0회(즉시 종료) → 번호 폭주 방지.
 *
 * AOIA ID 정책(옹스 룰)
 * - BODY_WRITE_MODE=local:
 *   로컬 테스트용 번호 발급 허용(실발행과 무관)
 *
 * - BODY_WRITE_MODE=active:
 *   실발행 후보만 발급(=today publishable)
 *   단, lib/page-ids.cjs 내부 가드:
 *     PUBLISH_MODE=enable AND DRY_RUN!=true 일 때만 active ledger +1 허용
 *
 * - PUBLISH_MODE=disable:
 *   active 발급 0회, 이력/카운터 보존
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const DIST_QUEUE_TODAY = path.join(ROOT, 'dist', 'queue', 'today.json');
const MANIFESTS_DIR = path.join(ROOT, 'manifests');

const PUBLISH_MODE = (process.env.PUBLISH_MODE || 'disable').toLowerCase(); // enable|disable
const BODY_WRITE_MODE = (process.env.BODY_WRITE_MODE || 'local').toLowerCase(); // local|active
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase(); // true|false (로깅용)

const {
  ensureDir,
  isValidPageId,
  ensurePageId,
  loadLedgerInfo
} = require('./lib/page-ids.cjs');

/* ───────────────────── utils ───────────────────── */

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

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * today.json에서 publishable slug 집합을 최대한 "유연하게" 뽑습니다.
 * - 기대 포맷이 조금 달라도 안전하게 추출되도록 방어
 *
 * 허용 케이스 예:
 * 1) ["slug-a","slug-b"]
 * 2) { items:[{slug:"a"},{slug:"b"}] }
 * 3) { posts:[{slug:"a"}] }
 * 4) { queue:[{slug:"a"}] }
 */
function loadPublishableSlugsFromToday() {
  const raw = readJsonSafe(DIST_QUEUE_TODAY, null);
  if (!raw) return { slugs: new Set(), source: DIST_QUEUE_TODAY, loaded: false };

  const out = new Set();

  // case: array root
  if (Array.isArray(raw)) {
    for (const it of raw) {
      if (typeof it === 'string' && it.trim()) out.add(it.trim());
      if (it && typeof it === 'object' && typeof it.slug === 'string' && it.slug.trim()) out.add(it.slug.trim());
    }
    return { slugs: out, source: DIST_QUEUE_TODAY, loaded: true };
  }

  // case: object root with candidates
  const candidates = []
    .concat(asArray(raw.items))
    .concat(asArray(raw.posts))
    .concat(asArray(raw.queue))
    .concat(asArray(raw.publishables));

  for (const it of candidates) {
    if (!it) continue;
    if (typeof it === 'string' && it.trim()) out.add(it.trim());
    if (typeof it === 'object' && typeof it.slug === 'string' && it.slug.trim()) out.add(it.slug.trim());
  }

  return { slugs: out, source: DIST_QUEUE_TODAY, loaded: true };
}

/**
 * ids.cjs 실행 대상(발급 후보) 결정
 * - local: 전체 posts/*.json (기존 정책 유지)
 * - active: today publishable에 포함된 slug만
 */
function isTargetDoc(slug, publishableSet) {
  if (BODY_WRITE_MODE !== 'active') return true; // local은 전체 허용
  return publishableSet.has(slug);
}

/* ───────────────────── main ───────────────────── */

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[ids] ROOT            =', ROOT);
  console.log('[ids] POSTS_DIR       =', POSTS_DIR);
  console.log('[ids] MANIFESTS_DIR   =', MANIFESTS_DIR);
  console.log('[ids] TODAY_QUEUE     =', DIST_QUEUE_TODAY);
  console.log('[ids] PUBLISH_MODE    =', PUBLISH_MODE);
  console.log('[ids] BODY_WRITE_MODE =', BODY_WRITE_MODE);
  console.log('[ids] DRY_RUN         =', DRY_RUN || '(empty)');

  ensureDir(MANIFESTS_DIR);

  // ✅ 1차 가드: active + publish disable => 0회 발급(보존)
  if (PUBLISH_MODE !== 'enable' && BODY_WRITE_MODE === 'active') {
    console.log('[ids] PAUSE: PUBLISH_MODE=disable 이므로 active 발급(+1) 금지 → 종료 (이력 보존)');
    return;
  }

  if (!fs.existsSync(POSTS_DIR)) {
    console.log('[ids] POSTS_DIR 없음 → 종료');
    return;
  }

  // ✅ publishable 로딩(active에서만 강제)
  const pub = loadPublishableSlugsFromToday();
  const publishableSet = pub.slugs;

  if (BODY_WRITE_MODE === 'active') {
    console.log('[ids] publishable loaded =', pub.loaded);
    console.log('[ids] publishable count  =', publishableSet.size);

    // ✅ 핵심 고정: today publishable이 비어있으면 "0회 발급"
    if (!pub.loaded || publishableSet.size === 0) {
      console.log('[ids] PAUSE: today.json publishable 비어있음 → active 발급 0회(번호 폭주 방지) → 종료');
      return;
    }
  }

  const files = fs.readdirSync(POSTS_DIR).filter(f => f.toLowerCase().endsWith('.json')).sort();
  console.log('[ids] 전체 JSON 수 =', files.length);

  const ledgerInfo = loadLedgerInfo(); // 어떤 ledger를 쓰는지 로깅용
  console.log('[ids] LEDGER_FILE =', ledgerInfo.ledgerFile);

  let assigned = 0;
  let skipped = 0;
  let filteredOut = 0;
  let failed = 0;

  for (const f of files) {
    const p = path.join(POSTS_DIR, f);
    const doc = readJsonSafe(p, null);
    if (!doc || typeof doc !== 'object') {
      failed++;
      console.error('[ids][FAIL] JSON 파싱 실패:', f);
      continue;
    }

    const slug = (doc.slug || path.basename(f, '.json') || '').trim();
    if (!slug) {
      failed++;
      console.error('[ids][FAIL] slug 없음:', f);
      continue;
    }

    // ✅ active 모드: publishable 아니면 대상에서 제외(발급 금지)
    if (!isTargetDoc(slug, publishableSet)) {
      filteredOut++;
      continue;
    }

    // 이미 pageId 있으면 스킵
    if (isValidPageId(doc.pageId)) {
      skipped++;
      continue;
    }

    // 발급/할당
    try {
      const pid = ensurePageId(slug); // ✅ 최종 통제는 lib/page-ids.cjs
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
  console.log('  할당(신규)      =', assigned);
  console.log('  SKIP(기존존재)  =', skipped);
  console.log('  FILTERED(비대상)=', filteredOut);
  console.log('  FAIL            =', failed);

  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();
