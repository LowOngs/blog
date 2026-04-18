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

const REVIEW_LABELS = [
  'app-reviews',
  'device-reviews',
  'subscription-services',
];

const REQUIRED_COMMON_FIELDS = [
  'entity',
  'angle',
  'audience',
  'intent',
  'keyPoints',
  'fingerprint',
];

const REQUIRED_REVIEW_FIELDS = [
  'reviewEntity',
  'selectionCriteria',
  'selectionMeta',
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
    required: ['type', 'name'],
    type: 'task',
  },
  'smart-savings': {
    required: ['type', 'name'],
    type: 'decision',
  },
  'templates-checklists': {
    required: ['type', 'name'],
    type: 'template',
  },
};

const REVIEW_ENTITY_SCHEMAS = {
  'app-reviews': {
    required: ['type', 'appName', 'platform'],
    type: 'app',
  },
  'device-reviews': {
    required: ['type', 'model'],
    type: 'device',
  },
  'subscription-services': {
    required: ['type', 'service'],
    type: 'subscription',
  },
};

const REVIEW_SELECTION_CRITERIA_SCHEMAS = {
  'app-reviews': {
    required: [
      'labelMatchStrict',
      'minDownloads',
      'minReviewCount',
      'minRatingCount',
      'requiresRating',
      'lastUpdatedWithinDays',
    ],
  },
  'device-reviews': {
    required: [
      'labelMatchStrict',
      'requiresMarketPresence',
      'requiresReviewVolume',
      'requiresComparableAlternatives',
    ],
  },
  'subscription-services': {
    required: [
      'labelMatchStrict',
      'requiresActivePlan',
      'requiresPublicPricing',
      'requiresReviewVolume',
      'requiresCancellationPolicy',
    ],
  },
};

