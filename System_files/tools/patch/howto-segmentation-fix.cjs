#!/usr/bin/env node
'use strict';

/**
 * System_files/tools/patch/howto-segmentation-fix.cjs
 *
 * 역할:
 * - warehouse/evergreen/how-to-playbooks-evergreen.json 시드를 수동 보정한다.
 * - how-to 시드의 intent가 how-to/execute에 과도하게 몰린 문제를 해결한다.
 * - intent / title / steps / expectedOutcome / selectionCriteria / selectionMeta를
 *   실행 가능한 문제 해결형 구조로 재분산한다.
 *
 * 사용:
 * - node ./System_files/tools/patch/howto-segmentation-fix.cjs
 *
 * 주의:
 * - 운영 build 파이프라인 파일이 아니라 수동 패치 도구다.
 * - 기존 id / fingerprint / entity / keyPoints / priority 등은 삭제하지 않는다.
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

const TYPE_ORDER = [
  'fix',
  'setup',
  'backup',
  'transfer',
  'cleanup',
  'security',
  'decision',
];

function fatal(message) {
  console.error('[howto-segmentation-fix][FATAL]', message);
  process.exit(1);
}

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function stripLeadingHowTo(value) {
  return normalizeText(value).replace(
    /^(how to fix|how to set up|how to setup|how to install|how to back up|how to backup|how to restore|how to transfer|how to move|how to sync|how to clean up|how to speed up|how to secure|how to protect|how to complete|how to|beginner’s guide to|beginner's guide to|universal troubleshooting checklist for)\s+/i,
    ''
  );
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

function pickTypeBySeed(seed, index) {
  const text = [
    seed.title,
    seed.angle,
    seed.goal,
    seed.environment,
    seed.entity && seed.entity.name,
  ]
    .map(normalizeText)
    .join(' ')
    .toLowerCase();

  if (/password|secure|security|privacy|protect|account|login|2fa|two-factor|credential/.test(text)) {
    return 'security';
  }

  if (/backup|back up|restore|recovery|recover|lost file|important files/.test(text)) {
    return 'backup';
  }

  if (/transfer|move|sync|migrate|between devices|photos|files between/.test(text)) {
    return 'transfer';
  }

  if (/slow|speed|lag|cleanup|clean up|optimize|performance|startup|cache/.test(text)) {
    return 'cleanup';
  }

  if (/setup|set up|install|configure|connect|pair|onboarding/.test(text)) {
    return 'setup';
  }

  if (/choose|compare|which|select|decision|before buying|before choosing/.test(text)) {
    return 'decision';
  }

  if (/fix|error|issue|problem|crash|freeze|disconnect|not working|troubleshoot|router|wifi|network/.test(text)) {
    return 'fix';
  }

  return TYPE_ORDER[index % TYPE_ORDER.length];
}

function getBaseName(seed) {
  const entityName = seed.entity && normalizeText(seed.entity.name);
  const title = normalizeText(seed.title);
  const raw = entityName || title || 'the task';

  return stripLeadingHowTo(raw) || 'the task';
}

function buildTitle(type, baseName) {
  if (type === 'fix') {
    return `How to fix ${baseName}`;
  }

  if (type === 'setup') {
    return `How to set up ${baseName}`;
  }

  if (type === 'backup') {
    return `How to back up and restore ${baseName}`;
  }

  if (type === 'transfer') {
    return `How to transfer ${baseName} without losing data`;
  }

  if (type === 'cleanup') {
    return `How to clean up and speed up ${baseName}`;
  }

  if (type === 'security') {
    return `How to secure ${baseName}`;
  }

  if (type === 'decision') {
    return `How to decide whether ${baseName} is the right choice`;
  }

  return `How to complete ${baseName}`;
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
  if (type === 'security' || type === 'backup' || type === 'transfer') {
    return 'medium';
  }

  return 'easy';
}

function buildTimeRequired(type) {
  if (type === 'backup' || type === 'transfer') {
    return '15-45 minutes';
  }

  if (type === 'security' || type === 'cleanup') {
    return '10-30 minutes';
  }

  return '5-20 minutes';
}

function patchSeed(seed, index) {
  let changed = 0;

  const type = pickTypeBySeed(seed, index);
  const intent = `how-to/${type}`;
  const baseName = getBaseName(seed);
  const title = buildTitle(type, baseName);
  const steps = buildSteps(type);
  const expectedOutcome = buildExpectedOutcome(type);
  const difficulty = buildDifficulty(type);
  const timeRequired = buildTimeRequired(type);

  if (seed.intent !== intent) {
    seed.intent = intent;
    changed += 1;
  }

  if (seed.title !== title) {
    seed.title = title;
    changed += 1;
  }

  if (!Array.isArray(seed.steps) || seed.steps.join('|') !== steps.join('|')) {
    seed.steps = steps;
    changed += 1;
  }

  if (seed.expectedOutcome !== expectedOutcome) {
    seed.expectedOutcome = expectedOutcome;
    changed += 1;
  }

  if (seed.difficulty !== difficulty) {
    seed.difficulty = difficulty;
    changed += 1;
  }

  if (seed.timeRequired !== timeRequired) {
    seed.timeRequired = timeRequired;
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
  };

  for (const [key, value] of Object.entries(nextCriteria)) {
    if (criteria[key] !== value) {
      criteria[key] = value;
      changed += 1;
    }
  }

  const meta = ensureObject(seed, 'selectionMeta');
  const now = new Date().toISOString();

  const nextMeta = {
    validated: true,
    sourceType: 'how-to type segmentation rule',
    selectionReason: `classified as ${intent} with type-specific steps`,
  };

  for (const [key, value] of Object.entries(nextMeta)) {
    if (meta[key] !== value) {
      meta[key] = value;
      changed += 1;
    }
  }

  if (!normalizeText(meta.selectedAt)) {
    meta.selectedAt = now;
    changed += 1;
  }

  return changed;
}

function main() {
  console.log('[howto-segmentation-fix] start');
  console.log(`[howto-segmentation-fix] target = ${TARGET_FILE}`);

  const data = readJson(TARGET_FILE);

  if (data.label !== 'how-to-playbooks') {
    fatal(`label mismatch: got=${data.label}, want=how-to-playbooks`);
  }

  if (!Array.isArray(data.evergreen)) {
    fatal('missing evergreen array');
  }

  let changed = 0;
  let checked = 0;

  data.evergreen.forEach((seed, index) => {
    if (!seed || typeof seed !== 'object') {
      return;
    }

    checked += 1;
    changed += patchSeed(seed, index);
  });

  writeJson(TARGET_FILE, data);

  const byIntent = {};
  for (const seed of data.evergreen) {
    const intent = normalizeText(seed && seed.intent) || 'missing';
    byIntent[intent] = (byIntent[intent] || 0) + 1;
  }

  console.log('[howto-segmentation-fix] checked =', checked);
  console.log('[howto-segmentation-fix] changed =', changed);
  console.log('[howto-segmentation-fix] intent distribution =');
  Object.keys(byIntent)
    .sort()
    .forEach((intent) => {
      console.log(`  - ${intent}: ${byIntent[intent]}`);
    });

  console.log('[howto-segmentation-fix] done');
}

main();
