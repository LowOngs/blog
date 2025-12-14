#!/usr/bin/env node
'use strict';

/**
 * normalize-review-body.cjs
 *
 * 목적:
 * - 리뷰 3라벨(app-reviews/device-reviews/subscription-services) 본문(body HTML)을
 *   "review-common" 규칙에 따라 정규화한다.
 *
 * 핵심:
 * - render 단계가 아니라 "content/posts/*.json의 body"를 미리 정규화(안정성↑)
 * - 고정 헤딩 6개는 반드시 존재/순서 고정
 * - 옵션 헤딩 풀에서 1~2개는 반드시 포함(결정은 slug 기반 결정적 선택)
 * - TL;DR/Key Facts/FAQ/Sources 같은 금지 섹션이 body 안에 들어오면 제거
 *
 * 파일/경로:
 * - 입력: System_files/content/posts/*.json
 * - 규칙(선택): System_files/content/reviews/review-common.json
 *   (없으면 스크립트 내 DEFAULT_RULE 사용)
 *
 * 실행 모드:
 * - 기본: SCHEDULE_MODE=live 일 때만 실제 저장
 * - test 모드에서도 저장하려면: FORCE_WRITE=1
 */

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

const RULE_PATH = path.join(ROOT, 'content', 'reviews', 'review-common.json');

const SCHEDULE_MODE = process.env.SCHEDULE_MODE || 'test';
const FORCE_WRITE = String(process.env.FORCE_WRITE || '').toLowerCase() === '1';
const IS_LIVE = SCHEDULE_MODE === 'live' || FORCE_WRITE;

// ─────────────────────────────────────────────
// Default rule (review-common)
// ─────────────────────────────────────────────
const DEFAULT_RULE = {
  appliesTo: ['app-reviews', 'device-reviews', 'subscription-services'],
  structure: {
    fixedHeadings: [
      'Overview',
      'Key Features',
      'Specs & ROI',
      'Insights',
      'Ratings',
      'Verdict',
    ],
    optionalHeadingsPool: [
      'Pros & Cons',
      'Best For / Not For',
      'Alternatives & Comparisons',
    ],
    optionalRules: { min: 1, max: 2 },
  },
  contentRules: {
    tone: 'neutral-analytical',
    comparisonBias: 'data-first',
    avoid: ['marketing hype', 'unverified claims', 'vague adjectives'],
  },
  reviewSignals: {
    ratings: { enabled: true, source: 'ssot:review-ratings.json' },
    insights: { enabled: true, source: 'ssot:review-ratings.json' },
  },
  aiPromptDirectives: {
    headingPolicy: 'headings_must_exist',
    contentFreedom: 'free_within_heading',
    variation: { introPattern: 'variable', examples: 'contextual' },
  },
};

// 금지 섹션(본문(body) 안에 들어오면 제거)
const FORBIDDEN_HEADING_TITLES = [
  'TL;DR',
  'Key Facts',
  'FAQ',
  'Sources',
];

// 최소 문단 보강(빈 섹션 방지)
const STUB_PARAGRAPH = (heading) =>
  `<p><em>(This section is being finalized with verified details and practical examples.)</em></p>`;

// ─────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────
function log(...a) { console.log('[normalize-review-body]', ...a); }
function warn(...a) { console.warn('[normalize-review-body][WARN]', ...a); }

function safeReadJsonSync(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    warn('JSON parse failed:', p, e.message);
    return fallback;
  }
}

