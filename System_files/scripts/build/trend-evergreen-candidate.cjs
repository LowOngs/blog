#!/usr/bin/env node
'use strict';

/**
 * ============================================================
 * System_files/scripts/build/trend-evergreen-candidate.cjs
 * ============================================================
 *
 * 역할:
 * - dist/trend-seeds/trend-seeds.json 을 읽어 evergreen 승격 후보를 선별한다.
 * - 실제 evergreen seedpool 주입은 하지 않는다.
 * - 출력은 dist/evergreen-candidates/evergreen-candidates.json 으로만 생성한다.
 *
 * 설계 원칙:
 * 1) trend seed 원본은 수정하지 않는다.
 * 2) seedpool/warehouse/evergreen 파일은 수정하지 않는다.
 * 3) 승격 후보 판정과 실제 주입 단계를 분리한다.
 * 4) evidence / trust / unknowns / marketStage 를 보존한다.
 * 5) 실존 불확실 대상은 evergreen 직행이 아니라 hold로 둔다.
 *
 * 파이프라인 위치:
 * raw-signal
 *   → entity-candidate
 *   → trend-seed-builder
 *   → trend-evergreen-candidate
 *   → trend-promote-evergreen (다음 단계)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ============================================================
 * paths
 * ============================================================ */
const ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_TREND_SEEDS_FILE = path.join(
  ROOT,
  'dist',
  'trend-seeds',
  'trend-seeds.json'
);

const EVERGREEN_CANDIDATES_DIR = path.join(
  ROOT,
  'dist',
  'evergreen-candidates'
);

const EVERGREEN_CANDIDATES_FILE = path.join(
  EVERGREEN_CANDIDATES_DIR,
  'evergreen-candidates.json'
);

const INPUT_FILE = String(
  process.env.TREND_SEEDS_FILE ||
  DEFAULT_TREND_SEEDS_FILE
).trim();

const OUTPUT_FILE = String(
  process.env.EVERGREEN_CANDIDATES_FILE ||
  EVERGREEN_CANDIDATES_FILE
).trim();

const PROMOTION_MODE = String(
  process.env.TREND_EVERGREEN_MODE ||
  'cautious'
).trim().toLowerCase();

/* ============================================================
 * logging
 * ============================================================ */
function log(...args) {
  console.log('[trend-evergreen-candidate]', ...args);
}

function fail(message) {
  console.error('[trend-evergreen-candidate][FATAL]', message);
  process.exit(1);
}

/* ============================================================
 * basic utils
 * ============================================================ */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, {
      recursive: true,
    });
  }
}

function readJson(filePath) {
  return JSON.parse(
    fs.readFileSync(filePath, 'utf8')
  );
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));

  const tmp = `${filePath}.tmp`;

  fs.writeFileSync(
    tmp,
    JSON.stringify(value, null, 2) + '\n',
    'utf8'
  );

  fs.renameSync(tmp, filePath);
}

function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function ensureArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function uniqueArray(values) {
  const seen = new Set();
  const out = [];

  for (const value of ensureArray(values)) {
    const text = normalizeText(value);
    if (!text) continue;

    const key = normalizeLower(text);
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(text);
  }

  return out;
}

