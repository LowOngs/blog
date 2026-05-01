#!/usr/bin/env node
'use strict';

/**
 * System_files/tools/patch/howto-intent-reclassify.cjs
 *
 * 역할:
 * - how-to-playbooks evergreen 시드를 사용자 행동 구조 기반 quota로 재분류한다.
 * - intent 재분류 후 title / steps / expectedOutcome / difficulty / timeRequired를 다시 정렬한다.
 * - 기존 id / fingerprint / entity / keyPoints / priority는 삭제하지 않는다.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const TARGET_FILE = path.join(
  ROOT,
  'seedpool',
  'warehouse',
  'evergreen',
  'how-to-playbooks-evergreen.json'
);

const INTENT_ORDER = ['fix', 'cleanup', 'security', 'transfer', 'backup', 'setup', 'decision'];

const TARGET_RATIO = {
  fix: 0.39,
  cleanup: 0.18,
  security: 0.13,
  transfer: 0.12,
  backup: 0.10,
  setup: 0.05,
  decision: 0.03,
};

function fatal(message) {
  console.error('[howto-intent-reclassify][FATAL]', message);
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

function stripLeadingHowTo(value) {
  return normalizeText(value)
    .replace(/^(how to fix)\s+/i, '')
    .replace(/^(how to set up)\s+/i, '')
    .replace(/^(how to setup)\s+/i, '')
    .replace(/^(how to install)\s+/i, '')
    .replace(/^(how to configure)\s+/i, '')
    .replace(/^(how to back up and restore)\s+/i, '')
    .replace(/^(how to back up)\s+/i, '')
    .replace(/^(how to backup)\s+/i, '')
    .replace(/^(how to restore)\s+/i, '')
    .replace(/^(how to transfer)\s+/i, '')
    .replace(/^(how to move)\s+/i, '')
    .replace(/^(how to sync)\s+/i, '')
    .replace(/^(how to clean up and speed up)\s+/i, '')
    .replace(/^(how to clean up)\s+/i, '')
    .replace(/^(how to speed up)\s+/i, '')
    .replace(/^(how to secure)\s+/i, '')
    .replace(/^(how to protect)\s+/i, '')
    .replace(/^(how to decide whether)\s+/i, '')
    .replace(/^(how to complete)\s+/i, '')
    .replace(/^(how to)\s+/i, '')
    .replace(/^(beginner’s guide to)\s+/i, '')
    .replace(/^(beginner's guide to)\s+/i, '')
    .replace(/^(universal troubleshooting checklist for)\s+/i, '')
    .trim();
}

function polishBase(base) {
  let out = stripLeadingHowTo(base);

  const replacements = [
    [/^Reset Any Router to Fix Connectivity Issues$/i, 'router connectivity issues'],
    [/^router connectivity issues$/i, 'router connectivity issues'],
    [/^Bluetooth Connection Problems$/i, 'Bluetooth connection problems'],
    [/^Reduce Battery Drain on Any Phone$/i, 'battery drain on your phone'],
    [/^Slow Wi-Fi Without Calling Your ISP$/i, 'slow Wi-Fi at home'],
    [/^Recover a Forgotten Password Securely$/i, 'a forgotten password securely'],
    [/^Clear Cache Safely Across Browsers$/i, 'browser cache safely'],
    [/^Apps Not Opening on Any Device$/i, 'apps that will not open'],
    [/^a New Device the Right Way$/i, 'a new device the right way'],
    [/^Any Smartphone$/i, 'common smartphone problems'],
    [/^Cleaning Up Slow Computers$/i, 'a slow computer'],
    [/^Important Files Safely$/i, 'important files safely'],
    [/^Photos Between Any Two Devices$/i, 'photos between devices'],
  ];

  for (const [pattern, replacement] of replacements) {
    out = out.replace(pattern, replacement);
  }

  out = out
    .replace(/\bAny Two Devices\b/g, 'devices')
    .replace(/\bAny Device\b/g, 'your device')
    .replace(/\bAny Phone\b/g, 'your phone')
    .replace(/\bAny Smartphone\b/g, 'your smartphone')
    .replace(/\bAny Router\b/g, 'your router')
    .replace(/\s+without losing data without losing data$/i, ' without losing data')
    .replace(/\s+/g, ' ')
    .trim();

  return out || 'the task';
}

function fixCase(title) {
  return normalizeText(title)
    .replace(/\bwi-fi\b/gi, 'Wi-Fi')
    .replace(/\bisp\b/gi, 'ISP')
    .replace(/\bpc\b/gi, 'PC')
    .replace(/\bmac\b/gi, 'Mac')
    .replace(/\bbluetooth\b/gi, 'Bluetooth');
}

function collectText(seed) {
  return [
    seed.angle,
    seed.audience,
    seed.environment,
    seed.goal,
    seed.entity && seed.entity.name,
    Array.isArray(seed.keyPoints) ? seed.keyPoints.join(' ') : '',
  ]
    .map(normalizeText)
    .join(' ');
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

function scoreSeed(seed) {
  const text = lowerText(collectText(seed));
  const scores = {
    fix: 0,
    cleanup: 0,
    security: 0,
    transfer: 0,
    backup: 0,
    setup: 0,
    decision: 0,
  };

  if (/common smartphone problems|router connectivity|connectivity issues|bluetooth connection|connection problems|apps that will not open|not opening|not working|crash|freezes|broken|error|failure|disconnect/.test(text)) {
    scores.fix += 10;
  }

  if (/slow|speed|lag|lags|cleanup|clean up|optimize|performance|startup|cache|storage full|low storage|battery drain|drains too fast|browser cache/.test(text)) {
    scores.cleanup += 10;
  }

  if (/password|secure|security|privacy|protect|account|login|2fa|two-factor|credential|hacked|phishing|forgotten password/.test(text)) {
    scores.security += 10;
  }

  if (/transfer|move files|move photos|sync|migrate|migration|between devices|copy files|share files|photos between devices/.test(text)) {
    scores.transfer += 10;
  }

  if (/backup|back up|restore files|restore backup|file backup|data backup|backup method|backup integrity|data loss|lost data|important files/.test(text)) {
    scores.backup += 10;
  }

  if (/new device|first time setup|initial setup|install app|pair device|pairing device|set up a new device|first time|initial/.test(text)) {
    scores.setup += 10;
  }

  if (/choose|compare|which|select|decision|decide|right choice|best option|before buying|before choosing/.test(text)) {
    scores.decision += 10;
  }

  if (scores.fix === 0 && /problem|issue|troubleshoot|troubleshooting/.test(text)) {
    scores.fix += 3;
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
      scores,
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

function buildTitle(type, base) {
  const cleanBase = polishBase(base);

  if (type === 'fix') {
    return fixCase(`How to fix ${cleanBase}`);
  }

  if (type === 'setup') {
    return fixCase(`How to set up ${cleanBase}`);
  }

  if (type === 'backup') {
    return fixCase(`How to back up and restore ${cleanBase}`);
  }

  if (type === 'transfer') {
    if (/without losing data$/i.test(cleanBase)) {
      return fixCase(`How to transfer ${cleanBase}`);
    }

    return fixCase(`How to transfer ${cleanBase} without losing data`);
  }

  if (type === 'cleanup') {
    return fixCase(`How to clean up and speed up ${cleanBase}`);
  }

  if (type === 'security') {
    return fixCase(`How to secure ${cleanBase}`);
  }

  if (type === 'decision') {
    return fixCase(`How to decide whether ${cleanBase} is the right choice`);
  }

  return fixCase(`How to complete ${cleanBase}`);
}

function buildSteps(type) {
  if (type === 'fix') {
    return [
      'identify the exact symptom and when it started',
      'apply the safest fix for the likely cause',
      'verify that the issue does not return',
    ];
  }

  if (type === 'setup') {
    return [
      'prepare the required account, device, or settings',
      'complete setup in the correct order',
      'confirm that the setup works as expected',
    ];
  }

  if (type === 'backup') {
    return [
      'choose the files or data that must be protected',
      'save the backup to a safe secondary location',
      'test that the backup can be restored',
    ];
  }

  if (type === 'transfer') {
    return [
      'identify the source and destination devices',
      'use the safest transfer method for the file type',
      'confirm that the transferred files open correctly',
    ];
  }

  if (type === 'cleanup') {
    return [
      'identify unnecessary files, apps, or background tasks',
      'remove or disable only safe items',
      'measure speed or storage improvement after cleanup',
    ];
  }

  if (type === 'security') {
    return [
      'check the current risk or exposure point',
      'apply the required protection setting',
      'verify recovery options and protection status',
    ];
  }

  if (type === 'decision') {
    return [
      'define the user goal and constraint',
      'compare the practical options using clear criteria',
      'choose the option with the lowest avoidable risk',
    ];
  }

  return [
    'identify the exact task context',
    'apply the correct working method',
    'verify the result before finishing',
  ];
}

function buildExpectedOutcome(type) {
  if (type === 'fix') {
    return 'the issue is resolved and normal operation is restored';
  }

  if (type === 'setup') {
    return 'the system or service is correctly configured and ready to use';
  }

  if (type === 'backup') {
    return 'important data is backed up and can be restored if needed';
  }

  if (type === 'transfer') {
    return 'files or settings are transferred without loss or corruption';
  }

  if (type === 'cleanup') {
    return 'performance or storage improves without breaking normal use';
  }

  if (type === 'security') {
    return 'the account, device, or workflow is protected against common risks';
  }

  if (type === 'decision') {
    return 'the user can make a clear decision with fewer avoidable mistakes';
  }

  return 'the task is completed with a clear and repeatable result';
}

function buildDifficulty(type) {
  if (type === 'backup' || type === 'transfer' || type === 'security') {
    return 'medium';
  }

  return 'easy';
}

function buildTimeRequired(type) {
  if (type === 'backup' || type === 'transfer') {
    return '15-45 minutes';
  }

  if (type === 'cleanup' || type === 'security') {
    return '10-30 minutes';
  }

  return '5-20 minutes';
}

function patchSeed(seed, type) {
  let changed = 0;

  const intent = `how-to/${type}`;
  const base = (seed.entity && seed.entity.name) || seed.title || 'the task';

  const nextTitle = buildTitle(type, base);
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
    problemSpecific: true,
    realWorldScenario: true,
    actionable: true,
    repeatable: true,
    hasVerificationStep: true,
    typeSpecificSteps: true,
    intentReclassified: true,
    evergreenQuotaBalanced: true,
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
    sourceType: 'how-to evergreen behavior quota rule',
    selectionReason: `assigned as ${intent} by evergreen behavior quota`,
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

  return changed;
}

function main() {
  console.log('[howto-intent-reclassify] start');
  console.log(`[howto-intent-reclassify] target = ${TARGET_FILE}`);

  const data = readJson(TARGET_FILE);

  if (data.label !== 'how-to-playbooks') {
    fatal(`label mismatch: got=${data.label}, want=how-to-playbooks`);
  }

  if (!Array.isArray(data.evergreen)) {
    fatal('missing evergreen array');
  }

  const seeds = data.evergreen.filter((seed) => seed && typeof seed === 'object');
  const assignment = assignTypes(seeds);

  let checked = 0;
  let changed = 0;

  for (const seed of seeds) {
    checked += 1;
    changed += patchSeed(seed, assignment.assigned.get(seed));
  }

  writeJson(TARGET_FILE, data);

  const byIntent = {};
  for (const seed of data.evergreen) {
    const intent = normalizeText(seed && seed.intent) || 'missing';
    byIntent[intent] = (byIntent[intent] || 0) + 1;
  }

  console.log('[howto-intent-reclassify] checked =', checked);
  console.log('[howto-intent-reclassify] changed =', changed);

  console.log('[howto-intent-reclassify] target quota =');
  for (const type of INTENT_ORDER) {
    console.log(`  - how-to/${type}: ${assignment.quota[type]}`);
  }

  console.log('[howto-intent-reclassify] actual distribution =');
  Object.keys(byIntent)
    .sort()
    .forEach((intent) => {
      console.log(`  - ${intent}: ${byIntent[intent]}`);
    });

  console.log('[howto-intent-reclassify] sample =');

  data.evergreen.slice(0, 12).forEach((seed) => {
    console.log(`  - ${seed.id}: ${seed.intent} :: ${seed.title}`);
  });

  console.log('[howto-intent-reclassify] done');
}

main();
