#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/trend-seed-to-queue.cjs
 *
 * 역할:
 * - dist/trend-seeds/trend-seeds.json 의 trend seed를 기존 AOIA queue 구조로 변환한다.
 * - 신규 trend entity가 기존 queue-to-posts → generate-body → generate-content 흐름에 합류할 수 있게 한다.
 *
 * 입력:
 * - System_files/dist/trend-seeds/trend-seeds.json
 *
 * 출력:
 * - System_files/dist/queue/trend.today.json
 *
 * 원칙:
 * - 기존 dist/queue/today.json 직접 수정 금지
 * - 기존 seedpool/warehouse 직접 수정 금지
 * - queue-to-posts.cjs가 읽을 수 있는 구조로만 변환
 * - trend seed의 sourceTrace / rawConceptKey / rawFingerprint / classificationHints / evidence / trust 보존
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

const OUT_DIR = path.join(
  ROOT,
  'dist',
  'queue'
);

const OUT_FILE = path.join(
  OUT_DIR,
  'trend.today.json'
);

const DEFAULT_CUTOFF = '10:00';
const DEFAULT_LABEL = 'device-reviews';
const QUEUE_SCHEMA_VERSION = 'trend-queue.v1';

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

function getKstDateString(date) {
  const formatter = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }
  );

  return formatter.format(date);
}

function normalizeLabel(seed) {
  return normalizeText(seed && seed.label) || DEFAULT_LABEL;
}

function normalizeMode(seed) {
  return normalizeText(seed && seed.mode) || 'trend';
}

function normalizeIntent(seed) {
  return normalizeText(seed && seed.intent) || 'review/update';
}

function normalizeEntityName(seed) {
  return normalizeText(seed && seed.entity && seed.entity.name);
}

function normalizeTitle(seed) {
  return normalizeText(seed && seed.title);
}

function normalizeFingerprint(seed) {
  return normalizeText(seed && seed.fingerprint);
}

function buildQueueId(seed, index) {
  const rawConceptKey = normalizeText(
    seed &&
    seed.selectionMeta &&
    seed.selectionMeta.rawConceptKey
  )
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const shortFp = normalizeFingerprint(seed)
    .replace(/^fp1:/, '')
    .slice(0, 10);

  return [
    'trend',
    rawConceptKey || 'unknown-concept',
    shortFp || String(index + 1).padStart(3, '0'),
  ]
    .filter(Boolean)
    .join('-');
}

