#!/usr/bin/env node
'use strict';

/**
 * System_files/tools/patch/smart-savings-evergreen-polish.cjs
 *
 * 역할:
 * - smart-savings evergreen 시드를 evergreen 기준에 맞게 재구조화한다.
 * - 할인/특가/최신 트렌드형 시드가 아니라 반복 절약 구조 중심으로 정리한다.
 * - intent / entity / title / angle / goal / keyPoints / steps / expectedOutcome / selectionCriteria / selectionMeta / fingerprint를 보정한다.
 * - 기존 id / priority 등 무관 필드는 삭제하지 않는다.
 *
 * 사용:
 * - node ./System_files/tools/patch/smart-savings-evergreen-polish.cjs
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
  'smart-savings-evergreen.json'
);

const INTENT_ORDER = [
  'avoid-leak',
  'optimize',
  'replace',
  'reduce',
  'system',
  'decision',
];

const TARGET_RATIO = {
  'avoid-leak': 0.28,
  optimize: 0.23,
  replace: 0.18,
  reduce: 0.14,
  system: 0.11,
  decision: 0.06,
};

const PLAN_LIBRARY = {
  'avoid-leak': [
    'monthly subscriptions',
    'food delivery',
    'mobile app purchases',
    'cloud storage plans',
    'streaming services',
    'bank account fees',
    'impulse purchases',
    'gym memberships',
    'delivery fees',
    'premium app renewals',
    'duplicate software tools',
    'trial subscriptions',
    'convenience store purchases',
    'online shopping add-ons',
    'insurance extras',
    'automatic renewals',
    'hidden service fees',
    'family subscriptions',
    'forgotten memberships',
    'digital storage upgrades',
  ],
  optimize: [
    'mobile data',
    'home internet plans',
    'home electricity',
    'grocery budgets',
    'cloud storage',
    'streaming subscriptions',
    'phone plan features',
    'software subscriptions',
    'home appliances',
    'commuting',
    'meal planning',
    'household supplies',
    'family entertainment',
    'online learning subscriptions',
    'work-from-home costs',
    'shared family accounts',
    'home heating and cooling',
    'backup storage',
    'device replacement timing',
    'service bundles',
  ],
  replace: [
    'paid apps',
    'delivery habits',
    'premium cloud storage',
    'single-use subscriptions',
    'brand-name household products',
    'paid productivity tools',
    'mobile plans',
    'entertainment services',
    'paid note-taking apps',
    'premium video editing tools',
    'grocery habits',
    'paid design tools',
    'hardware upgrades',
    'paid learning platforms',
    'premium finance apps',
    'storage upgrades',
    'high-fee banking services',
    'coffee habits',
    'premium music plans',
    'paid file transfer tools',
  ],
  reduce: [
    'electricity usage',
    'mobile data use',
    'food waste',
    'delivery orders',
    'paid app renewals',
    'cloud storage growth',
    'grocery waste',
    'home heating waste',
    'home cooling waste',
    'subscription overlap',
    'online shopping frequency',
    'takeout meals',
    'battery replacement pressure',
    'printer ink use',
    'data roaming costs',
    'snack purchases',
    'streaming service rotation',
    'digital purchase clutter',
    'household water usage',
    'device accessory purchases',
  ],
  system: [
    'a monthly subscription audit',
    'a household spending review',
    'an automatic renewal checklist',
    'a grocery budget routine',
    'a cloud storage cleanup routine',
    'a family subscription map',
    'a bill review calendar',
    'a recurring expense tracker',
    'a no-impulse shopping rule',
    'a digital purchase review system',
    'a weekly meal planning routine',
    'a mobile data monitoring habit',
    'a yearly insurance review',
    'a home energy check routine',
    'a shared account review',
    'a software subscription inventory',
    'a household supplies refill system',
    'a delivery spending limit',
    'a device upgrade decision rule',
    'a simple savings dashboard',
  ],
  decision: [
    'whether a subscription is still worth keeping',
    'whether to downgrade a mobile plan',
    'whether to cancel unused cloud storage',
    'whether delivery fees are worth the convenience',
    'whether to replace a paid app',
    'whether to keep multiple streaming services',
    'whether a premium feature is worth paying for',
    'whether to repair or replace a device',
    'whether a yearly plan saves enough money',
    'whether to bundle or separate services',
    'whether to buy more storage or clean up files',
    'whether to use paid or free software',
  ],
};

function fatal(message) {
  console.error('[smart-savings-evergreen-polish][FATAL]', message);
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

function createQuota(total) {
  const quota = {};
  let used = 0;

  for (const type of INTENT_ORDER) {
    quota[type] = Math.floor(total * TARGET_RATIO[type]);
    used += quota[type];
  }

  let remain = total - used;
  let index = 0;

  while (remain > 0) {
    quota[INTENT_ORDER[index % INTENT_ORDER.length]] += 1;
    remain -= 1;
    index += 1;
  }

  return quota;
}

function collectText(seed) {
  return [
    seed.title,
    seed.angle,
    seed.audience,
    seed.goal,
    seed.entity && seed.entity.name,
    Array.isArray(seed.keyPoints) ? seed.keyPoints.join(' ') : '',
  ]
    .map(normalizeText)
    .join(' ');
}

function scoreSeed(seed) {
  const text = lowerText(collectText(seed));

  const scores = {
    'avoid-leak': 0,
    optimize: 0,
    replace: 0,
    reduce: 0,
    system: 0,
    decision: 0,
  };

  if (/unused|forgotten|automatic renewal|renewal|overlap|duplicate|hidden fee|service fee|trial|membership|leak|wasteful|unnecessary/.test(text)) {
    scores['avoid-leak'] += 10;
  }

  if (/optimize|more value|same cost|plan value|bundle|capacity|efficiency|usage|features|spending efficiency/.test(text)) {
    scores.optimize += 10;
  }

  if (/replace|alternative|free alternative|cheaper|low-cost|instead of|switch from|premium to free/.test(text)) {
    scores.replace += 10;
  }

  if (/reduce|cut|lower|less|usage|waste|spending|electricity|data use|food waste|delivery orders/.test(text)) {
    scores.reduce += 10;
  }

  if (/system|routine|tracker|calendar|checklist|audit|review habit|dashboard|rule|inventory|monitoring/.test(text)) {
    scores.system += 10;
  }

  if (/whether|decide|decision|worth|keep|cancel|downgrade|upgrade|paying for|worth keeping/.test(text)) {
    scores.decision += 10;
  }

  if (scores['avoid-leak'] === 0 && /subscription|fee|renewal|spending/.test(text)) {
    scores['avoid-leak'] += 3;
  }

  if (scores.decision === 0) {
    scores.decision += 1;
  }

  return scores;
}

function rankTypes(scores) {
  return INTENT_ORDER
    .map((type) => ({ type, score: scores[type] || 0 }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return INTENT_ORDER.indexOf(a.type) - INTENT_ORDER.indexOf(b.type);
    });
}

function assignTypes(seeds) {
  const quota = createQuota(seeds.length);
  const used = {};
  const assigned = new Map();

  for (const type of INTENT_ORDER) {
    used[type] = 0;
  }

  const candidates = seeds.map((seed, index) => {
    const scores = scoreSeed(seed);
    const ranked = rankTypes(scores);
    const confidence = ranked[0].score - ranked[1].score;

    return {
      seed,
      index,
      ranked,
      confidence,
    };
  });

  candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }

    return a.index - b.index;
  });

  for (const item of candidates) {
    let picked = null;

    for (const rank of item.ranked) {
      if (used[rank.type] < quota[rank.type]) {
        picked = rank.type;
        break;
      }
    }

    if (!picked) {
      for (const type of INTENT_ORDER) {
        if (used[type] < quota[type]) {
          picked = type;
          break;
        }
      }
    }

    if (!picked) {
      picked = 'decision';
    }

    used[picked] += 1;
    assigned.set(item.seed, picked);
  }

  return {
    assigned,
    quota,
    used,
  };
}

function buildPlan(type, index) {
  const list = PLAN_LIBRARY[type] || PLAN_LIBRARY.decision;
  const base = list[index % list.length];
  const variant = Math.floor(index / list.length) + 1;

  return {
    entityName: variant > 1 ? `${base} checklist ${variant}` : base,
  };
}

function fixCase(title) {
  return normalizeText(title)
    .replace(/\bwi-fi\b/gi, 'Wi-Fi')
    .replace(/\bwifi\b/gi, 'Wi-Fi')
    .replace(/\biphone\b/gi, 'iPhone')
    .replace(/\bandroid\b/gi, 'Android')
    .replace(/\busb\b/gi, 'USB');
}

function buildTitle(type, base) {
  if (type === 'avoid-leak') {
    return fixCase(`How to stop unnecessary spending on ${base}`);
  }

  if (type === 'optimize') {
    return fixCase(`How to get more value from ${base} without spending more`);
  }

  if (type === 'replace') {
    return fixCase(`How to replace ${base} with cheaper alternatives`);
  }

  if (type === 'reduce') {
    return fixCase(`How to reduce ${base} without losing everyday comfort`);
  }

  if (type === 'system') {
    return fixCase(`How to build a simple system for ${base}`);
  }

  if (type === 'decision') {
    if (/^(whether|which)\b/i.test(base)) {
      return fixCase(`How to decide ${base}`);
    }

    return fixCase(`How to decide whether ${base} is worth the cost`);
  }

  return fixCase(`How to save money on ${base}`);
}

function buildAngle(type, base) {
  if (type === 'avoid-leak') {
    return `Find and close repeat spending leaks in ${base} without relying on temporary discounts.`;
  }

  if (type === 'optimize') {
    return `Improve the value of ${base} by using existing spending more efficiently.`;
  }

  if (type === 'replace') {
    return `Replace expensive parts of ${base} with practical lower-cost alternatives.`;
  }

  if (type === 'reduce') {
    return `Reduce ${base} in a way that preserves normal comfort and function.`;
  }

  if (type === 'system') {
    return `Create a repeatable system that keeps ${base} under control over time.`;
  }

  return `Decide whether ${base} deserves continued spending based on practical value.`;
}

function buildGoal(type, base) {
  if (type === 'avoid-leak') {
    return `prevent unnecessary recurring cost in ${base}`;
  }

  if (type === 'optimize') {
    return `increase practical value from ${base} without increasing the budget`;
  }

  if (type === 'replace') {
    return `replace expensive spending in ${base} with lower-cost options`;
  }

  if (type === 'reduce') {
    return `lower ongoing use or cost in ${base} without breaking normal use`;
  }

  if (type === 'system') {
    return `build a repeatable savings routine for ${base}`;
  }

  return `decide whether ${base} is worth the ongoing cost`;
}

function buildKeyPoints(type) {
  if (type === 'avoid-leak') {
    return [
      'identify recurring costs that no longer serve a clear purpose',
      'cancel or downgrade only after checking actual use',
      'review the same category again on a fixed schedule',
    ];
  }

  if (type === 'optimize') {
    return [
      'check what is already included before spending more',
      'match the plan or product to actual usage',
      'measure value by repeated use, not one-time appeal',
    ];
  }

  if (type === 'replace') {
    return [
      'find the paid part that creates most of the cost',
      'compare practical lower-cost alternatives',
      'switch only if the replacement covers the real need',
    ];
  }

  if (type === 'reduce') {
    return [
      'find the habit or usage pattern that drives cost',
      'reduce the highest-friction area first',
      'keep the change small enough to repeat',
    ];
  }

  if (type === 'system') {
    return [
      'turn the saving action into a repeatable routine',
      'use a checklist or calendar instead of memory',
      'review results before changing the system',
    ];
  }

  return [
    'define the real need behind the cost',
    'compare savings against convenience and risk',
    'choose the option that avoids regret and waste',
  ];
}

function buildSteps(type) {
  if (type === 'avoid-leak') {
    return [
      'list the recurring or repeated costs in this category',
      'mark what was not used recently or no longer fits the need',
      'cancel, downgrade, or limit one cost at a time',
    ];
  }

  if (type === 'optimize') {
    return [
      'check what the current plan or habit already provides',
      'remove overlap before adding anything new',
      'adjust usage so the same money produces more value',
    ];
  }

  if (type === 'replace') {
    return [
      'identify the expensive item or service being replaced',
      'compare cheaper options against the real requirement',
      'switch gradually and verify that the replacement works',
    ];
  }

  if (type === 'reduce') {
    return [
      'measure current usage or spending first',
      'reduce the easiest repeatable part',
      'check whether comfort or function was affected',
    ];
  }

  if (type === 'system') {
    return [
      'choose one spending category to monitor',
      'create a simple review rule or checklist',
      'repeat the review on a fixed schedule',
    ];
  }

  return [
    'define why the cost exists',
    'compare keep, downgrade, replace, and cancel options',
    'choose the option with the best long-term value',
  ];
}

function buildExpectedOutcome(type) {
  if (type === 'avoid-leak') {
    return 'unnecessary recurring spending is identified and reduced';
  }

  if (type === 'optimize') {
    return 'the same spending produces more practical value';
  }

  if (type === 'replace') {
    return 'a costly habit or service is replaced with a practical lower-cost option';
  }

  if (type === 'reduce') {
    return 'ongoing usage or spending is lowered without harming normal use';
  }

  if (type === 'system') {
    return 'a repeatable savings routine keeps the category under control';
  }

  return 'the user can decide whether the cost is still worth keeping';
}

function buildDifficulty(type) {
  if (type === 'system' || type === 'replace') {
    return 'medium';
  }

  return 'easy';
}

function buildTimeRequired(type) {
  if (type === 'system') {
    return '20-45 minutes';
  }

  if (type === 'replace' || type === 'decision') {
    return '15-30 minutes';
  }

  return '10-25 minutes';
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

function patchSeed(seed, type, index) {
  let changed = 0;

  const plan = buildPlan(type, index);
  const intent = `savings/${type}`;
  const base = plan.entityName;

  const entity = ensureObject(seed, 'entity');
  if (entity.name !== base) {
    entity.name = base;
    changed += 1;
  }

  if (entity.type !== 'expense-category') {
    entity.type = 'expense-category';
    changed += 1;
  }

  if (entity.intentFamily !== type) {
    entity.intentFamily = type;
    changed += 1;
  }

  const nextTitle = buildTitle(type, base);
  const nextAngle = buildAngle(type, base);
  const nextGoal = buildGoal(type, base);
  const nextKeyPoints = buildKeyPoints(type);
  const nextSteps = buildSteps(type);
  const nextOutcome = buildExpectedOutcome(type);
  const nextDifficulty = buildDifficulty(type);
  const nextTimeRequired = buildTimeRequired(type);

  if (seed.intent !== intent) {
    seed.intent = intent;
    changed += 1;
  }

  if (seed.title !== nextTitle) {
    seed.title = nextTitle;
    changed += 1;
  }

  if (seed.angle !== nextAngle) {
    seed.angle = nextAngle;
    changed += 1;
  }

  if (seed.goal !== nextGoal) {
    seed.goal = nextGoal;
    changed += 1;
  }

  if (!Array.isArray(seed.keyPoints) || seed.keyPoints.join('|') !== nextKeyPoints.join('|')) {
    seed.keyPoints = nextKeyPoints;
    changed += 1;
  }

  if (!Array.isArray(seed.steps) || seed.steps.join('|') !== nextSteps.join('|')) {
    seed.steps = nextSteps;
    changed += 1;
  }

  if (seed.expectedOutcome !== nextOutcome) {
    seed.expectedOutcome = nextOutcome;
    changed += 1;
  }

  if (seed.difficulty !== nextDifficulty) {
    seed.difficulty = nextDifficulty;
    changed += 1;
  }

  if (seed.timeRequired !== nextTimeRequired) {
    seed.timeRequired = nextTimeRequired;
    changed += 1;
  }

  const criteria = ensureObject(seed, 'selectionCriteria');
  const nextCriteria = {
    costReductionPotential: true,
    repeatableSaving: true,
    realWorldApplicable: true,
    notTrendDependent: true,
    behaviorBased: true,
    evergreenSavings: true,
    typeSpecificSteps: true,
    hasVerificationStep: true,
    semanticRedesigned: true,
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
    sourceType: 'smart-savings evergreen behavior redesign rule',
    selectionReason: `redesigned as ${intent} by evergreen savings behavior structure`,
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

function reorderEvergreenByIntent(seeds) {
  const buckets = {};

  for (const type of INTENT_ORDER) {
    buckets[type] = [];
  }

  for (const seed of seeds) {
    const intent = lowerText(seed && seed.intent).replace(/^savings\//, '');
    const type = INTENT_ORDER.includes(intent) ? intent : 'decision';
    buckets[type].push(seed);
  }

  const reordered = [];
  let moved = true;

  while (moved) {
    moved = false;

    for (const type of INTENT_ORDER) {
      const next = buckets[type].shift();

      if (next) {
        reordered.push(next);
        moved = true;
      }
    }
  }

  return reordered;
}

function main() {
  console.log('[smart-savings-evergreen-polish] start');
  console.log(`[smart-savings-evergreen-polish] target = ${TARGET_FILE}`);

  const data = readJson(TARGET_FILE);

  if (data.label !== 'smart-savings') {
    fatal(`label mismatch: got=${data.label}, want=smart-savings`);
  }

  if (!Array.isArray(data.evergreen)) {
    fatal('missing evergreen array');
  }

  const seeds = data.evergreen.filter((seed) => seed && typeof seed === 'object');
  const assignment = assignTypes(seeds);
  const typeIndex = {};

  for (const type of INTENT_ORDER) {
    typeIndex[type] = 0;
  }

  let checked = 0;
  let changed = 0;

  for (const seed of seeds) {
    const type = assignment.assigned.get(seed);
    const index = typeIndex[type];

    checked += 1;
    changed += patchSeed(seed, type, index);

    typeIndex[type] += 1;
  }

  data.evergreen = reorderEvergreenByIntent(seeds);

  writeJson(TARGET_FILE, data);

  const byIntent = {};
  for (const seed of data.evergreen) {
    const intent = normalizeText(seed && seed.intent) || 'missing';
    byIntent[intent] = (byIntent[intent] || 0) + 1;
  }

  console.log('[smart-savings-evergreen-polish] checked =', checked);
  console.log('[smart-savings-evergreen-polish] changed =', changed);

  console.log('[smart-savings-evergreen-polish] target quota =');
  for (const type of INTENT_ORDER) {
    console.log(`  - savings/${type}: ${assignment.quota[type]}`);
  }

  console.log('[smart-savings-evergreen-polish] actual distribution =');
  Object.keys(byIntent)
    .sort()
    .forEach((intent) => {
      console.log(`  - ${intent}: ${byIntent[intent]}`);
    });

  console.log('[smart-savings-evergreen-polish] sample =');

  data.evergreen.slice(0, 12).forEach((seed) => {
    console.log(`  - ${seed.id}: ${seed.intent} :: ${seed.title}`);
  });

  console.log('[smart-savings-evergreen-polish] done');
}

main();
