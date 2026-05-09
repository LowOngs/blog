#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/trend-seed-injector.cjs
 *
 * 역할:
 * - dist/trend-seeds/trend-seeds.json 의 trend seed를 seedpool warehouse trend 파일에 자동 적재한다.
 * - trend-seed-builder가 생성한 "실제 글 생성 가능한 trend seed"만 소비한다.
 * - fingerprint 중복을 차단한다.
 * - 가능한 경우 fp-cache에 사용/매핑 기록을 남긴다.
 *
 * 입력:
 * - System_files/dist/trend-seeds/trend-seeds.json
 *
 * 출력:
 * - System_files/seedpool/warehouse/trend/{label}-trend.json
 * - System_files/logs/trend-seed-inject-report.json
 *
 * 원칙:
 * - trend-seeds.json 수정 금지
 * - 기존 warehouse seed 삭제 금지
 * - append 전용
 * - fingerprint 중복 차단
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

const INPUT_FILE = path.join(
  ROOT,
  'dist',
  'trend-seeds',
  'trend-seeds.json'
);

const WAREHOUSE_TREND_DIR = path.join(
  ROOT,
  'seedpool',
  'warehouse',
  'trend'
);

const REPORT_FILE = path.join(
  ROOT,
  'logs',
  'trend-seed-inject-report.json'
);

const DEFAULT_LABEL = 'device-reviews';

function tryRequire(modulePath) {
  try {
    return require(modulePath);
  } catch {
    return null;
  }
}

const fpCache = tryRequire('./lib/fp-cache.cjs');
const seedDesignPolicy = tryRequire('./lib/seed-design-policy.cjs');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;

    const raw = fs.readFileSync(filePath, 'utf8').trim();

    if (!raw) return fallback;

    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));

  const tmp = `${filePath}.tmp`;

  fs.writeFileSync(
    tmp,
    `${JSON.stringify(data, null, 2)}\n`,
    'utf8'
  );

  fs.renameSync(tmp, filePath);
}

function getWarehouseFile(label) {
  const safeLabel = normalizeText(label) || DEFAULT_LABEL;

  return path.join(
    WAREHOUSE_TREND_DIR,
    `${safeLabel}-trend.json`
  );
}

function normalizeWarehouseShape(data, label) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      schema: 'AOIA',
      label,
      mode: 'trend',
      updatedAt: null,
      trend: [],
    };
  }

  if (!Array.isArray(data.trend)) {
    if (Array.isArray(data.items)) {
      data.trend = data.items;
    } else if (Array.isArray(data.seeds)) {
      data.trend = data.seeds;
    } else {
      data.trend = [];
    }
  }

  data.schema = data.schema || 'AOIA';
  data.label = data.label || label;
  data.mode = 'trend';

  return data;
}

function getWarehouseSeeds(data) {
  if (Array.isArray(data.trend)) return data.trend;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.seeds)) return data.seeds;

  return [];
}

function buildExistingFingerprintSet(warehouseData) {
  const set = new Set();

  for (const seed of getWarehouseSeeds(warehouseData)) {
    const fp = normalizeText(seed && seed.fingerprint);
    if (fp) set.add(fp);
  }

  return set;
}

function hasFpCacheUsed(fingerprint) {
  if (
    fpCache &&
    typeof fpCache.hasUsedFingerprint === 'function'
  ) {
    try {
      return !!fpCache.hasUsedFingerprint(fingerprint);
    } catch {
      return false;
    }
  }

  return false;
}

function markFpCache(seed) {
  if (
    !fpCache ||
    typeof fpCache.markUsedAndMap !== 'function'
  ) {
    return false;
  }

  try {
    fpCache.markUsedAndMap(seed.fingerprint, {
      recordKey: normalizeText(seed.selectionMeta && seed.selectionMeta.rawConceptKey) || normalizeText(seed.fingerprint),
      label: normalizeText(seed.label),
      mode: normalizeText(seed.mode),
      seedId: normalizeText(seed.id),
      usedAt: new Date().toISOString(),
      source: 'trend-seed-injector',
    });

    return true;
  } catch {
    return false;
  }
}

function validateWithSeedDesignPolicy(seed) {
  if (!seedDesignPolicy || typeof seedDesignPolicy !== 'object') {
    return [];
  }

  const possibleFns = [
    'validateSeed',
    'validateSeedDesign',
    'validateItem',
  ];

  for (const fnName of possibleFns) {
    if (typeof seedDesignPolicy[fnName] === 'function') {
      try {
        const result = seedDesignPolicy[fnName](seed);

        if (Array.isArray(result)) return result;
        if (result && Array.isArray(result.errors)) return result.errors;
        if (result && result.ok === false) return ['seed-design-policy failed'];

        return [];
      } catch (error) {
        return [`seed-design-policy error: ${error.message}`];
      }
    }
  }

  return [];
}

