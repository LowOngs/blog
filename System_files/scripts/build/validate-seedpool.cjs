#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/validate-seedpool.cjs
 * - seedpool/*.json 시드 상태 점검
 * - 라벨별 trend/evergreen 개수, 부족분, 만료 시드, 파싱 오류 등을 리포트
 * - 결과를 logs/seedpool-report.json 에 저장
 */

const fs   = require('fs');
const path = require('path');

// ────────────────────────────────────
// 기본 경로 설정
// ────────────────────────────────────
const ROOT      = path.resolve(__dirname, '..', '..');   // System_files
const SEEDDIR   = path.join(ROOT, 'seedpool');
const LOG_DIR   = path.join(ROOT, 'logs');
const REPORT_FN = path.join(LOG_DIR, 'seedpool-report.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeReadJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { ok: true, data: JSON.parse(raw), error: null };
  } catch (e) {
    return { ok: false, data: null, error: e };
  }
}

// 오늘 날짜(YYYY-MM-DD)
function getTodayISODate() {
  return new Date().toISOString().slice(0, 10);
}

// expiresAt이 문자열이면 YYYY-MM-DD 앞부분으로 비교
function isExpired(expiresAt, todayISO) {
  if (!expiresAt || typeof expiresAt !== 'string') return false;
  const d = expiresAt.slice(0, 10); // YYYY-MM-DD
  return d < todayISO;
}

// ────────────────────────────────────
// 메인
// ────────────────────────────────────
(function main() {
  console.log('────────────────────────────────────────────');
  console.log('[validate-seedpool] ROOT    =', ROOT);
  console.log('[validate-seedpool] SEEDDIR =', SEEDDIR);

  ensureDir(LOG_DIR);

  if (!fs.existsSync(SEEDDIR)) {
    console.error('[validate-seedpool] seedpool 디렉터리를 찾을 수 없습니다:', SEEDDIR);
    process.exit(1);
  }

  const todayISO = getTodayISODate();
  console.log('[validate-seedpool] today   =', todayISO);

  const entries = fs.readdirSync(SEEDDIR, { withFileTypes: true });

  // seedpool/ 바로 아래의 *.json 파일만 대상
  const seedFiles = entries
    .filter((ent) => ent.isFile() && ent.name.toLowerCase().endsWith('.json'))
    .map((ent) => ent.name)
    .sort();

  if (!seedFiles.length) {
    console.warn('[validate-seedpool] 시드 JSON 파일이 없습니다.');
  } else {
    console.log('[validate-seedpool] 대상 시드 파일 =', seedFiles.join(', '));
  }

  const labelReports = [];
  let totalTrend     = 0;
  let totalEvergreen = 0;
  let parseErrors    = 0;

  for (const file of seedFiles) {
    const fullPath = path.join(SEEDDIR, file);
    const baseName = path.basename(file, '.json');

    const { ok, data, error } = safeReadJson(fullPath);
    if (!ok) {
      console.error(
        `[validate-seedpool] JSON 파싱 실패: ${file} →`,
        (error && error.message) || error
      );
      labelReports.push({
        file,
        label: baseName,
        error: 'parse_error',
        message: (error && error.message) || String(error)
      });
      parseErrors++;
      continue;
    }

    const label          = data.label || baseName;
    const trendLimit     = Number.isFinite(data.trendLimit) ? data.trendLimit : 0;
    const evergreenLimit = Number.isFinite(data.evergreenLimit) ? data.evergreenLimit : 0;

    const trendArr     = Array.isArray(data.trend) ? data.trend : [];
    const evergreenArr = Array.isArray(data.evergreen) ? data.evergreen : [];

    const trendCount     = trendArr.length;
    const evergreenCount = evergreenArr.length;

    totalTrend     += trendCount;
    totalEvergreen += evergreenCount;

    // 만료된 trend 시드 수
    let expiredTrend   = 0;
    let expiredDetail  = [];
    for (const item of trendArr) {
      if (!item || typeof item !== 'object') continue;
      if (isExpired(item.expiresAt, todayISO)) {
        expiredTrend++;
        expiredDetail.push({
          id: item.id || null,
          title: item.title || null,
          expiresAt: item.expiresAt
        });
      }
    }

    const trendShortage     = Math.max(0, trendLimit - trendCount);
    const evergreenShortage = Math.max(0, evergreenLimit - evergreenCount);

    const issues = [];

    if (trendShortage > 0) {
      issues.push({
        type: 'trend_shortage',
        message: `trend 시드가 부족합니다 (${trendCount}/${trendLimit})`,
        current: trendCount,
        required: trendLimit
      });
    }

    if (evergreenShortage > 0) {
      issues.push({
        type: 'evergreen_shortage',
        message: `evergreen 시드가 부족합니다 (${evergreenCount}/${evergreenLimit})`,
        current: evergreenCount,
        required: evergreenLimit
      });
    }

    if (expiredTrend > 0) {
      issues.push({
        type: 'expired_trend',
        message: `만료된 trend 시드가 ${expiredTrend}개 있습니다.`,
        count: expiredTrend
      });
    }

    const report = {
      file,
      label,
      trendLimit,
      evergreenLimit,
      trendCount,
      evergreenCount,
      trendShortage,
      evergreenShortage,
      expiredTrend,
      expiredDetail,
      issues
    };

    labelReports.push(report);

    // 콘솔 출력(요약)
    console.log(
      `[${label}] trend=${trendCount}/${trendLimit}, evergreen=${evergreenCount}/${evergreenLimit}, expiredTrend=${expiredTrend}`
    );
    if (issues.length) {
      for (const iss of issues) {
        console.log(`  - issue: ${iss.type} → ${iss.message}`);
      }
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    today: todayISO,
    seedDir: SEEDDIR,
    totalLabels: labelReports.length,
    totalTrend,
    totalEvergreen,
    parseErrors,
    labels: labelReports
  };

  ensureDir(LOG_DIR);
  fs.writeFileSync(REPORT_FN, JSON.stringify(summary, null, 2), 'utf8');

  console.log('────────────────────────────────────────────');
  console.log('[validate-seedpool] 리포트 저장 →', REPORT_FN);

  if (parseErrors > 0) {
    console.warn('[validate-seedpool] 일부 시드 파일에서 파싱 오류가 발생했습니다.');
    process.exitCode = 1;
  }
})();
