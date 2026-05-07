#!/usr/bin/env node
'use strict';

/**
 * raw-signal-collector.cjs
 *
 * 역할:
 * - 외부 입력(raw signal)을 AOIA 표준 raw signal 구조로 정규화
 * - fingerprint 생성
 * - conceptKey 기반 dedupe / accumulation 갱신
 * - novelty 자동 판단 (패치)
 * - classificationHints 자동 생성 연동 (패치)
 * - trust 동적화 (패치)
 * - 최소 신뢰도 판단(writeReady=false 기본)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* =========================
   🔥 신규 연결 (국부 패치)
========================= */
const {
  buildClassificationHints,
} = require('./lib/classification-hints-policy.cjs');
/* ========================= */

const ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.join(ROOT, 'logs', 'raw-signals');
const OUT_FILE = path.join(OUT_DIR, 'raw-signals.jsonl');
const INDEX_FILE = path.join(OUT_DIR, 'raw-signals.index.json');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function normalizeText(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

function getCliValue(name) {
  const key = `--${name}`;
  const index = process.argv.indexOf(key);
  if (index < 0) return '';
  return normalizeText(process.argv[index + 1]);
}

function normalizeKey(v) {
  return normalizeText(v)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/* =========================
   🔥 신규 추가 (국부 패치)
========================= */
const KNOWN_DEVICE_WORDS = [
  'phone','smartphone','laptop','notebook','tablet','ipad',
  'watch','band','earbud','headphone','keyboard','mouse',
  'monitor','camera','router','storage','printer','console'
];

function detectNovelty(input) {
  const words = Array.isArray(input.productTypeWords)
    ? input.productTypeWords.map(w => normalizeText(w).toLowerCase())
    : [];

  const text = (input.rawSummary + ' ' + words.join(' ')).toLowerCase();

  const hasKnown = KNOWN_DEVICE_WORDS.some(k => text.includes(k));

  const hasNewInteraction =
    /hologram|gesture|air|xr|spatial|projection/.test(text);

  if (!hasKnown || hasNewInteraction) {
    return {
      type: 'new-category',
      claim: 'new device category candidate',
      isNewCategoryCandidate: true,
      timeSensitivity: 'high'
    };
  }

  return {
    type: 'existing-category',
    claim: '',
    isNewCategoryCandidate: false,
    timeSensitivity: 'medium'
  };
}
/* ========================= */

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;

    const raw = fs.readFileSync(file, 'utf8').trim();

    if (!raw) return fallback;

    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));

  const tmp = `${file}.tmp`;

  fs.writeFileSync(
    tmp,
    `${JSON.stringify(data, null, 2)}\n`,
    'utf8'
  );

  fs.renameSync(tmp, file);
}

function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));

  fs.appendFileSync(
    file,
    `${JSON.stringify(obj)}\n`,
    'utf8'
  );
}

function extractDomainFromUrl(url) {
  const raw = normalizeText(url);

  if (!raw) return '';

  try {
    return new URL(raw)
      .hostname
      .replace(/^www\./, '')
      .toLowerCase();
  } catch {
    return '';
  }
}

function normalizeSource(input) {
  const source =
    input.source &&
    typeof input.source === 'object'
      ? input.source
      : {};

  const url = normalizeText(source.url);

  const explicitDomain =
    normalizeText(source.domain).toLowerCase();

  const domain =
    explicitDomain ||
    extractDomainFromUrl(url);

  return {
    url,
    domain,
    sourceType:
      normalizeText(source.sourceType) ||
      'unknown',

    publishedAt:
      normalizeText(source.publishedAt),
  };
}

function buildConceptKey(input, source) {
  const brand = normalizeKey(input.rawBrand);

  const name = normalizeKey(input.rawName);

  const typeWords =
    Array.isArray(input.productTypeWords)
      ? input.productTypeWords
          .map(normalizeKey)
          .filter(Boolean)
          .slice(0, 5)
          .join('-')
      : '';

  const base =
    [brand, name]
      .filter(Boolean)
      .join('|');

  if (base) return base;

  return (
    [
      typeWords,
      normalizeKey(source.domain)
    ]
      .filter(Boolean)
      .join('|') ||
    'unknown-concept'
  );
}

