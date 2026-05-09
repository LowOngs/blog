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

function getLatestSignals(signals, limit) {
  const clean = signals
    .filter((signal) => signal.type === 'rawTrendSignal')
    .filter((signal) => signal.label === 'device-reviews')
    .sort((a, b) => {
      const at = normalizeText(
        a.source && a.source.capturedAt
      );
      const bt = normalizeText(
        b.source && b.source.capturedAt
      );

      return bt.localeCompare(at);
    });

  if (!limit || limit <= 0) {
    return clean;
  }

  return clean.slice(0, limit);
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

function attachSourceTrace(candidate, signal) {
  const cloned = JSON.parse(JSON.stringify(candidate));

  cloned.sourceTrace = {
    rawFingerprint: normalizeText(signal.fingerprint),
    rawConceptKey: normalizeText(
      signal.dedupe && signal.dedupe.conceptKey
    ),
    rawSimilarityGroup: normalizeText(
      signal.dedupe && signal.dedupe.similarityGroup
    ),
    capturedAt: normalizeText(
      signal.source && signal.source.capturedAt
    ),
    sourceDomain: normalizeText(
      signal.source && signal.source.domain
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
    classificationHints:
      signal.classificationHints || {},
    evidence:
      signal.evidence || {},
    trust:
      signal.trust || {},
  };

  return cloned;
}

function buildCandidatesFromSignals(signals) {
  const candidates = [];

  for (const signal of signals) {
    const input = rawSignalToCandidateInput(signal);
    const candidate = buildEntityCandidate(input);
    const traced = attachSourceTrace(candidate, signal);

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

  const output = {
    generatedAt: new Date().toISOString(),
    source: {
      rawSignalFile: RAW_SIGNAL_FILE,
      picked: pickedSignals.length,
      totalSignals: signals.length,
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
  };

  writeJsonPretty(OUT_JSON, output);
  writeJsonl(OUT_JSONL, rows);

  console.log('[entity-bridge] picked signals =', pickedSignals.length);
  console.log('[entity-bridge] candidates     =', candidates.length);
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
};
