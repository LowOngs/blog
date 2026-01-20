#!/usr/bin/env node
'use strict';

/* qa-check.cjs
 * dist/posts/*.html 대상 AIO/SEO/무결성 QA 체크
 *
 * 판정 규칙(요약)
 * - PASS: 문제 없음
 * - WARN: 경고(발행은 가능)
 * - FAIL: 오류(빌드 실패급)
 * - CRIT: 자동발행에서는 제외해야 하는 치명 이슈(무결성)
 *
 * ✅ CRIT(무결성) — 현재 확정 3개(qa-check 담당)
 * 1) 리뷰 라벨인데 missing-ssot 노출
 * 2) 템플릿 계약(핵심 ID: tldr/keyfacts/faq/sources) 누락
 * 3) pageId 무결성 파손(미존재/다중불일치)
 *
 * ⚠️ 나머지 2개(CRIT) — “하드 차단” 책임 파일에서 처리 권장
 * 4) PUBLISH 게이트 위반 → scripts/publish/blogger.cjs
 * 5) DRY_RUN 게이트 위반 → scripts/build/r2-upload.cjs
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist', 'posts');
const LOGS = path.join(ROOT, 'logs');

const CDN_BASE_RAW = process.env.CDN_BASE || 'https://ongsblog.com/images';
const CDN_BASE = CDN_BASE_RAW.replace(/\/+$/, '');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowKstDate() {
  const d = new Date();
  const k = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return k.toISOString().slice(0, 10);
}

function readHtml(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    console.warn(`[qa-check] HTML 읽기 실패: ${filePath} → ${e.message}`);
    return null;
  }
}

function extractOgImage(html) {
  const re =
    /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i;
  const m = html.match(re);
  return m ? m[1].trim() : null;
}

function hasArticleSchema(html) {
  return html.includes('"@type":"Article"') || html.includes('"@type": "Article"');
}

function hasBreadcrumbList(html) {
  return (
    html.includes('"@type":"BreadcrumbList"') ||
    html.includes('"@type": "BreadcrumbList"')
  );
}

function isReviewFileName(fileName) {
  const base = String(fileName || '').toLowerCase();
  return (
    base.startsWith('app-') ||
    base.startsWith('device-') ||
    base.startsWith('subscription-')
  );
}

/* ─────────────────────────────
 * CRIT #1: 리뷰 SSOT 누락 노출 감지
 * ───────────────────────────── */