function buildSimilarityGroup(input) {
  const words =
    Array.isArray(input.productTypeWords)
      ? input.productTypeWords
          .map(normalizeKey)
          .filter(Boolean)
      : [];

  if (
    words.includes('hologram') &&
    words.includes('keyboard')
  ) {
    return 'holographic-input-device';
  }

  if (words.includes('gesture')) {
    return 'gesture-input-device';
  }

  if (words.includes('wearable')) {
    return 'wearable-device';
  }

  if (words.length > 0) {
    return words
      .slice(0, 3)
      .join('-');
  }

  return 'unknown-signal-group';
}

function buildFingerprint(signal) {
  const src = [
    normalizeText(
      signal.dedupe.conceptKey
    ),

    normalizeText(
      signal.rawSummary
    ).toLowerCase(),

    normalizeText(
      signal.source.domain
    ).toLowerCase(),
  ].join('|');

  return (
    `fp1:${
      crypto
        .createHash('sha1')
        .update(src)
        .digest('hex')
    }`
  );
}

function loadIndex() {
  const index =
    readJsonSafe(
      INDEX_FILE,
      null
    );

  if (
    !index ||
    typeof index !== 'object'
  ) {
    return {
      version: 1,
      updatedAt: null,
      byConceptKey: {},
    };
  }

  if (
    !index.byConceptKey ||
    typeof index.byConceptKey !== 'object'
  ) {
    index.byConceptKey = {};
  }

  return index;
}

function updateAccumulation(
  index,
  signal,
  now
) {
  const conceptKey =
    signal.dedupe.conceptKey;

  const prev =
    index.byConceptKey[conceptKey];

  if (
    !prev ||
    typeof prev !== 'object'
  ) {
    const sources =
      signal.source.domain
        ? [signal.source.domain]
        : [];

    index.byConceptKey[conceptKey] = {
      conceptKey,

      normalizedName:
        signal.dedupe.normalizedName,

      similarityGroup:
        signal.dedupe.similarityGroup,

      mentionCount: 1,

      sourceCount:
        sources.length,

      sources,

      firstSeenAt: now,
      lastSeenAt: now,

      lastFingerprint:
        signal.fingerprint,
    };

    return {
      mentionCount: 1,

      sourceCount:
        sources.length,

      firstSeenAt: now,
      lastSeenAt: now,
    };
  }

  const sources =
    Array.isArray(prev.sources)
      ? prev.sources
      : [];

  if (
    signal.source.domain &&
    !sources.includes(
      signal.source.domain
    )
  ) {
    sources.push(
      signal.source.domain
    );
  }

  prev.mentionCount =
    Number(prev.mentionCount || 0) + 1;

  prev.sourceCount =
    sources.length;

  prev.sources = sources;

  prev.lastSeenAt = now;

  prev.lastFingerprint =
    signal.fingerprint;

  if (!prev.firstSeenAt) {
    prev.firstSeenAt = now;
  }

  return {
    mentionCount:
      prev.mentionCount,

    sourceCount:
      prev.sourceCount,

    firstSeenAt:
      prev.firstSeenAt,

    lastSeenAt:
      prev.lastSeenAt,
  };
}

/* =========================
   🔥 trust 동적화 패치
========================= */

function calculateEvidenceScore(
  evidence
) {
  let score = 0;

  if (
    Array.isArray(
      evidence.keyFacts
    )
  ) {
    score += Math.min(
      evidence.keyFacts.length,
      5
    );
  }

  if (
    Array.isArray(
      evidence.useCases
    )
  ) {
    score += Math.min(
      evidence.useCases.length,
      3
    );
  }

  return score;
}

