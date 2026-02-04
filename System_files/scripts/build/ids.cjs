#!/usr/bin/env node
'use strict';

require('./lib/env.cjs'); // ✅ .env 로드(필수)

/**
 * System_files/scripts/build/ids.cjs
 * 목적:
 * - content/posts/*.json 중 pageId 없는 문서들에 pageId를 "발급(=할당)"하여 기록
 *
 * ✅ 구조 고정(핵심):
 * - BODY_WRITE_MODE=active 일 때는 "publishable(=오늘 생성된 queue 결과)" slug만 발급한다.
 * - publishable 목록은 dist/queue/today.expanded.json 기반(실행 스냅샷, queue 결과 SSOT 관문).
 * - expanded가 없거나 비어있으면 active 발급은 0회(즉시 종료) → 번호 폭주/오발급 방지.
 *
 * ✅ Seed Ledger(Min v1):
 * - pageId 발급/할당 시 logs/seed-ledger.jsonl 에 assigned 상태로 upsert 기록
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

const DIST_QUEUE_DIR = path.join(ROOT, 'dist', 'queue');
const DIST_QUEUE_TODAY = path.join(DIST_QUEUE_DIR, 'today.json'); // 참고(하위호환/진단용)
const DIST_QUEUE_EXPANDED = path.join(DIST_QUEUE_DIR, 'today.expanded.json'); // ✅ active publishable SSOT

const MANIFESTS_DIR = path.join(ROOT, 'manifests');

const PUBLISH_MODE = (process.env.PUBLISH_MODE || 'disable').toLowerCase(); // enable|disable
const BODY_WRITE_MODE = (process.env.BODY_WRITE_MODE || 'local').toLowerCase(); // local|active

// DRY_RUN 통일 규칙:
// - 기본은 안전(dry-run)
// - 오직 false/0 만 live 취급
function parseDryRunEnv(v) {
  const s = String(v ?? '').toLowerCase().trim();
  const isLive = (s === 'false' || s === '0');
  return !isLive;
}
const DRY_RUN = parseDryRunEnv(process.env.DRY_RUN);

const {
  ensureDir,
  isValidPageId,
  ensurePageId,
  loadLedgerInfo
} = require('./lib/page-ids.cjs');

const { upsert: upsertSeedLedger } = require('./lib/seed-ledger.cjs');

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
 * active 모드 publishable slug 집합 로더(SSOT)
 * - 우선순위: today.expanded.json(items[].generatedSlug) → (하위호환) today.json(items[].slug 등)
 */
function loadPublishableSlugs() {
  // 1) expanded 우선(정답 경로)
  const ex = readJsonSafe(DIST_QUEUE_EXPANDED, null);
  if (ex && typeof ex === 'object') {
    const out = new Set();
    const items = asArray(ex.items);
    for (const it of items) {
      if (!it) continue;
      if (typeof it === 'string' && it.trim()) out.add(it.trim());
      if (typeof it === 'object') {
        const gs = typeof it.generatedSlug === 'string' ? it.generatedSlug.trim() : '';
        const sl = typeof it.slug === 'string' ? it.slug.trim() : '';
        if (gs) out.add(gs);
        else if (sl) out.add(sl);
      }
    }
    return { slugs: out, source: DIST_QUEUE_EXPANDED, loaded: true };
  }

  // 2) today.json 하위호환(진단/구버전 대응)
  const raw = readJsonSafe(DIST_QUEUE_TODAY, null);
  if (!raw) return { slugs: new Set(), source: DIST_QUEUE_EXPANDED, loaded: false };

  const out = new Set();

  // case: array root
  if (Array.isArray(raw)) {
    for (const it of raw) {
      if (typeof it === 'string' && it.trim()) out.add(it.trim());
      if (it && typeof it === 'object' && typeof it.slug === 'string' && it.slug.trim()) out.add(it.slug.trim());
    }
    return { slugs: out, source: DIST_QUEUE_TODAY, loaded: true };
  }

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
 * - local : 전체 posts/*.json
 * - active: publishable(오늘 큐 결과 slug)만
 */
function isTargetDoc(slug, publishableSet) {
  if (BODY_WRITE_MODE !== 'active') return true;
  return publishableSet.has(slug);
}

function inferSeedMeta(doc) {
  const sm = (doc && doc.seedMeta && typeof doc.seedMeta === 'object') ? doc.seedMeta : {};
  const source = sm.source || (doc.isFirstGate ? 'firstgate' : '') || '';
  const seedId = sm.seedId || doc.seedId || sm.id || '';
  const label = doc.label || sm.label || '';
  return { source, seedId, label };
}

/* ───────────────────── main ───────────────────── */

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[ids] ROOT            =', ROOT);
  console.log('[ids] POSTS_DIR       =', POSTS_DIR);
  console.log('[ids] MANIFESTS_DIR   =', MANIFESTS_DIR);
  console.log('[ids] QUEUE_TODAY     =', DIST_QUEUE_TODAY);
  console.log('[ids] QUEUE_EXPANDED  =', DIST_QUEUE_EXPANDED);
  console.log('[ids] PUBLISH_MODE    =', PUBLISH_MODE);
  console.log('[ids] BODY_WRITE_MODE =', BODY_WRITE_MODE);
  console.log('[ids] DRY_RUN         =', DRY_RUN); // ✅ bool 고정 출력

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
  const pub = loadPublishableSlugs();
  const publishableSet = pub.slugs;

  if (BODY_WRITE_MODE === 'active') {
    console.log('[ids] publishable source =', pub.source);
    console.log('[ids] publishable loaded =', pub.loaded);
    console.log('[ids] publishable count  =', publishableSet.size);

    // ✅ 핵심 고정: publishable 비어있으면 "0회 발급"
    if (!pub.loaded || publishableSet.size === 0) {
      console.log('[ids] PAUSE: publishable 비어있음 → active 발급 0회(번호 폭주 방지) → 종료');
      return;
    }
  }

  const files = fs.readdirSync(POSTS_DIR).filter(f => f.toLowerCase().endsWith('.json')).sort();
  console.log('[ids] 전체 JSON 수 =', files.length);

  const ledgerInfo = loadLedgerInfo();
  console.log('[ids] LEDGER_FILE =', ledgerInfo.ledgerFile);

  let assigned = 0;
  let skipped = 0;
  let filteredOut = 0;
  let failed = 0;
  let ledgerLogged = 0;

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

    try {
      const pid = ensurePageId(slug);
      if (!isValidPageId(pid)) throw new Error('ensurePageId()가 유효한 pageId를 반환하지 않음');

      doc.pageId = pid;
      writeJson(p, doc);
      assigned++;

      // ✅ Seed Ledger 기록(최소버전)
      try {
        const sm = inferSeedMeta(doc);
        upsertSeedLedger({
          stage: 'ids',
          status: 'assigned',
          slug,
          pageId: pid,
          label: sm.label,
          seedId: sm.seedId,
          source: sm.source,
          dryRun: DRY_RUN,
        });
        ledgerLogged++;
      } catch (e) {
        console.error('[ids][WARN] seed-ledger upsert fail:', e.message || e);
      }

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
  console.log('  LEDGER_LOGGED   =', ledgerLogged);

  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();