function detectMissingReviewSsot(html) {
  const h = String(html || '');
  if (!h) return false;

  const patterns = [
    /reviewStatus\s*=\s*["']missing-ssot["']/i,
    /data-review-status\s*=\s*["']missing-ssot["']/i,
    /missing-ssot/i,
    /데이터\s*수집\/?검증\s*후\s*업데이트\s*됩니다/i,
  ];
  return patterns.some((re) => re.test(h));
}

/* ─────────────────────────────
 * CRIT #2: 템플릿 계약(핵심 ID) 감지
 * - render 구조가 깨지면 AIO/인용 구조도 무너짐
 * ───────────────────────────── */
const REQUIRED_BLOCK_IDS = [
  'tldr',
  'keyfacts',
  'faq',
  'sources',
];

function detectMissingCoreBlocks(html) {
  const missing = [];
  for (const id of REQUIRED_BLOCK_IDS) {
    const re = new RegExp(`id=["']${id}["']`, 'i');
    if (!re.test(html)) missing.push(id);
  }
  return missing;
}

/* ─────────────────────────────
 * CRIT #3: pageId 무결성 감지
 * - pageId는 meta/schema/canonical/ledger 연쇄의 핵심
 * ───────────────────────────── */
function detectPageIds(html) {
  const h = String(html || '');
  const re = /page\d{6}/g;
  const matches = h.match(re) || [];
  const uniq = Array.from(new Set(matches));
  return uniq;
}

async function headCheck(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

function rankStatus(cur, next) {
  const w = { PASS: 0, WARN: 1, FAIL: 2, CRIT: 3 };
  const a = w[cur] ?? 0;
  const b = w[next] ?? 0;
  return b > a ? next : cur;
}

async function checkOne(fileName) {
  const fullPath = path.join(DIST, fileName);
  const html = readHtml(fullPath);
  if (!html) {
    return {
      status: 'FAIL',
      file: fileName,
      slug: fileName.replace(/\.html$/i, ''),
      messages: ['[FAIL] HTML 읽기 실패'],
    };
  }

  let status = 'PASS';
  const messages = [];

  // ── CRIT #2: 핵심 블록 계약 검사 (전 파일 공통)
  const missingCore = detectMissingCoreBlocks(html);
  if (missingCore.length) {
    status = rankStatus(status, 'CRIT');
    messages.push(`[CRIT] 핵심 블록 ID 누락 → ${missingCore.join(', ')}`);
  }

  // ── CRIT #3: pageId 무결성(미존재/다중불일치)
  const pageIds = detectPageIds(html);
  if (!pageIds.length) {
    status = rankStatus(status, 'CRIT');
    messages.push('[CRIT] pageId(page######) 미검출 → 메타/스키마/ledger 연쇄 위험');
  } else if (pageIds.length > 1) {
    status = rankStatus(status, 'CRIT');
    messages.push(`[CRIT] pageId가 다중 존재(불일치 가능) → ${pageIds.join(', ')}`);
  } else {
    messages.push(`[OK] pageId 감지 → ${pageIds[0]}`);
  }

  // ── CRIT #1: 리뷰 라벨인데 SSOT 누락 노출
  if (isReviewFileName(fileName)) {
    const missing = detectMissingReviewSsot(html);
    if (missing) {
      status = rankStatus(status, 'CRIT');
      messages.push('[CRIT] 리뷰 라벨인데 SSOT 누락(missing-ssot) 노출 → 자동발행 제외');
    }
  }

  // 기존 검사들(SEO/AIO 품질)
  const ogUrl = extractOgImage(html);
  const hasArticle = hasArticleSchema(html);
  const hasBreadcrumb = hasBreadcrumbList(html);

  // 1) Article / BreadcrumbList
  if (!hasArticle) {
    status = rankStatus(status, 'WARN');
    messages.push('[WARN] Article 스키마 없음');
  }
  if (!hasBreadcrumb) {
    status = rankStatus(status, 'WARN');
    messages.push('[WARN] BreadcrumbList 스키마 없음');
  }

  // 2) og:image
  if (!ogUrl) {
    status = rankStatus(status, 'FAIL');
    messages.push('[FAIL] og:image 메타 태그 없음');
  } else {
    if (!ogUrl.startsWith(CDN_BASE)) {
      status = rankStatus(status, 'WARN');
      messages.push(`[WARN] og:image CDN_BASE(${CDN_BASE}) 기준이 아님 → ${ogUrl}`);
    }

    const result = await headCheck(ogUrl);
    if (!result.ok) {
      status = rankStatus(status, 'FAIL');
      messages.push(
        `[FAIL] og:image 응답 오류 (status=${result.status}${
          result.error ? `, error=${result.error}` : ''
        }) → ${ogUrl}`,
      );
    } else {
      messages.push(`[OK] og:image 200 응답 확인 → ${ogUrl}`);
    }
  }

  return {
    status,
    file: fileName,
    slug: fileName.replace(/\.html$/i, ''),
    messages,
  };
}

function writeReport(report) {
  ensureDir(LOGS);

  const dateStr = nowKstDate();
  const dated = path.join(LOGS, `qa-report-${dateStr}.json`);
  const latest = path.join(LOGS, 'qa-report.json');

  fs.writeFileSync(dated, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(latest, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log(`[qa-check] report saved → ${dated}`);
  console.log(`[qa-check] report saved → ${latest}`);
}

async function main() {
  if (!fs.existsSync(DIST)) {
    console.log(`[qa-check] dist/posts 폴더가 없습니다. (${DIST})`);
    process.exit(0);
  }

  const files = fs
    .readdirSync(DIST)
    .filter((f) => f.toLowerCase().endsWith('.html'));

  if (!files.length) {
    console.log('[qa-check] 검사할 HTML 파일이 없습니다.');
    process.exit(0);
  }

  console.log(`[qa-check] 검사 대상 파일 수: ${files.length}`);
  console.log('────────────────────────────────────────────');

  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;
  let critCount = 0;

  const items = [];

  for (const file of files) {
    const result = await checkOne(file);
    items.push(result);

    if (result.status === 'PASS') passCount++;
    else if (result.status === 'WARN') warnCount++;
    else if (result.status === 'FAIL') failCount++;
    else if (result.status === 'CRIT') critCount++;

    console.log(`파일: ${file}`);
    console.log(`상태: ${result.status}`);
    if (result.messages && result.messages.length) {
      for (const msg of result.messages) console.log(`  - ${msg}`);
    }
    console.log('');
  }

  console.log('────────────────────────────────────────────');
  console.log(
    `[qa-check] 결과: PASS ${passCount} / WARN ${warnCount} / FAIL ${failCount} / CRIT ${critCount}`,
  );
  console.log('────────────────────────────────────────────');

  const report = {
    generatedAt: new Date().toISOString(),
    cdnBase: CDN_BASE,
    counts: { pass: passCount, warn: warnCount, fail: failCount, crit: critCount },
    requiredBlockIds: REQUIRED_BLOCK_IDS,
    items
  };

  writeReport(report);

  // FAIL/CRIT는 CI 실패로 처리
  if (failCount > 0 || critCount > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  if (typeof fetch !== 'function') {
    console.error('[qa-check] Node 18+ (전역 fetch 지원) 필요');
    process.exit(1);
  }
  main().catch((err) => {
    console.error('[qa-check] 치명적 오류:', err);
    process.exit(1);
  });
}
