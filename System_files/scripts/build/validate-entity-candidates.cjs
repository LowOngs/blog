#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/validate-entity-candidates.cjs
 *
 * 역할:
 * - entity 후보 검증
 * - pass / hold / reject 판정
 * - seed 전환 가능 후보의 최소 품질 기준 확정
 * - reality-gate.cjs 산출물의 realityGate 판정을 운영 검증에 반영
 *
 * 정책:
 * - entity 기본 구조가 깨진 후보는 reject
 * - 신규 종 후보라도 운영 필수 추적값(sourceTrace / trust / evidence)이 부족하면 hold
 * - 실존성 게이트(realityGate)가 reject면 reject
 * - 실존성 게이트가 hold/unknown이면 hold
 * - 실제 seed로 넘길 수 있는 후보만 pass
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.cwd(), 'System_files');
const ENTITY_CANDIDATES_FILE = path.join(ROOT, 'dist', 'entity-candidates', 'entity-candidates.json');
const REALITY_GATED_ENTITY_CANDIDATES_FILE = path.join(ROOT, 'dist', 'entity-candidates', 'entity-candidates.reality-gated.json');
const REPORT_FILE = path.join(ROOT, 'logs', 'entity-candidates-validation-report.json');

function isEmpty(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

function asNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isUnknownInteractionModel(v) {
  const s = String(v || '').trim().toLowerCase();
  return !s || s === 'unknown';
}

function isUnknownDeviceClass(v) {
  const s = String(v || '').trim().toLowerCase();
  return !s || s === 'unknown-device-class';
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJSONAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

const REAL_WORLD_EXISTENCE_PASS_STATUSES = new Set([
  'confirmed',
  'announced',
  'prototype',
  'patent',
]);

const REAL_WORLD_EXISTENCE_HOLD_STATUSES = new Set([
  'rumor',
  'unknown',
]);

const REAL_WORLD_EXISTENCE_REJECT_STATUSES = new Set([
  'speculative',
  'imagined',
]);

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

function normalizeRealityStatus(v) {
  return String(v || '').trim().toLowerCase();
}

function validateRealWorldExistence(candidate) {
  const errors = [];
  const gate = getRealityGate(candidate);

  if (!gate) {
    errors.push('missing realityGate');
    return errors;
  }

  const status = normalizeRealityStatus(gate.status);
  const decision = normalizeRealityStatus(gate.decision);

  if (!status) {
    errors.push('missing realityGate.status');
  }

  if (!decision) {
    errors.push('missing realityGate.decision');
  }

  if (REAL_WORLD_EXISTENCE_REJECT_STATUSES.has(status) || decision === 'reject') {
    errors.push('realityGate rejected');
    return errors;
  }

  if (REAL_WORLD_EXISTENCE_HOLD_STATUSES.has(status) || decision === 'hold') {
    errors.push('realityGate hold');
    return errors;
  }

  if (!REAL_WORLD_EXISTENCE_PASS_STATUSES.has(status)) {
    errors.push('realityGate status not allowed');
  }

  if (decision !== 'pass') {
    errors.push('realityGate decision not pass');
  }

  return errors;
}

function getTrust(candidate) {
  const direct = candidate && candidate.trust;
  if (direct && typeof direct === 'object') return direct;

  const ctx = candidate && candidate.rawSignalContext && candidate.rawSignalContext.trust;
  if (ctx && typeof ctx === 'object') return ctx;

  const trace = candidate && candidate.sourceTrace;
  if (trace && typeof trace === 'object') {
    return {
      confidence: trace.trustConfidence || '',
      trustScore: trace.trustScore,
    };
  }

  return {};
}

function getEvidence(candidate) {
  const direct = candidate && candidate.evidence;
  if (direct && typeof direct === 'object') return direct;

  const ctx = candidate && candidate.rawSignalContext && candidate.rawSignalContext.evidence;
  if (ctx && typeof ctx === 'object') return ctx;

  return {};
}

function validateStructure(candidate) {
  const errors = [];

  if (!candidate || typeof candidate !== 'object') {
    errors.push('invalid candidate object');
    return errors;
  }

  const entity = candidate.entity || {};
  const keyPoints = candidate.keyPoints || [];
  const ctx = candidate.trendContext || {};

  if (isEmpty(entity.name)) errors.push('missing entity.name');
  if (isEmpty(entity.category)) errors.push('missing entity.category');
  if (isEmpty(entity.deviceClass)) errors.push('missing deviceClass');

  if (!Array.isArray(keyPoints) || keyPoints.length < 2) {
    errors.push('insufficient keyPoints');
  }

  if (isEmpty(ctx.contextDate)) {
    errors.push('missing contextDate');
  }

  return errors;
}

function validateOperationalReadiness(candidate) {
  const errors = [];

  if (!candidate || typeof candidate !== 'object') {
    errors.push('invalid candidate object');
    return errors;
  }

  const entity = candidate.entity || {};
  const sourceTrace = candidate.sourceTrace || {};
  const trust = getTrust(candidate);
  const evidence = getEvidence(candidate);
  const realityErrors = validateRealWorldExistence(candidate);

  const trustScore = asNumber(trust.trustScore, null);
  const keyFacts = Array.isArray(evidence.keyFacts) ? evidence.keyFacts : [];
  const useCases = Array.isArray(evidence.useCases) ? evidence.useCases : [];

  if (candidate.writeReady !== true && candidate.status !== 'ready') {
    errors.push('writeReady not true');
  }

  if (!sourceTrace || typeof sourceTrace !== 'object') {
    errors.push('missing sourceTrace');
  }

  if (isEmpty(sourceTrace.rawConceptKey)) {
    errors.push('missing rawConceptKey');
  }

  if (isEmpty(sourceTrace.rawFingerprint)) {
    errors.push('missing rawFingerprint');
  }

  if (trustScore === null) {
    errors.push('missing trustScore');
  } else if (trustScore < 8) {
    errors.push('trustScore below minimum');
  }

  if (isUnknownInteractionModel(entity.interactionModel)) {
    errors.push('unknown interactionModel');
  }

  if (isUnknownDeviceClass(entity.deviceClass)) {
    errors.push('unknown deviceClass');
  }

  if (keyFacts.length < 1) {
    errors.push('insufficient evidence.keyFacts');
  }

  if (useCases.length < 1) {
    errors.push('insufficient evidence.useCases');
  }

  for (const err of realityErrors) {
    errors.push(err);
  }

  return errors;
}

function classifyCandidate(candidate) {
  const structureErrors = validateStructure(candidate);
  const readinessErrors = validateOperationalReadiness(candidate);
  const errors = Array.from(new Set([...structureErrors, ...readinessErrors]));

  const entity = candidate && candidate.entity ? candidate.entity : {};
  const isEmerging = entity.category === 'emerging-device';

  // REJECT
  if (errors.includes('invalid candidate object')) {
    return {
      status: 'reject',
      reason: 'invalid candidate object',
      errors
    };
  }

  if (errors.includes('missing entity.name')) {
    return {
      status: 'reject',
      reason: 'no entity name',
      errors
    };
  }

  if (structureErrors.length >= 4) {
    return {
      status: 'reject',
      reason: 'too many missing structure fields',
      errors
    };
  }

  if (errors.includes('realityGate rejected')) {
    return {
      status: 'reject',
      reason: 'real-world existence rejected',
      errors
    };
  }

  // HOLD: 실존성 게이트 대기 또는 운영 연결 필수값 부족
  if (readinessErrors.length > 0) {
    return {
      status: 'hold',
      reason: isEmerging
        ? 'emerging-device needs operational readiness'
        : 'candidate needs operational readiness',
      errors
    };
  }

  // HOLD: 구조 부족
  if (structureErrors.length > 0) {
    return {
      status: 'hold',
      reason: isEmerging
        ? 'emerging-device needs more data'
        : 'insufficient data',
      errors
    };
  }

  // PASS
  return {
    status: 'pass',
    reason: 'ready for seed handoff',
    errors: []
  };
}

function processCandidates(list) {
  const result = {
    pass: [],
    hold: [],
    reject: [],
    summary: {
      total: 0,
      pass: 0,
      hold: 0,
      reject: 0
    }
  };

  for (const item of list || []) {
    const decision = classifyCandidate(item);

    result.summary.total++;

    if (decision.status === 'pass') {
      result.pass.push({ ...item, validation: decision });
      result.summary.pass++;
    }

    if (decision.status === 'hold') {
      result.hold.push({ ...item, validation: decision });
      result.summary.hold++;
    }

    if (decision.status === 'reject') {
      result.reject.push({ ...item, validation: decision });
      result.summary.reject++;
    }
  }

  return result;
}

function pickInputFile() {
  const explicit = String(process.env.ENTITY_CANDIDATES_FILE || '').trim();
  if (explicit) return explicit;

  if (fs.existsSync(REALITY_GATED_ENTITY_CANDIDATES_FILE)) {
    return REALITY_GATED_ENTITY_CANDIDATES_FILE;
  }

  return ENTITY_CANDIDATES_FILE;
}

function extractCandidates(doc) {
  if (!doc || typeof doc !== 'object') return [];

  if (Array.isArray(doc.candidates)) return doc.candidates;
  if (Array.isArray(doc.items)) return doc.items;
  if (Array.isArray(doc.passOnly)) return doc.passOnly;
  if (Array.isArray(doc.latestPassCandidates)) return doc.latestPassCandidates;
  if (Array.isArray(doc.trendReadyCandidates)) return doc.trendReadyCandidates;
  if (Array.isArray(doc.pass)) return doc.pass;

  return [];
}

function buildTrendReadyCandidates(passList) {
  return (passList || []).map(item => {
    if (item && item.type === 'trendReadyEntityCandidate') {
      return item;
    }

    return {
      type: 'trendReadyEntityCandidate',
      schemaVersion: 'entity-candidates.v1',
      status: 'ready',
      label: item.label || 'device-reviews',
      mode: item.mode || 'trend',
      entity: item.entity,
      keyPoints: item.keyPoints || [],
      trendContext: item.trendContext || {},
      sourceTrace: item.sourceTrace || {},
      classificationHints: item.classificationHints || (
        item.rawSignalContext && item.rawSignalContext.classificationHints
          ? item.rawSignalContext.classificationHints
          : {}
      ),
      evidence: item.evidence || (
        item.rawSignalContext && item.rawSignalContext.evidence
          ? item.rawSignalContext.evidence
          : {}
      ),
      trust: item.trust || (
        item.rawSignalContext && item.rawSignalContext.trust
          ? item.rawSignalContext.trust
          : {}
      ),
      realityGate: getRealityGate(item),
      validation: item.validation || {
        status: 'pass',
        reason: 'ready for seed handoff',
        errors: []
      }
    };
  });
}

function buildOutputDoc(inputDoc, validationResult, inputFile) {
  const out = {
    ...(inputDoc && typeof inputDoc === 'object' ? inputDoc : {}),
    schemaVersion: 'entity-candidates.v1',
    validatedAt: nowIso(),
    validationSource: 'validate-entity-candidates.cjs',
    validationInputFile: inputFile,
    summary: validationResult.summary,
    pass: validationResult.pass,
    hold: validationResult.hold,
    reject: validationResult.reject,
    passOnly: validationResult.pass,
    latestPassCandidates: validationResult.pass,
    trendReadyCandidates: buildTrendReadyCandidates(validationResult.pass),
  };

  return out;
}

function buildReport(validationResult, inputFile, outputFile) {
  return {
    schemaVersion: 'entity-candidates-validation-report.v1',
    generatedAt: nowIso(),
    inputFile,
    outputFile,
    summary: validationResult.summary,
    items: [
      ...validationResult.pass.map(item => ({
        name: item && item.entity ? item.entity.name : '',
        status: 'pass',
        reason: item.validation ? item.validation.reason : '',
        errors: item.validation ? item.validation.errors : [],
        realityGate: getRealityGate(item),
      })),
      ...validationResult.hold.map(item => ({
        name: item && item.entity ? item.entity.name : '',
        status: 'hold',
        reason: item.validation ? item.validation.reason : '',
        errors: item.validation ? item.validation.errors : [],
        realityGate: getRealityGate(item),
      })),
      ...validationResult.reject.map(item => ({
        name: item && item.entity ? item.entity.name : '',
        status: 'reject',
        reason: item.validation ? item.validation.reason : '',
        errors: item.validation ? item.validation.errors : [],
        realityGate: getRealityGate(item),
      })),
    ],
  };
}

function main() {
  const inputFile = pickInputFile();

  if (!fs.existsSync(inputFile)) {
    console.error('[validate-entity-candidates][FATAL] 입력 파일 없음:', inputFile);
    process.exit(1);
  }

  const inputDoc = readJSON(inputFile);
  const candidates = extractCandidates(inputDoc);
  const validationResult = processCandidates(candidates);
  const outputDoc = buildOutputDoc(inputDoc, validationResult, inputFile);
  const report = buildReport(validationResult, inputFile, ENTITY_CANDIDATES_FILE);

  writeJSONAtomic(ENTITY_CANDIDATES_FILE, outputDoc);
  writeJSONAtomic(REPORT_FILE, report);

  console.log('────────────────────────────────────────────');
  console.log('[validate-entity-candidates] 시작');
  console.log('[validate-entity-candidates] ROOT    =', ROOT);
  console.log('[validate-entity-candidates] INPUT   =', inputFile);
  console.log('[validate-entity-candidates] OUTPUT  =', ENTITY_CANDIDATES_FILE);
  console.log('[validate-entity-candidates] REPORT  =', REPORT_FILE);
  console.log('────────────────────────────────────────────');
  console.log('[validate-entity-candidates] checked =', validationResult.summary.total);
  console.log('[validate-entity-candidates] pass    =', validationResult.summary.pass);
  console.log('[validate-entity-candidates] hold    =', validationResult.summary.hold);
  console.log('[validate-entity-candidates] reject  =', validationResult.summary.reject);
  console.log('────────────────────────────────────────────');
}

if (require.main === module) {
  main();
}

module.exports = {
  processCandidates,
  classifyCandidate,
  validateStructure,
  validateOperationalReadiness,
  validateRealWorldExistence,
  getRealityGate,
  extractCandidates,
  buildTrendReadyCandidates,
};
