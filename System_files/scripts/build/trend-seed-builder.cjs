'use strict';

/**
 * trend-seed-builder.cjs
 *
 * 역할:
 * - raw trend signal → seed 생성
 * - entity-candidate-bridge 출력 계약(entity-candidates.json)을 읽어 trend seed 생성
 * - trendReadyCandidates / passOnly 기반으로 pass 후보만 seed 생성
 * - pass 후보 기반으로 실제 글 생성 가능한 trend seed 구조를 안정화한다.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { processCandidates } = require('./validate-entity-candidates.cjs');
const { buildEntityCandidate } = require('./lib/entity-candidate-policy.cjs');

const ROOT = path.resolve(__dirname, '../..');

const ENTITY_CANDIDATES_FILE =
  process.env.ENTITY_CANDIDATES_FILE ||
  path.join(
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

const TREND_SEED_SCHEMA_VERSION = 'trend-seeds.v1';

const INTENTS = [
  'review/update',
  'review/recheck',
  'review/compare-now',
  'review/still-worth',
  'review/switch-or-keep',
  'review/risk-watch'
];

const REAL_WORLD_EXISTENCE_PASS_STATUSES = new Set([
  'confirmed',
  'announced',
  'prototype',
  'patent'
]);

function pickIntent(index) {
  return INTENTS[index % INTENTS.length];
}

function normalizeText(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

function normalizeLower(v) {
  return normalizeText(v).toLowerCase();
}

function getRealityGate(candidate) {
  if (candidate && candidate.realityGate && typeof candidate.realityGate === 'object') {
    return candidate.realityGate;
  }

  if (
    candidate &&
    candidate.rawSignalContext &&
    candidate.rawSignalContext.realityGate &&
    typeof candidate.rawSignalContext.realityGate === 'object'
  ) {
    return candidate.rawSignalContext.realityGate;
  }

  return null;
}

function isRealityGatePass(candidate) {
  const gate = getRealityGate(candidate);

  if (!gate) return false;

  const status = normalizeLower(gate.status);
  const decision = normalizeLower(gate.decision);

  return decision === 'pass' && REAL_WORLD_EXISTENCE_PASS_STATUSES.has(status);
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

function uniqueArray(values) {
  const out = [];
  const seen = new Set();

  for (const value of values || []) {
    const text = normalizeText(value);

    if (!text) continue;

    const key = text.toLowerCase();

    if (seen.has(key)) continue;

    seen.add(key);
    out.push(text);
  }

  return out;
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
  const evidence = candidate.evidence || rawSignalContext.evidence || {};
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
    candidateReady: true,
    evidenceUnknowns: Array.isArray(evidence.unknowns)
      ? evidence.unknowns
      : []
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
    seed.schemaVersion,
    seed.title,
    seed.intent,
    seed.entity.name,
    seed.angle,
    seed.audience,
    seed.trendContext.contextDate,
    seed.trendContext.changeReason,
    seed.selectionMeta.rawConceptKey
  ].join('|');

  return 'fp1:' + crypto.createHash('sha1').update(src).digest('hex');
}

function buildTitleSignals(classificationHints, evidence, trendContext) {
  const hints = classificationHints || {};
  const categoryHints = hints.categoryHints || {};
  const interactionHints = hints.interactionHints || {};
  const hardwareHints = hints.hardwareHints || {};
  const maturityHints = hints.maturityHints || {};
  const ecosystemHints = hints.ecosystemHints || {};

  const useCases = Array.isArray(evidence && evidence.useCases)
    ? evidence.useCases.map(normalizeText).filter(Boolean)
    : [];

  const unknowns = Array.isArray(evidence && evidence.unknowns)
    ? evidence.unknowns.map(normalizeText).filter(Boolean)
    : [];

  return {
    emergingCategory: normalizeText(categoryHints.emergingCategory),
    primaryCategory: normalizeText(categoryHints.primaryCategory),
    interactionModel: normalizeText(interactionHints.interactionModel),
    inputMethod: normalizeText(interactionHints.inputMethod),
    feedbackMethod: normalizeText(interactionHints.feedbackMethod),
    formFactor: normalizeText(hints.formFactor),
    connectivity: normalizeText(hints.connectivity || ecosystemHints.dependencyType),
    marketStage: normalizeText(maturityHints.marketStage),
    evidenceLevel: normalizeText(maturityHints.evidenceLevel),
    wearable: !!hardwareHints.wearable,
    requiresProjection: !!hardwareHints.requiresProjection,
    useCase: useCases[0] || '',
    unknown: unknowns[0] || '',
    changeReason: normalizeText(trendContext && trendContext.changeReason)
  };
}

function compactReason(reason) {
  const r = normalizeText(reason);
  if (!r) return 'recent changes';

  return r
    .replace(/\bnew\s+device\s+category\s+emergence\b/i, 'a new device category signal')
    .replace(/\bmarket\s+change\b/i, 'recent market changes');
}

function pickTitlePattern(intent, index, signals) {
  const s = signals || {};
  const n = Number.isFinite(Number(index)) ? Number(index) : 0;
  const pool = [];

  if (s.requiresProjection || /holographic|projection/i.test(`${s.interactionModel} ${s.emergingCategory}`)) {
    pool.push('verification');
    pool.push('concept-reality');
  }

  if (s.useCase) pool.push('use-case');
  if (s.unknown) pool.push('concern');
  if (s.marketStage) pool.push('market-position');
  if (s.inputMethod || s.interactionModel) pool.push('comparison');
  if (intent === 'review/risk-watch') pool.push('risk-watch');
  if (intent === 'review/compare-now') pool.push('comparison');
  if (intent === 'review/switch-or-keep') pool.push('watch-or-wait');
  if (intent === 'review/still-worth') pool.push('still-worth-cautious');

  pool.push('future-impact');
  pool.push('update');

  return pool[n % pool.length];
}

function buildTitle(intent, name, reason, classificationHints = {}, evidence = {}, trendContext = {}, index = 0) {
  const targetName = normalizeText(name) || 'this device';
  const signals = buildTitleSignals(classificationHints, evidence, trendContext);
  const safeReason = compactReason(signals.changeReason || reason);
  const category =
    signals.emergingCategory ||
    signals.primaryCategory ||
    'device category';
  const interaction =
    signals.inputMethod ||
    signals.interactionModel ||
    'input method';
  const useCase = signals.useCase || 'real use';
  const unknown = signals.unknown || 'key unknowns';
  const pattern = pickTitlePattern(intent, index, signals);

  if (pattern === 'verification') {
    return `${targetName}: what to verify before treating it as a real option`;
  }

  if (pattern === 'concept-reality') {
    return `${targetName} and the gap between concept promise and daily use`;
  }

  if (pattern === 'use-case') {
    return `${targetName} for ${useCase}: early signals and limits`;
  }

  if (pattern === 'concern') {
    return `${targetName}: why ${unknown} still matters before any recommendation`;
  }

  if (pattern === 'market-position') {
    return `${targetName} as a ${signals.marketStage} ${category} candidate`;
  }

  if (pattern === 'comparison') {
    return `${targetName} versus familiar input options: what changes in the decision`;
  }

  if (pattern === 'risk-watch') {
    return `${targetName}: risks to watch before trusting the ${interaction}`;
  }

  if (pattern === 'watch-or-wait') {
    return `${targetName}: watch the category or wait for proof?`;
  }

  if (pattern === 'still-worth-cautious') {
    return `${targetName}: still worth attention if the unknowns remain open?`;
  }

  if (pattern === 'future-impact') {
    return `Could ${targetName} change how users think about ${category}?`;
  }

  if (intent === 'review/update') {
    return `${targetName}: what ${safeReason} changes for buyers`;
  }

  if (intent === 'review/recheck') {
    return `${targetName}: a fresh look after ${safeReason}`;
  }

  if (intent === 'review/compare-now') {
    return `${targetName}: what to compare after ${safeReason}`;
  }

  if (intent === 'review/still-worth') {
    return `${targetName}: still worth considering after ${safeReason}?`;
  }

  if (intent === 'review/switch-or-keep') {
    return `${targetName}: keep watching or choose a safer alternative?`;
  }

  if (intent === 'review/risk-watch') {
    return `${targetName}: what risks users should verify after ${safeReason}`;
  }

  return `${targetName}: early signals, limits, and buyer questions`;
}

function buildRealityStageTitle(intent, name, reason, classificationHints = {}, evidence = {}, trendContext = {}, realityGate = {}, index = 0) {
  const status = normalizeLower(realityGate && realityGate.status);
  const targetName = normalizeText(name) || 'this device';

  if (status === 'confirmed') {
    return buildTitle(intent, targetName, reason, classificationHints, evidence, trendContext, index);
  }

  if (status === 'announced') {
    return `${targetName}: what to check before launch`;
  }

  if (status === 'prototype') {
    return `${targetName}: what the prototype proves and still leaves open`;
  }

  if (status === 'patent') {
    return `${targetName}: what the patent suggests and what remains uncertain`;
  }

  return buildTitle(intent, targetName, reason, classificationHints, evidence, trendContext, index);
}

function buildAngle(intent, entityName, reason, classificationHints) {
  const categoryHints = classificationHints.categoryHints || {};
  const interactionHints = classificationHints.interactionHints || {};

  const emergingCategory = normalizeText(categoryHints.emergingCategory);
  const interactionModel = normalizeText(interactionHints.interactionModel);

  if (intent === 'review/update') {
    return `Explain what changed around ${entityName} and why the ${reason} matters for current users.`;
  }

  if (intent === 'review/recheck') {
    return `Recheck ${entityName} as a current decision item, focusing on whether ${reason} changes the original recommendation.`;
  }

  if (intent === 'review/compare-now') {
    return `Compare ${entityName} against current alternatives, especially where ${interactionModel || emergingCategory || 'the new device model'} changes user expectations.`;
  }

  if (intent === 'review/still-worth') {
    return `Judge whether ${entityName} is still worth considering after ${reason}, with attention to practical usage risk.`;
  }

  if (intent === 'review/switch-or-keep') {
    return `Help users decide whether to keep watching ${entityName} or move toward a safer alternative.`;
  }

  if (intent === 'review/risk-watch') {
    return `Identify the main risks users should verify before trusting ${entityName} as a new device category.`;
  }

  return `Review ${entityName} as a time-stamped device decision record.`;
}

function buildAudience(entity, classificationHints) {
  const categoryHints = classificationHints.categoryHints || {};
  const interactionHints = classificationHints.interactionHints || {};
  const hardwareHints = classificationHints.hardwareHints || {};

  const primaryCategory = normalizeText(categoryHints.primaryCategory);
  const interactionModel = normalizeText(interactionHints.interactionModel);

  if (hardwareHints.wearable && primaryCategory === 'input-device') {
    return 'users considering wearable input devices for mobile or portable workflows';
  }

  if (interactionModel.includes('holographic')) {
    return 'users evaluating holographic or projection-based device interactions';
  }

  if (interactionModel.includes('gesture')) {
    return 'users considering gesture-based control devices';
  }

  if (primaryCategory) {
    return `users comparing ${primaryCategory} options before making a practical device decision`;
  }

  return `users evaluating whether ${entity.name} is worth attention`;
}

function buildGoal(intent, entityName, reason) {
  if (intent === 'review/update') {
    return `record what changed in ${entityName} and explain whether ${reason} changes the recommendation`;
  }

  if (intent === 'review/recheck') {
    return `decide whether ${entityName} deserves a fresh look after ${reason}`;
  }

  if (intent === 'review/compare-now') {
    return `compare ${entityName} with current alternatives after ${reason}`;
  }

  if (intent === 'review/still-worth') {
    return `decide whether ${entityName} is still worth considering after ${reason}`;
  }

  if (intent === 'review/switch-or-keep') {
    return `decide whether users should keep watching ${entityName} or consider alternatives`;
  }

  if (intent === 'review/risk-watch') {
    return `identify the main risks and unknowns around ${entityName}`;
  }

  return `evaluate ${entityName} after ${reason}`;
}

function normalizeKeyPoints(candidate, classificationHints, evidence, trendContext) {
  const categoryHints = classificationHints.categoryHints || {};
  const interactionHints = classificationHints.interactionHints || {};
  const hardwareHints = classificationHints.hardwareHints || {};
  const ecosystemHints = classificationHints.ecosystemHints || {};

  const base = Array.isArray(candidate.keyPoints)
    ? candidate.keyPoints
    : [];

  const evidenceFacts = Array.isArray(evidence.keyFacts)
    ? evidence.keyFacts
    : [];

  const useCases = Array.isArray(evidence.useCases)
    ? evidence.useCases
    : [];

  const unknowns = Array.isArray(evidence.unknowns)
    ? evidence.unknowns
    : [];

  const generated = [
    categoryHints.emergingCategory
      ? `emerging category: ${categoryHints.emergingCategory}`
      : '',

    interactionHints.interactionModel
      ? `interaction model: ${interactionHints.interactionModel}`
      : '',

    interactionHints.inputMethod
      ? `input method: ${interactionHints.inputMethod}`
      : '',

    hardwareHints.requiresProjection
      ? 'requires projection or holographic output'
      : '',

    ecosystemHints.dependencyType
      ? `ecosystem dependency: ${ecosystemHints.dependencyType}`
      : '',

    trendContext.changeReason
      ? `decision trigger: ${trendContext.changeReason}`
      : '',

    ...evidenceFacts.map((item) => `evidence: ${item}`),
    ...useCases.map((item) => `use case: ${item}`),
    ...unknowns.map((item) => `unknown to verify: ${item}`)
  ];

  return uniqueArray([
    ...base,
    ...generated
  ]).slice(0, 12);
}

function buildSeedFromCandidate(candidate, signal, index) {
  const intent = pickIntent(index);
  const entity = candidate.entity;

  const trendContext = buildTrendContext(signal, index);
  const decisionType = buildDecisionType(intent);

  const seed = {
    schemaVersion: TREND_SEED_SCHEMA_VERSION,
    label: 'device-reviews',
    mode: 'trend',
    entity,
    reviewEntity: entity,
    intent,
    title: buildTitle(intent, entity.name, trendContext.changeReason, {}, {}, trendContext, index),
    angle: `Review ${entity.name} as a time-stamped trend decision after ${trendContext.changeReason}.`,
    audience: `users evaluating whether ${entity.name} deserves attention now`,
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
  const realityGate = getRealityGate(candidate);

  const trendContext = buildTrendContextFromCandidate(candidate, index);
  const decisionType = buildDecisionType(intent);
  const angle = buildAngle(
    intent,
    entity.name,
    trendContext.changeReason,
    classificationHints
  );
  const audience = buildAudience(entity, classificationHints);
  const goal = buildGoal(
    intent,
    entity.name,
    trendContext.changeReason
  );
  const keyPoints = normalizeKeyPoints(
    candidate,
    classificationHints,
    evidence,
    trendContext
  );

  const seed = {
    schemaVersion: TREND_SEED_SCHEMA_VERSION,
    label: normalizeText(candidate.label) || 'device-reviews',
    mode: normalizeText(candidate.mode) || 'trend',

    entity,
    reviewEntity: entity,

    intent,
    title: buildRealityStageTitle(intent, entity.name, trendContext.changeReason, classificationHints, evidence, trendContext, realityGate, index),
    angle,
    audience,
    goal,
    decisionType,
    decisionSummary: buildDecisionSummary(entity.name, trendContext.changeReason),
    keyPoints,
    trendContext,

    selectionCriteria: {
      trend: true,
      entityDistributed: true,
      entityCandidateValidated: true,
      bridgeOutputContract: true,
      trustReady: normalizeText(sourceTrace.trustConfidence) !== 'low',
      sourceTraceRequired: true,
      hasAngle: !!angle,
      hasAudience: !!audience,
      hasEvidence: Array.isArray(evidence.keyFacts) && evidence.keyFacts.length > 0,
      hasUseCase: Array.isArray(evidence.useCases) && evidence.useCases.length > 0,
      realWorldExistenceRequired: true,
      realWorldExistencePass: isRealityGatePass(candidate)
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
      realityGateStatus: normalizeText(realityGate && realityGate.status),
      realityGateDecision: normalizeText(realityGate && realityGate.decision),
      realityGateEvidenceType: normalizeText(realityGate && realityGate.evidenceType),
      realityGateConfidence: normalizeText(realityGate && realityGate.confidence),
      realityGateSourceCount:
        Number.isFinite(Number(realityGate && realityGate.sourceCount))
          ? Number(realityGate.sourceCount)
          : null,
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
      trust,
      realityGate
    },
    realityGate
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

    if (!isRealityGatePass(candidate)) {
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
      source: 'entity-candidates.json',
      realWorldExistenceRequired: true
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
    schemaVersion: TREND_SEED_SCHEMA_VERSION,
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
  buildSeedFromReadyCandidate,
  buildAngle,
  buildAudience,
  normalizeKeyPoints,
  getRealityGate,
  isRealityGatePass,
  buildRealityStageTitle
};
