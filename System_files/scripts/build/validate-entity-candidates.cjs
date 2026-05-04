'use strict';

/**
 * validate-entity-candidates.cjs
 *
 * 역할:
 * - entity 후보 검증
 * - pass / hold / reject 판정
 */

function isEmpty(v) {
  return v === null || v === undefined || String(v).trim() === '';
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

function classifyCandidate(candidate) {
  const errors = validateStructure(candidate);

  const entity = candidate.entity || {};
  const isEmerging = entity.category === 'emerging-device';

  // REJECT
  if (errors.includes('missing entity.name')) {
    return {
      status: 'reject',
      reason: 'no entity name',
      errors
    };
  }

  if (errors.length >= 4) {
    return {
      status: 'reject',
      reason: 'too many missing fields',
      errors
    };
  }

  // HOLD (신규 종 특수 처리)
  if (isEmerging) {
    if (errors.length > 0) {
      return {
        status: 'hold',
        reason: 'emerging-device needs more data',
        errors
      };
    }
  }

  // 일반 HOLD
  if (errors.length > 0) {
    return {
      status: 'hold',
      reason: 'insufficient data',
      errors
    };
  }

  // PASS
  return {
    status: 'pass',
    reason: 'ready for writing',
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
  classifyCandidate
};