function validateSeed(seed) {
  const errors = [];

  if (!seed || typeof seed !== 'object') {
    return ['invalid seed object'];
  }

  if (normalizeText(seed.schemaVersion) !== 'trend-seeds.v1') {
    errors.push('bad seed schemaVersion');
  }

  if (normalizeText(seed.label) !== DEFAULT_LABEL) {
    errors.push('unsupported label');
  }

  if (normalizeText(seed.mode) !== 'trend') {
    errors.push('bad mode');
  }

  if (!normalizeText(seed.intent)) {
    errors.push('missing intent');
  }

  if (!normalizeText(seed.title)) {
    errors.push('missing title');
  }

  if (!normalizeText(seed.angle)) {
    errors.push('missing angle');
  }

  if (!normalizeText(seed.audience)) {
    errors.push('missing audience');
  }

  if (!normalizeText(seed.goal)) {
    errors.push('missing goal');
  }

  if (!seed.entity || typeof seed.entity !== 'object') {
    errors.push('missing entity');
  } else {
    if (!normalizeText(seed.entity.name)) {
      errors.push('missing entity.name');
    }

    if (normalizeText(seed.entity.type) !== 'device') {
      errors.push('bad entity.type');
    }
  }

  if (!seed.reviewEntity || typeof seed.reviewEntity !== 'object') {
    errors.push('missing reviewEntity');
  } else if (!normalizeText(seed.reviewEntity.name)) {
    errors.push('missing reviewEntity.name');
  }

  if (!Array.isArray(seed.keyPoints) || seed.keyPoints.length < 5) {
    errors.push('weak keyPoints');
  }

  if (!seed.trendContext || typeof seed.trendContext !== 'object') {
    errors.push('missing trendContext');
  } else {
    if (!normalizeText(seed.trendContext.contextDate)) {
      errors.push('missing contextDate');
    }

    if (!normalizeText(seed.trendContext.changeReason)) {
      errors.push('missing changeReason');
    }
  }

  if (!normalizeText(seed.fingerprint) || !normalizeText(seed.fingerprint).startsWith('fp1:')) {
    errors.push('bad fingerprint');
  }

  if (!seed.selectionMeta || typeof seed.selectionMeta !== 'object') {
    errors.push('missing selectionMeta');
  } else {
    if (!normalizeText(seed.selectionMeta.rawConceptKey)) {
      errors.push('missing rawConceptKey');
    }

    if (!normalizeText(seed.selectionMeta.rawFingerprint)) {
      errors.push('missing rawFingerprint');
    }
  }

  if (!seed.selectionCriteria || typeof seed.selectionCriteria !== 'object') {
    errors.push('missing selectionCriteria');
  } else {
    if (seed.selectionCriteria.entityCandidateValidated !== true) {
      errors.push('missing entityCandidateValidated');
    }

    if (seed.selectionCriteria.hasAngle !== true) {
      errors.push('missing hasAngle');
    }

    if (seed.selectionCriteria.hasAudience !== true) {
      errors.push('missing hasAudience');
    }
  }

  return [
    ...errors,
    ...validateWithSeedDesignPolicy(seed),
  ];
}

function buildSeedId(seed, index) {
  const concept = normalizeText(
    seed.selectionMeta && seed.selectionMeta.rawConceptKey
  )
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const shortFp = normalizeText(seed.fingerprint)
    .replace(/^fp1:/, '')
    .slice(0, 10);

  return [
    'trend-auto',
    concept || 'unknown-concept',
    shortFp || String(index + 1).padStart(3, '0'),
  ]
    .filter(Boolean)
    .join('-');
}

function normalizeSeedForWarehouse(seed, index) {
  const cloned = JSON.parse(JSON.stringify(seed));

  cloned.id = normalizeText(cloned.id) || buildSeedId(cloned, index);
  cloned.source = normalizeText(cloned.source) || 'auto-trend-signal';
  cloned.priority = normalizeText(cloned.priority) || 'normal';
  cloned.createdAt = normalizeText(cloned.createdAt) || new Date().toISOString();
  cloned.updatedAt = new Date().toISOString();

  cloned.selectionMeta = {
    ...(cloned.selectionMeta || {}),
    injectedAt: new Date().toISOString(),
    injectedBy: 'trend-seed-injector',
  };

  return cloned;
}

