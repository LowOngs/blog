#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/patch-seed-review-entity.cjs
 *
 * 역할:
 * - seedpool 내 review 라벨 seed(app/device/subscription)에 reviewEntity를 자동 보강한다.
 *
 * 처리 원칙:
 * 1) 기존 구현/기존 데이터 절대 삭제 금지
 * 2) 기존 필드/순서 최대 보존
 * 3) reviewEntity가 이미 있으면 건드리지 않음
 * 4) 비리뷰 라벨은 건드리지 않음
 * 5) 파일 전체 재구성 없이 "부족한 reviewEntity만 국부 추가"
 *
 * 지원 스코프:
 * - trend
 * - evergreen
 * - firstgate
 * - all (기본)
 *
 * 기본 경로:
 * - trend     : System_files/seedpool/warehouse/trend
 * - evergreen : System_files/seedpool/warehouse/evergreen
 * - firstgate : System_files/seedpool/first-gate.json
 *
 * 실행 예:
 * - node ./System_files/scripts/build/patch-seed-review-entity.cjs
 * - node ./System_files/scripts/build/patch-seed-review-entity.cjs --scope=trend
 * - node ./System_files/scripts/build/patch-seed-review-entity.cjs --scope=evergreen
 * - node ./System_files/scripts/build/patch-seed-review-entity.cjs --scope=firstgate
 *
 * 환경변수(선택):
 * - PATCH_SEED_SCOPE=trend|evergreen|firstgate|all
 * - FIRSTGATE_FILE=...  (기본값 경로 덮어쓰기)
 */

require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const SEEDPOOL_DIR = path.join(ROOT, 'seedpool');
const WAREHOUSE_DIR = path.join(SEEDPOOL_DIR, 'warehouse');
const TREND_DIR = path.join(WAREHOUSE_DIR, 'trend');
const EVERGREEN_DIR = path.join(WAREHOUSE_DIR, 'evergreen');
const FIRSTGATE_FILE = process.env.FIRSTGATE_FILE
  ? path.resolve(process.env.FIRSTGATE_FILE)
  : path.join(SEEDPOOL_DIR, 'first-gate.json');

const LOGS_DIR = path.join(ROOT, 'logs');
const REPORT_PATH = path.join(LOGS_DIR, 'patch-seed-review-entity-report.json');

const REVIEW_LABELS = new Set([
  'app-reviews',
  'device-reviews',
  'subscription-services',
]);

function log(...args) {
  console.log('[patch-seed-review-entity]', ...args);
}

function warn(...args) {
  console.warn('[patch-seed-review-entity][WARN]', ...args);
}

