#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/generate-body.cjs
 *
 * 목적
 * - content/posts/*.json 에 "본문(body)"가 비어있는 글에 대해,
 *   ✅ 구글 기준서(의도/시점/맥락) 기반으로 H2 중제목을 "반드시" 생성해서 본문 스켈레톤을 만든다.
 * - 이 파일이 H2 생성의 단일 책임(SSOT)이다.
 *   → template / render 단계에서 H2를 만들거나 보정하지 않는다.
 *
 * 핵심 원칙 (옹스님 요구사항 반영)
 * 1) 모든 포스트는 최소 1개 이상의 <h2>가 있어야 한다. (0개면 로직 오류)
 * 2) 리뷰 라벨 3종(app/device/subscription)은 공통 고정 H2 세트를 사용한다.
 * 3) 비리뷰 라벨은 "Intent(의도) + Time(시점) + Context(맥락)"를 입력으로 H2를 결정한다.
 * 4) 필요한 메타(의도/시점/맥락)가 없으면:
 *    - 라벨 기반으로 합리적 추론을 먼저 시도한다.
 *    - 그래도 확정 불가하면 STRICT 모드에서 즉시 실패한다. (침묵/비움 금지)
 *
 * 제어축
 * - BODY_WRITE_MODE=local | active -> JSON에 body 저장(WRITE)
 * - 그 외 -> DRY(미저장)
 *
 * NOTE
 * - 현재는 "H2 스켈레톤 생성" 단계까지만 담당한다.
 * - 실제 LLM 본문 생성(문단 채우기)은 별도 단계(또는 향후 확장)에서 수행한다.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const process = require('process');

const ROOT = path.resolve(process.cwd(), 'System_files');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

// local | active 일 때만 저장
const BODY_WRITE_MODE = String(process.env.BODY_WRITE_MODE || 'local').trim().toLowerCase();
const CAN_WRITE = BODY_WRITE_MODE === 'local' || BODY_WRITE_MODE === 'active';

// 헤딩 강제 모드(기본 true) — 값이 부족하면 실패
const HEADING_STRICT = String(process.env.HEADING_STRICT || 'true').trim().toLowerCase() !== 'false';

// 리뷰 라벨(3종) — "공통 고정" + 선택 1~2개(결정론적)
const REVIEW_LABELS = new Set(['app-reviews', 'device-reviews', 'subscription-services']);
const REVIEW_FIXED_H2 = [
  'Overview',
  'Key Features',
  'Specs & ROI',
  'Insights',
  'Ratings',
  'Verdict',
];
const REVIEW_OPTIONAL_POOL = [
  'Pros & Cons',
  'Best For / Not For',
  'Alternatives & Comparisons',
];
const REVIEW_OPTIONAL_RULE = { min: 1, max: 2 };

// 비리뷰 라벨(프로젝트 기준)
const NON_REVIEW_LABELS = new Set(['how-to-playbooks', 'smart-savings', 'templates-checklists']);

// 구글 기준서의 "의도(Intent) 필터" 카테고리(표준화)
const INTENT_ENUM = Object.freeze({
  EXPLAIN: 'explain',       // 설명
  COMPARE: 'compare',       // 비교
  EXECUTE: 'execute',       // 실행
  RECOVER: 'recover',       // 복구
  APPLY: 'apply',           // 응용
  SAVE: 'save',             // 절약
  TEMPLATE: 'template',     // 템플릿/체크리스트
});

// 구글 기준서의 "시점(Time) 필터" 카테고리(표준화)
const TIME_ENUM = Object.freeze({
  PRESENT: 'present', // 현재형
  PAST: 'past',       // 과거형
  FUTURE: 'future',   // 미래형
});

// ─────────────────────────────────────────────
// 로그 헤더
// ─────────────────────────────────────────────
console.log('────────────────────────────────────────────');
console.log('[generate-body] 시작');
console.log('[generate-body] ROOT            =', ROOT);
console.log('[generate-body] POSTS_DIR       =', POSTS_DIR);
console.log('[generate-body] BODY_WRITE_MODE =', BODY_WRITE_MODE, CAN_WRITE ? '(WRITE)' : '(DRY)');
console.log('[generate-body] HEADING_STRICT  =', HEADING_STRICT ? 'true' : 'false');
console.log('────────────────────────────────────────────');

// ─────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────
function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function sha1(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex');
}
function normStr(v) {
  return String(v == null ? '' : v).trim();
}
function toLower(v) {
  return normStr(v).toLowerCase();
}
function hasBody(post) {
  return !!(post && typeof post.body === 'string' && post.body.trim());
}
function ensureArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}
function uniq(arr) {
  return Array.from(new Set((arr || []).map(x => normStr(x)).filter(Boolean)));
}
function pickDeterministic(arr, min, max, seedStr) {
  // 랜덤 금지: slug 기반 해시로 "항상 같은 선택"을 보장
  const seed = sha1(seedStr || 'seed');
  const bytes = Buffer.from(seed, 'hex');

  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => {
    const aa = bytes[a.i % bytes.length];
    const bb = bytes[b.i % bytes.length];
    return aa - bb;
  });

  const n = Math.max(min, Math.min(max, indexed.length));
  return indexed.slice(0, n).map(x => x.v);
}
function h2(title) {
  // title은 이미 안전한 영문 키워드 중심으로 사용(현재 단계는 스켈레톤)
  const t = normStr(title);
  if (!t) return '';
  return `<h2>${t}</h2>`;
}
function paragraphPlaceholder() {
  return `<p><!-- content --></p>`;
}
function sectionBlock(title) {
  const H = h2(title);
  if (!H) return '';
  return `${H}\n${paragraphPlaceholder()}`;
}
function joinSections(titles) {
  const blocks = (titles || []).map(sectionBlock).filter(Boolean);
  return blocks.join('\n\n').trim();
}
function countH2(html) {
  const s = String(html || '');
  const m = s.match(/<h2\b[^>]*>/gi);
  return m ? m.length : 0;
}

// ─────────────────────────────────────────────
// 포스트 메타 추출 (의도/시점/맥락)
// ─────────────────────────────────────────────
function extractLabel(post) {
  // 프로젝트에서 label 필드는 단일, labels는 배열도 있을 수 있음
  const label = normStr(post.label);
  if (label) return label;

  // 혹시 labels 배열을 쓰는 경우 대응
  const labels = ensureArray(post.labels).map(normStr).filter(Boolean);
  if (labels.length === 1) return labels[0];

  // 과거 호환: seedMeta.label
  const seedLabel = normStr(post.seedMeta && post.seedMeta.label);
  if (seedLabel) return seedLabel;

  return '';
}

function extractIntentRaw(post) {
  // 의도는 seedpool에서 보통 intent로 내려올 가능성
  // 후보: post.intent / post.seedMeta.intent / post.meta.intent
  const a = normStr(post.intent);
  const b = normStr(post.seedMeta && post.seedMeta.intent);
  const c = normStr(post.meta && post.meta.intent);
  return a || b || c;
}

function extractTimeRaw(post) {
  // 후보: post.timing / post.seedMeta.timing / post.time
  const a = normStr(post.timing);
  const b = normStr(post.seedMeta && post.seedMeta.timing);
  const c = normStr(post.time);
  return a || b || c;
}

function extractContextRaw(post) {
  // 후보: post.environment / post.context / post.seedMeta.environment / post.seedMeta.context
  const a = normStr(post.environment);
  const b = normStr(post.context);
  const c = normStr(post.seedMeta && post.seedMeta.environment);
  const d = normStr(post.seedMeta && post.seedMeta.context);
  return a || b || c || d;
}

function normalizeIntent(intentRaw) {
  const x = toLower(intentRaw);

  // 한국어/영문 모두 느슨 매핑
  if (!x) return '';
  if (x.includes('설명') || x.includes('explain') || x.includes('guide')) return INTENT_ENUM.EXPLAIN;
  if (x.includes('비교') || x.includes('compare') || x.includes('vs')) return INTENT_ENUM.COMPARE;
  if (x.includes('실행') || x.includes('how') || x.includes('setup') || x.includes('step')) return INTENT_ENUM.EXECUTE;
  if (x.includes('복구') || x.includes('recover') || x.includes('fix') || x.includes('restore')) return INTENT_ENUM.RECOVER;
  if (x.includes('응용') || x.includes('apply') || x.includes('advanced')) return INTENT_ENUM.APPLY;
  if (x.includes('절약') || x.includes('save') || x.includes('cost') || x.includes('budget')) return INTENT_ENUM.SAVE;
  if (x.includes('템플릿') || x.includes('template') || x.includes('checklist')) return INTENT_ENUM.TEMPLATE;

  // 알 수 없는 값은 원문 유지하지 않고 빈값 처리(STRICT에서 걸리게)
  return '';
}

function normalizeTime(timeRaw) {
  const x = toLower(timeRaw);
  if (!x) return '';
  if (x.includes('현재') || x.includes('present') || x.includes('now')) return TIME_ENUM.PRESENT;
  if (x.includes('과거') || x.includes('past') || x.includes('old') || x.includes('legacy')) return TIME_ENUM.PAST;
  if (x.includes('미래') || x.includes('future') || x.includes('upcoming') || x.includes('next')) return TIME_ENUM.FUTURE;
  return '';
}

function inferDefaultsByLabel(label) {
  // label 기반 "합리적 추론" — 값이 누락되어도 공백으로 남기지 않기 위함
  if (REVIEW_LABELS.has(label)) {
    return { intent: INTENT_ENUM.EXPLAIN, time: TIME_ENUM.PRESENT };
  }
  if (label === 'how-to-playbooks') {
    return { intent: INTENT_ENUM.EXECUTE, time: TIME_ENUM.PRESENT };
  }
  if (label === 'smart-savings') {
    return { intent: INTENT_ENUM.SAVE, time: TIME_ENUM.PRESENT };
  }
  if (label === 'templates-checklists') {
    return { intent: INTENT_ENUM.TEMPLATE, time: TIME_ENUM.PRESENT };
  }
  // 알 수 없는 라벨
  return { intent: '', time: '' };
}

// ─────────────────────────────────────────────
// H2 플랜 생성(구글 기준서 기반)
// ─────────────────────────────────────────────
function buildReviewH2Plan(slug) {
  // 리뷰는 공통 고정 + 선택 1~2(결정론적)
  const optional = pickDeterministic(
    REVIEW_OPTIONAL_POOL,
    REVIEW_OPTIONAL_RULE.min,
    REVIEW_OPTIONAL_RULE.max,
    slug
  );
  return [...REVIEW_FIXED_H2, ...optional];
}

/**
 * 비리뷰 H2는 "의도/시점/맥락"을 반영한다.
 * - 의도(단일) = 결론/결과가 같은 글은 1개만 유지한다(구글 기준서: One intent = One URL).
 * - 시점/맥락이 바뀌면 같은 소재도 다른 글이 될 수 있다(중복 방지 필터).
 *
 * 여기서는 H2 타이틀에 시점/맥락 신호를 "과하게" 넣지 않고,
 * 필요한 경우 1~2개 섹션 이름에만 반영해 구조를 단순화한다(옹스님 선호).
 */