const REVIEW_SELECTION_META_SCHEMA = {
  required: [
    'validated',
    'sourceType',
    'selectionReason',
    'selectedAt',
  ],
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

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isReviewLabel(label) {
  return REVIEW_LABELS.includes(normStr(label));
}

function isFiniteNumber(v) {
  return Number.isFinite(Number(v));
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeObjectStrings(obj) {
  if (!isObject(obj)) return obj;
  const out = { ...obj };
  Object.keys(out).forEach((k) => {
    if (typeof out[k] === 'string' || out[k] == null) {
      out[k] = normStr(out[k]);
    }
  });
  return out;
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

  // 리뷰 계열 추가 필드 검증
  if (isReviewLabel(label)) {
    for (const field of REQUIRED_REVIEW_FIELDS) {
      if (!(field in seed)) {
        errors.push(`Missing required review field: ${field}`);
      }
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

  // reviewEntity 검증
  if (isReviewLabel(label)) {
    const reviewEntity = seed.reviewEntity;
    const reviewSchema = REVIEW_ENTITY_SCHEMAS[label];

    if (!isObject(reviewEntity)) {
      errors.push('reviewEntity must be an object');
    } else if (reviewSchema) {
      for (const key of reviewSchema.required) {
        if (!isNonEmpty(reviewEntity[key])) {
          errors.push(`reviewEntity missing field: ${key}`);
        }
      }

      if (reviewEntity.type !== reviewSchema.type) {
        errors.push(`reviewEntity type mismatch: expected ${reviewSchema.type}`);
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

  // fingerprint
  if (!isNonEmpty(seed.fingerprint)) {
    errors.push('fingerprint must be non-empty');
  } else if (!/^fp\d+:[a-f0-9]+$/i.test(normStr(seed.fingerprint))) {
    errors.push('fingerprint format is invalid');
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

  // selectionCriteria
  if (isReviewLabel(label)) {
    const selectionCriteria = seed.selectionCriteria;
    const criteriaSchema = REVIEW_SELECTION_CRITERIA_SCHEMAS[label];

    if (!isObject(selectionCriteria)) {
      errors.push('selectionCriteria must be an object');
    } else if (criteriaSchema) {
      for (const key of criteriaSchema.required) {
        if (!hasOwn(selectionCriteria, key)) {
          errors.push(`selectionCriteria missing field: ${key}`);
        }
      }

      if (hasOwn(selectionCriteria, 'labelMatchStrict') && typeof selectionCriteria.labelMatchStrict !== 'boolean') {
        errors.push('selectionCriteria.labelMatchStrict must be boolean');
      }

      if (label === 'app-reviews') {
        if (hasOwn(selectionCriteria, 'minDownloads') && !isFiniteNumber(selectionCriteria.minDownloads)) {
          errors.push('selectionCriteria.minDownloads must be numeric');
        }
        if (hasOwn(selectionCriteria, 'minReviewCount') && !isFiniteNumber(selectionCriteria.minReviewCount)) {
          errors.push('selectionCriteria.minReviewCount must be numeric');
        }
        if (hasOwn(selectionCriteria, 'minRatingCount') && !isFiniteNumber(selectionCriteria.minRatingCount)) {
          errors.push('selectionCriteria.minRatingCount must be numeric');
        }
        if (hasOwn(selectionCriteria, 'requiresRating') && typeof selectionCriteria.requiresRating !== 'boolean') {
          errors.push('selectionCriteria.requiresRating must be boolean');
        }
        if (hasOwn(selectionCriteria, 'lastUpdatedWithinDays') && !isFiniteNumber(selectionCriteria.lastUpdatedWithinDays)) {
          errors.push('selectionCriteria.lastUpdatedWithinDays must be numeric');
        }
      }
    }
  }

  // selectionMeta
  if (isReviewLabel(label)) {
    const selectionMeta = seed.selectionMeta;

    if (!isObject(selectionMeta)) {
      errors.push('selectionMeta must be an object');
    } else {
      for (const key of REVIEW_SELECTION_META_SCHEMA.required) {
        if (!hasOwn(selectionMeta, key)) {
          errors.push(`selectionMeta missing field: ${key}`);
        }
      }

      if (hasOwn(selectionMeta, 'validated') && typeof selectionMeta.validated !== 'boolean') {
        errors.push('selectionMeta.validated must be boolean');
      }

      if (hasOwn(selectionMeta, 'sourceType') && !isNonEmpty(selectionMeta.sourceType)) {
        errors.push('selectionMeta.sourceType must be non-empty');
      }

      if (hasOwn(selectionMeta, 'selectionReason') && !isNonEmpty(selectionMeta.selectionReason)) {
        errors.push('selectionMeta.selectionReason must be non-empty');
      }

      if (hasOwn(selectionMeta, 'selectedAt') && !isNonEmpty(selectionMeta.selectedAt)) {
        errors.push('selectionMeta.selectedAt must be non-empty');
      }
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
  out.fingerprint = normStr(out.fingerprint);

  if (out.entity && typeof out.entity === 'object') {
    out.entity = normalizeObjectStrings(out.entity);
  }

  if (out.reviewEntity && typeof out.reviewEntity === 'object') {
    out.reviewEntity = normalizeObjectStrings(out.reviewEntity);
  }

  if (out.selectionCriteria && typeof out.selectionCriteria === 'object') {
    out.selectionCriteria = { ...out.selectionCriteria };
    Object.keys(out.selectionCriteria).forEach((k) => {
      const value = out.selectionCriteria[k];
      if (typeof value === 'string' || value == null) {
        out.selectionCriteria[k] = normStr(value);
      }
    });
  }

  if (out.selectionMeta && typeof out.selectionMeta === 'object') {
    out.selectionMeta = { ...out.selectionMeta };
    Object.keys(out.selectionMeta).forEach((k) => {
      const value = out.selectionMeta[k];
      if (typeof value === 'string' || value == null) {
        out.selectionMeta[k] = normStr(value);
      }
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
  REVIEW_LABELS,
  REQUIRED_COMMON_FIELDS,
  REQUIRED_REVIEW_FIELDS,
  ENTITY_SCHEMAS,
  REVIEW_ENTITY_SCHEMAS,
  REVIEW_SELECTION_CRITERIA_SCHEMAS,
  REVIEW_SELECTION_META_SCHEMA,
  validateSeedStructure,
  normalizeSeed,
};
