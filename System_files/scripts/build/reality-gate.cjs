#!/usr/bin/env node
'use strict';

/**
 * ============================================================
 * System_files/scripts/build/reality-gate.cjs
 * ============================================================
 *
 * 역할:
 * - entity candidate가 실제 세계 근거를 가진 trend 후보인지 판정한다.
 * - 상상 조합, 증거 없는 미래형 제품, LLM 합성 후보가 trend seed로 내려가는 것을 막는다.
 * - entity-candidate-bridge.cjs의 변환 책임과 분리된 독립 게이트다.
 *
 * 입력:
 * - 기본: System_files/dist/entity-candidates/entity-candidates.json
 * - 환경변수 ENTITY_CANDIDATES_FILE 로 입력 파일 변경 가능
 *
 * 출력:
 * - 기본: System_files/dist/entity-candidates/entity-candidates.reality-gated.json
 * - 환경변수 REALITY_GATED_ENTITY_CANDIDATES_FILE 로 출력 파일 변경 가능
 * - 리포트: System_files/logs/reality-gate-report.json
 *
 * 설계 원칙:
 * 1) 입력 원본 파일은 기본적으로 수정하지 않는다.
 * 2) realityGate 필드를 candidate에 추가한 별도 산출물을 만든다.
 * 3) confirmed / announced / prototype / patent 만 trend seed 하류로 보낼 수 있다.
 * 4) speculative / imagined / rumor / unknown 은 hold 또는 reject로 둔다.
 * 5) 이름이 그럴듯해도 sourceTrace/evidence/trust 근거가 약하면 통과시키지 않는다.
 */

const fs = require('fs');
const path = require('path');

/* ============================================================
 * paths
 * ============================================================ */
const ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_INPUT_FILE = path.join(
  ROOT,
  'dist',
  'entity-candidates',
  'entity-candidates.json'
);

const DEFAULT_OUTPUT_FILE = path.join(
  ROOT,
  'dist',
  'entity-candidates',
  'entity-candidates.reality-gated.json'
);

const REPORT_FILE = path.join(
  ROOT,
  'logs',
  'reality-gate-report.json'
);

const INPUT_FILE = String(
  process.env.ENTITY_CANDIDATES_FILE ||
  DEFAULT_INPUT_FILE
).trim();

const OUTPUT_FILE = String(
  process.env.REALITY_GATED_ENTITY_CANDIDATES_FILE ||
  DEFAULT_OUTPUT_FILE
).trim();

const WRITE_MODE = String(
  process.env.REALITY_GATE_WRITE_MODE ||
  'local'
).trim().toLowerCase();

const CAN_WRITE =
  WRITE_MODE === 'local' ||
  WRITE_MODE === 'active' ||
  WRITE_MODE === 'write';

/* ============================================================
 * logging
 * ============================================================ */
function log(...args) {
  console.log('[reality-gate]', ...args);
}

function warn(...args) {
  console.warn('[reality-gate][WARN]', ...args);
}

function fatal(message) {
  console.error('[reality-gate][FATAL]', message);
  process.exit(1);
}

/* ============================================================
 * utilities
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

function nowIso() {
  return new Date().toISOString();
}

function includesAny(text, words) {
  const t = normalizeLower(text);
  return words.some(word => t.includes(normalizeLower(word)));
}

/* ============================================================
 * input shape helpers
 * ============================================================ */
function extractCandidates(doc) {
  if (!doc || typeof doc !== 'object') return [];

  if (Array.isArray(doc.candidates)) return doc.candidates;
  if (Array.isArray(doc.items)) return doc.items;

  if (
    Array.isArray(doc.pass) ||
    Array.isArray(doc.hold) ||
    Array.isArray(doc.reject)
  ) {
    return [
      ...ensureArray(doc.pass),
      ...ensureArray(doc.hold),
      ...ensureArray(doc.reject),
    ];
  }

  if (Array.isArray(doc.trendReadyCandidates)) return doc.trendReadyCandidates;
  if (Array.isArray(doc.latestPassCandidates)) return doc.latestPassCandidates;

  return [];
}

function replaceCandidates(doc, candidates) {
  const out = {
    ...(doc && typeof doc === 'object' ? doc : {}),
  };

  if (Array.isArray(out.candidates)) {
    out.candidates = candidates;
  } else if (Array.isArray(out.items)) {
    out.items = candidates;
  } else {
    out.candidates = candidates;
  }

  out.realityGate = {
    schemaVersion: 'reality-gate.v1',
    appliedAt: nowIso(),
    source: 'reality-gate.cjs',
  };

  out.realityGateSummary = summarizeCandidates(candidates);

  out.passOnly = candidates.filter(item =>
    item &&
    item.realityGate &&
    item.realityGate.decision === 'pass'
  );

  out.hold = candidates.filter(item =>
    item &&
    item.realityGate &&
    item.realityGate.decision === 'hold'
  );

  out.reject = candidates.filter(item =>
    item &&
    item.realityGate &&
    item.realityGate.decision === 'reject'
  );

  out.trendReadyCandidates = out.passOnly;
  out.latestPassCandidates = out.passOnly;

  return out;
}

