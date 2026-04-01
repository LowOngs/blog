#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/validate-review-ssot.cjs
 *
 * 하이브리드 전략(확정)
 * 1) 리뷰 라벨(app/device/subscription)만 대상
 * 2) 엔티티 누락이면 즉시 CRIT(재시도 없음)
 * 3) SSOT 누락 + 엔티티 정상 => update-review-ratings.cjs 1회 스파이크 재시도
 * 4) 재시도 후에도 SSOT 없으면 CRIT
 * 5) 무한 재시도 방지: slug 당 1회까지만(로그 기반)
 *
 * 출력:
 * - dist/logs/review-ssot-report.json  (요약 리포트)
 * - dist/logs/review-ssot-retry.json  (slug별 retry 카운트)
 *
 * 필요 환경:
 * - ROOT는 System_files 기준(프로젝트 규칙)
 * - update-review-ratings.cjs가 존재해야 함 (package.json에 이미 있음)
 *
 * [국부 보강]
 * - 파이프라인 실행 스코프 SSOT는 today.expanded.json 우선 사용
 * - 신규 생성 slug는 generatedSlug 우선 사용
 * - today.expanded.json이 없을 때만 today.json으로 fallback
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ✅ env 로드(루트/DRY_RUN 파서 통일은 env.cjs가 담당)
require('./lib/env.cjs');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const QUEUE_EXPANDED_PATH = path.join(ROOT, 'dist', 'queue', 'today.expanded.json');
const QUEUE_PATH = path.join(ROOT, 'dist', 'queue', 'today.json');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const SSOT_PATH = path.join(ROOT, 'content', 'reviews', 'review-ratings.json');

// 로그/리포트 저장소
const OUT_DIR = path.join(ROOT, 'dist', 'logs');
const REPORT_PATH = path.join(OUT_DIR, 'review-ssot-report.json');
const RETRY_LEDGER_PATH = path.join(OUT_DIR, 'review-ssot-retry.json');

// 스파이크 대상 스크립트
const UPDATE_SCRIPT = path.join(ROOT, 'scripts', 'build', 'update-review-ratings.cjs');

// 리뷰 라벨 3종 고정
const REVIEW_LABELS = new Set(['app-reviews', 'device-reviews', 'subscription-services']);

