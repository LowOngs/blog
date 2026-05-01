#!/usr/bin/env node
'use strict';

/**
 * System_files/tools/patch/app-review-evergreen-polish.cjs
 *
 * 역할:
 * - app-reviews evergreen 시드를 evergreen 기준에 맞게 다듬는다.
 * - trend성 연도 표현(2025/2026 등), best/top 계열 제목을 제거한다.
 * - title / goal / angle / selectionMeta / fingerprint를 안전하게 보정한다.
 * - 기존 id / entity / reviewEntity / selectionCriteria / priority 등 무관 필드는 삭제하지 않는다.
 *
 * 사용:
 * - node ./System_files/tools/patch/app-review-evergreen-polish.cjs
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const TARGET_FILE = path.join(
  ROOT,
  'seedpool',
  'warehouse',
  'evergreen',
  'app-reviews-evergreen.json'
);

const REVIEW_INTENTS = [
  'review/fit',
  'review/comparison',
  'review/decision',
  'review/long-term',
  'review/tradeoff',
  'review/value',
];

function fatal(message) {
  console.error('[app-review-evergreen-polish][FATAL]', message);
  process.exit(1);
}

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function lowerText(value) {
  return normalizeText(value).toLowerCase();
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    fatal(`target file not found: ${filePath}`);
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fatal(`failed to parse JSON: ${filePath} :: ${error.message}`);
  }
}

function writeJson(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function ensureObject(parent, key) {
  if (!parent[key] || typeof parent[key] !== 'object' || Array.isArray(parent[key])) {
    parent[key] = {};
  }

  return parent[key];
}

function getAppName(seed) {
  return normalizeText(
    (seed.reviewEntity && seed.reviewEntity.name) ||
    (seed.entity && seed.entity.name) ||
    seed.title ||
    'this app'
  )
    .replace(/\b202[0-9]\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeIntent(seed, index) {
  const current = normalizeText(seed.intent);

  if (REVIEW_INTENTS.includes(current)) {
    return current;
  }

  return REVIEW_INTENTS[index % REVIEW_INTENTS.length];
}

function buildTitle(intent, appName) {
  if (intent === 'review/fit') {
    return `Who should actually use ${appName}?`;
  }

  if (intent === 'review/comparison') {
    return `How does ${appName} compare with practical alternatives?`;
  }

  if (intent === 'review/decision') {
    return `Should you choose ${appName} for everyday use?`;
  }

  if (intent === 'review/long-term') {
    return `Does ${appName} hold up for long-term use?`;
  }

  if (intent === 'review/tradeoff') {
    return `What tradeoffs should you know before choosing ${appName}?`;
  }

  if (intent === 'review/value') {
    return `How much value does ${appName} provide for regular users?`;
  }

  return `Should you choose ${appName} for everyday use?`;
}

function buildGoal(intent, appName) {
  if (intent === 'review/fit') {
    return `decide whether ${appName} fits the user’s actual daily needs`;
  }

  if (intent === 'review/comparison') {
    return `compare ${appName} with practical alternatives without relying on hype`;
  }

  if (intent === 'review/decision') {
    return `decide whether ${appName} is worth choosing for normal use`;
  }

  if (intent === 'review/long-term') {
    return `judge whether ${appName} remains useful after repeated use`;
  }

  if (intent === 'review/tradeoff') {
    return `understand the main benefits and limitations before choosing ${appName}`;
  }

  if (intent === 'review/value') {
    return `judge whether ${appName} provides enough value for regular users`;
  }

  return `decide whether ${appName} is a practical choice`;
}

function buildAngle(intent, appName) {
  if (intent === 'review/fit') {
    return `Evaluate ${appName} by matching its strengths to the user’s real usage pattern.`;
  }

  if (intent === 'review/comparison') {
    return `Compare ${appName} against realistic alternatives using everyday decision criteria.`;
  }

  if (intent === 'review/decision') {
    return `Review ${appName} as a practical choice, not as a short-term trend.`;
  }

  if (intent === 'review/long-term') {
    return `Check whether ${appName} stays useful after the first impression fades.`;
  }

  if (intent === 'review/tradeoff') {
    return `Explain the strengths, limits, and compromises of choosing ${appName}.`;
  }

  if (intent === 'review/value') {
    return `Judge ${appName} by value, usefulness, and avoidable friction for regular users.`;
  }

  return `Review ${appName} from a durable evergreen decision angle.`;
}

function sanitizeTitle(title) {
  return normalizeText(title)
    .replace(/\b202[0-9]\b/g, '')
    .replace(/\b(best|top\s*\d*|ultimate|must-have|hottest)\b/gi, '')
    .replace(/\bworth buying\b/gi, 'worth choosing')
    .replace(/\s+/g, ' ')
    .replace(/\s+\?/g, '?')
    .trim();
}

function buildFingerprint(seed) {
  const source = [
    normalizeText(seed.title).toLowerCase(),
    normalizeText(seed.angle).toLowerCase(),
    normalizeText(seed.audience).toLowerCase(),
    normalizeText(seed.intent).toLowerCase(),
    normalizeText(seed.goal).toLowerCase(),
  ].join('|');

  return `fp1:${crypto.createHash('sha1').update(source).digest('hex')}`;
}

function patchSeed(seed, index) {
  let changed = 0;

  const appName = getAppName(seed);
  const intent = normalizeIntent(seed, index);

  if (seed.intent !== intent) {
    seed.intent = intent;
    changed += 1;
  }

  const nextTitle = sanitizeTitle(buildTitle(intent, appName));
  const nextGoal = buildGoal(intent, appName);
  const nextAngle = buildAngle(intent, appName);

  if (seed.title !== nextTitle) {
    seed.title = nextTitle;
    changed += 1;
  }

  if (seed.goal !== nextGoal) {
    seed.goal = nextGoal;
    changed += 1;
  }

  if (seed.angle !== nextAngle) {
    seed.angle = nextAngle;
    changed += 1;
  }

  const entity = ensureObject(seed, 'entity');
  if (!normalizeText(entity.name)) {
    entity.name = appName;
    changed += 1;
  }

  if (!normalizeText(entity.type)) {
    entity.type = 'app';
    changed += 1;
  }

  const reviewEntity = ensureObject(seed, 'reviewEntity');
  if (!normalizeText(reviewEntity.name)) {
    reviewEntity.name = appName;
    changed += 1;
  }

  if (!normalizeText(reviewEntity.type)) {
    reviewEntity.type = 'app';
    changed += 1;
  }

  const criteria = ensureObject(seed, 'selectionCriteria');
  const nextCriteria = {
    evergreenReview: true,
    trendYearRemoved: true,
    hypeTitleRemoved: true,
    durableDecisionAngle: true,
  };

  for (const [key, value] of Object.entries(nextCriteria)) {
    if (criteria[key] !== value) {
      criteria[key] = value;
      changed += 1;
    }
  }

  const meta = ensureObject(seed, 'selectionMeta');
  const nextMeta = {
    validated: true,
    sourceType: 'app review evergreen polish rule',
    selectionReason: 'polished for evergreen app review intent without trend-year or hype wording',
  };

  for (const [key, value] of Object.entries(nextMeta)) {
    if (meta[key] !== value) {
      meta[key] = value;
      changed += 1;
    }
  }

  if (!normalizeText(meta.selectedAt)) {
    meta.selectedAt = new Date().toISOString();
    changed += 1;
  }

  const nextFingerprint = buildFingerprint(seed);
  if (seed.fingerprint !== nextFingerprint) {
    seed.fingerprint = nextFingerprint;
    changed += 1;
  }

  return changed;
}

function main() {
  console.log('[app-review-evergreen-polish] start');
  console.log(`[app-review-evergreen-polish] target = ${TARGET_FILE}`);

  const data = readJson(TARGET_FILE);

  if (data.label !== 'app-reviews') {
    fatal(`label mismatch: got=${data.label}, want=app-reviews`);
  }

  if (!Array.isArray(data.evergreen)) {
    fatal('missing evergreen array');
  }

  let checked = 0;
  let changed = 0;

  for (const seed of data.evergreen) {
    if (!seed || typeof seed !== 'object') {
      continue;
    }

    changed += patchSeed(seed, checked);
    checked += 1;
  }

  writeJson(TARGET_FILE, data);

  const byIntent = {};
  for (const seed of data.evergreen) {
    const intent = normalizeText(seed && seed.intent) || 'missing';
    byIntent[intent] = (byIntent[intent] || 0) + 1;
  }

  console.log('[app-review-evergreen-polish] checked =', checked);
  console.log('[app-review-evergreen-polish] changed =', changed);
  console.log('[app-review-evergreen-polish] intent distribution =');

  Object.keys(byIntent)
    .sort()
    .forEach((intent) => {
      console.log(`  - ${intent}: ${byIntent[intent]}`);
    });

  console.log('[app-review-evergreen-polish] sample =');

  data.evergreen.slice(0, 12).forEach((seed) => {
    console.log(`  - ${seed.id}: ${seed.intent} :: ${seed.title}`);
  });

  console.log('[app-review-evergreen-polish] done');
}

main();
