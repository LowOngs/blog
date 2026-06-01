#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/entity-candidate-bridge.cjs
 *
 * 역할:
 * - logs/raw-signals/raw-signals.jsonl 의 rawTrendSignal을 읽는다.
 * - raw signal + classificationHints를 entity-candidate-policy 입력 형태로 변환한다.
 * - buildEntityCandidate()로 entity 후보를 생성한다.
 * - validate-entity-candidates.cjs의 processCandidates()로 pass / hold / reject를 분리한다.
 * - trend-seed-builder가 직접 읽을 수 있는 passOnly / latestPassCandidates / trendReadyCandidates 출력 계약을 제공한다.
 *
 * 입력:
 * - System_files/logs/raw-signals/raw-signals.jsonl
 *
 * 출력:
 * - System_files/dist/entity-candidates/entity-candidates.json
 * - System_files/dist/entity-candidates/entity-candidates.jsonl
 *
 * 원칙:
 * - raw signal 원장 수정 금지
 * - entity-candidate-policy.cjs 수정 금지
 * - validate-entity-candidates.cjs 수정 금지
 * - 이 파일은 연결/변환 계층만 담당
 * - conceptKey / fingerprint / classificationHints / trust가 없는 구버전 raw signal은 후보 생성 대상에서 제외
 */

const fs = require('fs');
const path = require('path');

const {
  buildEntityCandidate,
} = require('./lib/entity-candidate-policy.cjs');

const {
  processCandidates,
} = require('./validate-entity-candidates.cjs');

const ROOT = path.resolve(__dirname, '../..');
const RAW_SIGNAL_FILE = path.join(
  ROOT,
  'logs',
  'raw-signals',
  'raw-signals.jsonl'
);

const OUT_DIR = path.join(
  ROOT,
  'dist',
  'entity-candidates'
);

const OUT_JSON = path.join(
  OUT_DIR,
  'entity-candidates.json'
);

const OUT_JSONL = path.join(
  OUT_DIR,
  'entity-candidates.jsonl'
);

const OUTPUT_SCHEMA_VERSION = 'entity-candidates.v1';

function ensureDir(p) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

function readJsonlSafe(file) {
  if (!fs.existsSync(file)) {
    return [];
  }

  const raw = fs.readFileSync(file, 'utf8');

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.startsWith('{') && line.endsWith('}'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((item) => item && typeof item === 'object');
}

function writeJsonPretty(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(
    file,
    `${JSON.stringify(data, null, 2)}\n`,
    'utf8'
  );
}

function writeJsonl(file, rows) {
  ensureDir(path.dirname(file));

  const body = rows
    .map((row) => JSON.stringify(row))
    .join('\n');

  fs.writeFileSync(
    file,
    body ? `${body}\n` : '',
    'utf8'
  );
}

function normalizeArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(normalizeText)
    .filter(Boolean);
}

function normalizeSourceList(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') {
          return normalizeText(item);
        }

        if (item && typeof item === 'object') {
          return normalizeText(
            item.url ||
            item.href ||
            item.sourceUrl ||
            item.domain ||
            item.title
          );
        }

        return '';
      })
      .filter(Boolean);
  }

  if (typeof value === 'object') {
    return normalizeSourceList(Object.values(value));
  }

  return [normalizeText(value)].filter(Boolean);
}

function getEvidenceSourceCount(signal) {
  const evidence = signal && signal.evidence && typeof signal.evidence === 'object'
    ? signal.evidence
    : {};

  const sourceLists = [
    normalizeSourceList(evidence.sources),
    normalizeSourceList(evidence.sourceUrls),
    normalizeSourceList(evidence.references),
    normalizeSourceList(evidence.citations),
  ];

  const explicitCount = Number(evidence.sourceCount);

  if (Number.isFinite(explicitCount) && explicitCount > 0) {
    return explicitCount;
  }

  return Array.from(new Set(sourceLists.flat())).length;
}

function getRawConceptKey(signal) {
  return normalizeText(
    signal &&
    signal.dedupe &&
    signal.dedupe.conceptKey
  );
}

function getCapturedAt(signal) {
  return normalizeText(
    signal &&
    signal.source &&
    signal.source.capturedAt
  );
}

function getTrustScore(signal) {
  const value =
    signal &&
    signal.trust &&
    Number(signal.trust.trustScore);

  return Number.isFinite(value) ? value : 0;
}