/* ============================================================
 * field extraction
 * ============================================================ */
function extractEntity(candidate) {
  if (candidate && candidate.entity && typeof candidate.entity === 'object') {
    return candidate.entity;
  }

  if (candidate && candidate.reviewEntity && typeof candidate.reviewEntity === 'object') {
    return candidate.reviewEntity;
  }

  return {};
}

function extractEntityName(candidate) {
  const entity = extractEntity(candidate);

  return normalizeText(entity.name) ||
    normalizeText(candidate && candidate.name) ||
    normalizeText(candidate && candidate.title) ||
    'Unknown entity';
}

function extractSourceTrace(candidate) {
  if (candidate && candidate.sourceTrace && typeof candidate.sourceTrace === 'object') {
    return candidate.sourceTrace;
  }

  if (
    candidate &&
    candidate.rawSignalContext &&
    candidate.rawSignalContext.sourceTrace &&
    typeof candidate.rawSignalContext.sourceTrace === 'object'
  ) {
    return candidate.rawSignalContext.sourceTrace;
  }

  if (
    candidate &&
    candidate.seedMeta &&
    candidate.seedMeta.sourceTrace &&
    typeof candidate.seedMeta.sourceTrace === 'object'
  ) {
    return candidate.seedMeta.sourceTrace;
  }

  return {};
}

function extractClassificationHints(candidate) {
  if (
    candidate &&
    candidate.classificationHints &&
    typeof candidate.classificationHints === 'object'
  ) {
    return candidate.classificationHints;
  }

  if (
    candidate &&
    candidate.rawSignalContext &&
    candidate.rawSignalContext.classificationHints &&
    typeof candidate.rawSignalContext.classificationHints === 'object'
  ) {
    return candidate.rawSignalContext.classificationHints;
  }

  return {};
}

function extractEvidence(candidate) {
  if (candidate && candidate.evidence && typeof candidate.evidence === 'object') {
    return candidate.evidence;
  }

  if (
    candidate &&
    candidate.rawSignalContext &&
    candidate.rawSignalContext.evidence &&
    typeof candidate.rawSignalContext.evidence === 'object'
  ) {
    return candidate.rawSignalContext.evidence;
  }

  return {};
}

function extractTrust(candidate) {
  if (candidate && candidate.trust && typeof candidate.trust === 'object') {
    return candidate.trust;
  }

  if (
    candidate &&
    candidate.rawSignalContext &&
    candidate.rawSignalContext.trust &&
    typeof candidate.rawSignalContext.trust === 'object'
  ) {
    return candidate.rawSignalContext.trust;
  }

  return {};
}

function extractMaturityHints(candidate) {
  const hints = extractClassificationHints(candidate);

  if (hints && hints.maturityHints && typeof hints.maturityHints === 'object') {
    return hints.maturityHints;
  }

  return {};
}

function extractSourceTexts(candidate) {
  const sourceTrace = extractSourceTrace(candidate);
  const evidence = extractEvidence(candidate);
  const entity = extractEntity(candidate);
  const hints = extractClassificationHints(candidate);
  const trust = extractTrust(candidate);

  return uniqueArray([
    candidate && candidate.title,
    candidate && candidate.angle,
    candidate && candidate.goal,
    entity.name,
    entity.brand,
    entity.category,
    entity.deviceClass,
    entity.interactionModel,
    sourceTrace.sourceDomain,
    sourceTrace.sourceUrl,
    sourceTrace.url,
    sourceTrace.title,
    sourceTrace.rawConceptKey,
    evidence.summary,
    evidence.description,
    ...(ensureArray(evidence.keyFacts)),
    ...(ensureArray(evidence.useCases)),
    ...(ensureArray(evidence.unknowns)),
    ...(ensureArray(evidence.sources)),
    ...(ensureArray(evidence.sourceUrls)),
    ...(ensureArray(trust.riskFlags)),
    hints.productTypeWords ? ensureArray(hints.productTypeWords).join(' ') : '',
  ]);
}

/* ============================================================
 * reality policy
 * ============================================================ */
