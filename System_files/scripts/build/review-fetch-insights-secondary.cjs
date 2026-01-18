
#!/usr/bin/env node
'use strict';
// review-fetch-insights-secondary.cjs
// 2안: 비공식/세컨더리 소스(블로그·포럼·리뷰 페이지)에서 인사이트 문구만 수집하여 SSOT에 업서트

require('./lib/env.cjs'); // env 최상단 로딩

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// 공통 설정
// ─────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..', '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const REVIEWS_DIR = path.join(ROOT, 'content', 'reviews');
const SOURCES_PATH = path.join(REVIEWS_DIR, 'review-sources.json');

const DRY_RUN = !(['false', '0'].includes(String(process.env.DRY_RUN ?? 'true').toLowerCase()));
const MAX_ITEMS = Number(process.env.REVIEW_INSIGHTS_MAX ?? 10);

// ─────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────
function log(...a) { console.log('[review-insights-2nd]', ...a); }
function warn(...a) { console.warn('[review-insights-2nd][WARN]', ...a); }

function safeReadJson(p, fb) {
  try {
    if (!fs.existsSync(p)) return fb;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fb;
  }
}

function writeJson(p, o) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n', 'utf8');
}

function nowYmd() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function isReviewSlug(slug) {
  return slug.startsWith('app-') || slug.startsWith('device-') || slug.startsWith('subscription-');
}

// ─────────────────────────────────────────────
// 2안 핵심: 인사이트 생성기(LLM 미사용, 룰 기반 요약)
// ─────────────────────────────────────────────
function extractInsightsFromText(text) {
  if (!text) return [];
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 20 && l.length < 160);

  const positives = [];
  const negatives = [];

  for (const l of lines) {
    if (/good|fast|easy|useful|great|stable/i.test(l)) positives.push(l);
    else if (/bad|slow|bug|problem|issue|expensive/i.test(l)) negatives.push(l);
  }

  return {
    positive: positives.slice(0, 6),
    negative: negatives.slice(0, 6),
  };
}

// ─────────────────────────────────────────────
// 메인
// ─────────────────────────────────────────────
async function main() {
  log('start');
  log('DRY_RUN =', DRY_RUN);

  const sources = safeReadJson(SOURCES_PATH, { updatedAt: nowYmd(), bySlug: {} });

  if (!fs.existsSync(POSTS_DIR)) {
    warn('posts dir missing');
    return;
  }

  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'));
  let processed = 0;

  for (const f of files) {
    if (processed >= MAX_ITEMS) break;

    const post = safeReadJson(path.join(POSTS_DIR, f), null);
    if (!post || !isReviewSlug(post.slug)) continue;

    const slug = post.slug;
    const srcList = sources.bySlug[slug];
    if (!Array.isArray(srcList) || srcList.length === 0) continue;

    // 2안 정책: 외부 fetch 없음, source.label 기반 더미 텍스트 처리
    const combinedText = srcList.map(s => s.label).join('\n');

    const insights = extractInsightsFromText(combinedText);
    if (!insights.positive.length && !insights.negative.length) continue;

    if (!DRY_RUN) {
      // insights는 review-fetch-official에서 건드리지 않으므로
      // bucket별 *-insights.json 에 직접 쓰지 않고
      // review-ratings-next.json에 병합 대상 필드로만 남김
      const bucket =
        slug.startsWith('app-') ? 'app' :
        slug.startsWith('device-') ? 'device' : 'subscription';

      const nextPath = path.join(REVIEWS_DIR, `${bucket}-ratings-next.json`);
      const next = safeReadJson(nextPath, { updatedAt: nowYmd(), bySlug: {} });

      const entry = next.bySlug[slug] || {};
      entry.insights = {
        positive: insights.positive,
        negative: insights.negative,
      };
      entry.lastChecked = nowYmd();

      next.bySlug[slug] = entry;
      next.updatedAt = nowYmd();

      writeJson(nextPath, next);
    }

    processed++;
  }

  log(`done processed=${processed}`);
  if (DRY_RUN) log('DRY_RUN: no file writes');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
