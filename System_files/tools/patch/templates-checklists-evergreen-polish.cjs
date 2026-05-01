#!/usr/bin/env node
'use strict';

/**
 * System_files/tools/patch/templates-checklists-evergreen-polish.cjs
 *
 * 역할:
 * - templates-checklists evergreen 시드를 evergreen 기준에 맞게 재구조화한다.
 * - 최신/트렌드/모음형 템플릿이 아니라 재사용 가능한 실행 도구형 시드로 정리한다.
 * - intent / entity / title / angle / goal / keyPoints / steps / templateFields / expectedOutcome / selectionCriteria / selectionMeta / fingerprint를 보정한다.
 * - 기존 id / priority 등 무관 필드는 삭제하지 않는다.
 *
 * 사용:
 * - node ./System_files/tools/patch/templates-checklists-evergreen-polish.cjs
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
  'templates-checklists-evergreen.json'
);

const INTENT_ORDER = [
  'checklist',
  'planner',
  'tracker',
  'comparison',
  'audit',
  'decision',
];

const TARGET_RATIO = {
  checklist: 0.28,
  planner: 0.20,
  tracker: 0.18,
  comparison: 0.14,
  audit: 0.12,
  decision: 0.08,
};

const PLAN_LIBRARY = {
  checklist: [
    'monthly subscription review',
    'cloud storage cleanup',
    'home Wi-Fi troubleshooting',
    'device setup readiness',
    'account recovery preparation',
    'app permission review',
    'home budget check',
    'grocery shopping preparation',
    'digital file cleanup',
    'password manager setup',
    'phone storage review',
    'email inbox cleanup',
    'software renewal review',
    'home energy check',
    'backup readiness',
    'device trade-in preparation',
    'family account review',
    'online shopping review',
    'mobile data usage check',
    'recurring bill review',
  ],
  planner: [
    'monthly household budget',
    'weekly meal plan',
    'device replacement timing',
    'subscription cancellation schedule',
    'cloud storage cleanup plan',
    'home office setup plan',
    'family digital account plan',
    'annual bill review plan',
    'phone upgrade plan',
    'software renewal plan',
    'home energy saving plan',
    'grocery budget plan',
    'backup schedule',
    'work-from-home expense plan',
    'online learning budget plan',
    'travel spending plan',
    'holiday purchase plan',
    'emergency file backup plan',
    'home maintenance plan',
    'digital declutter plan',
  ],
  tracker: [
    'monthly subscription spending',
    'mobile data usage',
    'grocery spending',
    'electricity usage',
    'cloud storage growth',
    'delivery order frequency',
    'app renewal dates',
    'device repair costs',
    'household supply refills',
    'streaming service use',
    'software license renewals',
    'online shopping returns',
    'family account usage',
    'printer ink usage',
    'home heating costs',
    'home cooling costs',
    'bank fee charges',
    'coffee spending',
    'takeout spending',
    'storage upgrade history',
  ],
  comparison: [
    'cloud storage options',
    'paid app alternatives',
    'mobile plan options',
    'streaming service choices',
    'note-taking app options',
    'home internet plans',
    'device repair options',
    'password manager choices',
    'budgeting app options',
    'video meeting tools',
    'file transfer methods',
    'backup storage choices',
    'online learning platforms',
    'grocery delivery options',
    'music subscription options',
    'home office tools',
    'photo backup options',
    'family sharing plans',
    'finance app options',
    'device upgrade choices',
  ],
  audit: [
    'recurring subscriptions',
    'cloud storage accounts',
    'automatic renewals',
    'software tools',
    'family digital services',
    'monthly bills',
    'mobile phone plans',
    'home internet costs',
    'app permissions',
    'shared accounts',
    'backup coverage',
    'online shopping habits',
    'delivery spending',
    'insurance extras',
    'bank fees',
    'password recovery settings',
    'unused paid tools',
    'home energy usage',
    'digital storage folders',
    'device accessories',
  ],
  decision: [
    'whether to cancel a subscription',
    'whether to downgrade a mobile plan',
    'whether to replace a paid app',
    'whether to repair or replace a device',
    'whether to buy more cloud storage',
    'whether to keep a streaming service',
    'whether to switch internet plans',
    'whether to pay for a premium feature',
    'whether to keep duplicate tools',
    'whether to upgrade a device',
    'whether to use paid or free software',
    'whether to keep a yearly plan',
  ],
};

function fatal(message) {
  console.error('[templates-checklists-evergreen-polish][FATAL]', message);
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
    checklist: 0,
    planner: 0,
    tracker: 0,
    comparison: 0,
    audit: 0,
    decision: 0,
  };

  if (/checklist|check list|steps|readiness|preparation|review list|setup readiness/.test(text)) {
    scores.checklist += 10;
  }

  if (/plan|planner|schedule|calendar|timeline|routine|budget plan/.test(text)) {
    scores.planner += 10;
  }

  if (/track|tracker|tracking|log|history|usage|spending|renewal dates|frequency/.test(text)) {
    scores.tracker += 10;
  }

  if (/compare|comparison|alternatives|options|choices|methods|versus|vs/.test(text)) {
    scores.comparison += 10;
  }

  if (/audit|inspect|review|inventory|coverage|permissions|renewals|accounts/.test(text)) {
    scores.audit += 10;
  }

  if (/whether|decide|decision|choose|cancel|downgrade|replace|upgrade|keep/.test(text)) {
    scores.decision += 10;
  }

  if (scores.checklist === 0 && /template|worksheet|sheet|form/.test(text)) {
    scores.checklist += 3;
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
    entityName: variant > 1 ? `${base} template ${variant}` : base,
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
  if (type === 'checklist') {
    return fixCase(`How to use a simple checklist for ${base}`);
  }

  if (type === 'planner') {
    return fixCase(`How to plan ${base} with a reusable template`);
  }

  if (type === 'tracker') {
    return fixCase(`How to track ${base} with a simple worksheet`);
  }

  if (type === 'comparison') {
    return fixCase(`How to compare ${base} with a practical table`);
  }

  if (type === 'audit') {
    return fixCase(`How to audit ${base} with a repeatable checklist`);
  }

  if (type === 'decision') {
    if (/^(whether|which)\b/i.test(base)) {
      return fixCase(`How to decide ${base}`);
    }

    return fixCase(`How to decide ${base} with a simple worksheet`);
  }

  return fixCase(`How to organize ${base} with a reusable template`);
}

function buildAngle(type, base) {
  if (type === 'checklist') {
    return `Turn ${base} into a reusable checklist that helps the user complete the task without missing key items.`;
  }

  if (type === 'planner') {
    return `Use a reusable planning template to organize ${base} before action is taken.`;
  }

  if (type === 'tracker') {
    return `Track ${base} with a simple worksheet so repeated patterns become visible.`;
  }

  if (type === 'comparison') {
    return `Compare ${base} with a practical table that focuses on useful decision criteria.`;
  }

  if (type === 'audit') {
    return `Audit ${base} with a repeatable checklist that can be reused over time.`;
  }

  return `Use a decision worksheet to choose the safest practical option for ${base}.`;
}

function buildGoal(type, base) {
  if (type === 'checklist') {
    return `make ${base} easier to complete with a reusable checklist`;
  }

  if (type === 'planner') {
    return `organize ${base} before execution with a reusable planning structure`;
  }

  if (type === 'tracker') {
    return `track ${base} consistently so the user can review changes over time`;
  }

  if (type === 'comparison') {
    return `compare ${base} using clear fields instead of vague impressions`;
  }

  if (type === 'audit') {
    return `review ${base} repeatedly with the same checklist structure`;
  }

  return `help the user decide ${base} with less confusion and fewer avoidable mistakes`;
}

function buildKeyPoints(type) {
  if (type === 'checklist') {
    return [
      'use clear yes or no fields',
      'include a final review step',
      'make the checklist reusable for the same task',
    ];
  }

  if (type === 'planner') {
    return [
      'define the goal before listing actions',
      'separate required steps from optional steps',
      'include a review date or follow-up field',
    ];
  }

  if (type === 'tracker') {
    return [
      'record the same fields every time',
      'keep the tracking format simple',
      'review patterns before making changes',
    ];
  }

  if (type === 'comparison') {
    return [
      'compare only criteria that affect the decision',
      'use the same fields for every option',
      'include a final tradeoff note',
    ];
  }

  if (type === 'audit') {
    return [
      'inspect the same category on a fixed schedule',
      'mark risk and next action clearly',
      'keep old audit results for comparison',
    ];
  }

  return [
    'define the decision clearly',
    'compare practical options by risk and effort',
    'write the final choice and reason',
  ];
}

function buildSteps(type) {
  if (type === 'checklist') {
    return [
      'list the items that must be checked',
      'mark each item as done, missing, or not needed',
      'review the unchecked items before finishing',
    ];
  }

  if (type === 'planner') {
    return [
      'define the goal and time frame',
      'list the required actions in order',
      'add a review date before using the plan',
    ];
  }

  if (type === 'tracker') {
    return [
      'choose the fields to record every time',
      'enter the first baseline record',
      'review the pattern after repeated entries',
    ];
  }

  if (type === 'comparison') {
    return [
      'list the options being compared',
      'score each option using the same fields',
      'choose the option with the clearest tradeoff',
    ];
  }

  if (type === 'audit') {
    return [
      'list the accounts, tools, or items being audited',
      'mark status, risk, and next action',
      'repeat the audit on a fixed schedule',
    ];
  }

  return [
    'define the decision question',
    'compare keep, change, delay, and cancel options',
    'write the final decision and next action',
  ];
}

function buildTemplateFields(type) {
  if (type === 'checklist') {
    return [
      'item',
      'status',
      'required',
      'notes',
      'final review',
    ];
  }

  if (type === 'planner') {
    return [
      'goal',
      'time frame',
      'required action',
      'owner',
      'review date',
    ];
  }

  if (type === 'tracker') {
    return [
      'date',
      'category',
      'amount or count',
      'status',
      'change noticed',
    ];
  }

  if (type === 'comparison') {
    return [
      'option',
      'cost',
      'benefit',
      'risk',
      'final score',
    ];
  }

  if (type === 'audit') {
    return [
      'item',
      'current status',
      'risk level',
      'next action',
      'review date',
    ];
  }

  return [
    'decision question',
    'option',
    'benefit',
    'risk',
    'final choice',
  ];
}

function buildExpectedOutcome(type) {
  if (type === 'checklist') {
    return 'the user can complete the task with fewer missed steps';
  }

  if (type === 'planner') {
    return 'the user has a reusable plan before taking action';
  }

  if (type === 'tracker') {
    return 'the user can review repeated patterns using consistent records';
  }

  if (type === 'comparison') {
    return 'the user can compare options with clear and reusable criteria';
  }

  if (type === 'audit') {
    return 'the user can inspect the same category repeatedly without rebuilding the process';
  }

  return 'the user can make a clear decision and record the reason';
}

function buildDifficulty(type) {
  if (type === 'comparison' || type === 'audit') {
    return 'medium';
  }

  return 'easy';
}

function buildTimeRequired(type) {
  if (type === 'audit' || type === 'comparison') {
    return '15-35 minutes';
  }

  if (type === 'planner' || type === 'tracker') {
    return '10-25 minutes';
  }

  return '5-20 minutes';
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
  const intent = `template/${type}`;
  const base = plan.entityName;

  const entity = ensureObject(seed, 'entity');
  if (entity.name !== base) {
    entity.name = base;
    changed += 1;
  }

  if (entity.type !== 'template-use-case') {
    entity.type = 'template-use-case';
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
  const nextTemplateFields = buildTemplateFields(type);
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

  if (!Array.isArray(seed.templateFields) || seed.templateFields.join('|') !== nextTemplateFields.join('|')) {
    seed.templateFields = nextTemplateFields;
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
    evergreenTemplate: true,
    reusableStructure: true,
    actionableFields: true,
    notTrendDependent: true,
    beginnerFriendly: true,
    hasReviewStep: true,
    typeSpecificTemplate: true,
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
    sourceType: 'templates-checklists evergreen tool redesign rule',
    selectionReason: `redesigned as ${intent} by evergreen reusable tool structure`,
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
    const intent = lowerText(seed && seed.intent).replace(/^template\//, '');
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
  console.log('[templates-checklists-evergreen-polish] start');
  console.log(`[templates-checklists-evergreen-polish] target = ${TARGET_FILE}`);

  const data = readJson(TARGET_FILE);

  if (data.label !== 'templates-checklists') {
    fatal(`label mismatch: got=${data.label}, want=templates-checklists`);
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

  console.log('[templates-checklists-evergreen-polish] checked =', checked);
  console.log('[templates-checklists-evergreen-polish] changed =', changed);

  console.log('[templates-checklists-evergreen-polish] target quota =');
  for (const type of INTENT_ORDER) {
    console.log(`  - template/${type}: ${assignment.quota[type]}`);
  }

  console.log('[templates-checklists-evergreen-polish] actual distribution =');
  Object.keys(byIntent)
    .sort()
    .forEach((intent) => {
      console.log(`  - ${intent}: ${byIntent[intent]}`);
    });

  console.log('[templates-checklists-evergreen-polish] sample =');

  data.evergreen.slice(0, 12).forEach((seed) => {
    console.log(`  - ${seed.id}: ${seed.intent} :: ${seed.title}`);
  });

  console.log('[templates-checklists-evergreen-polish] done');
}

main();