const STATUS = Object.freeze({
  CONFIRMED: 'confirmed',
  ANNOUNCED: 'announced',
  PROTOTYPE: 'prototype',
  PATENT: 'patent',
  RUMOR: 'rumor',
  SPECULATIVE: 'speculative',
  IMAGINED: 'imagined',
  UNKNOWN: 'unknown',
});

const PASS_STATUSES = new Set([
  STATUS.CONFIRMED,
  STATUS.ANNOUNCED,
  STATUS.PROTOTYPE,
  STATUS.PATENT,
]);

const HOLD_STATUSES = new Set([
  STATUS.RUMOR,
  STATUS.UNKNOWN,
]);

const REJECT_STATUSES = new Set([
  STATUS.SPECULATIVE,
  STATUS.IMAGINED,
]);

function detectEvidenceType(candidate) {
  const evidence = extractEvidence(candidate);
  const sourceTrace = extractSourceTrace(candidate);
  const maturityHints = extractMaturityHints(candidate);
  const texts = extractSourceTexts(candidate).join(' | ');
  const lower = normalizeLower(texts);

  const explicitType = normalizeLower(
    evidence.evidenceType ||
    evidence.sourceType ||
    sourceTrace.evidenceType ||
    sourceTrace.sourceType
  );

  if (explicitType) {
    if (/(sale|store|retail|shipping|available|released|launched|confirmed)/.test(explicitType)) {
      return 'product';
    }

    if (/(announcement|official|press|event|keynote|launch)/.test(explicitType)) {
      return 'announcement';
    }

    if (/(prototype|demo|hands-on|hands on|showcase|exhibition|computex|ces|mwc)/.test(explicitType)) {
      return 'prototype';
    }

    if (/(patent|filing|paper|research)/.test(explicitType)) {
      return 'patent';
    }

    if (/(rumor|leak)/.test(explicitType)) {
      return 'rumor';
    }
  }

  if (/(available now|on sale|retail|shipping|ships|launched|released|buy now|store listing|product page)/i.test(lower)) {
    return 'product';
  }

  if (/(officially announced|announced|press release|keynote|developer conference|launch event|introduced)/i.test(lower)) {
    return 'announcement';
  }

  if (/(prototype|demo|hands-on|hands on|showcase|exhibition|computex|ces|mwc|shown at|displayed at|working model)/i.test(lower)) {
    return 'prototype';
  }

  if (/(patent|filing|research paper|white paper|technical paper|published paper)/i.test(lower)) {
    return 'patent';
  }

  if (/(rumor|rumour|leak|leaked|tipster|unconfirmed report)/i.test(lower)) {
    return 'rumor';
  }

  const marketStage = normalizeLower(maturityHints.marketStage);

  if (marketStage.includes('early-commercial')) {
    return 'product';
  }

  if (marketStage.includes('prototype')) {
    return 'prototype';
  }

  if (marketStage.includes('concept')) {
    return 'concept';
  }

  return '';
}

function detectSyntheticRisk(candidate) {
  const name = extractEntityName(candidate);
  const sourceTrace = extractSourceTrace(candidate);
  const evidence = extractEvidence(candidate);
  const entity = extractEntity(candidate);
  const texts = extractSourceTexts(candidate).join(' | ');
  const lower = normalizeLower(texts);
  const rawConceptKey = normalizeLower(sourceTrace.rawConceptKey || candidate.rawConceptKey);

  const risk = [];

  const hasSourceDomain = !!normalizeText(sourceTrace.sourceDomain);
  const hasSourceUrl = !!normalizeText(sourceTrace.sourceUrl || sourceTrace.url);
  const sourceCount = Number(
    evidence.sourceCount ||
    sourceTrace.sourceCount ||
    ensureArray(evidence.sources).length ||
    ensureArray(evidence.sourceUrls).length ||
    0
  ) || 0;

  if (!hasSourceDomain && !hasSourceUrl && sourceCount === 0) {
    risk.push('no external source reference');
  }

  if (includesAny(lower, [
    'imagined',
    'synthetic',
    'fictional',
    'made-up',
    'hypothetical',
    'concept-only',
    'concept only',
  ])) {
    risk.push('explicit imagined/synthetic wording');
  }

  if (entity && normalizeLower(entity.status) === 'candidate' && normalizeLower(entity.confidence) === 'low') {
    risk.push('candidate entity with low confidence');
  }

  if (rawConceptKey && rawConceptKey.split('|').length >= 2) {
    const parts = rawConceptKey.split('|').map(s => s.trim()).filter(Boolean);
    const joinedName = normalizeLower(name);

    if (parts.length >= 2 && parts.every(part => joinedName.includes(part.replace(/-/g, ' ')))) {
      if (!hasSourceDomain && sourceCount === 0) {
        risk.push('brand-product synthetic combination without source');
      }
    }
  }

  return uniqueArray(risk);
}