function calculateClassificationScore(
  classificationHints
) {
  let score = 0;

  if (
    classificationHints &&
    classificationHints.categoryHints &&
    classificationHints.categoryHints.primaryCategory
  ) {
    score += 2;
  }

  if (
    classificationHints &&
    classificationHints.interactionHints &&
    classificationHints.interactionHints.interactionModel &&
    classificationHints.interactionHints.interactionModel !== 'unknown'
  ) {
    score += 2;
  }

  if (
    classificationHints &&
    classificationHints.hardwareHints &&
    classificationHints.hardwareHints.wearable
  ) {
    score += 1;
  }

  return score;
}

function calculateMaturityScore(
  classificationHints
) {
  const maturity =
    classificationHints &&
    classificationHints.maturityHints;

  if (!maturity) return 0;

  let score = 0;

  if (
    maturity.marketStage ===
    'prototype-commercial'
  ) {
    score += 1;
  }

  if (
    maturity.evidenceLevel ===
    'medium'
  ) {
    score += 1;
  }

  if (
    maturity.productionConfidence ===
    'medium'
  ) {
    score += 1;
  }

  return score;
}

function collectEvidenceRiskFlags(
  evidence
) {
  const flags = [];

  const unknownCount =
    Array.isArray(evidence.unknowns)
      ? evidence.unknowns.length
      : 0;

  const keyFactCount =
    Array.isArray(evidence.keyFacts)
      ? evidence.keyFacts.length
      : 0;

  const useCaseCount =
    Array.isArray(evidence.useCases)
      ? evidence.useCases.length
      : 0;

  if (unknownCount > 0) {
    flags.push('evidence-unknowns');
  }

  if (keyFactCount === 0) {
    flags.push('no-key-facts');
  }

  if (useCaseCount === 0) {
    flags.push('no-use-cases');
  }

  return flags;
}

function buildTrust(
  accumulation,
  novelty,
  classificationHints,
  evidence
) {
  const riskFlags = [];

  if (
    accumulation.sourceCount <= 1
  ) {
    riskFlags.push(
      'single-source'
    );
  }

  if (
    novelty.isNewCategoryCandidate
  ) {
    riskFlags.push(
      'new-category-claim'
    );
  }

  if (
    accumulation.mentionCount <= 1
  ) {
    riskFlags.push(
      'first-sighting'
    );
  }

  for (
    const flag of collectEvidenceRiskFlags(
      evidence
    )
  ) {
    if (!riskFlags.includes(flag)) {
      riskFlags.push(flag);
    }
  }

  const evidenceScore =
    calculateEvidenceScore(
      evidence
    );

  const classificationScore =
    calculateClassificationScore(
      classificationHints
    );

  const maturityScore =
    calculateMaturityScore(
      classificationHints
    );

  const accumulationScore =
    accumulation.mentionCount +
    accumulation.sourceCount;

  const totalScore =
    evidenceScore +
    classificationScore +
    maturityScore +
    accumulationScore;

  let confidence = 'low';

  if (totalScore >= 8) {
    confidence = 'medium';
  }

  if (totalScore >= 14) {
    confidence = 'high';
  }

  return {
    confidence,

    trustScore:
      totalScore,

    scoreBreakdown: {
      accumulationScore,
      evidenceScore,
      classificationScore,
      maturityScore,
    },

    riskFlags,

    writeReady:
      confidence !== 'low',

    needsMoreEvidence:
      confidence === 'low',
  };
}
/* ========================= */

