'use strict';

/**
 * trend-seed-builder.cjs
 *
 * 역할:
 * - raw trend signal → seed 생성
 */

const crypto = require('crypto');
const { processCandidates } = require('./validate-entity-candidates.cjs');
const { buildEntityCandidate } = require('./lib/entity-candidate-policy.cjs');

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

function buildTrendContext(signal, index) {
  const month = String((index % 12) + 1).padStart(2, '0');

  return {
    contextDate: `2026-${month}`,
    changeReason: normalizeText(signal.reason) || 'market change',
    timing: `2026-Q${(index % 4) + 1}`,
    historicalValue: true
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

/**
 * main builder
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

module.exports = {
  buildTrendSeeds
};
