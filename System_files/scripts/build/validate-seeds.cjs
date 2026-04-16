#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/validate-seeds.cjs
 *
 * 역할
 * - seedpool 전체를 순회하며 시드 구조 검증
 * - seed-design-policy.cjs 기준으로 validate 수행
 * - 엔티티 없는 시드 / 구조 불일치 시드 차단
 *
 * 설계 원칙
 * 1) scheduler 이전 단계에서 실행
 * 2) FAIL 발생 시 즉시 종료 (파이프라인 차단)
 * 3) 수정은 하지 않고 검증만 수행 (읽기 전용)
 */

const fs = require('fs');
const path = require('path');

const {
  validateSeedStructure,
  normalizeSeed,
} = require('./lib/seed-design-policy.cjs');

/* ============================================================
 * 경로 설정
 * ============================================================ */

const ROOT = path.resolve(__dirname, '../..');
const SEEDPOOL_ROOT = path.join(ROOT, 'seedpool');

const TARGET_PATHS = [
  path.join(SEEDPOOL_ROOT, 'warehouse', 'trend'),
  path.join(SEEDPOOL_ROOT, 'warehouse', 'evergreen'),
  path.join(SEEDPOOL_ROOT, 'first-gate'),
];

/* ============================================================
 * 유틸
 * ============================================================ */

function log(...args) {
  console.log('[validate-seeds]', ...args);
}

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  const files = [];

  for (const e of entries) {
    const full = path.join(dir, e.name);

    if (e.isDirectory()) {
      files.push(...listJsonFiles(full));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.json')) {
      files.push(full);
    }
  }

  return files;
}

/* ============================================================
 * 핵심 처리
 * ============================================================ */

function extractItems(json) {
  // 구조 유연 대응 (items / 단일 배열 / 단일 객체)
  if (!json) return [];

  if (Array.isArray(json)) return json;

  if (Array.isArray(json.items)) return json.items;

  return [json];
}

function validateFile(filePath) {
  let json;

  try {
    json = readJSON(filePath);
  } catch (e) {
    return {
      ok: false,
      errors: [`JSON parse error: ${e.message}`],
      filePath,
    };
  }

  const items = extractItems(json);

  const fileErrors = [];

  items.forEach((seed, idx) => {
    const normalized = normalizeSeed(seed);
    const result = validateSeedStructure(normalized);

    if (!result.ok) {
      fileErrors.push({
        index: idx,
        errors: result.errors,
        seed: normalized,
      });
    }
  });

  return {
    ok: fileErrors.length === 0,
    filePath,
    errors: fileErrors,
    count: items.length,
  };
}

/* ============================================================
 * 메인
 * ============================================================ */

function main() {
  log('────────────────────────────────────────────');
  log('시작');
  log('ROOT =', ROOT);
  log('SEEDPOOL_ROOT =', SEEDPOOL_ROOT);
  log('────────────────────────────────────────────');

  let totalFiles = 0;
  let totalSeeds = 0;
  let totalFailFiles = 0;
  let totalFailSeeds = 0;

  const allResults = [];

  for (const dir of TARGET_PATHS) {
    const files = listJsonFiles(dir);

    for (const file of files) {
      totalFiles++;

      const result = validateFile(file);

      totalSeeds += result.count || 0;

      if (!result.ok) {
        totalFailFiles++;
        totalFailSeeds += result.errors.length;
        allResults.push(result);
      }
    }
  }

  log('────────────────────────────────────────────');
  log('검증 결과');
  log('파일 수        =', totalFiles);
  log('시드 수        =', totalSeeds);
  log('실패 파일 수   =', totalFailFiles);
  log('실패 시드 수   =', totalFailSeeds);
  log('────────────────────────────────────────────');

  if (allResults.length > 0) {
    log('❌ 실패 상세');

    for (const r of allResults) {
      log(`\n[FILE] ${r.filePath}`);

      for (const err of r.errors) {
        log(`  - index: ${err.index}`);
        err.errors.forEach(e => log(`    • ${e}`));
      }
    }

    log('────────────────────────────────────────────');
    log('❌ 검증 실패 → 파이프라인 중단');
    process.exit(1);
  }

  log('✅ 모든 시드 검증 통과');
  log('────────────────────────────────────────────');
}

if (require.main === module) {
  main();
}
