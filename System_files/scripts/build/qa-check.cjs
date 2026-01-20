#!/usr/bin/env node
/* qa-check.cjs
 * dist/posts/*.html 대상으로 "무결성 5" 중 QA가 책임지는 3개를 CRIT로 판정한다.
 *
 * [무결성 5 (확정)]
 * 1) Review SSOT 무결성: 리뷰 라벨인데 missing-ssot 노출이면 CRIT
 * 2) 핵심 블록 계약: id="tldr|keyfacts|faq|sources" 누락이면 CRIT
 * 3) pageId 무결성: pageId 누락/파손/복수 불일치면 CRIT
 * 4) PUBLISH 게이트: publish/blogger.cjs가 최종 차단(qa-check 범위 아님)
 * 5) DRY_RUN 게이트: build/r2-upload.cjs가 최종 차단(qa-check 범위 아님)
 *
 * (주의) og:image HEAD(fetch) 불안정 이슈는 "정리 이후" 단계에서 다룬다.
 *       → 여기서는 og:image 존재/형식만 체크(WARN/FAIL)로 최소 유지.
 */

'use strict';

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

// ─────────────────────────────────────────────
// [무결성 #1] Review SSOT missing-ssot 감지 (리뷰 라벨만)
// ─────────────────────────────────────────────
function isReviewFileName(fileName) {
  const base = String(fileName || '').toLowerCase();
  return (
    base.startsWith('app-') ||
    base.startsWith('device-') ||
    base.startsWith('subscription-')
  );
}

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

// ─────────────────────────────────────────────
// [무결성 #2] Content Block Contract (tldr/keyfacts/faq/sources) 체크
// ─────────────────────────────────────────────
function hasId(html, id) {
  const re = new RegExp(`id=["']${id}["']`, 'i');
  return re.test(String(html || ''));
}

function checkCoreBlocks(html) {
  const missing = [];
  if (!hasId(html, 'tldr')) missing.push('tldr');
  if (!hasId(html, 'keyfacts')) missing.push('keyfacts');
  if (!hasId(html, 'faq')) missing.push('faq');
  if (!hasId(html, 'sources')) missing.push('sources');
  return missing;
}