/* ------------------------------ utils ------------------------------ */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe(p, fallback = null) {
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

function firstLabelFromPost(postJson) {
  const a = String(postJson?.label || '').trim();
  if (a) return a;
  const labels = asArray(postJson?.labels).map(x => String(x || '').trim()).filter(Boolean);
  if (labels.length) return labels[0];
  const b = String(postJson?.seedMeta?.label || '').trim();
  return b;
}

function isReviewPost(postJson) {
  const label = firstLabelFromPost(postJson);
  return REVIEW_LABELS.has(label);
}

/**
 * 엔티티 판정(하이브리드 핵심)
 * - 리뷰 라벨이면 반드시 1개 엔티티가 있어야 “될 만한 녀석”
 *
 * 허용 입력(둘 중 하나만 있으면 OK):
 * A) postJson.reviewEntity = { type: 'app'|'device'|'subscription', appId/appName/platform/model/service ... }
 * B) postJson.seedMeta.entity = {...} (호환)
 */
function pickReviewEntity(postJson) {
  const e1 = postJson?.reviewEntity && typeof postJson.reviewEntity === 'object' ? postJson.reviewEntity : null;
  const e2 = postJson?.seedMeta?.entity && typeof postJson.seedMeta.entity === 'object' ? postJson.seedMeta.entity : null;
  const e = e1 || e2;
  if (!e) return null;

  const type = String(e.type || '').trim().toLowerCase();
  const appId = String(e.appId || '').trim();
  const appName = String(e.appName || '').trim();
  const platform = String(e.platform || '').trim();
  const model = String(e.model || '').trim();
  const service = String(e.service || '').trim();

  // type이 비어있으면 내용으로 추론(최소)
  let t = type;
  if (!t) {
    if (service) t = 'subscription';
    else if (model) t = 'device';
    else if (appId || appName) t = 'app';
  }

  if (t === 'app') {
    // appId 우선, 없으면 appName+platform
    if (appId) return { type: 'app', appId, platform, appName };
    if (appName && platform) return { type: 'app', appName, platform };
    return null;
  }

  if (t === 'device') {
    if (model) return { type: 'device', model };
    return null;
  }

  if (t === 'subscription') {
    if (service) return { type: 'subscription', service };
    return null;
  }

  return null;
}

function readSsotBySlug() {
  const ssot = readJsonSafe(SSOT_PATH, null);
  const bySlug = ssot && ssot.bySlug && typeof ssot.bySlug === 'object' ? ssot.bySlug : null;
  return { ssot, bySlug };
}

function hasSsotForSlug(bySlug, slug) {
  if (!bySlug || typeof bySlug !== 'object') return false;
  const v = bySlug[slug];
  return !!(v && typeof v === 'object');
}

function loadRetryLedger() {
  const obj = readJsonSafe(RETRY_LEDGER_PATH, {});
  return obj && typeof obj === 'object' ? obj : {};
}

function saveRetryLedger(ledger) {
  writeJson(RETRY_LEDGER_PATH, ledger);
}

function bumpRetry(ledger, slug) {
  const cur = Number(ledger[slug] || 0) || 0;
  ledger[slug] = cur + 1;
  return ledger[slug];
}

function getRetryCount(ledger, slug) {
  return Number(ledger[slug] || 0) || 0;
}

function resolveScopeQueue() {
  const expanded = readJsonSafe(QUEUE_EXPANDED_PATH, null);
  const today = readJsonSafe(QUEUE_PATH, null);

  if (expanded && typeof expanded === 'object') {
    return {
      queue: expanded,
      queuePath: QUEUE_EXPANDED_PATH,
      queueType: 'expanded',
    };
  }

  if (today && typeof today === 'object') {
    return {
      queue: today,
      queuePath: QUEUE_PATH,
      queueType: 'today',
    };
  }

  return {
    queue: null,
    queuePath: fs.existsSync(QUEUE_EXPANDED_PATH) ? QUEUE_EXPANDED_PATH : QUEUE_PATH,
    queueType: 'none',
  };
}

function resolveSlugFromQueueItem(it) {
  return String(
    it?.generatedSlug ||
    it?.slug ||
    ''
  ).trim();
}

/**
 * 스파이크 실행
 * - 원칙: slug별 1회만 허용(ledger로 강제)
 * - update-review-ratings.cjs가 슬러그 필터를 지원하면 REVIEW_SLUGS로 넘김(선택)
 *   (지원 안 해도 전체 갱신 1회 실행으로 동작은 함)
 */
function runSpikeUpdate(slugs) {
  if (!fs.existsSync(UPDATE_SCRIPT)) {
    return { ok: false, msg: `update-review-ratings.cjs 없음: ${UPDATE_SCRIPT}` };
  }

  const env = { ...process.env };

  // ✅ 필터 지원 시 활용(지원 안 해도 무해)
  env.REVIEW_SLUGS = slugs.join(',');

  const r = spawnSync(process.execPath, [UPDATE_SCRIPT], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  });

  return { ok: r.status === 0, msg: `exit=${r.status}` };
}

/* ------------------------------ main ------------------------------ */