function buildRawSignal(
  input,
  index
) {
  const now =
    new Date().toISOString();

  const source =
    normalizeSource(input);

  const conceptKey =
    buildConceptKey(
      input,
      source
    );

  const similarityGroup =
    buildSimilarityGroup(input);

  /* =========================
     🔥 신규 연결
  ========================= */
  const classificationHints =
    buildClassificationHints(
      input
    );
  /* ========================= */

  const rawSignal = {
    type: 'rawTrendSignal',

    label:
      input.label ||
      'device-reviews',

    mode: 'trend',

    rawTitle:
      normalizeText(
        input.rawTitle
      ),

    rawName:
      normalizeText(
        input.rawName
      ),

    rawBrand:
      normalizeText(
        input.rawBrand
      ),

    rawSummary:
      normalizeText(
        input.rawSummary
      ),

    source: {
      ...source,
      capturedAt: now,
    },

    novelty:
      detectNovelty(input),

    classificationHints,

    evidence: {
      keyFacts:
        Array.isArray(
          input.keyFacts
        )
          ? input.keyFacts
          : [],

      useCases:
        Array.isArray(
          input.useCases
        )
          ? input.useCases
          : [],

      unknowns:
        Array.isArray(
          input.unknowns
        )
          ? input.unknowns
          : [],
    },

    dedupe: {
      normalizedName:
        normalizeKey(
          input.rawName
        ),

      conceptKey,

      similarityGroup,
    },

    accumulation: {
      mentionCount: 1,

      sourceCount:
        source.domain
          ? 1
          : 0,

      firstSeenAt: now,
      lastSeenAt: now,
    },

    trust: {
      confidence: 'low',
      riskFlags: [
        'new-signal'
      ],
      writeReady: false,
      needsMoreEvidence: true,
    },
  };

  rawSignal.fingerprint =
    buildFingerprint(rawSignal);

  const nextAccumulation =
    updateAccumulation(
      index,
      rawSignal,
      now
    );

  rawSignal.accumulation =
    nextAccumulation;

  rawSignal.trust =
    buildTrust(
      nextAccumulation,
      rawSignal.novelty,
      rawSignal.classificationHints,
      rawSignal.evidence
    );

  index.updatedAt = now;

  return rawSignal;
}

function main() {
  console.log(
    '[raw-signal] start'
  );

  const index =
    loadIndex();

  const domain =
    getCliValue(
      'domain'
    ) || 'example.com';

  const url =
    getCliValue('url') ||
    `https://${domain}/samsung-hologram-keyboard`;

  const sampleInput = {
    rawTitle:
      'Samsung introduces hologram keyboard',

    rawName:
      'Samsung Hologram Keyboard',

    rawBrand:
      'Samsung',

    rawSummary:
      'Wrist-worn holographic keyboard device',

    source: {
      url,
      domain,

      sourceType:
        getCliValue(
          'sourceType'
        ) || 'sample',

      publishedAt:
        getCliValue(
          'publishedAt'
        ) || '2026-05-05',
    },

    novelty: {
      type:
        'new-category',

      claim:
        'new input device',

      isNewCategoryCandidate: true,

      timeSensitivity:
        'high',
    },

    productTypeWords: [
      'keyboard',
      'hologram',
      'wearable'
    ],

    formFactor:
      'wrist-worn',

    interactionModel:
      'holographic input',

    inputMethod:
      'finger tracking',

    connectivity:
      'bluetooth',

    keyFacts: [
      'hologram projection',
      'finger tracking'
    ],

    useCases: [
      'mobile typing'
    ],

    unknowns: [
      'price',
      'battery life',
      'typing accuracy'
    ],
  };

  const signal =
    buildRawSignal(
      sampleInput,
      index
    );

  appendJsonl(
    OUT_FILE,
    signal
  );

  writeJsonAtomic(
    INDEX_FILE,
    index
  );

  console.log(
    '[raw-signal] saved:',
    OUT_FILE
  );

  console.log(
    '[raw-signal] index:',
    INDEX_FILE
  );

  console.log(
    '[raw-signal] conceptKey:',
    signal.dedupe.conceptKey
  );

  console.log(
    '[raw-signal] mentionCount:',
    signal.accumulation.mentionCount
  );

  console.log(
    '[raw-signal] sourceCount:',
    signal.accumulation.sourceCount
  );

  console.log(
    '[raw-signal] confidence:',
    signal.trust.confidence
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  buildRawSignal,
  buildConceptKey,
  buildSimilarityGroup,
  loadIndex,
};