function hasModernRawSignalShape(signal) {
  if (!signal || typeof signal !== 'object') {
    return false;
  }

  if (signal.type !== 'rawTrendSignal') {
    return false;
  }

  if (signal.label !== 'device-reviews') {
    return false;
  }

  if (!normalizeText(signal.fingerprint)) {
    return false;
  }

  if (!getRawConceptKey(signal)) {
    return false;
  }

  if (
    !signal.classificationHints ||
    typeof signal.classificationHints !== 'object'
  ) {
    return false;
  }

  if (
    !signal.trust ||
    typeof signal.trust !== 'object'
  ) {
    return false;
  }

  return true;
}

function dedupeSignalsByConceptKey(signals) {
  const byConceptKey = new Map();

  for (const signal of signals) {
    if (!hasModernRawSignalShape(signal)) {
      continue;
    }

    const conceptKey = getRawConceptKey(signal);

    const prev = byConceptKey.get(conceptKey);

    if (!prev) {
      byConceptKey.set(conceptKey, signal);
      continue;
    }

    const prevScore = getTrustScore(prev);
    const nextScore = getTrustScore(signal);

    if (nextScore > prevScore) {
      byConceptKey.set(conceptKey, signal);
      continue;
    }

    if (nextScore === prevScore) {
      const prevCapturedAt = getCapturedAt(prev);
      const nextCapturedAt = getCapturedAt(signal);

      if (nextCapturedAt > prevCapturedAt) {
        byConceptKey.set(conceptKey, signal);
      }
    }
  }

  return Array.from(byConceptKey.values());
}

function getLatestSignals(signals, limit) {
  const clean = signals
    .filter(hasModernRawSignalShape)
    .sort((a, b) => {
      const at = getCapturedAt(a);
      const bt = getCapturedAt(b);

      return bt.localeCompare(at);
    });

  const deduped = dedupeSignalsByConceptKey(clean)
    .sort((a, b) => {
      const at = getCapturedAt(a);
      const bt = getCapturedAt(b);

      return bt.localeCompare(at);
    });

  if (!limit || limit <= 0) {
    return deduped;
  }

  return deduped.slice(0, limit);
}

function buildSummaryText(signal) {
  const evidence = signal.evidence || {};
  const hints = signal.classificationHints || {};
  const categoryHints = hints.categoryHints || {};
  const interactionHints = hints.interactionHints || {};
  const hardwareHints = hints.hardwareHints || {};
  const maturityHints = hints.maturityHints || {};
  const ecosystemHints = hints.ecosystemHints || {};

  const parts = [
    signal.rawSummary,
    categoryHints.primaryCategory,
    categoryHints.secondaryCategory,
    categoryHints.emergingCategory,
    interactionHints.interactionModel,
    interactionHints.inputMethod,
    interactionHints.feedbackMethod,
    interactionHints.controlSurface,
    hardwareHints.wearable ? 'wearable' : '',
    hardwareHints.requiresProjection ? 'projection' : '',
    hardwareHints.requiresPhone ? 'requires phone' : '',
    maturityHints.marketStage,
    maturityHints.evidenceLevel,
    ecosystemHints.dependencyType,
    ecosystemHints.platformBinding,
    ...normalizeArray(evidence.keyFacts),
    ...normalizeArray(evidence.useCases),
  ];

  return parts
    .map(normalizeText)
    .filter(Boolean)
    .join('. ');
}

function rawSignalToCandidateInput(signal) {
  const hints = signal.classificationHints || {};
  const productTypeWords = normalizeArray(
    hints.productTypeWords
  );

  const categoryHints = hints.categoryHints || {};
  const interactionHints = hints.interactionHints || {};
  const hardwareHints = hints.hardwareHints || {};
  const ecosystemHints = hints.ecosystemHints || {};

  const extraWords = [
    categoryHints.primaryCategory,
    categoryHints.secondaryCategory,
    categoryHints.emergingCategory,
    interactionHints.interactionModel,
    interactionHints.inputMethod,
    interactionHints.feedbackMethod,
    interactionHints.controlSurface,
    hardwareHints.wearable ? 'wearable' : '',
    hardwareHints.requiresProjection ? 'projection' : '',
    hardwareHints.requiresPhone ? 'phone' : '',
    ecosystemHints.dependencyType,
    ecosystemHints.platformBinding,
  ]
    .map(normalizeText)
    .filter(Boolean);

  return {
    rawName: normalizeText(signal.rawName),
    rawBrand: normalizeText(signal.rawBrand),
    rawSummary: buildSummaryText(signal),
    productTypeWords: Array.from(
      new Set([
        ...productTypeWords,
        ...extraWords,
      ])
    ),
  };
}

