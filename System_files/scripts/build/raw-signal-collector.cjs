#!/usr/bin/env node
'use strict';

/**
 * raw-signal-collector.cjs
 *
 * 역할:
 * - 외부 입력(raw signal)을 AOIA 표준 raw signal 구조로 정규화
 * - fingerprint 생성
 * - 최소 신뢰도 판단(writeReady=false 기본)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.join(ROOT, 'logs', 'raw-signals');
const OUT_FILE = path.join(OUT_DIR, 'raw-signals.jsonl');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function normalizeText(v) {
  return String(v || '').trim();
}

function buildFingerprint(signal) {
  const src = [
    normalizeText(signal.rawName).toLowerCase(),
    normalizeText(signal.rawSummary).toLowerCase(),
    normalizeText(signal.source?.domain).toLowerCase()
  ].join('|');

  return 'fp1:' + crypto.createHash('sha1').update(src).digest('hex');
}

function buildRawSignal(input) {
  const now = new Date().toISOString();

  const rawSignal = {
    type: 'rawTrendSignal',
    label: input.label || 'device-reviews',
    mode: 'trend',

    rawTitle: normalizeText(input.rawTitle),
    rawName: normalizeText(input.rawName),
    rawBrand: normalizeText(input.rawBrand),
    rawSummary: normalizeText(input.rawSummary),

    source: {
      url: normalizeText(input.source?.url),
      domain: normalizeText(input.source?.domain),
      sourceType: normalizeText(input.source?.sourceType) || 'unknown',
      publishedAt: normalizeText(input.source?.publishedAt),
      capturedAt: now
    },

    novelty: {
      type: normalizeText(input.novelty?.type) || 'unknown',
      claim: normalizeText(input.novelty?.claim),
      isNewCategoryCandidate: !!input.novelty?.isNewCategoryCandidate,
      timeSensitivity: normalizeText(input.novelty?.timeSensitivity) || 'medium'
    },

    classificationHints: {
      brand: normalizeText(input.rawBrand),
      productTypeWords: input.productTypeWords || [],
      formFactor: normalizeText(input.formFactor),
      interactionModel: normalizeText(input.interactionModel),
      inputMethod: normalizeText(input.inputMethod),
      connectivity: normalizeText(input.connectivity)
    },

    evidence: {
      keyFacts: input.keyFacts || [],
      useCases: input.useCases || [],
      unknowns: input.unknowns || []
    },

    dedupe: {
      normalizedName: normalizeText(input.rawName).toLowerCase(),
      conceptKey: '',
      similarityGroup: ''
    },

    accumulation: {
      mentionCount: 1,
      sourceCount: 1,
      firstSeenAt: now,
      lastSeenAt: now
    },

    trust: {
      confidence: 'low',
      riskFlags: ['new-signal'],
      writeReady: false,
      needsMoreEvidence: true
    }
  };

  rawSignal.fingerprint = buildFingerprint(rawSignal);

  return rawSignal;
}

function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

function main() {
  console.log('[raw-signal] start');

  // 테스트용 입력 (실제는 외부 입력 연결 예정)
  const sampleInput = {
    rawTitle: 'Samsung introduces hologram keyboard',
    rawName: 'Samsung Hologram Keyboard',
    rawBrand: 'Samsung',
    rawSummary: 'Wrist-worn holographic keyboard device',
    novelty: {
      type: 'new-category',
      claim: 'new input device'
    },
    productTypeWords: ['keyboard', 'hologram', 'wearable'],
    keyFacts: ['hologram projection', 'finger tracking'],
    useCases: ['mobile typing']
  };

  const signal = buildRawSignal(sampleInput);
  appendJsonl(OUT_FILE, signal);

  console.log('[raw-signal] saved:', OUT_FILE);
}

if (require.main === module) main();
