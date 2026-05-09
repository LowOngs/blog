'use strict';

/**
 * trend-seed-builder.cjs
 *
 * 역할:
 * - raw trend signal → seed 생성
 * - entity-candidate-bridge 출력 계약(entity-candidates.json)을 읽어 trend seed 생성
 * - trendReadyCandidates / passOnly 기반으로 pass 후보만 seed 생성
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { processCandidates } = require('./validate-entity-candidates.cjs');
const { buildEntityCandidate } = require('./lib/entity-candidate-policy.cjs');

const ROOT = path.resolve(__dirname, '../..');

const ENTITY_CANDIDATES_FILE = path.join(
  ROOT,
  'dist',
  'entity-candidates',
  'entity-candidates.json'
);

const OUT_DIR = path.join(
  ROOT,
  'dist',
  'trend-seeds'
);

const OUT_JSON = path.join(
  OUT_DIR,
  'trend-seeds.json'
);

const INTENTS = [
  'review/update',
  'review/recheck',
  'review/compare-now',
  'review/still-worth',
  'review/switch-or-keep',
  'review/risk-watch'
];

function pickIntent(index) {
  return INTENTS[index % INTENTS.length];
}

function normalizeText(v) {
  return String(v || '').trim();
}

function ensureDir(p) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;

    const raw = fs.readFileSync(file, 'utf8').trim();

    if (!raw) return fallback;

    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonPretty(file, data) {
  ensureDir(path.dirname(file));

  fs.writeFileSync(
    file,
    `${JSON.stringify(data, null, 2)}\n`,
    'utf8'
  );
}

function buildTrendContext(signal, index) {
  const month = String((index % 12) + 1).padStart(2, '0');

  return {
    contextDate: `2026-${month}`,
    changeReason: normalizeText(signal.reason) || 'market change',
    timing: `2026-Q${(index % 4) + 1}`,
    historicalValue: true
  };
}

function buildTrendContextFromCandidate(candidate, index) {
  const existing = candidate.trendContext || {};
  const rawSignalContext = candidate.rawSignalContext || {};
  const noveltyType = normalizeText(rawSignalContext.noveltyType);
  const month = String((index % 12) + 1).padStart(2, '0');

  return {
    contextDate:
      normalizeText(existing.contextDate) ||
      `2026-${month}`,

    changeReason:
      normalizeText(existing.changeReason) ||
      (noveltyType === 'new-category'
        ? 'new device category emergence'
        : 'market change'),

    timing:
      normalizeText(existing.timing) ||
      `2026-Q${(index % 4) + 1}`,

    historicalValue:
      existing.historicalValue !== false,

    sourceType: 'entity-candidate-bridge',
    candidateReady: true
  };
}

function buildDecisionType(intent) {
  if (intent === 'review/compare-now') return 'compare';
  if (intent === 'review/still-worth') return 'keep';
  if (intent === 'review/switch-or-keep') return 'keep-or-switch';
  if (intent === 'review/risk-watch') return 'watch';
  return 'test';
}

function buildDecisionSummary(entityName, reason) {
  return `${entityName} should be re-evaluated because ${reason} may affect current usage decisions.`;
}

function buildFingerprint(seed) {
  const src = [
    seed.title,
    seed.intent,
    seed.entity.name,
    seed.trendContext.contextDate,
    seed.trendContext.changeReason
  ].join('|');

  return 'fp1:' + crypto.createHash('sha1').update(src).digest('hex');
}

function buildTitle(intent, name, reason) {
  if (intent === 'review/update') return `What changed in ${name} after ${reason}?`;
  if (intent === 'review/recheck') return `Should you recheck ${name} after recent changes?`;
  if (intent === 'review/compare-now') return `How does ${name} compare now after ${reason}?`;
  if (intent === 'review/still-worth') return `Is ${name} still worth using after ${reason}?`;
  if (intent === 'review/switch-or-keep') return `Should you keep using ${name} after ${reason}?`;
  if (intent === 'review/risk-watch') return `What risks should users watch in ${name} after ${reason}?`;
  return `Should you recheck ${name}?`;
}

function buildSeedFromCandidate(candidate, signal, index) {
  const intent = pickIntent(index);
  const entity = candidate.entity;

  const trendContext = buildTrendContext(signal, index);
  const decisionType = buildDecisionType(intent);

  const seed = {
    entity,
    reviewEntity: entity,
    intent,
    title: buildTitle(intent, entity.name, trendContext.changeReason),
    goal: `evaluate ${entity.name} after ${trendContext.changeReason}`,
    decisionType,
    decisionSummary: buildDecisionSummary(entity.name, trendContext.changeReason),
    keyPoints: candidate.keyPoints,
    trendContext,
    selectionCriteria: {
      trend: true,
      entityDistributed: true
    },
    selectionMeta: {
      source: 'trend-seed-builder',
      createdAt: new Date().toISOString()
    }
  };

  seed.fingerprint = buildFingerprint(seed);

  return seed;
}

function buildSeedFromReadyCandidate(candidate, index) {
  const intent = pickIntent(index);
  const entity = candidate.entity || {};
  const sourceTrace = candidate.sourceTrace || {};
  const rawSignalContext = candidate.rawSignalContext || {};
  const trust = candidate.trust || rawSignalContext.trust || {};
  const classificationHints =
    candidate.classificationHints ||
    rawSignalContext.classificationHints ||
    {};
  const evidence =
    candidate.evidence ||
    rawSignalContext.evidence ||
    {};
  const validation = candidate.validation || {};

  const trendContext = buildTrendContextFromCandidate(candidate, index);
  const decisionType = buildDecisionType(intent);

  const seed = {
    entity,
    reviewEntity: entity,
    intent,
    title: buildTitle(intent, entity.name, trendContext.changeReason),
    goal: `evaluate ${entity.name} after ${trendContext.changeReason}`,
    decisionType,
    decisionSummary: buildDecisionSummary(entity.name, trendContext.changeReason),
    keyPoints: Array.isArray(candidate.keyPoints) ? candidate.keyPoints : [],
    trendContext,
    selectionCriteria: {
      trend: true,
      entityDistributed: true,
      entityCandidateValidated: true,
      bridgeOutputContract: true,
      trustReady: normalizeText(sourceTrace.trustConfidence) !== 'low',
      sourceTraceRequired: true
    },
    selectionMeta: {
      source: 'trend-seed-builder',
      inputSource: 'entity-candidates.json',
      bridgeSchemaVersion: normalizeText(candidate.schemaVersion),
      rawFingerprint: normalizeText(sourceTrace.rawFingerprint),
      rawConceptKey: normalizeText(sourceTrace.rawConceptKey),
      rawSimilarityGroup: normalizeText(sourceTrace.rawSimilarityGroup),
      sourceDomain: normalizeText(sourceTrace.sourceDomain),
      trustConfidence: normalizeText(sourceTrace.trustConfidence),
      trustScore:
        Number.isFinite(Number(sourceTrace.trustScore))
          ? Number(sourceTrace.trustScore)
          : null,
      validationStatus: normalizeText(validation.status),
      validationReason: normalizeText(validation.reason),
      createdAt: new Date().toISOString()
    },
    seedMeta: {
      sourceLayer: 'entity-candidate-bridge',
      candidateType: normalizeText(candidate.type),
      candidateStatus: normalizeText(candidate.status),
      label: normalizeText(candidate.label) || 'device-reviews',
      mode: normalizeText(candidate.mode) || 'trend',
      classificationHints,
      evidence,
      trust
    }
  };

  seed.fingerprint = buildFingerprint(seed);

  return seed;
}

function pickSeedInputCandidates(entityCandidatesData) {
  if (!entityCandidatesData || typeof entityCandidatesData !== 'object') {
    return [];
  }

  if (Array.isArray(entityCandidatesData.trendReadyCandidates)) {
    return entityCandidatesData.trendReadyCandidates;
  }

  if (Array.isArray(entityCandidatesData.passOnly)) {
    return entityCandidatesData.passOnly;
  }

  if (Array.isArray(entityCandidatesData.pass)) {
    return entityCandidatesData.pass;
  }

  return [];
}

function buildTrendSeedsFromEntityCandidatesData(entityCandidatesData) {
  const candidates = pickSeedInputCandidates(entityCandidatesData);
  const seeds = [];

  let index = 0;

  for (const candidate of candidates) {
    const validation = candidate.validation || {};

    if (normalizeText(validation.status) && validation.status !== 'pass') {
      continue;
    }

    const seed = buildSeedFromReadyCandidate(candidate, index);
    seeds.push(seed);
    index++;
  }

  return {
    seeds,
    summary: {
      inputSchemaVersion: normalizeText(entityCandidatesData.schemaVersion),
      totalCandidates: candidates.length,
      seeds: seeds.length,
      source: 'entity-candidates.json'
    }
  };
}

function buildTrendSeedsFromEntityCandidatesFile(filePath) {
  const sourceFile = filePath || ENTITY_CANDIDATES_FILE;
  const data = readJsonSafe(sourceFile, null);
  const result = buildTrendSeedsFromEntityCandidatesData(data);

  return {
    ...result,
    sourceFile
  };
}

/**
 * 기존 main builder
 * - 기존 테스트/직접 호출 호환용으로 유지
 */