function buildNonReviewH2Plan({ label, intent, time, context }) {
  const ctx = normStr(context);
  const hasCtx = !!ctx;

  // time에 따른 섹션명 보정(최소만)
  const timeHint =
    time === TIME_ENUM.PAST ? ' (Legacy/Older)' :
    time === TIME_ENUM.FUTURE ? ' (Upcoming)' :
    ''; // present은 힌트 생략

  // 의도별 기본 H2 템플릿
  // ※ 너무 복잡하게 H3까지 강제하지 않음(옹스님 요구)
  if (intent === INTENT_ENUM.EXECUTE) {
    // 실행/가이드
    return uniq([
      'Overview' + (hasCtx ? ` (${ctx})` : ''),
      'Before You Start' + timeHint,
      'Step-by-Step',
      'Common Mistakes & Fixes',
      'Checklist',
      'Next Steps',
    ]);
  }

  if (intent === INTENT_ENUM.SAVE) {
    // 절약/요금/비용
    return uniq([
      'Overview' + (hasCtx ? ` (${ctx})` : ''),
      'Cost Breakdown' + timeHint,
      'Compare Options',
      'Best Choice by Situation',
      'How to Save More',
      'Summary',
    ]);
  }

  if (intent === INTENT_ENUM.TEMPLATE) {
    // 템플릿/체크리스트
    return uniq([
      'Overview' + (hasCtx ? ` (${ctx})` : ''),
      'When to Use This Template' + timeHint,
      'Template / Checklist',
      'Examples',
      'Common Pitfalls',
      'How to Customize',
    ]);
  }

  if (intent === INTENT_ENUM.COMPARE) {
    // 비교
    return uniq([
      'Overview' + (hasCtx ? ` (${ctx})` : ''),
      'Comparison Criteria' + timeHint,
      'Side-by-Side Comparison',
      'Best For / Not For',
      'Decision Guide',
      'Verdict',
    ]);
  }

  if (intent === INTENT_ENUM.RECOVER) {
    // 복구/문제해결
    return uniq([
      'What Went Wrong' + timeHint,
      'Why It Happens' + (hasCtx ? ` (${ctx})` : ''),
      'How to Fix Now',
      'Verification Steps',
      'Prevention Tips',
    ]);
  }

  if (intent === INTENT_ENUM.APPLY) {
    // 응용/고급 활용
    return uniq([
      'Overview' + (hasCtx ? ` (${ctx})` : ''),
      'Core Concept' + timeHint,
      'Practical Use Cases',
      'Step-by-Step Example',
      'Optimization Tips',
      'Summary',
    ]);
  }

  if (intent === INTENT_ENUM.EXPLAIN) {
    // 설명/개념
    return uniq([
      'Overview' + timeHint,
      'Who This Is For' + (hasCtx ? ` (${ctx})` : ''),
      'Key Concepts',
      'Examples',
      'Common Misunderstandings',
      'Summary',
    ]);
  }

  // intent가 비어있으면(여기까지 왔다면) 호출부에서 STRICT로 처리해야 함
  return [];
}

