#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/patch-seed-review-entity.cjs
 *
 * 역할:
 * - seedpool 내 review 계열 seed에 reviewEntity를 보강한다.
 *
 * 처리 원칙:
 * 1) 기존 구현/기존 데이터 절대 삭제 금지
 * 2) 기존 필드 유지, 없는 reviewEntity만 국부 추가
 * 3) 이미 reviewEntity가 있으면 절대 수정하지 않음
 * 4) 비리뷰 라벨은 건드리지 않음
 * 5) first-gate는 운영 정책상 "app 출력 성격"으로 고정 처리
 *
 * 지원 대상:
 * - warehouse/trend/*.json
 * - warehouse/evergreen/*.json
 * - seedpool/first-gate.json
 *
 * 대상 라벨:
 * - app-reviews
 * - device-reviews
 * - subscription-services
 * - first-gate (내부 출력 성격을 app으로 고정)
 *
 * 실행 예:
 *   node ./System_files/scripts/build/patch-seed-review-entity.cjs
 *   node ./System_files/scripts/build/patch-seed-review-entity.cjs --scope=trend
 *   node ./System_files/scripts/build/patch-seed-review-entity.cjs --scope=evergreen
 *   node ./System_files/scripts/build/patch-seed-review-entity.cjs --scope=firstgate
 *   node ./System_files/scripts/build/patch-seed-review-entity.cjs --scope=all
 */

require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const SEEDPOOL_DIR = path.join(ROOT, 'seedpool');
const WAREHOUSE_DIR = path.join(SEEDPOOL_DIR, 'warehouse');
const TREND_DIR = path.join(WAREHOUSE_DIR, 'trend');
const EVERGREEN_DIR = path.join(WAREHOUSE_DIR, 'evergreen');
const FIRSTGATE_FILE = path.join(SEEDPOOL_DIR, 'first-gate.json');

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
  fatal(`unsupported scope: ${s}`);
}

function isReviewLabel(label) {
  return REVIEW_LABELS.has(String(label || '').trim());
}

function normalizeSpace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function titleCaseWords(input) {
  return normalizeSpace(input)
    .replace(/[_/]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => {
      const lower = w.toLowerCase();
      if (lower === 'ai') return 'AI';
      if (lower === 'tv') return 'TV';
      if (lower === 'pc') return 'PC';
      if (lower === 'ev') return 'EV';
      if (lower === 'vr') return 'VR';
      if (lower === 'xr') return 'XR';
      if (lower === 'anc') return 'ANC';
      if (lower === 'gps') return 'GPS';
      if (lower === 'wi-fi') return 'Wi-Fi';
      if (lower === 'wifi') return 'WiFi';
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function cleanTitleForEntity(title) {
  return normalizeSpace(title)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[?!.:,;]+$/g, '')
    .trim();
}

function stripLeadingQuestion(text) {
  return cleanTitleForEntity(text)
    .replace(/^(is|are|does|do|did|can|should|which|what|how|will|would)\s+/i, '')
    .trim();
}

function firstNonEmptyString(...vals) {
  for (const v of vals) {
    const s = normalizeSpace(v);
    if (s) return s;
  }
  return '';
}

function hasValidReviewEntity(label, entity) {
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) return false;

  const type = normalizeSpace(entity.type).toLowerCase();

  if (label === 'app-reviews') {
    const appId = normalizeSpace(entity.appId);
    const appName = normalizeSpace(entity.appName);
    const platform = normalizeSpace(entity.platform);
    if (type !== 'app') return false;
    if (appId) return true;
    if (appName && platform) return true;
    return false;
  }

  if (label === 'device-reviews') {
    const model = normalizeSpace(entity.model);
    if (type !== 'device') return false;
    return !!model;
  }

  if (label === 'subscription-services') {
    const service = normalizeSpace(entity.service);
    if (type !== 'subscription') return false;
    return !!service;
  }

  return false;
}

function hasValidFirstGateEntity(entity) {
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) return false;
  const type = normalizeSpace(entity.type).toLowerCase();
  const appId = normalizeSpace(entity.appId);
  const appName = normalizeSpace(entity.appName);
  const platform = normalizeSpace(entity.platform);
  if (type !== 'app') return false;
  if (appId) return true;
  if (appName && platform) return true;
  return false;
}