function classifyReality(candidate) {
  const evidence = extractEvidence(candidate);
  const trust = extractTrust(candidate);
  const maturityHints = extractMaturityHints(candidate);
  const sourceTrace = extractSourceTrace(candidate);
  const evidenceType = detectEvidenceType(candidate);
  const syntheticRisk = detectSyntheticRisk(candidate);

  const sourceCount = Number(
    evidence.sourceCount ||
    sourceTrace.sourceCount ||
    ensureArray(evidence.sources).length ||
    ensureArray(evidence.sourceUrls).length ||
    0
  ) || 0;

  const trustScore = Number(
    trust.trustScore ||
    sourceTrace.trustScore ||
    candidate.trustScore ||
    0
  ) || 0;

  const trustConfidence = normalizeLower(
    trust.confidence ||
    trust.trustConfidence ||
    sourceTrace.trustConfidence ||
    ''
  );

  const marketStage = normalizeLower(maturityHints.marketStage);
  const evidenceLevel = normalizeLower(maturityHints.evidenceLevel);
  const productionConfidence = normalizeLower(maturityHints.productionConfidence);

  let status = STATUS.UNKNOWN;
  const reasons = [];
  const positives = [];
  const negatives = [];

  if (evidenceType === 'product') {
    status = STATUS.CONFIRMED;
    positives.push('product or commercial availability evidence');
  } else if (evidenceType === 'announcement') {
    status = STATUS.ANNOUNCED;
    positives.push('official announcement evidence');
  } else if (evidenceType === 'prototype') {
    status = STATUS.PROTOTYPE;
    positives.push('prototype/demo/showcase evidence');
  } else if (evidenceType === 'patent') {
    status = STATUS.PATENT;
    positives.push('patent/research evidence');
  } else if (evidenceType === 'rumor') {
    status = STATUS.RUMOR;
    negatives.push('rumor/leak evidence only');
  } else if (evidenceType === 'concept') {
    status = STATUS.SPECULATIVE;
    negatives.push('concept-stage evidence');
  }

  if (sourceCount > 0) {
    positives.push(`source count ${sourceCount}`);
  } else {
    negatives.push('missing source count');
  }

  if (trustScore >= 20) {
    positives.push('strong trust score');
  } else if (trustScore > 0) {
    positives.push('some trust score');
  } else {
    negatives.push('missing trust score');
  }

  if (trustConfidence === 'high') {
    positives.push('high trust confidence');
  }

  if (evidenceLevel === 'high' || evidenceLevel === 'medium') {
    positives.push(`${evidenceLevel} evidence level`);
  }

  if (productionConfidence === 'high' || productionConfidence === 'medium') {
    positives.push(`${productionConfidence} production confidence`);
  }

  if (syntheticRisk.length > 0) {
    negatives.push(...syntheticRisk);
  }

  if (syntheticRisk.some(item => item.includes('imagined') || item.includes('synthetic'))) {
    status = STATUS.IMAGINED;
  }

  if (
    status === STATUS.UNKNOWN &&
    syntheticRisk.length > 0 &&
    sourceCount === 0 &&
    trustScore === 0
  ) {
    status = STATUS.SPECULATIVE;
  }

  if (
    status === STATUS.PROTOTYPE &&
    syntheticRisk.includes('candidate entity with low confidence') &&
    sourceCount === 0
  ) {
    status = STATUS.SPECULATIVE;
  }

  let decision = 'hold';

  if (PASS_STATUSES.has(status)) {
    if (syntheticRisk.length === 0 || sourceCount > 0 || trustScore >= 15) {
      decision = 'pass';
    } else {
      decision = 'hold';
      reasons.push('real-world status exists but evidence is too thin');
    }
  } else if (HOLD_STATUSES.has(status)) {
    decision = 'hold';
  } else if (REJECT_STATUSES.has(status)) {
    decision = 'reject';
  }

  if (status === STATUS.UNKNOWN && sourceCount === 0 && trustScore === 0) {
    decision = 'reject';
    reasons.push('unknown existence with no source or trust evidence');
  }

  if (status === STATUS.SPECULATIVE || status === STATUS.IMAGINED) {
    decision = 'reject';
  }

  return {
    schemaVersion: 'reality-gate.v1',
    checkedAt: nowIso(),
    status,
    decision,
    evidenceType: evidenceType || 'unknown',
    confidence: decideRealityConfidence({
      status,
      decision,
      sourceCount,
      trustScore,
      trustConfidence,
      evidenceLevel,
      productionConfidence,
      syntheticRisk,
    }),
    sourceCount,
    trustScore,
    trustConfidence: trustConfidence || null,
    marketStage: marketStage || null,
    evidenceLevel: evidenceLevel || null,
    productionConfidence: productionConfidence || null,
    syntheticRisk,
    positives,
    negatives,
    reason: buildReason(status, decision, positives, negatives, reasons),
  };
}