// ─────────────────────────────────────────────
// 본문 생성(스켈레톤)
// ─────────────────────────────────────────────
function generateBodySkeleton({ post, label, slug }) {
  // 리뷰 라벨(공통)
  if (REVIEW_LABELS.has(label)) {
    const plan = buildReviewH2Plan(slug);
    const html = joinSections(plan);

    // 안전장치: H2 0개 금지
    if (countH2(html) === 0) {
      throw new Error(`H2 생성 실패(리뷰): slug=${slug}`);
    }
    return { html, plan, kind: 'review' };
  }

  // 비리뷰 라벨
  const intentRaw = extractIntentRaw(post);
  const timeRaw = extractTimeRaw(post);
  const contextRaw = extractContextRaw(post);

  // 1) 정규화
  let intent = normalizeIntent(intentRaw);
  let time = normalizeTime(timeRaw);
  const context = normStr(contextRaw);

  // 2) 라벨 기반 추론(공백 방지)
  const inferred = inferDefaultsByLabel(label);
  if (!intent) intent = inferred.intent;
  if (!time) time = inferred.time;

  // 3) 최종 가드
  if (!intent) {
    const msg = `intent 누락(확정불가): slug=${slug} label=${label} (seedMeta.intent 또는 intent 필드 필요)`;
    if (HEADING_STRICT) throw new Error(msg);
    console.warn('[WARN]', msg);
  }
  if (!time) {
    const msg = `time 누락(확정불가): slug=${slug} label=${label} (seedMeta.timing 또는 timing 필드 필요)`;
    if (HEADING_STRICT) throw new Error(msg);
    console.warn('[WARN]', msg);
  }

  const plan = buildNonReviewH2Plan({ label, intent, time, context });
  const html = joinSections(plan);

  // 안전장치: H2 0개 금지
  if (countH2(html) === 0) {
    throw new Error(`H2 생성 실패(비리뷰): slug=${slug} label=${label} intent=${intent} time=${time}`);
  }

  return {
    html,
    plan,
    kind: 'non-review',
    meta: { intent, time, context },
  };
}

