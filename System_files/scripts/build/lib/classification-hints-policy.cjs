#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/lib/classification-hints-policy.cjs
 *
 * 역할:
 * - raw signal 기반 classificationHints 자동 생성 SSOT
 * - 신규 디바이스/신규 인터랙션 구조를 시스템이 해석 가능한 형태로 변환
 *
 * 책임:
 * - categoryHints
 * - interactionHints
 * - hardwareHints
 * - maturityHints
 * - ecosystemHints
 *
 * 주의:
 * - raw signal 자체 수정 금지
 * - entity 생성 책임 없음
 * - trust 계산 책임 없음
 */

function normalizeText(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

function lower(v) {
  return normalizeText(v).toLowerCase();
}

function normalizeArray(arr) {
  if (!Array.isArray(arr)) return [];

  return arr
    .map(v => normalizeText(v).toLowerCase())
    .filter(Boolean);
}

function buildFullText(input) {
  return [
    input.rawTitle,
    input.rawName,
    input.rawBrand,
    input.rawSummary,
    input.formFactor,
    input.interactionModel,
    input.inputMethod,
    input.connectivity,
    ...(Array.isArray(input.productTypeWords)
      ? input.productTypeWords
      : []),
    ...(Array.isArray(input.keyFacts)
      ? input.keyFacts
      : []),
    ...(Array.isArray(input.useCases)
      ? input.useCases
      : []),
  ]
    .map(normalizeText)
    .join(' ')
    .toLowerCase();
}

/* =========================================================
 * categoryHints
========================================================= */

function detectPrimaryCategory(text) {
  if (/keyboard/.test(text)) return 'input-device';
  if (/mouse|pointer/.test(text)) return 'input-device';
  if (/headset|xr|spatial|vision/.test(text)) return 'spatial-device';
  if (/watch|wearable|band/.test(text)) return 'wearable-device';
  if (/tablet|ipad/.test(text)) return 'tablet-device';
  if (/phone|smartphone/.test(text)) return 'smartphone';
  if (/laptop|notebook/.test(text)) return 'laptop';

  return 'emerging-device';
}

function detectSecondaryCategory(text) {
  if (/hologram/.test(text)) return 'holographic-device';
  if (/gesture/.test(text)) return 'gesture-device';
  if (/projection/.test(text)) return 'projection-device';
  if (/xr|spatial/.test(text)) return 'xr-device';

  return '';
}

function detectEmergingCategory(text) {
  if (/hologram.*keyboard|keyboard.*hologram/.test(text)) {
    return 'holographic-input-device';
  }

  if (/gesture.*control|air.*gesture/.test(text)) {
    return 'air-gesture-control-device';
  }

  if (/xr|spatial/.test(text)) {
    return 'spatial-computing-device';
  }

  return '';
}

function buildCategoryHints(text) {
  return {
    primaryCategory: detectPrimaryCategory(text),
    secondaryCategory: detectSecondaryCategory(text),
    emergingCategory: detectEmergingCategory(text),
  };
}

/* =========================================================
 * interactionHints
========================================================= */

function detectInteractionModel(text) {
  if (/gesture|air gesture/.test(text)) {
    return 'air-gesture';
  }

  if (/hologram/.test(text)) {
    return 'holographic-interaction';
  }

  if (/touch/.test(text)) {
    return 'touch';
  }

  if (/voice/.test(text)) {
    return 'voice';
  }

  if (/xr|spatial/.test(text)) {
    return 'spatial-interaction';
  }

  return 'unknown';
}

function detectInputMethod(text) {
  if (/finger tracking/.test(text)) {
    return 'finger-tracking';
  }

  if (/gesture/.test(text)) {
    return 'gesture-input';
  }

  if (/voice/.test(text)) {
    return 'voice-input';
  }

  if (/touch/.test(text)) {
    return 'touch-input';
  }

  return 'unknown';
}

function detectFeedbackMethod(text) {
  if (/hologram/.test(text)) {
    return 'holographic-visual';
  }

  if (/audio/.test(text)) {
    return 'audio-feedback';
  }

  if (/vibration|haptic/.test(text)) {
    return 'haptic-feedback';
  }

  return 'standard-visual';
}

function detectControlSurface(text) {
  if (/air|gesture|mid-air/.test(text)) {
    return 'mid-air';
  }

  if (/touch/.test(text)) {
    return 'surface-touch';
  }

  return 'unknown';
}

function buildInteractionHints(text) {
  return {
    interactionModel: detectInteractionModel(text),
    inputMethod: detectInputMethod(text),
    feedbackMethod: detectFeedbackMethod(text),
    controlSurface: detectControlSurface(text),
  };
}

/* =========================================================
 * hardwareHints
========================================================= */

function buildHardwareHints(text) {
  return {
    wearable: /wearable|wrist|watch|band/.test(text),
    standalone: !/requires phone|phone-connected/.test(text),
    requiresPhone: /phone|smartphone/.test(text),
    requiresProjection: /projection|hologram/.test(text),
    batteryPowered: !/wired/.test(text),
  };
}

/* =========================================================
 * maturityHints
========================================================= */

function detectMarketStage(text) {
  if (/prototype/.test(text)) {
    return 'prototype';
  }

  if (/beta|preview/.test(text)) {
    return 'early-commercial';
  }

  if (/released|launch|available/.test(text)) {
    return 'commercial';
  }

  return 'prototype-commercial';
}

function detectEvidenceLevel(input) {
  const facts = Array.isArray(input.keyFacts)
    ? input.keyFacts.length
    : 0;

  const useCases = Array.isArray(input.useCases)
    ? input.useCases.length
    : 0;

  const score = facts + useCases;

  if (score >= 6) return 'high';
  if (score >= 3) return 'medium';

  return 'low';
}

function buildMaturityHints(text, input) {
  const evidenceLevel = detectEvidenceLevel(input);

  return {
    marketStage: detectMarketStage(text),
    evidenceLevel,
    adoptionRisk:
      evidenceLevel === 'low'
        ? 'high'
        : evidenceLevel === 'medium'
          ? 'medium'
          : 'low',
    productionConfidence:
      evidenceLevel === 'high'
        ? 'high'
        : 'medium',
  };
}

/* =========================================================
 * ecosystemHints
========================================================= */

function buildEcosystemHints(text) {
  const companionDevices = [];

  if (/phone|smartphone/.test(text)) {
    companionDevices.push('smartphone');
  }

  if (/tablet/.test(text)) {
    companionDevices.push('tablet');
  }

  return {
    companionDevices,
    dependencyType:
      /bluetooth/.test(text)
        ? 'bluetooth-linked'
        : 'standalone',
    platformBinding:
      /android/.test(text)
        ? 'android'
        : /ios|apple/.test(text)
          ? 'ios'
          : 'cross-platform',
  };
}

/* =========================================================
 * public
========================================================= */

function buildClassificationHints(input) {
  const text = buildFullText(input);

  return {
    brand: normalizeText(input.rawBrand),

    productTypeWords: normalizeArray(
      input.productTypeWords
    ),

    formFactor: normalizeText(input.formFactor),

    interactionModel: normalizeText(
      input.interactionModel
    ),

    inputMethod: normalizeText(
      input.inputMethod
    ),

    connectivity: normalizeText(
      input.connectivity
    ),

    categoryHints: buildCategoryHints(text),

    interactionHints: buildInteractionHints(text),

    hardwareHints: buildHardwareHints(text),

    maturityHints: buildMaturityHints(text, input),

    ecosystemHints: buildEcosystemHints(text),
  };
}

module.exports = {
  buildClassificationHints,
};
