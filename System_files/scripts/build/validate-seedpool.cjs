#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/validate-seedpool.cjs
 * seedpool/*.json 시드 상태 점검 + 라벨/스키마/중복/만료 리포트 강화
 */

require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');

// ────────────────────────────────────
// 기본 경로 설정
// ────────────────────────────────────
const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const SEEDDIR = path.join(ROOT, 'seedpool');
const LOG_DIR = path.join(ROOT, 'logs');
const REPORT_FN = path.join(LOG_DIR, 'seedpool-report.json');

// ────────────────────────────────────
// 라벨(SSOT) 고정
// ────────────────────────────────────
const ALLOWED_LABELS = new Set([
  'app-reviews',
  'device-reviews',
  'subscription-services',
  'how-to-playbooks',
  'smart-savings',
  'templates-checklists',
]);

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

function isIsoDatePrefix(s) {
  if (typeof s !== 'string') return false;
  const d = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d);
}

function normalizeLabel(fileBaseName, labelFromJson) {
  const cand = String(labelFromJson || fileBaseName || '').trim();
  return cand;
}

function pushIssue(issues, type, message, extra = {}) {
  issues.push({ type, message, ...extra });
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
  let totalTrend = 0;
  let totalEvergreen = 0;

  let parseErrors = 0;
  let invalidLabels = 0;
  let schemaErrors = 0;
  let dupErrors = 0;

  // 전체 중복 탐지(라벨 범위 전체)
  const globalIdSet = new Set(); // `${label}::${id}`

  for (const file of seedFiles) {
    const fullPath = path.join(SEEDDIR, file);
    const baseName = path.basename(file, '.json');

    const { ok, data, error } = safeReadJson(fullPath);
    if (!ok) {
      console.error(`[validate-seedpool] JSON 파싱 실패: ${file} →`, (error && error.message) || error);
      labelReports.push({
        file,
        label: baseName,
        error: 'parse_error',
        message: (error && error.message) || String(error),
      });
      parseErrors++;
      continue;
    }

    const issues = [];

    // 라벨 확정
    const label = normalizeLabel(baseName, data.label);
    if (!ALLOWED_LABELS.has(label)) {
      invalidLabels++;
      pushIssue(
        issues,
        'invalid_label',
        `라벨이 허용 목록(6개)과 일치하지 않습니다: "${label}"`,
        { allowed: Array.from(ALLOWED_LABELS) }
      );
    }

    // limit (없으면 0)
    const trendLimit = Number.isFinite(data.trendLimit) ? data.trendLimit : 0;
    const evergreenLimit = Number.isFinite(data.evergreenLimit) ? data.evergreenLimit : 0;

    // 배열 강제
    const trendArr = Array.isArray(data.trend) ? data.trend : [];
    const evergreenArr = Array.isArray(data.evergreen) ? data.evergreen : [];

    if (!Array.isArray(data.trend)) {
      pushIssue(issues, 'trend_not_array', 'trend 필드가 배열이 아닙니다. 빈 배열로 처리했습니다.');
      schemaErrors++;
    }
    if (!Array.isArray(data.evergreen)) {
      pushIssue(issues, 'evergreen_not_array', 'evergreen 필드가 배열이 아닙니다. 빈 배열로 처리했습니다.');
      schemaErrors++;
    }

    const trendCount = trendArr.length;
    const evergreenCount = evergreenArr.length;

    totalTrend += trendCount;
    totalEvergreen += evergreenCount;

    // 만료된 trend 시드 수 + expiresAt 형식 오류
    let expiredTrend = 0;
    const expiredDetail = [];
    const invalidExpiresDetail = [];

    // 파일 내 중복 탐지
    const localIdSet = new Set();
    const dupDetail = [];

    function checkSeedItem(item, kind, idx) {
      if (!item || typeof item !== 'object') {
        schemaErrors++;
        pushIssue(issues, 'seed_not_object', `${kind}[${idx}] 항목이 객체가 아닙니다.`);
        return;
      }

      const id = item.id ? String(item.id).trim() : '';
      const title = item.title ? String(item.title).trim() : '';

      if (!id) {
        schemaErrors++;
        pushIssue(issues, 'missing_id', `${kind}[${idx}] id 누락`);
      }
      if (!title) {
        schemaErrors++;
        pushIssue(issues, 'missing_title', `${kind}[${idx}] title 누락`, { id: id || null });
      }

      // priority 형식(있으면 숫자)
      if (item.priority !== undefined && item.priority !== null) {
        const p = Number(item.priority);
        if (Number.isNaN(p)) {
          schemaErrors++;
          pushIssue(issues, 'invalid_priority', `${kind}[${idx}] priority가 숫자가 아닙니다.`, {
            id: id || null,
            value: item.priority,
          });
        }
      }

      // expiresAt 형식
      if (item.expiresAt !== undefined && item.expiresAt !== null) {
        if (typeof item.expiresAt !== 'string' || !isIsoDatePrefix(item.expiresAt)) {
          schemaErrors++;
          invalidExpiresDetail.push({
            kind,
            index: idx,
            id: id || null,
            title: title || null,
            expiresAt: item.expiresAt,
          });
        }
      }

      // 중복(파일 내)
      if (id) {
        const localKey = `${label}::${id}`;
        if (localIdSet.has(localKey)) {
          dupErrors++;
          dupDetail.push({ kind, index: idx, id, title: title || null });
        } else {
          localIdSet.add(localKey);
        }

        // 중복(전체)
        if (globalIdSet.has(localKey)) {
          dupErrors++;
          pushIssue(issues, 'duplicate_id_global', `전체 범위에서 중복 id 감지: ${localKey}`, {
            id,
            label,
          });
        } else {
          globalIdSet.add(localKey);
        }
      }
    }

    trendArr.forEach((item, idx) => {
      checkSeedItem(item, 'trend', idx);

      if (item && typeof item === 'object' && isExpired(item.expiresAt, todayISO)) {
        expiredTrend++;
        expiredDetail.push({
          id: item.id || null,
          title: item.title || null,
          expiresAt: item.expiresAt,
        });
      }
    });

    evergreenArr.forEach((item, idx) => {
      checkSeedItem(item, 'evergreen', idx);
    });

    if (dupDetail.length) {
      pushIssue(issues, 'duplicate_id_local', `파일 내부 중복 id가 ${dupDetail.length}개 있습니다.`, {
        count: dupDetail.length,
      });
    }

    if (invalidExpiresDetail.length) {
      pushIssue(issues, 'invalid_expiresAt', `expiresAt 형식이 비정상인 항목이 ${invalidExpiresDetail.length}개 있습니다.`, {
        count: invalidExpiresDetail.length,
      });
    }

    const trendShortage = Math.max(0, trendLimit - trendCount);
    const evergreenShortage = Math.max(0, evergreenLimit - evergreenCount);

    if (trendShortage > 0) {
      pushIssue(issues, 'trend_shortage', `trend 시드가 부족합니다 (${trendCount}/${trendLimit})`, {
        current: trendCount,
        required: trendLimit,
      });
    }

    if (evergreenShortage > 0) {
      pushIssue(issues, 'evergreen_shortage', `evergreen 시드가 부족합니다 (${evergreenCount}/${evergreenLimit})`, {
        current: evergreenCount,
        required: evergreenLimit,
      });
    }

    if (expiredTrend > 0) {
      pushIssue(issues, 'expired_trend', `만료된 trend 시드가 ${expiredTrend}개 있습니다.`, { count: expiredTrend });
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
      invalidExpiresDetail,
      dupDetail,
      issues,
    };

    labelReports.push(report);

    // 콘솔 출력(요약)
    console.log(
      `[${label}] trend=${trendCount}/${trendLimit}, evergreen=${evergreenCount}/${evergreenLimit}, expiredTrend=${expiredTrend}, issues=${issues.length}`
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
    totals: {
      files: seedFiles.length,
      totalTrend,
      totalEvergreen,
      parseErrors,
      invalidLabels,
      schemaErrors,
      dupErrors,
    },
    labels: labelReports,
  };

  ensureDir(LOG_DIR);
  fs.writeFileSync(REPORT_FN, JSON.stringify(summary, null, 2), 'utf8');

  console.log('────────────────────────────────────────────');
  console.log('[validate-seedpool] 리포트 저장 →', REPORT_FN);

  // CI에서 잡히게 exitCode만 설정(리포트는 항상 남김)
  if (parseErrors > 0 || invalidLabels > 0 || schemaErrors > 0 || dupErrors > 0) {
    console.warn('[validate-seedpool] 오류/경고가 존재합니다. totals =', JSON.stringify(summary.totals));
    process.exitCode = 1;
  }
})();