// ─────────────────────────────────────────────
// main
// ─────────────────────────────────────────────
function main() {
  if (!fs.existsSync(POSTS_DIR)) {
    console.log('[generate-body] content/posts 없음 -> 종료');
    process.exit(0);
  }

  const files = fs.readdirSync(POSTS_DIR).filter(f => f.toLowerCase().endsWith('.json')).sort();
  console.log('[generate-body] JSON 파일 수 =', files.length);

  let written = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const full = path.join(POSTS_DIR, file);

    let post;
    try {
      post = readJSON(full);
    } catch (e) {
      failed++;
      console.error('[FAIL] JSON 파싱 실패:', file, e.message);
      continue;
    }

    const slug = normStr(post.slug) || path.basename(file, '.json');
    const label = extractLabel(post);

    // 0) body가 이미 있으면 스킵(덮어쓰기 금지)
    if (hasBody(post)) {
      console.log(`[SKIP] ${slug} — body 이미 존재`);
      skipped++;
      continue;
    }

    // 2) label이 없으면 STRICT에서 실패(중제목 정책이 라벨 기반이기 때문)
    if (!label) {
      const msg = `label 누락: slug=${slug} (post.label 또는 post.labels 또는 seedMeta.label 필요)`;
      if (HEADING_STRICT) {
        failed++;
        console.error('[FAIL]', msg);
        continue;
      } else {
        console.warn('[WARN]', msg);
      }
    }

    try {
      // 3) H2 플랜 생성(구글 기준서 기반)
      const res = generateBodySkeleton({ post, label, slug });

      // 4) body 저장
      post.body = res.html;

      // 5) 생성 메타 기록(추적/재현용)
      post.bodyGen = {
        mode: 'skeleton-h2',
        updatedAt: new Date().toISOString(),
        writeMode: BODY_WRITE_MODE,
        strict: HEADING_STRICT,
        label: label || '',
        kind: res.kind,
        h2Count: countH2(res.html),
        headingHash: sha1(res.html),
        headingPlan: res.plan, // ✅ 나중에 "왜 이런 구조인지" 추적 가능
        // 비리뷰일 때만 추가
        intent: res.meta ? res.meta.intent : null,
        timing: res.meta ? res.meta.time : null,
        context: res.meta ? (res.meta.context || null) : null,
      };

      // 6) 리뷰는 reviewMeta도 함께 고정 기록(SSOT 연결용)
      if (REVIEW_LABELS.has(label)) {
        post.reviewMeta = {
          ratings: { source: 'ssot:content/reviews/*-ratings.json', freshnessDays: 90 },
          insights: { source: 'ssot:content/reviews/*-insights.json', freshnessDays: 90 },
          headingHash: post.bodyGen.headingHash,
        };
      }

      // 7) 실제 저장/미저장 분기
      if (CAN_WRITE) {
        writeJSON(full, post);
        console.log(`[OK] ${slug} — H2 스켈레톤 저장 완료 (h2=${post.bodyGen.h2Count})`);
        written++;
      } else {
        console.log(`[DRY] ${slug} — 생성만 수행(미저장) (h2=${post.bodyGen.h2Count})`);
      }
    } catch (e) {
      failed++;
      console.error(`[FAIL] ${slug} —`, e.message || e);
    }
  }

  console.log('────────────────────────────────────────────');
  console.log('[generate-body] 요약');
  console.log('  저장(WRITE) =', written);
  console.log('  SKIP        =', skipped);
  console.log('  실패        =', failed);
  console.log('────────────────────────────────────────────');

  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();
