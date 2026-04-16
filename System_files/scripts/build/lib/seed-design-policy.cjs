#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/lib/seed-design-policy.cjs
 *
 * 역할 (Seed Design SSOT)
 * - 라벨별 시드 구조를 강제한다.
 * - entity / angle / audience / intent / keyPoints 필수화
 * - 시드 검증 기준을 단일 정책으로 제공
 *
 * 설계 원칙
 * 1) 시드는 “글 설계 완료 상태”여야 한다.
 * 2) generate-content는 판단하지 않는다 (writer only)
 * 3) 엔티티 없는 시드는 파이프라인 진입 금지
 *
 * 적용 범위
 * - seed-refill.cjs
 * - seed-scheduler.cjs (전 단계 검증)
 * - validate-seeds.cjs (신규 검증 계층)
 */

/* ============================================================
 * 기본 설정
 * ============================================================ */

const ALLOWED_LABELS = [
  'app-reviews',
  'device-reviews',
  'subscription-services',
  'how-to-playbooks',
  'smart-savings',
  'templates-checklists',
];

const REQUIRED_COMMON_FIELDS = [
  'entity',
  'angle',
  'audience',
  'intent',
  'keyPoints',
];

/* ============================================================
 * 라벨별 Entity 구조 정의
 * ============================================================ */

const ENTITY_SCHEMAS = {
  'app-reviews': {
    required: ['type', 'name', 'platform'],
    type: 'app',
  },
  'device-reviews': {
    required: ['type', 'brand', 'model'],
    type: 'device',
  },
  'subscription-services': {
    required: ['type', 'name', 'category'],
    type: 'service',
  },
  'how-to-playbooks': {
    required: [],
    type: 'generic',
  },
  'smart-savings': {
    required: [],
    type: 'generic',
  },
  'templates-checklists': {
    required: [],
    type: 'generic',
  },
};

/* ============================================================
 * 유틸
 * ============================================================ */

function normStr(v) {
  return String(v == null ? '' : v).trim();
}

function isNonEmpty(v) {
  return normStr(v).length > 0;
}

function isArray(v) {
  return Array.isArray(v);
}

/* ============================================================
 * 핵심 검증 함수
 * ============================================================ */

/**
 * 시드 구조 검증
 * @param {object} seed
 * @returns {object} { ok: boolean, errors: string[] }
 */
function validateSeedStructure(seed) {
  const errors = [];

  if (!seed || typeof seed !== 'object') {
    return { ok: false, errors: ['Seed must be an object'] };
  }

  const label = normStr(seed.label);

  if (!ALLOWED_LABELS.includes(label)) {
    errors.push(`Invalid label: ${label}`);
  }

  // 공통 필드 검증
  for (const field of REQUIRED_COMMON_FIELDS) {
    if (!(field in seed)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // entity 검증
  const entity = seed.entity;
  const schema = ENTITY_SCHEMAS[label];

  if (schema && schema.required.length > 0) {
    if (!entity || typeof entity !== 'object') {
      errors.push('Entity must be an object');
    } else {
      for (const key of schema.required) {
        if (!isNonEmpty(entity[key])) {
          errors.push(`Entity missing field: ${key}`);
        }
      }

      // type 강제
      if (schema.type !== 'generic') {
        if (entity.type !== schema.type) {
          errors.push(`Entity type mismatch: expected ${schema.type}`);
        }
      }
    }
  }

  // angle
  if (!isNonEmpty(seed.angle)) {
    errors.push('angle must be non-empty');
  }

  // audience
  if (!isNonEmpty(seed.audience)) {
    errors.push('audience must be non-empty');
  }

  // intent
  if (!isNonEmpty(seed.intent)) {
    errors.push('intent must be non-empty');
  }

  // keyPoints
  if (!isArray(seed.keyPoints)) {
    errors.push('keyPoints must be an array');
  } else {
    const validPoints = seed.keyPoints.filter(isNonEmpty);
    if (validPoints.length < 3) {
      errors.push('keyPoints must have at least 3 items');
    }
    if (validPoints.length > 5) {
      errors.push('keyPoints must have at most 5 items');
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

/* ============================================================
 * 시드 정규화 (옵션)
 * ============================================================ */

function normalizeSeed(seed) {
  const out = { ...seed };

  out.label = normStr(out.label);
  out.angle = normStr(out.angle);
  out.audience = normStr(out.audience);
  out.intent = normStr(out.intent);

  if (out.entity && typeof out.entity === 'object') {
    out.entity = { ...out.entity };
    Object.keys(out.entity).forEach(k => {
      out.entity[k] = normStr(out.entity[k]);
    });
  }

  if (isArray(out.keyPoints)) {
    out.keyPoints = out.keyPoints.map(normStr).filter(Boolean);
  }

  return out;
}

/* ============================================================
 * Export
 * ============================================================ */

module.exports = {
  ALLOWED_LABELS,
  REQUIRED_COMMON_FIELDS,
  ENTITY_SCHEMAS,
  validateSeedStructure,
  normalizeSeed,
};