function fatal(...args) {
  console.error('[patch-seed-review-entity][FATAL]', ...args);
  process.exit(1);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    warn(`JSON parse failed: ${filePath} :: ${err.message}`);
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function parseCliArgs(argv) {
  const out = {};
  for (const raw of argv.slice(2)) {
    const s = String(raw || '').trim();
    if (!s.startsWith('--')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) {
      out[s.slice(2)] = true;
      continue;
    }
    const k = s.slice(2, eq).trim();
    const v = s.slice(eq + 1).trim();
    out[k] = v;
  }
  return out;
}

function normalizeScope(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return 'all';
  if (s === 'trend') return 'trend';
  if (s === 'evergreen') return 'evergreen';
  if (s === 'firstgate') return 'firstgate';
  if (s === 'all') return 'all';
  fatal(`지원하지 않는 scope: ${s}`);
}

function isReviewLabel(label) {
  return REVIEW_LABELS.has(String(label || '').trim());
}

function titleCaseWords(input) {
  return String(input || '')
    .replace(/[_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => {
      const lower = w.toLowerCase();
      if (lower === 'ai') return 'AI';
      if (lower === 'tv') return 'TV';
      if (lower === 'pc') return 'PC';
      if (lower === 'ev') return 'EV';
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function cleanTitleForEntity(title) {
  return String(title || '')
    .replace(/[“”"'`]/g, '')
    .replace(/[?!.:,;]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLeadingQuestion(title) {
  const t = cleanTitleForEntity(title);
  return t
    .replace(/^(is|are|does|do|did|can|should|which|what|how)\s+/i, '')
    .trim();
}

function pickString(...vals) {
  for (const v of vals) {
    const s = String(v || '').trim();
    if (s) return s;
  }
  return '';
}

function hasValidReviewEntity(label, entity) {
  if (!entity || typeof entity !== 'object') return false;

  const type = String(entity.type || '').trim().toLowerCase();

  if (label === 'app-reviews') {
    const appId = String(entity.appId || '').trim();
    const appName = String(entity.appName || '').trim();
    const platform = String(entity.platform || '').trim();
    if (type !== 'app') return false;
    if (appId) return true;
    if (appName && platform) return true;
    return false;
  }

  if (label === 'device-reviews') {
    const model = String(entity.model || '').trim();
    if (type !== 'device') return false;
    return !!model;
  }

  if (label === 'subscription-services') {
    const service = String(entity.service || '').trim();
    if (type !== 'subscription') return false;
    return !!service;
  }

  return false;
}

/**
 * app-reviews:
 * - appId는 현재 seed만으로 확정 불가한 경우가 많으므로 무리하게 생성하지 않음
 * - appName + platform 조합으로 최소 인식 구조 생성
 */
function inferAppEntity(item) {
  const title = cleanTitleForEntity(item.title || '');
  const env = titleCaseWords(item.environment || '');
  const goal = titleCaseWords(item.goal || '');

  let appName = '';

  if (/app/i.test(title)) {
    appName = stripLeadingQuestion(title)
      .replace(/\bworth switching to\b/ig, '')
      .replace(/\bactually reducing inbox stress\b/ig, '')
      .replace(/\bdoes it work\b/ig, '')
      .replace(/\bdoes it deliver\b/ig, '')
      .replace(/\bactually better\b/ig, '')
      .replace(/\bactually faster\b/ig, '')
      .replace(/\bis it legit\b/ig, '')
      .replace(/\bworth the hype\b/ig, '')
      .replace(/\bgives the most accurate answers\b/ig, '')
      .replace(/\bhandles ai cutouts best\b/ig, '')
      .replace(/\bimproves typing speed the most\b/ig, '')
      .replace(/\bimproved the most this year\b/ig, '')
      .replace(/\bhas the best ai tutor this year\b/ig, '')
      .replace(/\bhas the best playback ai\b/ig, '')
      .replace(/\bhas the best ai coaching\b/ig, '')
      .replace(/\bmost accurately\b/ig, '')
      .replace(/\bright now\b/ig, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (!appName && env) {
    appName = `${env} App`;
  }

  if (!appName && goal) {
    appName = `${goal} App`;
  }

  if (!appName) {
    appName = 'Generic App';
  }

  return {
    type: 'app',
    appName,
    platform: 'android',
  };
}

/**
 * device-reviews:
 * - validate-review-ssot.cjs 기준 최소 조건은 model
 * - title/environment를 바탕으로 model만 안정적으로 생성
 */
function inferDeviceEntity(item) {
  const title = cleanTitleForEntity(item.title || '');
  const env = titleCaseWords(item.environment || '');

  let model = '';

  if (env) {
    model = env;
  } else {
    model = stripLeadingQuestion(title)
      .replace(/\breally\b/ig, '')
      .replace(/\bthis year\b/ig, '')
      .replace(/\bfinally\b/ig, '')
      .replace(/\bactually\b/ig, '')
      .replace(/\bworth upgrading\b/ig, '')
      .replace(/\bworth it\b/ig, '')
      .replace(/\bworth the price hike\b/ig, '')
      .replace(/\bany better\b/ig, '')
      .replace(/\bis it better than your default\b/ig, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (!model) model = 'Generic Device';

  return {
    type: 'device',
    model,
  };
}

/**
 * subscription-services:
 * - validate-review-ssot.cjs 기준 최소 조건은 service
 */
function inferSubscriptionEntity(item) {
  const title = cleanTitleForEntity(item.title || '');
  const env = titleCaseWords(item.environment || '');

  let service = '';

  if (env) {
    service = env;
  } else {
    service = stripLeadingQuestion(title)
      .replace(/\breally\b/ig, '')
      .replace(/\bworth it\b/ig, '')
      .replace(/\bworth subscribing to\b/ig, '')
      .replace(/\bthis year\b/ig, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (!service) service = 'Generic Service';

  return {
    type: 'subscription',
    service,
  };
}

function buildMissingReviewEntity(label, item) {
  if (label === 'app-reviews') return inferAppEntity(item);
  if (label === 'device-reviews') return inferDeviceEntity(item);
  if (label === 'subscription-services') return inferSubscriptionEntity(item);
  return null;
}

function patchSeedArrayItems(label, arr, filePath, bucketName, report) {
  if (!Array.isArray(arr)) return { changed: false, patched: 0, kept: 0, skipped: 0 };

  let changed = false;
  let patched = 0;
  let kept = 0;
  let skipped = 0;

  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      skipped += 1;
      continue;
    }

    if (!isReviewLabel(label)) {
      skipped += 1;
      continue;
    }

    if (hasValidReviewEntity(label, item.reviewEntity)) {
      kept += 1;
      continue;
    }

    const built = buildMissingReviewEntity(label, item);
    if (!built) {
      skipped += 1;
      continue;
    }

    item.reviewEntity = built;
    changed = true;
    patched += 1;

    report.items.push({
      file: filePath,
      bucket: bucketName,
      label,
      id: String(item.id || '').trim(),
      action: 'patched-reviewEntity',
      reviewEntity: built,
    });
  }

  return { changed, patched, kept, skipped };
}

function processWarehouseFile(filePath, bucketName, report) {
  const json = readJsonSafe(filePath, null);
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    warn(`warehouse file skip (invalid object): ${filePath}`);
    report.files.push({
      file: filePath,
      bucket: bucketName,
      ok: false,
      reason: 'invalid-object',
    });
    return;
  }

  const label = String(json.label || '').trim();
  if (!label) {
    warn(`warehouse file skip (missing label): ${filePath}`);
    report.files.push({
      file: filePath,
      bucket: bucketName,
      ok: false,
      reason: 'missing-label',
    });
    return;
  }

  const arr = Array.isArray(json[bucketName]) ? json[bucketName] : [];
  const result = patchSeedArrayItems(label, arr, filePath, bucketName, report);

  if (result.changed) {
    json[bucketName] = arr;
    writeJsonAtomic(filePath, json);
  }

  report.files.push({
    file: filePath,
    bucket: bucketName,
    ok: true,
    label,
    changed: result.changed,
    patched: result.patched,
    kept: result.kept,
    skipped: result.skipped,
    total: arr.length,
  });
}

function detectFirstgateArrayHolder(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;

  if (Array.isArray(json.items)) return { key: 'items', arr: json.items };
  if (Array.isArray(json.firstgate)) return { key: 'firstgate', arr: json.firstgate };
  if (Array.isArray(json.seeds)) return { key: 'seeds', arr: json.seeds };
  if (Array.isArray(json.queue)) return { key: 'queue', arr: json.queue };

  return null;
}

function detectItemLabel(item, rootLabel) {
  const a = String(item && item.label || '').trim();
  if (a) return a;
  const b = String(item && item.seedLabel || '').trim();
  if (b) return b;
  const c = String(rootLabel || '').trim();
  if (c) return c;
  return '';
}

function processFirstgateFile(filePath, report) {
  const json = readJsonSafe(filePath, null);
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    warn(`firstgate file skip (invalid object): ${filePath}`);
    report.files.push({
      file: filePath,
      bucket: 'firstgate',
      ok: false,
      reason: 'invalid-object',
    });
    return;
  }

  const holder = detectFirstgateArrayHolder(json);
  if (!holder) {
    warn(`firstgate array holder not found: ${filePath}`);
    report.files.push({
      file: filePath,
      bucket: 'firstgate',
      ok: false,
      reason: 'array-holder-not-found',
    });
    return;
  }

  const arr = holder.arr;
  const rootLabel = String(json.label || '').trim();

  let changed = false;
  let patched = 0;
  let kept = 0;
  let skipped = 0;

  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      skipped += 1;
      continue;
    }

    const label = detectItemLabel(item, rootLabel);
    if (!isReviewLabel(label)) {
      skipped += 1;
      continue;
    }

    if (hasValidReviewEntity(label, item.reviewEntity)) {
      kept += 1;
      continue;
    }

    const built = buildMissingReviewEntity(label, item);
    if (!built) {
      skipped += 1;
      continue;
    }

    item.reviewEntity = built;
    changed = true;
    patched += 1;

    report.items.push({
      file: filePath,
      bucket: 'firstgate',
      label,
      id: String(item.id || '').trim(),
      action: 'patched-reviewEntity',
      reviewEntity: built,
    });
  }

  if (changed) {
    json[holder.key] = arr;
    writeJsonAtomic(filePath, json);
  }

  report.files.push({
    file: filePath,
    bucket: 'firstgate',
    ok: true,
    holderKey: holder.key,
    changed,
    patched,
    kept,
    skipped,
    total: arr.length,
  });
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort()
    .map((name) => path.join(dir, name));
}

function main() {
  ensureDir(LOGS_DIR);

  const cli = parseCliArgs(process.argv);
  const scope = normalizeScope(cli.scope || process.env.PATCH_SEED_SCOPE || 'all');

  const report = {
    startedAt: new Date().toISOString(),
    root: ROOT,
    scope,
    files: [],
    items: [],
    summary: {
      filesChecked: 0,
      filesChanged: 0,
      itemPatched: 0,
      itemKept: 0,
      itemSkipped: 0,
    },
  };

  log(`ROOT = ${ROOT}`);
  log(`scope = ${scope}`);

  if (scope === 'trend' || scope === 'all') {
    const files = listJsonFiles(TREND_DIR);
    log(`trend files = ${files.length}`);
    for (const file of files) {
      processWarehouseFile(file, 'trend', report);
    }
  }

  if (scope === 'evergreen' || scope === 'all') {
    const files = listJsonFiles(EVERGREEN_DIR);
    log(`evergreen files = ${files.length}`);
    for (const file of files) {
      processWarehouseFile(file, 'evergreen', report);
    }
  }

  if (scope === 'firstgate' || scope === 'all') {
    if (fs.existsSync(FIRSTGATE_FILE)) {
      log(`firstgate file = ${FIRSTGATE_FILE}`);
      processFirstgateFile(FIRSTGATE_FILE, report);
    } else {
      warn(`firstgate file not found: ${FIRSTGATE_FILE}`);
      report.files.push({
        file: FIRSTGATE_FILE,
        bucket: 'firstgate',
        ok: false,
        reason: 'file-not-found',
      });
    }
  }

  for (const f of report.files) {
    report.summary.filesChecked += 1;
    if (f.changed) report.summary.filesChanged += 1;
    report.summary.itemPatched += Number(f.patched || 0);
    report.summary.itemKept += Number(f.kept || 0);
    report.summary.itemSkipped += Number(f.skipped || 0);
  }

  report.finishedAt = new Date().toISOString();

  writeJsonAtomic(REPORT_PATH, report);

  log('────────────────────────────────────────────');
  log(`filesChecked = ${report.summary.filesChecked}`);
  log(`filesChanged = ${report.summary.filesChanged}`);
  log(`itemPatched  = ${report.summary.itemPatched}`);
  log(`itemKept     = ${report.summary.itemKept}`);
  log(`itemSkipped  = ${report.summary.itemSkipped}`);
  log(`report       = ${REPORT_PATH}`);
  log('────────────────────────────────────────────');
}

if (require.main === module) {
  main();
}