function loadInputSeeds() {
  const data = readJsonSafe(INPUT_FILE, null);

  if (!data || typeof data !== 'object') {
    return {
      data: null,
      seeds: [],
      errors: ['missing trend-seeds input'],
    };
  }

  const seeds = Array.isArray(data.seeds) ? data.seeds : [];

  return {
    data,
    seeds,
    errors: [],
  };
}

function injectSeeds() {
  const input = loadInputSeeds();
  const now = new Date().toISOString();

  const report = {
    startedAt: now,
    finishedAt: null,
    inputFile: INPUT_FILE,
    warehouseDir: WAREHOUSE_TREND_DIR,
    checked: 0,
    valid: 0,
    inserted: 0,
    skippedDuplicate: 0,
    rejected: 0,
    fpCacheMarked: 0,
    targetFiles: {},
    errors: [],
    rejectedItems: [],
    insertedItems: [],
    skippedItems: [],
  };

  if (input.errors.length > 0) {
    report.errors.push(...input.errors);
    report.finishedAt = new Date().toISOString();
    writeJsonAtomic(REPORT_FILE, report);
    return report;
  }

  const byLabel = new Map();

  input.seeds.forEach((seed, index) => {
    report.checked++;

    const errors = validateSeed(seed);

    if (errors.length > 0) {
      report.rejected++;
      report.rejectedItems.push({
        index,
        title: normalizeText(seed && seed.title),
        fingerprint: normalizeText(seed && seed.fingerprint),
        errors,
      });
      return;
    }

    report.valid++;

    const label = normalizeText(seed.label) || DEFAULT_LABEL;

    if (!byLabel.has(label)) {
      byLabel.set(label, []);
    }

    byLabel.get(label).push({
      seed,
      index,
    });
  });

  for (const [label, rows] of byLabel.entries()) {
    const file = getWarehouseFile(label);
    const warehouseData = normalizeWarehouseShape(
      readJsonSafe(file, null),
      label
    );

    const existingFingerprints = buildExistingFingerprintSet(warehouseData);
    const targetSeeds = getWarehouseSeeds(warehouseData);

    if (!report.targetFiles[label]) {
      report.targetFiles[label] = {
        file,
        before: targetSeeds.length,
        after: targetSeeds.length,
        inserted: 0,
        skippedDuplicate: 0,
      };
    }

    for (const row of rows) {
      const seed = normalizeSeedForWarehouse(row.seed, row.index);
      const fingerprint = normalizeText(seed.fingerprint);

      if (
        existingFingerprints.has(fingerprint) ||
        hasFpCacheUsed(fingerprint)
      ) {
        report.skippedDuplicate++;
        report.targetFiles[label].skippedDuplicate++;
        report.skippedItems.push({
          id: normalizeText(seed.id),
          title: normalizeText(seed.title),
          fingerprint,
          reason: 'duplicate fingerprint',
        });
        continue;
      }

      targetSeeds.push(seed);
      existingFingerprints.add(fingerprint);

      report.inserted++;
      report.targetFiles[label].inserted++;
      report.insertedItems.push({
        id: normalizeText(seed.id),
        title: normalizeText(seed.title),
        fingerprint,
        targetFile: file,
      });

      if (markFpCache(seed)) {
        report.fpCacheMarked++;
      }
    }

    warehouseData.trend = targetSeeds;
    warehouseData.updatedAt = new Date().toISOString();

    report.targetFiles[label].after = targetSeeds.length;

    writeJsonAtomic(file, warehouseData);
  }

  report.finishedAt = new Date().toISOString();

  writeJsonAtomic(REPORT_FILE, report);

  return report;
}

function main() {
  const report = injectSeeds();

  console.log('[trend-seed-injector] input    =', INPUT_FILE);
  console.log('[trend-seed-injector] checked  =', report.checked);
  console.log('[trend-seed-injector] valid    =', report.valid);
  console.log('[trend-seed-injector] inserted =', report.inserted);
  console.log('[trend-seed-injector] dup      =', report.skippedDuplicate);
  console.log('[trend-seed-injector] rejected =', report.rejected);
  console.log('[trend-seed-injector] report   =', REPORT_FILE);
}

if (require.main === module) {
  main();
}

module.exports = {
  injectSeeds,
  validateSeed,
  normalizeSeedForWarehouse,
};
