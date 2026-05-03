#!/usr/bin/env node
'use strict';

/**
 * System_files/tools/patch/device-review-trend-redesign.cjs
 *
 * 역할:
 * - device-reviews trend 시드를 AOIA 기준으로 재구조화
 * - “지금 구매 판단 기록” 중심으로 변환
 * - entity 분산 + intent quota 유지 + trendContext 강화
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const TARGET_FILE = path.join(
  ROOT,
  'seedpool',
  'warehouse',
  'trend',
  'device-reviews-trend.json'
);

const INTENT_ORDER = [
  'review/update',
  'review/recheck',
  'review/compare-now',
  'review/still-worth',
  'review/buy-or-wait',
  'review/risk-watch',
];

const TARGET_RATIO = {
  'review/update': 0.22,
  'review/recheck': 0.18,
  'review/compare-now': 0.18,
  'review/still-worth': 0.16,
  'review/buy-or-wait': 0.16,
  'review/risk-watch': 0.10,
};

const DEVICE_LIBRARY = [
  { name: 'iPhone 15', brand: 'Apple', category: 'smartphone' },
  { name: 'Galaxy S24', brand: 'Samsung', category: 'smartphone' },
  { name: 'Pixel 8', brand: 'Google', category: 'smartphone' },
  { name: 'MacBook Air M3', brand: 'Apple', category: 'laptop' },
  { name: 'Galaxy Book4', brand: 'Samsung', category: 'laptop' },
  { name: 'iPad Pro M4', brand: 'Apple', category: 'tablet' },
  { name: 'Galaxy Tab S9', brand: 'Samsung', category: 'tablet' },
  { name: 'Sony WH-1000XM5', brand: 'Sony', category: 'audio' },
  { name: 'AirPods Pro 2', brand: 'Apple', category: 'audio' },
  { name: 'Apple Watch Series 9', brand: 'Apple', category: 'wearable' },
  { name: 'Galaxy Watch6', brand: 'Samsung', category: 'wearable' },
];

const REASONS = [
  'new generation release',
  'price drop',
  'long-term user feedback',
  'battery concern',
  'software support change',
  'competitor launch',
  'performance benchmark shift',
  'stock availability change',
  'repairability concern',
];

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function getItems(data) {
  return data.trend || data.items || data.seeds || [];
}

function setItems(data, items) {
  if (data.trend) data.trend = items;
  else if (data.items) data.items = items;
  else data.seeds = items;
}

function hash(seed) {
  return 'fp1:' + crypto.createHash('sha1').update(seed).digest('hex');
}

function pick(arr, i) {
  return arr[i % arr.length];
}

function buildTitle(intent, name, reason, date) {
  if (intent === 'review/buy-or-wait')
    return `Should you buy or wait on ${name} after ${reason}?`;

  if (intent === 'review/risk-watch')
    return `What risks should users watch in ${name} after ${reason}?`;

  if (intent === 'review/update')
    return `What changed in ${name} after the ${date} ${reason}?`;

  if (intent === 'review/compare-now')
    return `How does ${name} compare now after ${reason}?`;

  if (intent === 'review/still-worth')
    return `Is ${name} still worth buying after ${reason}?`;

  return `Should you recheck ${name} after recent changes?`;
}

function buildDecisionType(intent) {
  if (intent === 'review/compare-now') return 'compare';
  if (intent === 'review/still-worth') return 'buy';
  if (intent === 'review/buy-or-wait') return 'buy-or-wait';
  if (intent === 'review/risk-watch') return 'watch';
  return 'test';
}

function main() {
  console.log('[device-trend] start');

  const data = readJson(TARGET_FILE);
  const items = getItems(data);

  let idx = 0;

  for (const seed of items) {
    const intent = INTENT_ORDER[idx % INTENT_ORDER.length];
    const device = pick(DEVICE_LIBRARY, idx);
    const reason = pick(REASONS, idx);
    const month = String((idx % 12) + 1).padStart(2, '0');
    const contextDate = `2026-${month}`;

    seed.intent = intent;

    seed.entity = {
      name: `${device.brand} ${device.name}`,
      type: 'device',
      category: device.category,
    };

    seed.reviewEntity = {
      name: `${device.brand} ${device.name}`,
      type: 'device',
    };

    seed.title = buildTitle(intent, seed.entity.name, reason, contextDate);

    seed.goal = `decide whether ${seed.entity.name} is a good purchase after ${reason}`;

    seed.decisionType = buildDecisionType(intent);

    seed.decisionSummary =
      `${seed.entity.name} should be evaluated again because ${reason} may change buying decision.`;

    seed.trendContext = {
      timing: `2026-Q${(idx % 4) + 1}`,
      contextDate,
      changeReason: reason,
      historicalValue: true,
      currentUse: 'buy decision',
      laterUse: 'historical record',
    };

    seed.selectionCriteria = {
      timeStamped: true,
      historicalValue: true,
      deviceTrend: true,
      entityDistributed: true,
    };

    seed.fingerprint = hash(
      seed.title + seed.intent + contextDate + reason
    );

    idx++;
  }

  setItems(data, items);
  data.updatedAt = new Date().toISOString();

  writeJson(TARGET_FILE, data);

  console.log('[device-trend] done');
}

main();