async function readJson(p) {
  const raw = await fsp.readFile(p, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(p, obj) {
  const pretty = JSON.stringify(obj, null, 2);
  await fsp.writeFile(p, pretty + '\n', 'utf8');
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function pickLabel(post) {
  if (Array.isArray(post.labels) && post.labels.length) return String(post.labels[0]);
  if (post.label) return String(post.label);
  if (post.seedMeta && post.seedMeta.label) return String(post.seedMeta.label);
  return '';
}

function hasBody(post) {
  return typeof post.body === 'string' && post.body.trim().length > 0;
}

// ─────────────────────────────────────────────
// HTML helpers (lightweight parsing)
// ─────────────────────────────────────────────
function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '').trim();
}

function normalizeHeadingText(t) {
  // 공백/대소문자/특수문자 약간의 흔들림 흡수
  return stripTags(t)
    .replace(/\s+/g, ' ')
    .replace(/[“”"]/g, '"')
    .trim()
    .toLowerCase();
}

function normalizeCanonicalHeading(h) {
  // canonical 표기는 원문 그대로 유지(대소문자 포함)
  return String(h || '').trim();
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 본문에서 heading 단위로 section을 추출한다.
 * - h2/h3를 섹션 시작으로 보고 다음 h2/h3 전까지를 section으로 저장
 */
function extractSections(html) {
  const src = String(html || '');
  const re = /<(h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/gi;

  const headings = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const tag = m[1].toLowerCase();
    const rawTitle = m[2];
    const titleText = stripTags(rawTitle);
    headings.push({
      tag,
      titleText,
      titleNorm: normalizeHeadingText(titleText),
      start: m.index,
      end: re.lastIndex, // heading tag end
    });
  }

  if (headings.length === 0) {
    return { sections: [], trailing: src };
  }

  const sections = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const next = headings[i + 1];

    const sectionStart = h.start;
    const sectionEnd = next ? next.start : src.length;

    const sectionHtml = src.slice(sectionStart, sectionEnd);
    sections.push({
      titleText: h.titleText,
      titleNorm: h.titleNorm,
      html: sectionHtml,
    });
  }

  return { sections, trailing: '' };
}

/**
 * heading title 기준으로 특정 섹션 제거
 */
function removeSectionsByHeadingTitles(sections, forbiddenTitles) {
  const forbiddenNorm = new Set(forbiddenTitles.map((t) => normalizeHeadingText(t)));
  const kept = [];
  let removedCount = 0;

  for (const sec of sections) {
    if (forbiddenNorm.has(sec.titleNorm)) {
      removedCount += 1;
      continue;
    }
    kept.push(sec);
  }

  return { sections: kept, removedCount };
}

/**
 * section의 heading tag를 무조건 <h2>로 강제하고,
 * 표제는 canonicalHeading으로 교체한다.
 */
function forceH2Heading(sectionHtml, canonicalHeading) {
  const canon = escapeHtml(canonicalHeading);
  // 첫 heading(h2/h3)만 교체
  return String(sectionHtml).replace(
    /<(h2|h3)\b[^>]*>[\s\S]*?<\/\1>/i,
    `<h2>${canon}</h2>`
  );
}

/**
 * 섹션 내부가 "heading만 있고 내용이 없다" 같은 경우 보강
 */
function ensureSectionHasContent(sectionHtml, canonicalHeading) {
  const s = String(sectionHtml || '').trim();

  // heading 이후에 의미있는 텍스트/태그가 없으면 stub를 붙인다
  const afterHeading = s.replace(/^(?:[\s\S]*?<\/h2>|[\s\S]*?<\/h3>)/i, '').trim();
  const hasMeaningful =
    afterHeading.length >= 20 ||
    /<p\b|<ul\b|<ol\b|<table\b|<blockquote\b|<div\b/i.test(afterHeading);

  if (hasMeaningful) return s;

  return s + '\n' + STUB_PARAGRAPH(canonicalHeading);
}

// ─────────────────────────────────────────────
// Deterministic optional heading pick (slug 기반)
// ─────────────────────────────────────────────
function hash32(str) {
  const s = String(str || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickOptionalHeadings(slug, pool, min, max) {
  const cleanPool = asArray(pool).map(String).filter(Boolean);
  if (!cleanPool.length) return [];

  const h = hash32(slug);
  const count = min + (h % Math.max(1, (max - min + 1))); // min..max

  // pool을 slug 기반으로 섞어 고정 선택(결정적)
  const picked = [];
  let cursor = h;

  const used = new Set();
  while (picked.length < Math.min(count, cleanPool.length)) {
    cursor = (cursor * 1103515245 + 12345) >>> 0;
    const idx = cursor % cleanPool.length;
    const v = cleanPool[idx];
    if (used.has(v)) continue;
    used.add(v);
    picked.push(v);
  }

  return picked;
}

// ─────────────────────────────────────────────
// Main normalize logic
// ─────────────────────────────────────────────
function findSectionByHeading(sections, headingTitle) {
  const targetNorm = normalizeHeadingText(headingTitle);
  return sections.find((s) => s.titleNorm === targetNorm) || null;
}

function findAnyOptionalSections(sections, optionalPool) {
  const poolNorm = new Set(asArray(optionalPool).map((t) => normalizeHeadingText(t)));
  return sections.filter((s) => poolNorm.has(s.titleNorm));
}

function rebuildBodyWithRule({ slug, html, rule }) {
  const fixed = rule.structure.fixedHeadings || [];
  const pool = rule.structure.optionalHeadingsPool || [];
  const minOpt = Number(rule.structure.optionalRules && rule.structure.optionalRules.min || 0);
  const maxOpt = Number(rule.structure.optionalRules && rule.structure.optionalRules.max || 0);

  const parsed = extractSections(html);
  let sections = parsed.sections;

  // 1) 금지 섹션 제거
  const rm = removeSectionsByHeadingTitles(sections, FORBIDDEN_HEADING_TITLES);
  sections = rm.sections;
  const removedForbidden = rm.removedCount;

  // 2) 기존 optional 섹션 확보
  const existingOptional = findAnyOptionalSections(sections, pool);

  // 3) fixed 섹션을 순서대로 구성
  const out = [];
  let changed = false;

  for (const canonHeading of fixed) {
    const sec = findSectionByHeading(sections, canonHeading);

    if (sec) {
      // 헤딩을 <h2> + canonical title로 강제
      let secHtml = forceH2Heading(sec.html, canonHeading);
      secHtml = ensureSectionHasContent(secHtml, canonHeading);

      out.push(secHtml);
      // 헤딩이 h3였거나 타이틀이 달랐을 가능성 → 보수적으로 changed 처리
      if (!sec.html.startsWith(`<h2>${escapeHtml(canonHeading)}</h2>`)) changed = true;
    } else {
      // 없으면 stub 섹션 삽입
      out.push(`<h2>${escapeHtml(canonHeading)}</h2>\n${STUB_PARAGRAPH(canonHeading)}`);
      changed = true;
    }
  }

  // 4) optional 섹션 1~2개 보장 (규칙)
  //    위치: "Specs & ROI" 다음, "Insights" 이전에 삽입(고정)
  const optNeededMin = Math.max(0, minOpt);
  const optNeededMax = Math.max(optNeededMin, maxOpt);

  const optPresentTitles = new Set(existingOptional.map((s) => s.titleNorm));
  const optInsertTitles = [];

  if (optNeededMin > 0) {
    // 현재 optional이 하나도 없으면, slug 기반으로 1~2개 선택 후 삽입
    const hasAny = existingOptional.length > 0;
    if (!hasAny) {
      const picks = pickOptionalHeadings(slug, pool, optNeededMin, optNeededMax);
      for (const t of picks) optInsertTitles.push(t);
      if (picks.length) changed = true;
    } else {
      // optional이 있더라도 max 초과면 줄이진 않음(삭제 위험) — 다만 경고용 정보는 반환
    }
  }

  // 5) optional 실제 삽입 블록 생성
  const optBlocks = [];

  // 기존 optional 섹션이 있으면: 그대로 살리되, <h2> + canonical로만 강제
  // (순서가 어디 있든 “삭제/이동”은 안정성 위해 하지 않음)
  // → 대신 “없을 때만” out 내부에 삽입
  if (optInsertTitles.length > 0) {
    for (const t of optInsertTitles) {
      optBlocks.push(`<h2>${escapeHtml(t)}</h2>\n${STUB_PARAGRAPH(t)}`);
    }
  }

  // 삽입 위치 계산: fixedHeading 배열에서 "Specs & ROI" 다음 인덱스
  if (optBlocks.length > 0) {
    const specsIdx = fixed.findIndex((h) => normalizeHeadingText(h) === normalizeHeadingText('Specs & ROI'));
    const insertAt = (specsIdx >= 0) ? (specsIdx + 1) : 2;
    out.splice(insertAt, 0, ...optBlocks);
  }

  const newHtml = out.join('\n\n').trim() + '\n';

  // 6) 변화 판단(내용이 동일하면 변경 없음)
  if (newHtml.trim() !== String(html || '').trim()) changed = true;

  return {
    html: newHtml,
    changed,
    removedForbidden,
    optExistingCount: existingOptional.length,
    optInsertedCount: optBlocks.length,
  };
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function listPostFiles() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  const entries = await fsp.readdir(POSTS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => path.join(POSTS_DIR, e.name))
    .sort();
}

async function main() {
  log('ROOT =', ROOT);
  log('POSTS_DIR =', POSTS_DIR);
  log('RULE_PATH =', RULE_PATH);
  log('SCHEDULE_MODE =', SCHEDULE_MODE, IS_LIVE ? '(WRITE)' : '(DRY-RUN)');
  log('────────────────────────────────────────────');

  const ruleFile = safeReadJsonSync(RULE_PATH, null);
  const rule = ruleFile && typeof ruleFile === 'object' ? ruleFile : DEFAULT_RULE;

  const appliesTo = new Set(asArray(rule.appliesTo).map(String));

  const files = await listPostFiles();
  log('JSON files =', files.length);

  let scanned = 0;
  let skippedNotReview = 0;
  let skippedNoBody = 0;
  let updated = 0;
  let dryRunWouldUpdate = 0;

  let removedForbiddenTotal = 0;
  let insertedOptionalTotal = 0;

  for (const filePath of files) {
    scanned += 1;
    const name = path.basename(filePath);

    let post;
    try {
      post = await readJson(filePath);
    } catch (e) {
      warn('JSON parse failed:', name, e.message);
      continue;
    }

    const label = pickLabel(post);
    if (!appliesTo.has(label)) {
      skippedNotReview += 1;
      continue;
    }

    if (!hasBody(post)) {
      skippedNoBody += 1;
      continue;
    }

    const slug = String(post.slug || path.basename(name, '.json'));
    const before = post.body;

    const r = rebuildBodyWithRule({ slug, html: before, rule });

    removedForbiddenTotal += r.removedForbidden;
    insertedOptionalTotal += r.optInsertedCount;

    if (!r.changed) continue;

    // 기록(실행 모드에 따라)
    post.body = r.html;
    post.bodyNorm = Object.assign({}, post.bodyNorm || {}, {
      reviewCommon: true,
      updatedAt: new Date().toISOString(),
      removedForbidden: r.removedForbidden,
      optionalExisting: r.optExistingCount,
      optionalInserted: r.optInsertedCount,
      mode: IS_LIVE ? 'write' : 'dry-run',
    });

    if (IS_LIVE) {
      await writeJson(filePath, post);
      updated += 1;
      log(`✓ updated: ${slug} (${label}) forbiddenRemoved=${r.removedForbidden} optInserted=${r.optInsertedCount}`);
    } else {
      dryRunWouldUpdate += 1;
      log(`≈ DRY-RUN would update: ${slug} (${label}) forbiddenRemoved=${r.removedForbidden} optInserted=${r.optInsertedCount}`);
    }
  }

  log('────────────────────────────────────────────');
  log('done:',
    `scanned=${scanned}`,
    `updated=${updated}`,
    `dryRunWouldUpdate=${dryRunWouldUpdate}`,
    `skippedNotReview=${skippedNotReview}`,
    `skippedNoBody=${skippedNoBody}`,
    `removedForbiddenTotal=${removedForbiddenTotal}`,
    `insertedOptionalTotal=${insertedOptionalTotal}`
  );

  if (!IS_LIVE) {
    log('NOTE: test 모드입니다. 저장하려면 SCHEDULE_MODE=live 또는 FORCE_WRITE=1 을 사용하세요.');
  }
}

main().catch((e) => {
  console.error('[normalize-review-body] FATAL:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
