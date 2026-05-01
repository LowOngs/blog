#!/usr/bin/env node
'use strict';

/**
 * System_files/tools/patch/howto-intent-reclassify.cjs
 *
 * 역할:
 * - how-to-playbooks evergreen 시드를 사용자 행동 구조 기반 quota로 재분류한다.
 * - intent에 맞지 않는 seed는 entity / angle / goal / keyPoints까지 함께 재설계한다.
 * - intent 재분류 후 title / steps / expectedOutcome / difficulty / timeRequired를 다시 정렬한다.
 * - 기존 id / priority 등 무관 필드는 삭제하지 않는다.
 * - fingerprint는 재설계된 의미 단위 기준으로 갱신한다.
 * - 최종 evergreen 배열은 intent별 라운드로빈 방식으로 분산 재배치한다.
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

const PLAN_LIBRARY = {
  fix: [
    'common smartphone problems',
    'router connectivity issues',
    'Bluetooth connection problems',
    'apps that will not open',
    'printer connection problems',
    'email sync errors',
    'video call audio problems',
    'mobile hotspot connection failures',
    'cloud sync errors',
    'keyboard input problems',
    'screen sharing failures',
    'app notification problems',
    'Wi-Fi connection drops',
    'browser loading errors',
    'file download failures',
    'camera not working on a laptop',
    'microphone not detected',
    'smart TV connection problems',
    'USB device not recognized',
    'two devices that will not pair',
  ],
  cleanup: [
    'a slow computer',
    'battery drain on your phone',
    'slow Wi-Fi at home',
    'browser cache safely',
    'low storage on your phone',
    'startup apps on a laptop',
    'unused mobile apps',
    'duplicate photos on your phone',
    'large files on a computer',
    'background apps on Android',
    'old downloads on a laptop',
    'browser extensions slowing things down',
    'temporary files on Windows',
    'storage warnings on iPhone',
    'slow tablet performance',
    'cluttered cloud storage',
    'old screenshots and media files',
    'slow home network basics',
    'unused email attachments',
    'messy desktop files',
  ],
  security: [
    'a forgotten password securely',
    'your main email account',
    'two-factor authentication',
    'a password manager',
    'account recovery settings',
    'suspicious login alerts',
    'shared device privacy',
    'browser saved passwords',
    'phone lock screen settings',
    'cloud account security',
    'public Wi-Fi safety',
    'phishing message checks',
    'app permission settings',
    'social account recovery',
    'family device privacy',
    'work account login safety',
    'backup codes',
    'recovery email settings',
    'personal data on an old phone',
    'privacy settings before selling a device',
  ],
  transfer: [
    'photos between devices',
    'files from an old phone to a new phone',
    'contacts between phones',
    'browser bookmarks to a new computer',
    'documents between cloud drives',
    'photos from phone to laptop',
    'files between Windows and Mac',
    'notes to a new device',
    'calendar data between accounts',
    'music files to a new phone',
    'chat backup to a new phone',
    'email data to a new account',
    'screenshots to cloud storage',
    'large files without corruption',
    'files from USB to cloud storage',
    'contacts from Android to iPhone',
    'photos from iPhone to Windows',
    'documents from laptop to tablet',
    'app data before changing phones',
    'work files to a new laptop',
  ],
  backup: [
    'important files safely',
    'phone photos before a reset',
    'laptop documents before repair',
    'family photos to cloud storage',
    'work files before changing computers',
    'browser bookmarks before reinstalling',
    'contacts before switching phones',
    'two-factor backup codes',
    'important PDFs and receipts',
    'school files before a device reset',
    'cloud files to a second location',
    'external drive backups',
    'email attachments worth keeping',
    'phone notes before migration',
    'tax documents safely',
    'project files before cleanup',
    'photos before deleting duplicates',
    'backup integrity after copying files',
    'files before factory reset',
    'data loss prevention basics',
  ],
  setup: [
    'a new device the right way',
    'a home Wi-Fi router',
    'a password manager for the first time',
    'two-factor authentication for a new account',
    'a cloud backup app',
    'a new laptop for daily use',
    'a new phone before installing apps',
    'a browser profile on a new computer',
    'email on a new phone',
    'a printer on a home network',
    'a video call app before a meeting',
    'family sharing on a phone',
    'cloud storage on a new device',
    'a smart TV connection',
    'a Bluetooth headset',
    'a mobile hotspot',
    'a new tablet for study',
    'a work profile on Android',
    'a basic home office setup',
    'a secure login method',
  ],
  decision: [
    'whether to repair or replace a slow device',
    'whether cloud backup is enough',
    'which files should be backed up first',
    'whether to reset a phone or clean it up',
    'whether to use Wi-Fi or mobile hotspot',
    'which password manager setup is safer',
    'whether to move files manually or use cloud sync',
    'which old apps are safe to remove',
    'whether to buy storage or clean up files',
    'whether to use browser sync',
    'which device should store family photos',
    'whether to keep local or cloud copies',
    'which account recovery method is safer',
    'whether to factory reset a device',
    'which transfer method fits large files',
  ],
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
  return stripLeadingHowTo(base)
    .replace(/\bAny Two Devices\b/g, 'devices')
    .replace(/\bAny Device\b/g, 'your device')
    .replace(/\bAny Phone\b/g, 'your phone')
    .replace(/\bAny Smartphone\b/g, 'your smartphone')
    .replace(/\bAny Router\b/g, 'your router')
    .replace(/\s+without losing data without losing data$/i, ' without losing data')
    .replace(/\s+/g, ' ')
    .trim() || 'the task';
}

function fixCase(title) {
  return normalizeText(title)
    .replace(/\bwi-fi\b/gi, 'Wi-Fi')
    .replace(/\bwifi\b/gi, 'Wi-Fi')
    .replace(/\bisp\b/gi, 'ISP')
    .replace(/\bpc\b/gi, 'PC')
    .replace(/\bmac\b/gi, 'Mac')
    .replace(/\bbluetooth\b/gi, 'Bluetooth')
    .replace(/\biphone\b/gi, 'iPhone')
    .replace(/\bandroid\b/gi, 'Android')
    .replace(/\busb\b/gi, 'USB');
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

  if (/connectivity|connection problem|not opening|not working|crash|freeze|broken|error|failure|disconnect|router|bluetooth/.test(text)) {
    scores.fix += 10;
  }

  if (/slow|speed|cleanup|clean up|performance|startup|cache|storage full|low storage|battery drain|browser cache|duplicate|large files/.test(text)) {
    scores.cleanup += 10;
  }

  if (/password|secure|security|privacy|protect|account|login|2fa|two-factor|credential|hacked|phishing|recovery/.test(text)) {
    scores.security += 10;
  }

  if (/transfer|move files|move photos|sync|migrate|migration|between devices|copy files|share files/.test(text)) {
    scores.transfer += 10;
  }

  if (/backup|back up|restore files|restore backup|file backup|data backup|data loss|lost data|important files|backup codes/.test(text)) {
    scores.backup += 10;
  }

  if (/new device|first time setup|initial setup|install app|pair device|pairing device|set up a new device|home office setup/.test(text)) {
    scores.setup += 10;
  }

  if (/choose|compare|which|select|decision|decide|right choice|best option|whether/.test(text)) {
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

function buildAngle(type, base) {
  if (type === 'fix') {
    return `Troubleshoot ${base} with a safe step-by-step repair path.`;
  }

  if (type === 'cleanup') {
    return `Improve ${base} by removing avoidable clutter and performance drag.`;
  }

  if (type === 'security') {
    return `Protect ${base} against common account, privacy, or access risks.`;
  }

  if (type === 'transfer') {
    return `Move ${base} without losing files, settings, or access.`;
  }

  if (type === 'backup') {
    return `Protect ${base} with a restorable backup workflow.`;
  }

  if (type === 'setup') {
    return `Set up ${base} correctly before normal use.`;
  }

  return `Decide whether ${base} fits the user’s practical need.`;
}

function buildGoal(type, base) {
  if (type === 'fix') {
    return `restore normal operation for ${base}`;
  }

  if (type === 'cleanup') {
    return `improve performance or storage condition for ${base}`;
  }

  if (type === 'security') {
    return `reduce avoidable security or privacy risk for ${base}`;
  }

  if (type === 'transfer') {
    return `move ${base} safely between devices or accounts`;
  }

  if (type === 'backup') {
    return `make ${base} recoverable if something goes wrong`;
  }

  if (type === 'setup') {
    return `prepare ${base} for reliable first use`;
  }

  return `help the user choose the safest practical option for ${base}`;
}

function buildKeyPoints(type) {
  if (type === 'fix') {
    return [
      'identify the symptom before changing settings',
      'start with reversible fixes first',
      'verify the issue after each step',
    ];
  }

  if (type === 'cleanup') {
    return [
      'remove only low-risk clutter',
      'avoid deleting unknown system files',
      'check storage or speed after cleanup',
    ];
  }

  if (type === 'security') {
    return [
      'confirm account ownership and recovery options',
      'enable stronger protection settings',
      'check for suspicious access or weak credentials',
    ];
  }

  if (type === 'transfer') {
    return [
      'confirm source and destination before moving data',
      'use a transfer method that preserves file integrity',
      'verify files after transfer',
    ];
  }

  if (type === 'backup') {
    return [
      'choose data that must not be lost',
      'store a copy in a separate location',
      'test restore access before trusting the backup',
    ];
  }

  if (type === 'setup') {
    return [
      'prepare account and device requirements first',
      'complete setup in the correct order',
      'confirm the setup before relying on it',
    ];
  }

  return [
    'define the user need clearly',
    'compare options by risk and effort',
    'choose the option that avoids unnecessary work',
  ];
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

function buildFingerprint(seed) {
  const source = [
    normalizeText(seed.title).toLowerCase(),
    normalizeText(seed.angle).toLowerCase(),
    normalizeText(seed.audience).toLowerCase(),
    normalizeText(seed.intent).toLowerCase(),
  ].join('|');

  return `fp1:${crypto.createHash('sha1').update(source).digest('hex')}`;
}

function patchSeed(seed, type, index) {
  let changed = 0;

  const plan = buildPlan(type, index);
  const intent = `how-to/${type}`;
  const base = plan.entityName;

  const entity = ensureObject(seed, 'entity');
  if (entity.name !== base) {
    entity.name = base;
    changed += 1;
  }

  if (entity.type !== 'how-to-topic') {
    entity.type = 'how-to-topic';
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
    problemSpecific: true,
    realWorldScenario: true,
    actionable: true,
    repeatable: true,
    hasVerificationStep: true,
    typeSpecificSteps: true,
    intentReclassified: true,
    evergreenQuotaBalanced: true,
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
    sourceType: 'how-to evergreen behavior quota redesign rule',
    selectionReason: `redesigned as ${intent} by evergreen behavior quota`,
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
    const intent = lowerText(seed && seed.intent).replace(/^how-to\//, '');
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