function patchCandidateFromClassificationHints(candidate, signal) {
  const cloned = JSON.parse(JSON.stringify(candidate));
  const hints = signal.classificationHints || {};
  const interactionHints = hints.interactionHints || {};
  const categoryHints = hints.categoryHints || {};

  if (!cloned.entity || typeof cloned.entity !== 'object') {
    cloned.entity = {};
  }

  const inferredInteractionModel = normalizeText(
    interactionHints.interactionModel
  );

  if (
    inferredInteractionModel &&
    (
      !cloned.entity.interactionModel ||
      cloned.entity.interactionModel === 'unknown'
    )
  ) {
    cloned.entity.interactionModel = inferredInteractionModel;
  }

  const inferredDeviceClass = normalizeText(
    categoryHints.emergingCategory ||
    categoryHints.secondaryCategory ||
    categoryHints.primaryCategory
  );

  if (
    inferredDeviceClass &&
    (
      !cloned.entity.deviceClass ||
      cloned.entity.deviceClass === 'unknown-device-class'
    )
  ) {
    cloned.entity.deviceClass = inferredDeviceClass;
  }

  if (
    cloned.classification &&
    typeof cloned.classification === 'object'
  ) {
    if (inferredInteractionModel) {
      cloned.classification.inferredInteractionModel =
        inferredInteractionModel;
    }

    if (inferredDeviceClass) {
      cloned.classification.inferredDeviceClass =
        inferredDeviceClass;
    }
  }

  return cloned;
}

function attachSourceTrace(candidate, signal) {
  const cloned = JSON.parse(JSON.stringify(candidate));

  const evidence = signal.evidence && typeof signal.evidence === 'object'
    ? signal.evidence
    : {};
  const source = signal.source && typeof signal.source === 'object'
    ? signal.source
    : {};
  const evidenceSources = Array.from(new Set([
    ...normalizeSourceList(evidence.sources),
    ...normalizeSourceList(evidence.sourceUrls),
    ...normalizeSourceList(evidence.references),
    ...normalizeSourceList(evidence.citations),
  ]));
  const sourceCount = getEvidenceSourceCount(signal);

  cloned.sourceTrace = {
    rawFingerprint: normalizeText(signal.fingerprint),
    rawConceptKey: normalizeText(
      signal.dedupe && signal.dedupe.conceptKey
    ),
    rawSimilarityGroup: normalizeText(
      signal.dedupe && signal.dedupe.similarityGroup
    ),
    capturedAt: normalizeText(
      source.capturedAt
    ),
    sourceDomain: normalizeText(
      source.domain
    ),
    sourceUrl: normalizeText(
      source.url || source.href || source.sourceUrl
    ),
    sourceTitle: normalizeText(
      source.title || source.name
    ),
    sourceCount,
    evidenceType: normalizeText(
      evidence.evidenceType || evidence.sourceType || source.evidenceType || source.type
    ),
    trustConfidence: normalizeText(
      signal.trust && signal.trust.confidence
    ),
    trustScore:
      signal.trust &&
      Number.isFinite(Number(signal.trust.trustScore))
        ? Number(signal.trust.trustScore)
        : null,
  };

  cloned.rawSignalContext = {
    noveltyType: normalizeText(
      signal.novelty && signal.novelty.type
    ),
    isNewCategoryCandidate:
      !!(signal.novelty && signal.novelty.isNewCategoryCandidate),
    source: {
      title: normalizeText(source.title || source.name),
      url: normalizeText(source.url || source.href || source.sourceUrl),
      domain: normalizeText(source.domain),
      capturedAt: normalizeText(source.capturedAt),
    },
    realityGateInput: {
      sourceCount,
      sources: evidenceSources,
      evidenceType: normalizeText(
        evidence.evidenceType || evidence.sourceType || source.evidenceType || source.type
      ),
    },
    classificationHints:
      signal.classificationHints || {},
    evidence: {
      ...evidence,
      sourceCount,
      sources: evidenceSources.length ? evidenceSources : evidence.sources,
    },
    trust:
      signal.trust || {},
  };

  return cloned;
}