// ─────────────────────────────────────────────
// [무결성 #3] pageId 무결성 체크
// - 최소 기준: page\d{6} 패턴이 최소 1개 이상 존재
// - 강화 기준: 서로 다른 pageId가 2개 이상이면 CRIT (불일치/오염)
// ─────────────────────────────────────────────
function extractAllPageIds(html) {
  const h = String(html || '');
  const set = new Set();

  // 1) data-page-id="page000001"
  {
    const re = /data-page-id\s*=\s*["'](page\d{6})["']/gi;
    let m;
    while ((m = re.exec(h))) set.add(m[1]);
  }

  // 2) id="pageId">page000001<
  {
    const re = /id\s*=\s*["']pageId["'][^>]*>\s*(page\d{6})\s*</gi;
    let m;
    while ((m = re.exec(h))) set.add(m[1]);
  }

  // 3) fallback: page000001 anywhere (너무 느슨하지만 “완전 누락” 방어용)
  if (set.size === 0) {
    const re = /\b(page\d{6})\b/g;
    let m;
    while ((m = re.exec(h))) set.add(m[1]);
  }

  return Array.from(set);
}

function pickSinglePageId(pageIds) {
  if (!Array.isArray(pageIds) || pageIds.length === 0) return { ok: false, pageId: '' };
  if (pageIds.length === 1) return { ok: true, pageId: pageIds[0] };
  // 서로 다른 pageId가 여러 개면 무결성 파손
  return { ok: false, pageId: '' };
}

// ─────────────────────────────────────────────
// SEO/AIO 일반 체크(무결성 CRIT가 아닌 영역)
// - Article/Breadcrumb schema: 없으면 WARN
// - og:image: 없으면 FAIL, CDN_BASE 불일치면 WARN
// ─────────────────────────────────────────────
function extractOgImage(html) {
  const re =
    /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i;
  const m = String(html || '').match(re);
  return m ? m[1].trim() : null;
}

function hasArticleSchema(html) {
  const h = String(html || '');
  return h.includes('"@type":"Article"') || h.includes('"@type": "Article"');
}

function hasBreadcrumbList(html) {
  const h = String(html || '');
  return h.includes('"@type":"BreadcrumbList"') || h.includes('"@type": "BreadcrumbList"');
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
      pageId: '',
      messages: ['[FAIL] HTML 읽기 실패'],
      integrity: { reviewSsot: null, coreBlocks: null, pageId: null },
    };
  }

  const slug = fileName.replace(/\.html$/i, '');
  const messages = [];
  let status = 'PASS';

  // ── 무결성 #1: 리뷰 라벨인데 missing-ssot 노출 ──
  let integrityReview = null;
  if (isReviewFileName(fileName)) {
    const missing = detectMissingReviewSsot(html);
    integrityReview = { isReview: true, missingSsot: missing };
    if (missing) {
      status = rankStatus(status, 'CRIT');
      messages.push('[CRIT][I1] 리뷰 라벨인데 SSOT 누락(missing-ssot) → 자동발행 제외 대상');
    }
  } else {
    integrityReview = { isReview: false, missingSsot: false };
  }

  // ── 무결성 #2: 핵심 블록 계약(tldr/keyfacts/faq/sources) ──
  const missingBlocks = checkCoreBlocks(html);
  const integrityBlocks = { missing: missingBlocks.slice() };
  if (missingBlocks.length > 0) {
    status = rankStatus(status, 'CRIT');
    messages.push(`[CRIT][I2] 핵심 블록 계약 누락: ${missingBlocks.join(', ')}`);
  }

  // ── 무결성 #3: pageId 무결성 ──
  const pageIds = extractAllPageIds(html);
  const picked = pickSinglePageId(pageIds);
  const integrityPageId = { found: pageIds.slice(), ok: picked.ok };

  let pageId = '';
  if (!picked.ok) {
    status = rankStatus(status, 'CRIT');
    if (pageIds.length === 0) {
      messages.push('[CRIT][I3] pageId 누락 (page###### 패턴이 전혀 없음)');
    } else {
      messages.push(`[CRIT][I3] pageId 불일치/복수 감지: ${pageIds.join(', ')}`);
    }
  } else {
    pageId = picked.pageId;
  }

  // ── 일반 QA: Schema ──
  if (!hasArticleSchema(html)) {
    status = rankStatus(status, 'WARN');
    messages.push('[WARN] Article 스키마 없음');
  }
  if (!hasBreadcrumbList(html)) {
    status = rankStatus(status, 'WARN');
    messages.push('[WARN] BreadcrumbList 스키마 없음');
  }

  // ── 일반 QA: og:image (HEAD 체크는 제거) ──
  const ogUrl = extractOgImage(html);
  if (!ogUrl) {
    status = rankStatus(status, 'FAIL');
    messages.push('[FAIL] og:image 메타 태그 없음');
  } else {
    if (!ogUrl.startsWith(CDN_BASE)) {
      status = rankStatus(status, 'WARN');
      messages.push(`[WARN] og:image CDN_BASE(${CDN_BASE}) 기준이 아님 → ${ogUrl}`);
    } else {
      messages.push(`[OK] og:image 존재 확인 → ${ogUrl}`);
    }
  }

  return {
    status,
    file: fileName,
    slug,
    pageId,
    messages,
    integrity: {
      reviewSsot: integrityReview,
      coreBlocks: integrityBlocks,
      pageId: integrityPageId,
    },
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
    .filter((f) => f.toLowerCase().endsWith('.html'))
    .sort();

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
    integrityPolicy: {
      I1_reviewMissingSsot_isCRIT: true,
      I2_coreBlocksMissing_isCRIT: true,
      I3_pageIdBroken_isCRIT: true,
      I4_publishGate_isOutsideQa: 'publish/blogger.cjs',
      I5_dryRunGate_isOutsideQa: 'build/r2-upload.cjs',
      note: 'og:image HEAD check intentionally disabled (stability patch deferred).',
    },
    counts: { pass: passCount, warn: warnCount, fail: failCount, crit: critCount },
    items,
  };

  writeReport(report);

  // FAIL/CRIT는 CI 실패로 처리
  if (failCount > 0 || critCount > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[qa-check] 치명적 오류:', err);
    process.exit(1);
  });
}