function decideRealityConfidence(input) {
  if (input.syntheticRisk && input.syntheticRisk.length > 0 && input.sourceCount === 0) {
    return 'low';
  }

  if (
    input.decision === 'pass' &&
    input.sourceCount >= 2 &&
    input.trustScore >= 20 &&
    input.trustConfidence === 'high'
  ) {
    return 'high';
  }

  if (
    input.decision === 'pass' &&
    (input.sourceCount >= 1 || input.trustScore >= 15)
  ) {
    return 'medium';
  }

  if (
    input.decision === 'hold' &&
    (input.sourceCount >= 1 || input.trustScore > 0)
  ) {
    return 'medium';
  }

  return 'low';
}

function buildReason(status, decision, positives, negatives, extraReasons) {
  const chunks = [];

  chunks.push(`status=${status}`);
  chunks.push(`decision=${decision}`);

  if (positives.length) {
    chunks.push(`positive: ${positives.slice(0, 4).join(', ')}`);
  }

  if (negatives.length) {
    chunks.push(`negative: ${negatives.slice(0, 4).join(', ')}`);
  }

  if (extraReasons.length) {
    chunks.push(`note: ${extraReasons.slice(0, 3).join(', ')}`);
  }

  return chunks.join(' | ');
}

/* ============================================================
 * output helpers
 * ============================================================ */
function applyRealityGate(candidate) {
  return {
    ...candidate,
    realityGate: classifyReality(candidate),
  };
}

function summarizeCandidates(candidates) {
  const summary = {
    total: candidates.length,
    pass: 0,
    hold: 0,
    reject: 0,
    byStatus: {},
  };

  for (const candidate of candidates) {
    const gate = candidate && candidate.realityGate
      ? candidate.realityGate
      : {};

    const decision = gate.decision || 'unknown';
    const status = gate.status || 'unknown';

    if (decision === 'pass') summary.pass++;
    else if (decision === 'hold') summary.hold++;
    else if (decision === 'reject') summary.reject++;

    summary.byStatus[status] = (summary.byStatus[status] || 0) + 1;
  }

  return summary;
}

function buildReport(inputFile, outputFile, candidates) {
  return {
    schemaVersion: 'reality-gate-report.v1',
    generatedAt: nowIso(),
    inputFile,
    outputFile,
    summary: summarizeCandidates(candidates),
    items: candidates.map(candidate => ({
      name: extractEntityName(candidate),
      decision: candidate.realityGate.decision,
      status: candidate.realityGate.status,
      evidenceType: candidate.realityGate.evidenceType,
      confidence: candidate.realityGate.confidence,
      reason: candidate.realityGate.reason,
    })),
  };
}

/* ============================================================
 * main
 * ============================================================ */
function runRealityGate() {
  if (!fs.existsSync(INPUT_FILE)) {
    fatal(`입력 파일 없음: ${INPUT_FILE}`);
  }

  const inputDoc = readJson(INPUT_FILE);
  const candidates = extractCandidates(inputDoc);

  const gatedCandidates = candidates.map(applyRealityGate);
  const outputDoc = replaceCandidates(inputDoc, gatedCandidates);
  const report = buildReport(INPUT_FILE, OUTPUT_FILE, gatedCandidates);

  if (CAN_WRITE) {
    writeJsonAtomic(OUTPUT_FILE, outputDoc);
    writeJsonAtomic(REPORT_FILE, report);
  }

  return {
    outputDoc,
    report,
  };
}

function main() {
  log('source =', INPUT_FILE);
  log('output =', OUTPUT_FILE);
  log('mode   =', WRITE_MODE, CAN_WRITE ? '(WRITE)' : '(DRY)');

  const { report } = runRealityGate();

  log('total  =', report.summary.total);
  log('pass   =', report.summary.pass);
  log('hold   =', report.summary.hold);
  log('reject =', report.summary.reject);
  log('saved  =', OUTPUT_FILE);
  log('report =', REPORT_FILE);
}

if (require.main === module) {
  main();
}

module.exports = {
  classifyReality,
  applyRealityGate,
  runRealityGate,
  detectEvidenceType,
  detectSyntheticRisk,
};