function buildCandidatesFromSignals(signals) {
  const candidates = [];

  for (const signal of signals) {
    if (!hasModernRawSignalShape(signal)) {
      continue;
    }

    const input = rawSignalToCandidateInput(signal);
    const candidate = buildEntityCandidate(input);
    const patched = patchCandidateFromClassificationHints(
      candidate,
      signal
    );
    const traced = attachSourceTrace(patched, signal);

    candidates.push(traced);
  }

  return candidates;
}

function flattenValidationResult(result) {
  const rows = [];

  for (const status of ['pass', 'hold', 'reject']) {
    const arr = Array.isArray(result[status])
      ? result[status]
      : [];

    for (const item of arr) {
      rows.push({
        type: 'entityCandidate',
        status,
        name: normalizeText(
          item.entity && item.entity.name
        ),
        brand: normalizeText(
          item.entity && item.entity.brand
        ),
        category: normalizeText(
          item.entity && item.entity.category
        ),
        deviceClass: normalizeText(
          item.entity && item.entity.deviceClass
        ),
        interactionModel: normalizeText(
          item.entity && item.entity.interactionModel
        ),
        writeReady: !!item.writeReady,
        missing: Array.isArray(item.missing)
          ? item.missing
          : [],
        rawFingerprint: normalizeText(
          item.sourceTrace && item.sourceTrace.rawFingerprint
        ),
        rawConceptKey: normalizeText(
          item.sourceTrace && item.sourceTrace.rawConceptKey
        ),
        sourceDomain: normalizeText(
          item.sourceTrace && item.sourceTrace.sourceDomain
        ),
        sourceUrl: normalizeText(
          item.sourceTrace && item.sourceTrace.sourceUrl
        ),
        sourceCount:
          item.sourceTrace &&
          Number.isFinite(Number(item.sourceTrace.sourceCount))
            ? Number(item.sourceTrace.sourceCount)
            : 0,
        trustConfidence: normalizeText(
          item.sourceTrace && item.sourceTrace.trustConfidence
        ),
        trustScore:
          item.sourceTrace &&
          Number.isFinite(Number(item.sourceTrace.trustScore))
            ? Number(item.sourceTrace.trustScore)
            : null,
      });
    }
  }

  return rows;
}

function pickLatestPassCandidates(passList, limit) {
  const arr = Array.isArray(passList) ? passList : [];

  const sorted = arr
    .slice()
    .sort((a, b) => {
      const at = normalizeText(
        a.sourceTrace && a.sourceTrace.capturedAt
      );
      const bt = normalizeText(
        b.sourceTrace && b.sourceTrace.capturedAt
      );

      return bt.localeCompare(at);
    });

  if (!limit || limit <= 0) {
    return sorted;
  }

  return sorted.slice(0, limit);
}

function buildTrendReadyCandidate(candidate) {
  const entity = candidate.entity || {};
  const sourceTrace = candidate.sourceTrace || {};
  const rawSignalContext = candidate.rawSignalContext || {};
  const classificationHints = rawSignalContext.classificationHints || {};
  const evidence = rawSignalContext.evidence || {};
  const trust = rawSignalContext.trust || {};
  const validation = candidate.validation || {};

  return {
    type: 'trendReadyEntityCandidate',
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    status: 'ready',
    label: 'device-reviews',
    mode: 'trend',

    entity,
    keyPoints: Array.isArray(candidate.keyPoints)
      ? candidate.keyPoints
      : [],

    trendContext: candidate.trendContext || {},

    sourceTrace: {
      rawFingerprint: normalizeText(sourceTrace.rawFingerprint),
      rawConceptKey: normalizeText(sourceTrace.rawConceptKey),
      rawSimilarityGroup: normalizeText(sourceTrace.rawSimilarityGroup),
      capturedAt: normalizeText(sourceTrace.capturedAt),
      sourceDomain: normalizeText(sourceTrace.sourceDomain),
      sourceUrl: normalizeText(sourceTrace.sourceUrl),
      sourceTitle: normalizeText(sourceTrace.sourceTitle),
      sourceCount:
        Number.isFinite(Number(sourceTrace.sourceCount))
          ? Number(sourceTrace.sourceCount)
          : 0,
      evidenceType: normalizeText(sourceTrace.evidenceType),
      trustConfidence: normalizeText(sourceTrace.trustConfidence),
      trustScore:
        Number.isFinite(Number(sourceTrace.trustScore))
          ? Number(sourceTrace.trustScore)
          : null,
    },

    classificationHints,
    evidence,
    trust,
    realityGate: candidate.realityGate || null,

    validation: {
      status: normalizeText(validation.status),
      reason: normalizeText(validation.reason),
      errors: Array.isArray(validation.errors)
        ? validation.errors
        : [],
    },
  };
}

