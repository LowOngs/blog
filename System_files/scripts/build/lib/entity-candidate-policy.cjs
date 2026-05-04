'use strict';

/**
 * entity-candidate-policy.cjs
 *
 * 역할:
 * - raw signal → entity 후보 생성
 * - category 판정
 * - deviceClass / interactionModel 추론
 * - writeReady 판단
 */

function normalizeText(v) {
  return String(v || '').trim();
}

function lower(v) {
  return normalizeText(v).toLowerCase();
}

function detectBrand(text) {
  const brands = [
    'samsung','apple','google','sony','microsoft','amazon',
    'meta','tesla','xiaomi','huawei','lg','lenovo'
  ];

  const t = lower(text);
  for (const b of brands) {
    if (t.includes(b)) return b.charAt(0).toUpperCase() + b.slice(1);
  }
  return '';
}

function detectCategory(text) {
  const t = lower(text);

  if (/phone|smartphone/.test(t)) return 'smartphone';
  if (/laptop|notebook/.test(t)) return 'laptop';
  if (/tablet|ipad/.test(t)) return 'tablet';
  if (/watch|band/.test(t)) return 'wearable';
  if (/earbud|headphone/.test(t)) return 'audio';

  return 'emerging-device';
}

function detectDeviceClass(text) {
  const t = lower(text);

  if (/gesture|air|hologram/.test(t)) return 'gesture-input-device';
  if (/keyboard/.test(t)) return 'keyboard-device';
  if (/controller/.test(t)) return 'control-device';

  return 'unknown-device-class';
}

function detectInteractionModel(text) {
  const t = lower(text);

  if (/gesture|air/.test(t)) return 'air-gesture';
  if (/touch/.test(t)) return 'touch';
  if (/voice/.test(t)) return 'voice';

  return 'unknown';
}

function extractEntityName(text) {
  const words = normalizeText(text).split(' ');
  return words.slice(0, 4).join(' ');
}

function buildKeyPoints(text) {
  const parts = normalizeText(text).split('.');
  return parts.slice(0, 3).map(s => s.trim()).filter(Boolean);
}

function buildTrendContext() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');

  return {
    contextDate: `${now.getFullYear()}-${month}`,
    changeReason: 'new device category emergence',
    historicalValue: true
  };
}

function evaluateWriteReady(entity, keyPoints) {
  const missing = [];

  if (!entity.name) missing.push('entity.name');
  if (!entity.category) missing.push('entity.category');
  if (!entity.deviceClass) missing.push('deviceClass');
  if (!keyPoints || keyPoints.length < 2) missing.push('keyPoints');

  return {
    writeReady: missing.length === 0,
    missing
  };
}

function buildEntityCandidate(rawText) {
  const text = normalizeText(rawText);

  const name = extractEntityName(text);
  const brand = detectBrand(text);
  const category = detectCategory(text);
  const deviceClass = detectDeviceClass(text);
  const interactionModel = detectInteractionModel(text);

  const keyPoints = buildKeyPoints(text);
  const trendContext = buildTrendContext();

  const entity = {
    name,
    brand,
    type: 'device',
    category,
    deviceClass,
    interactionModel,
    status: 'candidate',
    confidence: category === 'emerging-device' ? 'low' : 'medium'
  };

  const writeCheck = evaluateWriteReady(entity, keyPoints);

  return {
    entity,
    keyPoints,
    trendContext,
    classification: {
      status: 'candidate',
      confidence: entity.confidence,
      requiresCategoryReview: category === 'emerging-device'
    },
    writeReady: writeCheck.writeReady,
    missing: writeCheck.missing
  };
}

module.exports = {
  buildEntityCandidate
};