function inferAppEntity(item) {
  const title = cleanTitleForEntity(item.title || '');
  const env = titleCaseWords(item.environment || '');
  const audience = titleCaseWords(item.audience || '');
  const goal = titleCaseWords(item.goal || '');

  let appName = '';

  if (title) {
    appName = stripLeadingQuestion(title)
      .replace(/\bRight Now\b/ig, '')
      .replace(/\bThis Year\b/ig, '')
      .replace(/\bIn 20\d{2}\b/ig, '')
      .replace(/\bWorth Switching To\b/ig, '')
      .replace(/\bDoes It Deliver\b/ig, '')
      .replace(/\bActually Better\b/ig, '')
      .replace(/\bActually Faster\b/ig, '')
      .replace(/\bWorth Migrating To\b/ig, '')
      .replace(/\bWorth The Hype\b/ig, '')
      .replace(/\bLegit\b/ig, '')
      .replace(/\bBest\b/ig, 'Best')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (!appName && env) appName = `${env} App`;
  if (!appName && audience) appName = `${audience} App`;
  if (!appName && goal) appName = `${goal} App`;
  if (!appName) appName = 'Generic App';

  return {
    type: 'app',
    appName,
    platform: 'android',
  };
}

function inferDeviceEntity(item) {
  const title = cleanTitleForEntity(item.title || '');
  const env = titleCaseWords(item.environment || '');

  let model = '';
  if (env) {
    model = env;
  } else if (title) {
    model = stripLeadingQuestion(title)
      .replace(/\bThis Year'?s\b/ig, '')
      .replace(/\bThis Year\b/ig, '')
      .replace(/\bLatest\b/ig, '')
      .replace(/\bNew\b/ig, '')
      .replace(/\bActually\b/ig, '')
      .replace(/\bFinally\b/ig, '')
      .replace(/\bWorth It\b/ig, '')
      .replace(/\bWorth The Price Hike\b/ig, '')
      .replace(/\bAny Better\b/ig, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (!model) model = 'Generic Device';

  return {
    type: 'device',
    model,
  };
}

function inferSubscriptionEntity(item) {
  const title = cleanTitleForEntity(item.title || '');
  const env = titleCaseWords(item.environment || '');
  const goal = titleCaseWords(item.goal || '');

  let service = '';
  if (env) {
    service = env;
  } else if (title) {
    service = stripLeadingQuestion(title)
      .replace(/\bThis Year\b/ig, '')
      .replace(/\bActually\b/ig, '')
      .replace(/\bWorth It\b/ig, '')
      .replace(/\s+/g, ' ')
      .trim();
  } else if (goal) {
    service = goal;
  }

  if (!service) service = 'Generic Service';

  return {
    type: 'subscription',
    service,
  };
}

function buildMissingEntityByLabel(label, item) {
  if (label === 'app-reviews') return inferAppEntity(item);
  if (label === 'device-reviews') return inferDeviceEntity(item);
  if (label === 'subscription-services') return inferSubscriptionEntity(item);
  return null;
}

function buildFirstGateEntity(item) {
  return inferAppEntity(item);
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort()
    .map((name) => path.join(dir, name));
}

function processWarehouseFile(filePath, bucketKey, report) {
  const json = readJsonSafe(filePath, null);
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    warn(`invalid warehouse json: ${filePath}`);
    report.files.push({
      file: filePath,
      bucket: bucketKey,
      ok: false,
      reason: 'invalid-json-object',
    });
    return;
  }

  const label = normalizeSpace(json.label);
  if (!label) {
    warn(`missing label: ${filePath}`);
    report.files.push({
      file: filePath,
      bucket: bucketKey,
      ok: false,
      reason: 'missing-label',
    });
    return;
  }

  if (!isReviewLabel(label)) {
    report.files.push({
      file: filePath,
      bucket: bucketKey,
      ok: true,
      skipped: true,
      reason: 'non-review-label',
      label,
    });
    return;
  }

  const arr = Array.isArray(json[bucketKey]) ? json[bucketKey] : null;
  if (!arr) {
    warn(`missing array key "${bucketKey}": ${filePath}`);
    report.files.push({
      file: filePath,
      bucket: bucketKey,
      ok: false,
      reason: `missing-array-${bucketKey}`,
      label,
    });
    return;
  }

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

    if (hasValidReviewEntity(label, item.reviewEntity)) {
      kept += 1;
      continue;
    }

    const built = buildMissingEntityByLabel(label, item);
    if (!built) {
      skipped += 1;
      continue;
    }

    item.reviewEntity = built;
    changed = true;
    patched += 1;

    report.items.push({
      file: filePath,
      bucket: bucketKey,
      label,
      id: firstNonEmptyString(item.id),
      action: 'patched-reviewEntity',
      reviewEntity: built,
    });
  }

  if (changed) {
    json[bucketKey] = arr;
    writeJsonAtomic(filePath, json);
    log(`patched ${bucketKey}: ${path.basename(filePath)} patched=${patched}`);
  } else {
    log(`no-change ${bucketKey}: ${path.basename(filePath)} kept=${kept}`);
  }

  report.files.push({
    file: filePath,
    bucket: bucketKey,
    ok: true,
    label,
    changed,
    patched,
    kept,
    skipped,
    total: arr.length,
  });
}

function processFirstGateFile(filePath, report) {
  const json = readJsonSafe(filePath, null);
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    warn(`invalid first-gate json: ${filePath}`);
    report.files.push({
      file: filePath,
      bucket: 'firstGate',
      ok: false,
      reason: 'invalid-json-object',
    });
    return;
  }

  const rootLabel = normalizeSpace(json.label);
  const arr = Array.isArray(json.firstGate) ? json.firstGate : null;

  if (!arr) {
    warn(`missing firstGate array: ${filePath}`);
    report.files.push({
      file: filePath,
      bucket: 'firstGate',
      ok: false,
      reason: 'missing-array-firstGate',
      label: rootLabel || null,
    });
    return;
  }

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

    if (hasValidFirstGateEntity(item.reviewEntity)) {
      kept += 1;
      continue;
    }

    const built = buildFirstGateEntity(item);
    if (!built) {
      skipped += 1;
      continue;
    }

    item.reviewEntity = built;
    changed = true;
    patched += 1;

    report.items.push({
      file: filePath,
      bucket: 'firstGate',
      label: rootLabel || 'first-gate',
      id: firstNonEmptyString(item.id),
      action: 'patched-reviewEntity',
      reviewEntity: built,
    });
  }

  if (changed) {
    json.firstGate = arr;
    writeJsonAtomic(filePath, json);
    log(`patched firstGate: ${path.basename(filePath)} patched=${patched}`);
  } else {
    log(`no-change firstGate: ${path.basename(filePath)} kept=${kept}`);
  }

  report.files.push({
    file: filePath,
    bucket: 'firstGate',
    ok: true,
    label: rootLabel || 'first-gate',
    changed,
    patched,
    kept,
    skipped,
    total: arr.length,
  });
}

function summarizeReport(report) {
  const summary = {
    filesChecked: 0,
    filesChanged: 0,
    itemPatched: 0,
    itemKept: 0,
    itemSkipped: 0,
  };

  for (const f of report.files) {
    summary.filesChecked += 1;
    if (f.changed) summary.filesChanged += 1;
    summary.itemPatched += Number(f.patched || 0);
    summary.itemKept += Number(f.kept || 0);
    summary.itemSkipped += Number(f.skipped || 0);
  }

  report.summary = summary;
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
    summary: null,
    finishedAt: null,
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
      processFirstGateFile(FIRSTGATE_FILE, report);
    } else {
      warn(`firstgate file not found: ${FIRSTGATE_FILE}`);
      report.files.push({
        file: FIRSTGATE_FILE,
        bucket: 'firstGate',
        ok: false,
        reason: 'file-not-found',
      });
    }
  }

  summarizeReport(report);
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
