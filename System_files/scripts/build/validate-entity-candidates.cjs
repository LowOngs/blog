'use strict';

/**
 * validate-entity-candidates.cjs
 *
 * 역할:
 * - entity 후보 검증
 * - pass / hold / reject 판정
 * - seed 전환 가능 후보의 최소 품질 기준 확정
 *
 * 정책:
 * - entity 기본 구조가 깨진 후보는 reject
 * - 신규 종 후보라도 운영 필수 추적값(sourceTrace / trust / evidence)이 부족하면 hold
 * - 실제 seed로 넘길 수 있는 후보만 pass
 */

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

function getTrust(candidate) {
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

  const trustScore = asNumber(trust.trustScore, null);
  const keyFacts = Array.isArray(evidence.keyFacts) ? evidence.keyFacts : [];
  const useCases = Array.isArray(evidence.useCases) ? evidence.useCases : [];

  if (candidate.writeReady !== true) {
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

  // HOLD: 운영 연결 필수값 부족
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

module.exports = {
  processCandidates,
  classifyCandidate,
  validateStructure,
  validateOperationalReadiness
};
