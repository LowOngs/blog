#!/usr/bin/env node
'use strict';

/**
 * System_files/tools/patch/howto-title-polish.cjs
 *
 * 역할:
 * - how-to-playbooks evergreen 시드의 제목만 자연스럽게 보정한다.
 * - intent / steps / expectedOutcome 등 구조 필드는 건드리지 않는다.
 * - 어색한 중복 표현을 제거한다.
 *
 * 사용:
 * - node ./System_files/tools/patch/howto-title-polish.cjs
 *
 * 주의:
 * - 운영 build 파이프라인 파일이 아니라 수동 패치 도구다.
 * - 기존 id / fingerprint / entity / keyPoints / priority / steps / intent 삭제 금지.
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

function fatal(message) {
  console.error('[howto-title-polish][FATAL]', message);
  process.exit(1);
}

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
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

function stripActionPrefix(value) {
  return normalizeText(value)
    .replace(/^(how to fix)\s+/i, '')
    .replace(/^(how to set up)\s+/i, '')
    .replace(/^(how to setup)\s+/i, '')
    .replace(/^(how to install)\s+/i, '')
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
  let out = normalizeText(base);

  const replacements = [
    [/^Reset Any Router to Fix Connectivity Issues$/i, 'router connectivity issues'],
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
    .replace(/\bSafely Safely\b/g, 'Safely')
    .replace(/\s+without losing data without losing data$/i, ' without losing data')
    .replace(/\s+/g, ' ')
    .trim();

  return out || 'the task';
}

function sentenceCaseAfterPrefix(title) {
  return normalizeText(title)
    .replace(/\bwi-fi\b/i, 'Wi-Fi')
    .replace(/\bisp\b/i, 'ISP')
    .replace(/\bpc\b/i, 'PC')
    .replace(/\bmac\b/i, 'Mac')
    .replace(/\bbluetooth\b/i, 'Bluetooth');
}

function buildTitle(intent, base) {
  const cleanBase = polishBase(stripActionPrefix(base));

  if (intent === 'how-to/fix') {
    return `How to fix ${cleanBase}`;
  }

  if (intent === 'how-to/setup') {
    return `How to set up ${cleanBase}`;
  }

  if (intent === 'how-to/backup') {
    return `How to back up and restore ${cleanBase}`;
  }

  if (intent === 'how-to/transfer') {
    if (/without losing data$/i.test(cleanBase)) {
      return `How to transfer ${cleanBase}`;
    }
    return `How to transfer ${cleanBase} without losing data`;
  }

  if (intent === 'how-to/cleanup') {
    return `How to clean up and speed up ${cleanBase}`;
  }

  if (intent === 'how-to/security') {
    return `How to secure ${cleanBase}`;
  }

  if (intent === 'how-to/decision') {
    return `How to decide whether ${cleanBase} is the right choice`;
  }

  return `How to complete ${cleanBase}`;
}

function patchSeed(seed) {
  if (!seed || typeof seed !== 'object') {
    return 0;
  }

  const intent = normalizeText(seed.intent);
  const entityName = normalizeText(seed.entity && seed.entity.name);
  const currentTitle = normalizeText(seed.title);
  const base = entityName || currentTitle;

  if (!base) {
    return 0;
  }

  const nextTitle = sentenceCaseAfterPrefix(buildTitle(intent, base));

  if (nextTitle && seed.title !== nextTitle) {
    seed.title = nextTitle;
    return 1;
  }

  return 0;
}

function main() {
  console.log('[howto-title-polish] start');
  console.log(`[howto-title-polish] target = ${TARGET_FILE}`);

  const data = readJson(TARGET_FILE);

  if (data.label !== 'how-to-playbooks') {
    fatal(`label mismatch: got=${data.label}, want=how-to-playbooks`);
  }

  if (!Array.isArray(data.evergreen)) {
    fatal('missing evergreen array');
  }

  let changed = 0;
  let checked = 0;

  for (const seed of data.evergreen) {
    if (!seed || typeof seed !== 'object') {
      continue;
    }

    checked += 1;
    changed += patchSeed(seed);
  }

  writeJson(TARGET_FILE, data);

  console.log('[howto-title-polish] checked =', checked);
  console.log('[howto-title-polish] changed =', changed);
  console.log('[howto-title-polish] sample =');

  data.evergreen.slice(0, 12).forEach((seed) => {
    console.log(`  - ${seed.id}: ${seed.title}`);
  });

  console.log('[howto-title-polish] done');
}

main();
