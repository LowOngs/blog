#!/usr/bin/env node
/* qa-check.cjs
 * dist/posts/*.html 대상으로 AIO/SEO 이미지·스키마 QA 체크
 * - og:image: 실제 CDN URL + HTTP 200 여부 검사
 * - Article / BreadcrumbList 스키마 존재 여부 확인
 * - ✅ (추가) 리뷰 라벨인데 SSOT 누락이면 CRIT (자동발행 스킵 근거)
 *
 * 판정 규칙(요약)
 * - PASS: 문제 없음
 * - WARN: 경고(발행은 가능)
 * - FAIL: 오류(빌드 실패급)
 * - CRIT: 자동발행에서는 제외해야 하는 치명 이슈(특히 리뷰 SSOT 누락)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist', 'posts');

const CDN_BASE_RAW = process.env.CDN_BASE || 'https://ongsblog.com/images';
const CDN_BASE = CDN_BASE_RAW.replace(/\/+$/, '');

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
  // JSON-LD 내 Article 유무 간단 체크
  return html.includes('"@type":"Article"') || html.includes('"@type": "Article"');
}

function hasBreadcrumbList(html) {
  return (
    html.includes('"@type":"BreadcrumbList"') ||
    html.includes('"@type": "BreadcrumbList"')
  );
}

function isReviewFileName(fileName) {
  // 프로젝트 slug prefix 규칙 기반(가장 안전/간단)
  // app-YYYYMMDD-###, device-..., subscription-...
  const base = String(fileName || '').toLowerCase();
  return (
    base.startsWith('app-') ||
    base.startsWith('device-') ||
    base.startsWith('subscription-')
  );
}

function detectMissingReviewSsot(html) {
  // render 단계에서 아래 중 하나라도 박혀 있으면 "SSOT 누락"으로 확정
  // - reviewStatus="missing-ssot" (권장)
  // - data-review-status="missing-ssot"
  // - HTML 주석에 missing-ssot
  const h = String(html || '');
  if (!h) return false;

  const patterns = [
    /reviewStatus\s*=\s*["']missing-ssot["']/i,
    /data-review-status\s*=\s*["']missing-ssot["']/i,
    /missing-ssot/i,
    /데이터\s*수집\/?검증\s*후\s*업데이트\s*됩니다/i, // 플레이스홀더 문구 감지(최후 방어)
  ];

  return patterns.some((re) => re.test(h));
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
  // PASS < WARN < FAIL < CRIT
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
      reason: 'HTML 읽기 실패',
      file: fileName,
    };
  }

  const ogUrl = extractOgImage(html);
  const hasArticle = hasArticleSchema(html);
  const hasBreadcrumb = hasBreadcrumbList(html);

  let status = 'PASS';
  const messages = [];

  // 0) ✅ 리뷰 SSOT 누락은 CRIT (리뷰 라벨만)
  if (isReviewFileName(fileName)) {
    const missing = detectMissingReviewSsot(html);
    if (missing) {
      status = rankStatus(status, 'CRIT');
      messages.push('[CRIT] 리뷰 라벨인데 SSOT 누락(missing-ssot) → 자동발행 제외 대상');
    }
  }

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
    messages,
  };
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

  for (const file of files) {
    const result = await checkOne(file);

    if (result.status === 'PASS') passCount++;
    else if (result.status === 'WARN') warnCount++;
    else if (result.status === 'FAIL') failCount++;
    else if (result.status === 'CRIT') critCount++;

    console.log(`파일: ${file}`);
    console.log(`상태: ${result.status}`);
    if (result.messages && result.messages.length) {
      for (const msg of result.messages) {
        console.log(`  - ${msg}`);
      }
    }
    console.log('');
  }

  console.log('────────────────────────────────────────────');
  console.log(
    `[qa-check] 결과: PASS ${passCount} / WARN ${warnCount} / FAIL ${failCount} / CRIT ${critCount}`,
  );
  console.log('────────────────────────────────────────────');

  // FAIL/CRIT는 CI 실패로 처리(자동발행 제외 로직은 7번에서 사용)
  if (failCount > 0 || critCount > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  // Node 18+ 기준 global fetch 사용
  if (typeof fetch !== 'function') {
    console.error(
      '[qa-check] 이 스크립트는 Node 18 이상(전역 fetch 지원) 환경을 전제로 합니다.',
    );
    process.exit(1);
  }
  main().catch((err) => {
    console.error('[qa-check] 치명적 오류:', err);
    process.exit(1);
  });
}