function sha1(value) {
  return crypto
    .createHash('sha1')
    .update(String(value || ''), 'utf8')
    .digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

/* ============================================================
 * seed extraction
 * ============================================================ */
function extractSeeds(doc) {
  if (!doc || typeof doc !== 'object') return [];

  if (Array.isArray(doc.seeds)) {
    return doc.seeds;
  }

  if (Array.isArray(doc.items)) {
    return doc.items;
  }

  return [];
}

function extractEntityName(seed) {
  return normalizeText(
    seed &&
    seed.entity &&
    seed.entity.name
  ) ||
  normalizeText(
    seed &&
    seed.reviewEntity &&
    seed.reviewEntity.name
  ) ||
  normalizeText(seed && seed.title) ||
  'Unknown entity';
}

function extractLabel(seed) {
  return normalizeText(seed && seed.label) ||
    normalizeText(seed && seed.seedMeta && seed.seedMeta.label) ||
    'device-reviews';
}

function extractMode(seed) {
  return normalizeText(seed && seed.mode) ||
    normalizeText(seed && seed.seedMeta && seed.seedMeta.mode) ||
    'trend';
}

function extractTrendContext(seed) {
  const direct =
    seed &&
    seed.trendContext &&
    typeof seed.trendContext === 'object'
      ? seed.trendContext
      : null;

  const meta =
    seed &&
    seed.seedMeta &&
    seed.seedMeta.trendContext &&
    typeof seed.seedMeta.trendContext === 'object'
      ? seed.seedMeta.trendContext
      : null;

  return direct || meta || {};
}

function extractClassificationHints(seed) {
  const meta =
    seed &&
    seed.seedMeta &&
    seed.seedMeta.classificationHints &&
    typeof seed.seedMeta.classificationHints === 'object'
      ? seed.seedMeta.classificationHints
      : null;

  const direct =
    seed &&
    seed.classificationHints &&
    typeof seed.classificationHints === 'object'
      ? seed.classificationHints
      : null;

  return meta || direct || {};
}

function extractMaturityHints(seed) {
  const hints = extractClassificationHints(seed);

  return hints &&
    hints.maturityHints &&
    typeof hints.maturityHints === 'object'
      ? hints.maturityHints
      : {};
}

function extractEvidence(seed) {
  const meta =
    seed &&
    seed.seedMeta &&
    seed.seedMeta.evidence &&
    typeof seed.seedMeta.evidence === 'object'
      ? seed.seedMeta.evidence
      : null;

  const direct =
    seed &&
    seed.evidence &&
    typeof seed.evidence === 'object'
      ? seed.evidence
      : null;

  return meta || direct || {};
}

function extractTrust(seed) {
  const meta =
    seed &&
    seed.seedMeta &&
    seed.seedMeta.trust &&
    typeof seed.seedMeta.trust === 'object'
      ? seed.seedMeta.trust
      : null;

  const direct =
    seed &&
    seed.trust &&
    typeof seed.trust === 'object'
      ? seed.trust
      : null;

  return meta || direct || {};
}

function extractSourceTrace(seed) {
  const meta = seed && seed.selectionMeta && typeof seed.selectionMeta === 'object'
    ? seed.selectionMeta
    : {};

  const seedMeta = seed && seed.seedMeta && typeof seed.seedMeta === 'object'
    ? seed.seedMeta
    : {};

  return {
    sourceLayer: normalizeText(seedMeta.sourceLayer) || normalizeText(meta.source) || 'trend-seed-builder',
    rawConceptKey: normalizeText(seedMeta.rawConceptKey) || normalizeText(meta.rawConceptKey),
    rawFingerprint: normalizeText(seedMeta.rawFingerprint) || normalizeText(meta.rawFingerprint),
    rawSimilarityGroup: normalizeText(seedMeta.rawSimilarityGroup) || normalizeText(meta.rawSimilarityGroup),
    sourceDomain: normalizeText(seedMeta.sourceDomain) || normalizeText(meta.sourceDomain),
    trustScore: Number(seedMeta.trustScore || meta.trustScore || 0) || 0,
    trustConfidence: normalizeText(seedMeta.trustConfidence) || normalizeText(meta.trustConfidence),
  };
}

function extractUnknowns(seed) {
  const evidence = extractEvidence(seed);
  const trendContext = extractTrendContext(seed);

  return uniqueArray([
    ...ensureArray(evidence.unknowns),
    ...ensureArray(trendContext.evidenceUnknowns),
  ]);
}

function extractKeyPoints(seed) {
  const evidence = extractEvidence(seed);

  return uniqueArray([
    ...ensureArray(seed && seed.keyPoints),
    ...ensureArray(evidence.keyFacts),
    ...ensureArray(evidence.useCases),
  ]);
}

/* ============================================================
 * promotion policy
 * ============================================================ */
function isReviewLabel(label) {
  return (
    label === 'app-reviews' ||
    label === 'device-reviews' ||
    label === 'subscription-services'
  );
}

function hasBlockingUnknowns(unknowns) {
  const joined = uniqueArray(unknowns)
    .join(' | ')
    .toLowerCase();

  if (!joined) return false;

  return /price|battery|accuracy|safety|approval|privacy|latency|repair|support|availability|release|production/.test(joined);
}

function isEarlyOrConceptStage(marketStage) {
  const s = normalizeLower(marketStage);

  if (!s) return true;

  return (
    s.includes('concept') ||
    s.includes('prototype') ||
    s.includes('candidate') ||
    s.includes('pre-commercial') ||
    s.includes('unverified')
  );
}

function isMatureEnoughForEvergreen(marketStage) {
  const s = normalizeLower(marketStage);

  return (
    s.includes('mature') ||
    s.includes('mainstream') ||
    s.includes('commercial') ||
    s.includes('early-commercial')
  ) && !isEarlyOrConceptStage(s);
}

function scoreSeedForEvergreen(seed) {
  const label = extractLabel(seed);
  const mode = extractMode(seed);
  const entityName = extractEntityName(seed);
  const trendContext = extractTrendContext(seed);
  const maturityHints = extractMaturityHints(seed);
  const evidence = extractEvidence(seed);
  const trust = extractTrust(seed);
  const sourceTrace = extractSourceTrace(seed);
  const unknowns = extractUnknowns(seed);
  const keyPoints = extractKeyPoints(seed);

  const marketStage = normalizeText(maturityHints.marketStage);
  const evidenceLevel = normalizeLower(maturityHints.evidenceLevel);
  const productionConfidence = normalizeLower(maturityHints.productionConfidence);
  const changeReason = normalizeText(trendContext.changeReason);
  const trustScore = Number(
    trust.trustScore ||
    sourceTrace.trustScore ||
    0
  ) || 0;
  const trustConfidence = normalizeLower(
    trust.confidence ||
    sourceTrace.trustConfidence
  );
  const useCases = uniqueArray(evidence.useCases);
  const riskFlags = uniqueArray(trust.riskFlags);
  const blockingUnknowns = hasBlockingUnknowns(unknowns);
  const earlyStage = isEarlyOrConceptStage(marketStage);
  const matureEnough = isMatureEnoughForEvergreen(marketStage);

  let score = 0;
  const positives = [];
  const negatives = [];

  if (isReviewLabel(label)) {
    score += 10;
    positives.push('review label');
  } else {
    negatives.push('non-review label');
  }

  if (mode === 'trend') {
    score += 5;
    positives.push('trend mode');
  }

  if (entityName && entityName !== 'Unknown entity') {
    score += 10;
    positives.push('named entity');
  } else {
    negatives.push('missing entity name');
  }

  if (keyPoints.length >= 3) {
    score += 10;
    positives.push('enough key points');
  } else {
    negatives.push('thin key points');
  }

  if (useCases.length > 0) {
    score += 10;
    positives.push('has use case');
  } else {
    negatives.push('missing use case');
  }

  if (changeReason) {
    score += 5;
    positives.push('trend change reason present');
  }

  if (trustScore >= 20) {
    score += 15;
    positives.push('strong trust score');
  } else if (trustScore >= 15) {
    score += 10;
    positives.push('acceptable trust score');
  } else if (trustScore > 0) {
    score += 5;
    positives.push('some trust score');
  } else {
    negatives.push('missing trust score');
  }

  if (trustConfidence === 'high') {
    score += 10;
    positives.push('high trust confidence');
  }

  if (evidenceLevel === 'high') {
    score += 10;
    positives.push('high evidence level');
  } else if (evidenceLevel === 'medium') {
    score += 5;
    positives.push('medium evidence level');
  } else {
    negatives.push('weak evidence level');
  }

  if (productionConfidence === 'high') {
    score += 10;
    positives.push('high production confidence');
  } else if (productionConfidence === 'medium') {
    score += 5;
    positives.push('medium production confidence');
  }

  if (matureEnough) {
    score += 10;
    positives.push('market stage can support evergreen review');
  }

  if (earlyStage) {
    score -= 20;
    negatives.push('early or concept market stage');
  }

  if (blockingUnknowns) {
    score -= 20;
    negatives.push('blocking unknowns remain');
  }

  if (riskFlags.length > 0) {
    score -= Math.min(15, riskFlags.length * 5);
    negatives.push(`risk flags: ${riskFlags.join(', ')}`);
  }

  if (PROMOTION_MODE === 'loose') {
    score += 10;
  }

  if (PROMOTION_MODE === 'strict') {
    score -= 10;
  }

  return {
    score,
    positives,
    negatives,
    facts: {
      label,
      mode,
      entityName,
      marketStage,
      evidenceLevel,
      productionConfidence,
      trustScore,
      trustConfidence,
      changeReason,
      unknowns,
      useCases,
      riskFlags,
      keyPointCount: keyPoints.length,
      blockingUnknowns,
      earlyStage,
      matureEnough,
    },
  };
}

function decidePromotionStatus(scoreResult) {
  const facts = scoreResult.facts;

  if (!isReviewLabel(facts.label)) {
    return {
      status: 'reject',
      reason: 'non-review label cannot be promoted by this layer',
    };
  }

  if (facts.earlyStage || facts.blockingUnknowns) {
    return {
      status: 'hold',
      reason: 'not ready for evergreen because market stage or unknowns still require verification',
    };
  }

  if (scoreResult.score >= 60) {
    return {
      status: 'promoteCandidate',
      reason: 'trend seed has enough durable evidence for evergreen candidate review',
    };
  }

  if (scoreResult.score >= 40) {
    return {
      status: 'hold',
      reason: 'candidate has partial evergreen value but needs more evidence',
    };
  }

  return {
    status: 'reject',
    reason: 'insufficient durable evidence for evergreen promotion',
  };
}

/* ============================================================
 * candidate building
 * ============================================================ */
function buildEvergreenIntent(seed, scoreResult) {
  const label = scoreResult.facts.label;

  if (label === 'device-reviews') {
    return 'evergreen/device-assessment';
  }

  if (label === 'app-reviews') {
    return 'evergreen/app-assessment';
  }

  if (label === 'subscription-services') {
    return 'evergreen/subscription-assessment';
  }

  return 'evergreen/review-assessment';
}

function buildEvergreenTitle(seed, scoreResult) {
  const entityName = scoreResult.facts.entityName;
  const marketStage = scoreResult.facts.marketStage;

  if (scoreResult.facts.earlyStage || scoreResult.facts.blockingUnknowns) {
    return `${entityName}: what must be proven before it becomes evergreen`;
  }

  if (marketStage) {
    return `${entityName}: evergreen review after ${marketStage} signals`;
  }

  return `${entityName}: evergreen review and long-term buying context`;
}

function buildEvergreenAngle(seed, scoreResult) {
  const entityName = scoreResult.facts.entityName;
  const unknowns = scoreResult.facts.unknowns;
  const useCases = scoreResult.facts.useCases;

  if (scoreResult.facts.earlyStage || scoreResult.facts.blockingUnknowns) {
    return `Track whether ${entityName} can move from trend interest to evergreen value by verifying ${unknowns.slice(0, 3).join(', ') || 'the remaining evidence gaps'}.`;
  }

  if (useCases.length) {
    return `Evaluate ${entityName} as a durable option for ${useCases.slice(0, 2).join(' and ')}.`;
  }

  return `Evaluate ${entityName} as a durable evergreen review target.`;
}

function buildEvergreenGoal(seed, scoreResult) {
  const entityName = scoreResult.facts.entityName;

  if (scoreResult.facts.earlyStage || scoreResult.facts.blockingUnknowns) {
    return `hold ${entityName} until market evidence and unknowns are strong enough for evergreen promotion`;
  }

  return `promote ${entityName} from trend seed to evergreen review candidate`;
}

function buildCandidateFingerprint(seed, scoreResult) {
  const base = [
    'evergreen-candidate',
    normalizeLower(scoreResult.facts.label),
    normalizeLower(scoreResult.facts.entityName),
    normalizeLower(scoreResult.facts.marketStage),
    normalizeLower((seed && seed.fingerprint) || ''),
  ].join('|');

  return `fp1:${sha1(base)}`;
}

function buildEvergreenCandidate(seed, index) {
  const scoreResult = scoreSeedForEvergreen(seed);
  const decision = decidePromotionStatus(scoreResult);
  const sourceTrace = extractSourceTrace(seed);
  const classificationHints = extractClassificationHints(seed);
  const evidence = extractEvidence(seed);
  const trendContext = extractTrendContext(seed);
  const trust = extractTrust(seed);

  return {
    schemaVersion: 'evergreen-candidates.v1',
    type: 'trendToEvergreenCandidate',
    status: decision.status,
    reason: decision.reason,
    index,
    label: scoreResult.facts.label,
    sourceMode: scoreResult.facts.mode,
    targetMode: 'evergreen',
    entity: seed.entity || seed.reviewEntity || {
      name: scoreResult.facts.entityName,
    },
    reviewEntity: seed.reviewEntity || seed.entity || {
      name: scoreResult.facts.entityName,
    },
    intent: buildEvergreenIntent(seed, scoreResult),
    title: buildEvergreenTitle(seed, scoreResult),
    angle: buildEvergreenAngle(seed, scoreResult),
    audience: normalizeText(seed.audience) || 'users evaluating whether this trend has become a durable choice',
    goal: buildEvergreenGoal(seed, scoreResult),
    score: scoreResult.score,
    scoreBreakdown: {
      positives: scoreResult.positives,
      negatives: scoreResult.negatives,
    },
    promotionReadiness: {
      marketStage: scoreResult.facts.marketStage,
      evidenceLevel: scoreResult.facts.evidenceLevel,
      productionConfidence: scoreResult.facts.productionConfidence,
      trustScore: scoreResult.facts.trustScore,
      trustConfidence: scoreResult.facts.trustConfidence,
      unknowns: scoreResult.facts.unknowns,
      useCases: scoreResult.facts.useCases,
      riskFlags: scoreResult.facts.riskFlags,
      blockingUnknowns: scoreResult.facts.blockingUnknowns,
      earlyStage: scoreResult.facts.earlyStage,
      matureEnough: scoreResult.facts.matureEnough,
    },
    keyPoints: extractKeyPoints(seed),
    sourceTrend: {
      fingerprint: normalizeText(seed.fingerprint),
      title: normalizeText(seed.title),
      angle: normalizeText(seed.angle),
      goal: normalizeText(seed.goal),
      trendContext,
      classificationHints,
      evidence,
      trust,
      sourceTrace,
    },
    selectionCriteria: {
      fromTrendSeed: true,
      evergreenPromotionCandidate: true,
      reviewLabelRequired: true,
      entityNameRequired: true,
      unknownsMustBeResolvedForPromote: true,
      earlyStageHeldByDefault: true,
      noSeedpoolWrite: true,
    },
    selectionMeta: {
      source: 'trend-evergreen-candidate',
      inputSource: path.basename(INPUT_FILE),
      outputSource: path.basename(OUTPUT_FILE),
      createdAt: nowIso(),
      promotionMode: PROMOTION_MODE,
    },
    fingerprint: buildCandidateFingerprint(seed, scoreResult),
  };
}

/* ============================================================
 * main build
 * ============================================================ */
function summarize(candidates) {
  const summary = {
    total: candidates.length,
    promoteCandidate: 0,
    hold: 0,
    reject: 0,
  };

  for (const item of candidates) {
    if (item.status === 'promoteCandidate') {
      summary.promoteCandidate++;
    } else if (item.status === 'hold') {
      summary.hold++;
    } else if (item.status === 'reject') {
      summary.reject++;
    }
  }

  return summary;
}

function buildEvergreenCandidates(inputFile) {
  if (!fs.existsSync(inputFile)) {
    fail(`입력 trend-seeds 파일 없음: ${inputFile}`);
  }

  const trendSeedsDoc = readJson(inputFile);
  const seeds = extractSeeds(trendSeedsDoc);

  const candidates = seeds.map((seed, index) =>
    buildEvergreenCandidate(seed, index)
  );

  const summary = summarize(candidates);

  return {
    schemaVersion: 'evergreen-candidates.v1',
    generatedAt: nowIso(),
    sourceFile: inputFile,
    promotionMode: PROMOTION_MODE,
    summary,
    items: candidates,
    promoteCandidates: candidates.filter(item => item.status === 'promoteCandidate'),
    hold: candidates.filter(item => item.status === 'hold'),
    reject: candidates.filter(item => item.status === 'reject'),
  };
}

function main() {
  log('source =', INPUT_FILE);
  log('output =', OUTPUT_FILE);
  log('mode   =', PROMOTION_MODE);

  const result = buildEvergreenCandidates(INPUT_FILE);

  writeJsonAtomic(
    OUTPUT_FILE,
    result
  );

  log('total  =', result.summary.total);
  log('promote=', result.summary.promoteCandidate);
  log('hold   =', result.summary.hold);
  log('reject =', result.summary.reject);
  log('saved  =', OUTPUT_FILE);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildEvergreenCandidates,
  buildEvergreenCandidate,
  scoreSeedForEvergreen,
  decidePromotionStatus,
};