function buildTrendSeeds(signals) {
  const candidates = [];

  for (const signal of signals) {
    const candidate = buildEntityCandidate(signal);
    if (candidate) candidates.push(candidate);
  }

  const validated = processCandidates(candidates);

  const seeds = [];
  let index = 0;

  for (const item of validated.pass) {
    const seed = buildSeedFromCandidate(item, signals[index], index);
    seeds.push(seed);
    index++;
  }

  return {
    seeds,
    summary: validated.summary
  };
}

function main() {
  const result = buildTrendSeedsFromEntityCandidatesFile(
    ENTITY_CANDIDATES_FILE
  );

  const output = {
    schemaVersion: 'trend-seeds.v1',
    generatedAt: new Date().toISOString(),
    sourceFile: result.sourceFile,
    summary: result.summary,
    seeds: result.seeds
  };

  writeJsonPretty(OUT_JSON, output);

  console.log('[trend-seed-builder] source =', result.sourceFile);
  console.log('[trend-seed-builder] seeds  =', result.seeds.length);
  console.log('[trend-seed-builder] saved  =', OUT_JSON);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildTrendSeeds,
  buildTrendSeedsFromEntityCandidatesData,
  buildTrendSeedsFromEntityCandidatesFile,
  buildSeedFromReadyCandidate
};