function main() {
  ensureDir(OUT_DIR);

  // 실행 스코프 SSOT: today.expanded.json 우선, 없으면 today.json
  const scope = resolveScopeQueue();

  // queue 자체가 없으면 검증도 스킵
  if (!scope.queue) {
    const report = {
      ok: true,
      skipped: true,
      reason: 'queue scope file not found',
      queuePath: scope.queuePath,
      queueType: scope.queueType,
      ts: new Date().toISOString(),
    };
    writeJson(REPORT_PATH, report);
    console.log('[validate-review-ssot] queue scope file 없음 → 스킵');
    process.exit(0);
  }

  const items = Array.isArray(scope.queue?.items) ? scope.queue.items : [];

  if (!items.length) {
    const report = {
      ok: true,
      skipped: true,
      reason: 'queue items empty',
      queuePath: scope.queuePath,
      queueType: scope.queueType,
      ts: new Date().toISOString(),
    };
    writeJson(REPORT_PATH, report);
    console.log('[validate-review-ssot] items 비어있음 → 스킵');
    process.exit(0);
  }

  const retryLedger = loadRetryLedger();

  // 1) 오늘 발행 대상 중 “리뷰 라벨”만 실제 postJson을 찾아 검사
  const targets = [];
  for (const it of items) {
    const slug = resolveSlugFromQueueItem(it);
    const label = String(it?.label || '').trim();

    if (!slug) continue;
    if (!REVIEW_LABELS.has(label)) continue;

    const postPath = path.join(POSTS_DIR, `${slug}.json`);
    const postJson = readJsonSafe(postPath, null);

    targets.push({
      slug,
      label,
      postPath,
      postExists: fs.existsSync(postPath),
      postJson,
      queueType: scope.queueType,
    });
  }

  if (!targets.length) {
    const report = {
      ok: true,
      skipped: true,
      reason: 'no review posts in queue scope',
      queuePath: scope.queuePath,
      queueType: scope.queueType,
      totalItems: items.length,
      reviewItems: 0,
      ts: new Date().toISOString(),
    };
    writeJson(REPORT_PATH, report);
    console.log('[validate-review-ssot] 오늘 스코프에 리뷰 글 없음 → 스킵');
    process.exit(0);
  }

  // 2) 1차 판정: 엔티티 / SSOT 존재 여부
  let { bySlug } = readSsotBySlug();

  const crit = [];
  const needSpike = []; // 엔티티 OK인데 SSOT 누락이며 retry 0인 슬러그만

  for (const t of targets) {
    if (!t.postJson) {
      crit.push({
        slug: t.slug,
        label: t.label,
        code: 'missing-post-json',
        detail: 'content/posts/*.json missing',
        postPath: t.postPath,
      });
      continue;
    }

    // 라벨 방어(혹시 queue label이 맞더라도 postJson이 오염된 경우)
    if (!isReviewPost(t.postJson)) {
      crit.push({
        slug: t.slug,
        label: t.label,
        code: 'label-mismatch',
        detail: 'queue label is review but postJson label is not review',
      });
      continue;
    }

    const entity = pickReviewEntity(t.postJson);
    if (!entity) {
      // ✅ 엔티티 누락이면 즉시 폐기(재시도 없음)
      crit.push({
        slug: t.slug,
        label: t.label,
        code: 'missing-entity',
        detail: 'reviewEntity (or seedMeta.entity) required for review posts',
      });
      continue;
    }

    const exists = hasSsotForSlug(bySlug, t.slug);
    if (exists) continue;

    const retryCount = getRetryCount(retryLedger, t.slug);
    if (retryCount >= 1) {
      // 이미 1회 구제했는데도 없음 => 최종 CRIT
      crit.push({
        slug: t.slug,
        label: t.label,
        code: 'missing-ssot-after-retry',
        detail: 'SSOT missing after 1 spike retry',
      });
      continue;
    }

    // 엔티티는 정상 + SSOT만 없음 + retry 0 => 스파이크 후보
    needSpike.push(t.slug);
  }

  // 3) 스파이크(딱 1회만)
  let spikeRun = null;
  if (needSpike.length) {
    console.log('────────────────────────────────────────────');
    console.log('[validate-review-ssot] SSOT 누락(엔티티 정상) → 1회 스파이크 재시도');
    console.log('[validate-review-ssot] 대상 slug 수 =', needSpike.length);
    console.log('────────────────────────────────────────────');

    spikeRun = runSpikeUpdate(needSpike);

    // ledger에 retry 사용 기록(성공/실패와 무관하게 “1회 사용”으로 고정)
    for (const slug of needSpike) bumpRetry(retryLedger, slug);
    saveRetryLedger(retryLedger);

    // 스파이크 후 SSOT 재로딩
    ({ bySlug } = readSsotBySlug());

    // 스파이크 후에도 없는 것만 CRIT 확정
    for (const slug of needSpike) {
      if (!hasSsotForSlug(bySlug, slug)) {
        crit.push({
          slug,
          code: 'missing-ssot-after-spike',
          detail: 'SSOT still missing after spike run',
        });
      }
    }
  } else {
    // needSpike가 없더라도 ledger 저장은 유지(읽기만)
    saveRetryLedger(retryLedger);
  }

  // 4) 리포트 저장
  const report = {
    ok: crit.length === 0,
    ts: new Date().toISOString(),
    scope: {
      queuePath: scope.queuePath,
      queueType: scope.queueType,
      itemsTotal: items.length,
      reviewTargets: targets.length,
    },
    spike: {
      requested: needSpike.length,
      ran: !!needSpike.length,
      result: spikeRun || null,
    },
    crit,
  };

  writeJson(REPORT_PATH, report);

  console.log('────────────────────────────────────────────');
  console.log('[validate-review-ssot] 결과');
  console.log('  queueType      =', scope.queueType);
  console.log('  reviewTargets  =', targets.length);
  console.log('  spikeRequested =', needSpike.length);
  console.log('  CRIT           =', crit.length);
  console.log('  report         =', REPORT_PATH);
  console.log('────────────────────────────────────────────');

  if (crit.length) process.exitCode = 1;
}

if (require.main === module) main();