function buildBodyPrompt(seed) {
  const entityName = normalizeEntityName(seed);
  const title = normalizeTitle(seed);
  const label = normalizeLabel(seed);
  const intent = normalizeIntent(seed);
  const angle = normalizeText(seed && seed.angle);
  const audience = normalizeText(seed && seed.audience);
  const goal = normalizeText(seed && seed.goal);
  const trendContext = seed && seed.trendContext && typeof seed.trendContext === 'object'
    ? seed.trendContext
    : {};
  const changeReason = normalizeText(trendContext.changeReason);
  const contextDate = normalizeText(trendContext.contextDate);
  const keyPoints = Array.isArray(seed && seed.keyPoints)
    ? seed.keyPoints.map(normalizeText).filter(Boolean)
    : [];

  const unknowns = Array.isArray(trendContext.evidenceUnknowns)
    ? trendContext.evidenceUnknowns.map(normalizeText).filter(Boolean)
    : [];

  return [
    `Title: ${title}`,
    `Label: ${label}`,
    `Intent: ${intent}`,
    `Entity: ${entityName}`,
    `Angle: ${angle}`,
    `Audience: ${audience}`,
    `Goal: ${goal}`,
    `TrendContextDate: ${contextDate}`,
    `TrendChangeReason: ${changeReason}`,
    `Guidance: Write this as a time-stamped trend review for a newly detected or recently changed device entity. Keep claims cautious, separate confirmed evidence from unknowns, and explain what the reader should verify before deciding.`,
    keyPoints.length > 0
      ? `KeyPoints: ${keyPoints.join(' | ')}`
      : '',
    unknowns.length > 0
      ? `UnknownsToVerify: ${unknowns.join(' | ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function validateSeed(seed) {
  const errors = [];

  if (!seed || typeof seed !== 'object') {
    return ['invalid seed object'];
  }

  if (normalizeText(seed.schemaVersion) !== 'trend-seeds.v1') {
    errors.push('bad seed schemaVersion');
  }

  if (!normalizeTitle(seed)) {
    errors.push('missing title');
  }

  if (!normalizeEntityName(seed)) {
    errors.push('missing entity.name');
  }

  if (!normalizeIntent(seed)) {
    errors.push('missing intent');
  }

  if (!normalizeFingerprint(seed).startsWith('fp1:')) {
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

  if (!seed.seedMeta || typeof seed.seedMeta !== 'object') {
    errors.push('missing seedMeta');
  } else if (normalizeText(seed.seedMeta.sourceLayer) !== 'entity-candidate-bridge') {
    errors.push('bad sourceLayer');
  }

  if (!Array.isArray(seed.keyPoints) || seed.keyPoints.length < 5) {
    errors.push('weak keyPoints');
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

  return errors;
}

function buildQueueItem(seed, index, queueDate, cutoff) {
  const label = normalizeLabel(seed);
  const intent = normalizeIntent(seed);
  const title = normalizeTitle(seed);
  const entityName = normalizeEntityName(seed);

  return {
    id: buildQueueId(seed, index),
    source: 'trend-seed-to-queue',
    mode: 'trend',
    label,
    title,
    intent,
    goal: normalizeText(seed.goal),
    angle: normalizeText(seed.angle),
    audience: normalizeText(seed.audience),
    bodyPrompt: buildBodyPrompt(seed),
    queueDate,
    cutoff,

    entity: seed.entity || {},
    reviewEntity: seed.reviewEntity || seed.entity || {},

    keyPoints: Array.isArray(seed.keyPoints)
      ? seed.keyPoints
      : [],

    trendContext: seed.trendContext || {},

    fingerprint: normalizeFingerprint(seed),

    seedMeta: {
      id: buildQueueId(seed, index),
      label,
      mode: 'trend',
      intent,
      sourceLayer: 'trend-seed-builder',
      upstreamSourceLayer: normalizeText(
        seed.seedMeta && seed.seedMeta.sourceLayer
      ),
      trendSeedSchemaVersion: normalizeText(seed.schemaVersion),
      rawConceptKey: normalizeText(
        seed.selectionMeta && seed.selectionMeta.rawConceptKey
      ),
      rawFingerprint: normalizeText(
        seed.selectionMeta && seed.selectionMeta.rawFingerprint
      ),
      rawSimilarityGroup: normalizeText(
        seed.selectionMeta && seed.selectionMeta.rawSimilarityGroup
      ),
      sourceDomain: normalizeText(
        seed.selectionMeta && seed.selectionMeta.sourceDomain
      ),
      trustConfidence: normalizeText(
        seed.selectionMeta && seed.selectionMeta.trustConfidence
      ),
      trustScore:
        seed.selectionMeta &&
        Number.isFinite(Number(seed.selectionMeta.trustScore))
          ? Number(seed.selectionMeta.trustScore)
          : null,
      queueDate,
      cutoff,
      entityName,
      fingerprint: normalizeFingerprint(seed),
      classificationHints:
        seed.seedMeta && seed.seedMeta.classificationHints
          ? seed.seedMeta.classificationHints
          : {},
      evidence:
        seed.seedMeta && seed.seedMeta.evidence
          ? seed.seedMeta.evidence
          : {},
      trust:
        seed.seedMeta && seed.seedMeta.trust
          ? seed.seedMeta.trust
          : {},
    },
  };
}

function loadTrendSeeds() {
  const data = readJsonSafe(INPUT_FILE, null);

  if (!data || typeof data !== 'object') {
    return {
      data: null,
      seeds: [],
      errors: ['missing trend-seeds input'],
    };
  }

  if (normalizeText(data.schemaVersion) !== 'trend-seeds.v1') {
    return {
      data,
      seeds: [],
      errors: ['bad trend-seeds schemaVersion'],
    };
  }

  const seeds = Array.isArray(data.seeds)
    ? data.seeds
    : [];

  return {
    data,
    seeds,
    errors: [],
  };
}

function buildTrendQueue(options) {
  const opts = options && typeof options === 'object'
    ? options
    : {};

  const now = new Date();
  const queueDate = normalizeText(opts.queueDate) || getKstDateString(now);
  const cutoff = normalizeText(opts.cutoff) || DEFAULT_CUTOFF;

  const input = loadTrendSeeds();

  const report = {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    inputFile: INPUT_FILE,
    outputFile: OUT_FILE,
    queueDate,
    cutoff,
    checked: 0,
    queued: 0,
    rejected: 0,
    errors: [],
    rejectedItems: [],
  };

  if (input.errors.length > 0) {
    report.errors.push(...input.errors);
  }

  const items = [];

  input.seeds.forEach((seed, index) => {
    report.checked++;

    const errors = validateSeed(seed);

    if (errors.length > 0) {
      report.rejected++;
      report.rejectedItems.push({
        index,
        title: normalizeTitle(seed),
        fingerprint: normalizeFingerprint(seed),
        errors,
      });
      return;
    }

    items.push(
      buildQueueItem(seed, index, queueDate, cutoff)
    );

    report.queued++;
  });

  const output = {
    schema: 'AOIA',
    schemaVersion: QUEUE_SCHEMA_VERSION,
    type: 'trendQueue',
    source: 'trend-seed-to-queue',
    generatedAt: now.toISOString(),
    queueDate,
    cutoff,
    items,
    report,
  };

  writeJsonAtomic(OUT_FILE, output);

  return output;
}

function main() {
  const queueDate =
    normalizeText(process.env.TREND_QUEUE_DATE) ||
    normalizeText(process.argv[2]);

  const cutoff =
    normalizeText(process.env.TREND_QUEUE_CUTOFF) ||
    normalizeText(process.argv[3]);

  const output = buildTrendQueue({
    queueDate,
    cutoff,
  });

  console.log('[trend-seed-to-queue] input   =', INPUT_FILE);
  console.log('[trend-seed-to-queue] output  =', OUT_FILE);
  console.log('[trend-seed-to-queue] checked =', output.report.checked);
  console.log('[trend-seed-to-queue] queued  =', output.report.queued);
  console.log('[trend-seed-to-queue] rejected=', output.report.rejected);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildTrendQueue,
  buildQueueItem,
  validateSeed,
};