function buildTrendReadyCandidates(passList) {
  return (Array.isArray(passList) ? passList : [])
    .filter((item) => {
      const validation = item.validation || {};
      return validation.status === 'pass';
    })
    .map(buildTrendReadyCandidate);
}

function main() {
  const limit = Math.max(
    1,
    Number(process.env.ENTITY_CANDIDATE_LIMIT || 20) || 20
  );

  console.log('────────────────────────────────────────────');
  console.log('[entity-bridge] ROOT      =', ROOT);
  console.log('[entity-bridge] RAW       =', RAW_SIGNAL_FILE);
  console.log('[entity-bridge] OUT_JSON  =', OUT_JSON);
  console.log('[entity-bridge] OUT_JSONL =', OUT_JSONL);
  console.log('[entity-bridge] limit     =', limit);
  console.log('────────────────────────────────────────────');

  const signals = readJsonlSafe(RAW_SIGNAL_FILE);
  const pickedSignals = getLatestSignals(signals, limit);

  const candidates = buildCandidatesFromSignals(pickedSignals);
  const validation = processCandidates(candidates);
  const rows = flattenValidationResult(validation);

  const skippedSignals = signals
    .filter((signal) => signal && signal.type === 'rawTrendSignal')
    .length - getLatestSignals(signals, 0).length;

  const now = new Date().toISOString();
  const passOnly = Array.isArray(validation.pass)
    ? validation.pass
    : [];
  const latestPassCandidates = pickLatestPassCandidates(
    passOnly,
    limit
  );
  const trendReadyCandidates = buildTrendReadyCandidates(
    latestPassCandidates
  );

  const output = {
    generatedAt: now,
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    exportedAt: now,
    source: {
      rawSignalFile: RAW_SIGNAL_FILE,
      picked: pickedSignals.length,
      totalSignals: signals.length,
      skippedOldSchema: skippedSignals > 0 ? skippedSignals : 0,
      dedupe: 'conceptKey',
      requiredShape: [
        'fingerprint',
        'dedupe.conceptKey',
        'classificationHints',
        'trust',
      ],
    },
    summary: validation.summary || {
      total: candidates.length,
      pass: 0,
      hold: 0,
      reject: 0,
    },
    pass: validation.pass || [],
    hold: validation.hold || [],
    reject: validation.reject || [],

    passOnly,
    latestPassCandidates,
    trendReadyCandidates,
  };

  writeJsonPretty(OUT_JSON, output);
  writeJsonl(OUT_JSONL, rows);

  console.log('[entity-bridge] picked signals =', pickedSignals.length);
  console.log('[entity-bridge] candidates     =', candidates.length);
  console.log('[entity-bridge] skipped old    =', output.source.skippedOldSchema);
  console.log('[entity-bridge] passOnly       =', output.passOnly.length);
  console.log('[entity-bridge] trendReady     =', output.trendReadyCandidates.length);
  console.log('[entity-bridge] summary        =', JSON.stringify(output.summary));
  console.log('[entity-bridge] saved:', OUT_JSON);
  console.log('[entity-bridge] saved:', OUT_JSONL);
  console.log('────────────────────────────────────────────');
}

if (require.main === module) {
  main();
}

module.exports = {
  rawSignalToCandidateInput,
  buildCandidatesFromSignals,
  readJsonlSafe,
  dedupeSignalsByConceptKey,
  patchCandidateFromClassificationHints,
  hasModernRawSignalShape,
  pickLatestPassCandidates,
  buildTrendReadyCandidate,
  buildTrendReadyCandidates,
  normalizeSourceList,
  getEvidenceSourceCount,
};
