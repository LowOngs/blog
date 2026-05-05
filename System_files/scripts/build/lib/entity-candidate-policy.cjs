'use strict';

/**
 * entity-candidate-policy.cjs (FIXED)
 */

function normalizeText(v) {
  if (typeof v !== 'string') return '';
  return v.trim();
}

function lower(v) {
  return normalizeText(v).toLowerCase();
}

function buildRawText(input) {
  return [
    input.rawName,
    input.rawBrand,
    input.rawSummary,
    ...(Array.isArray(input.productTypeWords) ? input.productTypeWords : [])
  ]
    .map(normalizeText)
    .join(' ');
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

function extractEntityName(input) {
  if (normalizeText(input.rawName)) return input.rawName;
  return 'Unknown Device';
}

function buildKeyPoints(input) {
  const arr = [];

  if (normalizeText(input.rawSummary)) {
    arr.push(normalizeText(input.rawSummary));
  }

  if (Array.isArray(input.productTypeWords)) {
    arr.push(...input.productTypeWords.map(normalizeText));
  }

  return arr.filter(Boolean).slice(0, 5);
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

function buildEntityCandidate(input) {
  const text = buildRawText(input);

  const name = extractEntityName(input);
  const brand = detectBrand(text) || normalizeText(input.rawBrand);
  const category = detectCategory(text);
  const deviceClass = detectDeviceClass(text);
  const interactionModel = detectInteractionModel(text);

  const keyPoints = buildKeyPoints(input);
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
