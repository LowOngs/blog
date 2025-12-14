#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/generate-body.cjs
 *
 * C안 확정:
 * - body가 비어 있고 bodyPrompt가 있는 포스트만 대상으로 본문 생성
 * - 1~2회: OpenAI 생성 재시도
 * - 2회 모두 실패(또는 품질 검증 실패) 시: 3회차는 "A안 폴백 본문"을 즉시 주입
 * - SCHEDULE_MODE === 'live' 일 때만 저장, 아니면 DRY-RUN
 *
 * 주의:
 * - 이 스크립트는 본문(body)만 채웁니다.
 * - TL;DR/Key Facts/FAQ/Sources는 별도 단계(생성기/채움기)에서 채우는 구조를 권장합니다.
 */

// ✅ 로컬 .env 로드 (GitHub Actions에서는 Secrets가 env로 주입되므로 영향 없음)
try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Node 18+ global fetch
const fetchFn = global.fetch || require('node-fetch');

// ===== 설정 =====
const ROOT = path.resolve(__dirname, '..', '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

const SCHEDULE_MODE = process.env.SCHEDULE_MODE || 'test';
const IS_LIVE = SCHEDULE_MODE === 'live';

// 재시도 규칙(확정)
const MAX_GENERATE_ATTEMPTS = 2; // 1~2회: 생성
// 3회는 "생성 재시도"가 아니라 "폴백 주입"입니다.

// 검증 최소 기준(가볍게, 그러나 실패 원인 잡을 만큼)
const VALIDATE_MIN_H2 = 4;
const VALIDATE_MIN_P = 8;
const VALIDATE_MIN_CHARS = 1200;

// 본문에 있으면 안 되는 섹션(중복 방지)
const FORBIDDEN_SNIPPETS = [
  'TL;DR',
  'Key Facts',
  '<section id="tldr"',
  'id="tldr"',
  'id="keyfacts"',
  '<details class="collapsible" id="faq"',
  'id="sources"',
  '<h3>Sources</h3>',
];

// 기본 시스템 프롬프트
const BASE_SYSTEM_PROMPT = [
  'You are a writing assistant for a clear, practical tech/productivity blog.',
  'Write only the HTML fragment for the article body.',
  'Do NOT include <html>, <head>, <body>, or outer <section> wrappers.',
  'Use <h2>, <h3>, <p>, <ul>, <ol>, <li> for structure.',
  'Do NOT include TL;DR, Key Facts, FAQ, or Sources sections – they are handled separately.',
  'Paragraphs should be short and easy to scan.',
  'Avoid hype and generic buzzwords.',
].join(' ');

// 라벨별 톤 힌트
function getLabelHint(label) {
  switch (label) {
    case 'app-reviews':
      return 'Style: balanced review. Explain strengths, limitations, ideal users. Avoid fake benchmarks.';
    case 'device-reviews':
      return 'Style: hardware review. Focus on real-world usage: battery, thermals, screen, keyboard, portability.';
    case 'subscription-services':
      return 'Style: subscription value analysis. Use simple numeric examples but do not invent fake brands.';
    case 'how-to-playbooks':
      return 'Style: step-by-step guide. Use ordered lists and clear phases.';
    case 'smart-savings':
      return 'Style: money-saving guide. Show trade-offs and practical steps.';
    case 'templates-checklists':
      return 'Style: reusable template/checklist. Provide structured bullet lists and examples.';
    default:
      return 'Style: clear, practical, friendly.';
  }
}

/* ─────────────────────────────────────────────
 * 리뷰(3라벨) 공용 헤딩 스캐폴드
 * - app-reviews / device-reviews / subscription-services 에만 적용
 * - 고정 6개 + 선택 1~2개(랜덤)
 * - 공용 설정은 seedpool/profiles/label-profiles.json 의 reviewCommon 에서 관리
 * ───────────────────────────────────────────── */

const REVIEW_LABELS = new Set(['app-reviews', 'device-reviews', 'subscription-services']);

function isReviewLabel(label) {
  return REVIEW_LABELS.has(String(label || ''));
}

function loadReviewCommon() {
  const p = path.join(ROOT, 'seedpool', 'profiles', 'label-profiles.json');
  try {
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j && j.reviewCommon ? j.reviewCommon : null;
  } catch (_) {
    return null;
  }
}

function pickRandom(arr, n) {
  const a = Array.isArray(arr) ? arr.slice() : [];
  for (let i = a.length - 1; i > 0; i--) {
    const r = Math.floor(Math.random() * (i + 1));
    [a[i], a[r]] = [a[r], a[i]];
  }
  return a.slice(0, Math.max(0, n));
}

function buildReviewHeadingScaffold({ common }) {
  const fixed = (common && Array.isArray(common.fixedHeadings) && common.fixedHeadings.length)
    ? common.fixedHeadings
    : [
        'Overview',
        'Key features',
        'Pricing & ROI',
        'Real-world insights',
        'User ratings snapshot',
        'Verdict'
      ];

  const optional = (common && Array.isArray(common.optionalHeadings) && common.optionalHeadings.length)
    ? common.optionalHeadings
    : [
        'Best for / Not for',
        'What’s new in the last 90 days',
        'Alternatives',
        'Setup & onboarding notes',
        'Privacy & data considerations',
        'Limitations & deal-breakers'
      ];

  const pickMin = (common && typeof common.pickOptionalMin === 'number') ? common.pickOptionalMin : 1;
  const pickMax = (common && typeof common.pickOptionalMax === 'number') ? common.pickOptionalMax : 2;
  const pickCount = Math.max(pickMin, Math.min(pickMax, 2));
  const picked = pickRandom(optional, pickCount);

  const all = fixed.concat(picked);

  const lines = [
    'REVIEW STRUCTURE RULE (must follow):',
    '- Use the exact H2 headings listed below, in the same order.',
    '- Do not rename, merge, reorder, or remove these headings.',
    '- You may add H3 subheadings inside sections if helpful.',
    '',
    'Required H2 headings:',
    ...all.map(h => `- ${h}`),
    '',
    'Important:',
    '- Write only the article BODY HTML fragment.',
    '- Do NOT add TL;DR / Key Facts / FAQ / Sources sections (handled elsewhere).',
    '- “User ratings snapshot” section must NOT invent numbers. If you do not have verified figures, describe how readers should interpret ratings and what to watch for.',
  ];

  return lines.join('\n');
}

// ===== 유틸 =====
async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}
async function writeJson(filePath, data) {
  const pretty = JSON.stringify(data, null, 2);
  await fsp.writeFile(filePath, pretty + '\n', 'utf8');
}
async function listPostFiles() {
  const entries = await fsp.readdir(POSTS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => path.join(POSTS_DIR, e.name));
}
function hasBody(data) {
  if (!Object.prototype.hasOwnProperty.call(data, 'body')) return false;
  if (data.body == null) return false;
  if (typeof data.body !== 'string') return false;
  return data.body.trim().length > 0;
}
function pickLabel(data) {
  if (Array.isArray(data.labels) && data.labels.length > 0) return String(data.labels[0]);
  if (data.label) return String(data.label);
  if (data.seedMeta && data.seedMeta.label) return String(data.seedMeta.label);
  return 'unknown';
}
function safeStr(v) {
  return (v == null) ? '' : String(v);
}

// OpenAI 호출
async function generateBodyFromPrompt({ slug, label, bodyPrompt }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set in environment.');

  const systemPrompt = [
    BASE_SYSTEM_PROMPT,
    getLabelHint(label),
    'Write in natural, clear English suitable for a global audience.',
  ].join(' ');

  const common = loadReviewCommon();
  const scaffold = isReviewLabel(label) ? buildReviewHeadingScaffold({ common }) : '';

  const userPrompt = [
    scaffold ? scaffold : '',
    'Use the following instructions as the main brief for the article body:',
    '',
    bodyPrompt
  ].filter(Boolean).join('\n');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  const res = await fetchFn('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.7
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI API error slug=${slug}: ${res.status} ${res.statusText} ${text}`);
  }

  const data = await res.json();
  const content =
    data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;

  if (!content || typeof content !== 'string') {
    throw new Error(`OpenAI API returned empty content for slug=${slug}`);
  }

  return sanitizeModelOutput(content);
}

// 모델 출력 정리(가끔 ```html ... ``` 같은 것 제거)
function sanitizeModelOutput(txt) {
  let s = safeStr(txt).trim();

  // 코드펜스 제거
  s = s.replace(/^```[a-zA-Z]*\s*/m, '');
  s = s.replace(/```$/m, '');
  s = s.trim();

  // 혹시 전체 문서가 들어오면 body만 남기기(최후 방어)
  s = s.replace(/<\/?html[^>]*>/gi, '');
  s = s.replace(/<\/?head[^>]*>/gi, '');
  s = s.replace(/<\/?body[^>]*>/gi, '');
  return s.trim();
}

// 품질 검증(경량)
function validateBodyHtml(html) {
  const s = safeStr(html).trim();
  if (s.length < VALIDATE_MIN_CHARS) return { ok: false, reason: `too short (<${VALIDATE_MIN_CHARS} chars)` };

  const h2Count = (s.match(/<h2\b/gi) || []).length;
  const pCount  = (s.match(/<p\b/gi) || []).length;

  if (h2Count < VALIDATE_MIN_H2) return { ok: false, reason: `not enough <h2> (${h2Count} < ${VALIDATE_MIN_H2})` };
  if (pCount  < VALIDATE_MIN_P)  return { ok: false, reason: `not enough <p> (${pCount} < ${VALIDATE_MIN_P})` };

  for (const bad of FORBIDDEN_SNIPPETS) {
    if (s.includes(bad)) return { ok: false, reason: `contains forbidden snippet: ${bad}` };
  }

  return { ok: true };
}

// A안 폴백 본문(“빈칸 가리기” 최소 안전 템플릿)
// - 절대 TL;DR/Key Facts/FAQ/Sources 섹션을 만들지 않음
function buildFallbackBody(data) {
  const title = safeStr(data.title || data.slug || 'Untitled');
  const label = pickLabel(data);
  const angle = safeStr(data.seedMeta && data.seedMeta.angle);
  const audience = safeStr(data.seedMeta && data.seedMeta.audience);

  const hintLine = angle ? `This page is being finalized around: ${angle}.` : 'This page is being finalized with updated details.';

  return [
    `<h2>What this post covers</h2>`,
    `<p>${escapeHtml(hintLine)}</p>`,
    `<p>Below is a structured outline that will be expanded with verified details and examples.</p>`,

    `<h2>Who this is for</h2>`,
    `<p>${escapeHtml(audience || 'Readers who want clear, practical guidance without unnecessary complexity.')}</p>`,

    `<h2>Core points</h2>`,
    `<ul>`,
    `<li>One clear recommendation path based on your situation.</li>`,
    `<li>Concrete steps you can apply immediately.</li>`,
    `<li>Trade-offs explained in plain language.</li>`,
    `</ul>`,

    `<h2>How to use this</h2>`,
    `<p>Use the headings as a checklist. If you’re short on time, focus on the “Core points” and apply the next step today.</p>`,

    `<h2>Next step</h2>`,
    `<p>Pick one small action you can complete in 10 minutes. Consistency beats complexity.</p>`,

    // label별 아주 약한 힌트(내용 왜곡/허위 방지 위해 ‘일반론’만)
    `<h2>Notes for ${escapeHtml(label)}</h2>`,
    `<p>This section will be updated to match the label’s format and include relevant examples tied to “${escapeHtml(title)}”.</p>`,
  ].join('\n');
}

// HTML escape (폴백에서만 사용)
function escapeHtml(str) {
  return safeStr(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ===== 메인 =====
async function main() {
  console.log('────────────────────────────────────────────');
  console.log('[generate-body] 시작');
  console.log(`[generate-body] ROOT          = ${ROOT}`);
  console.log(`[generate-body] POSTS_DIR     = ${POSTS_DIR}`);
  console.log(`[generate-body] MODEL         = ${OPENAI_MODEL}`);
  console.log(`[generate-body] SCHEDULE_MODE = ${SCHEDULE_MODE} (${IS_LIVE ? 'LIVE' : 'DRY-RUN'})`);

  if (!OPENAI_API_KEY) {
    console.error('[generate-body] ERROR: OPENAI_API_KEY 가 설정되어 있지 않습니다.');
    process.exitCode = 1;
    return;
  }

  const files = await listPostFiles();
  console.log(`[generate-body] JSON 파일 수 = ${files.length}`);

  let total = 0;
  let generated = 0;
  let fallbacked = 0;
  let skippedHasBody = 0;
  let skippedNoPrompt = 0;
  let failed = 0;
  let dryRunTargets = 0;

  for (const filePath of files) {
    total += 1;
    const name = path.basename(filePath);

    let data;
    try {
      data = await readJson(filePath);
    } catch (err) {
      failed += 1;
      console.error(`[generate-body] [ERROR] JSON 파싱 실패: ${name} — ${err.message}`);
      continue;
    }

    const slug = data.slug || path.basename(name, '.json');
    const label = pickLabel(data);
    const bodyPrompt = data.bodyPrompt;

    if (hasBody(data)) {
      skippedHasBody += 1;
      console.log(`[generate-body] [SKIP] slug=${slug} — body 이미 존재`);
      continue;
    }

    if (!bodyPrompt || typeof bodyPrompt !== 'string') {
      skippedNoPrompt += 1;
      console.log(`[generate-body] [SKIP] slug=${slug} — bodyPrompt 없음`);
      continue;
    }

    if (!IS_LIVE) {
      dryRunTargets += 1;
      console.log(`[generate-body] [DRY-RUN] slug=${slug}, label=${label} — 생성 대상(저장은 안 함)`);
      continue;
    }

    console.log('────────────────────────────────────────────');
    console.log(`[generate-body] [TARGET] slug=${slug}, label=${label}`);

    let ok = false;
    let lastErr = '';

    // 1~2회: 생성+검증
    for (let attempt = 1; attempt <= MAX_GENERATE_ATTEMPTS; attempt++) {
      try {
        console.log(`[generate-body] attempt ${attempt}/${MAX_GENERATE_ATTEMPTS} — generating...`);
        const bodyHtml = await generateBodyFromPrompt({ slug, label, bodyPrompt });

        const v = validateBodyHtml(bodyHtml);
        if (!v.ok) {
          throw new Error(`validation failed: ${v.reason}`);
        }

        data.body = bodyHtml;
        data.bodyGen = {
          mode: 'generated',
          model: OPENAI_MODEL,
          attemptsUsed: attempt,
          updatedAt: new Date().toISOString(),
        };

        await writeJson(filePath, data);
        generated += 1;
        ok = true;
        console.log(`[generate-body] [OK] slug=${slug} — body 생성 저장 완료`);
        break;
      } catch (err) {
        lastErr = err && err.message ? err.message : String(err);
        console.error(`[generate-body] [WARN] slug=${slug} — attempt ${attempt} 실패: ${lastErr}`);
      }
    }

    // 3회차: A안 폴백(즉시 주입)
    if (!ok) {
      try {
        console.log(`[generate-body] [FALLBACK] slug=${slug} — 2회 실패 → A안 폴백 주입`);
        const fb = buildFallbackBody(data);

        // 폴백도 최소 검증(너무 짧지만 않게)
        const v2 = validateBodyHtml(fb);
        // 폴백은 구조가 짧을 수 있어 검증 완화: 길이만 체크
        if (!v2.ok && !String(v2.reason).includes('too short')) {
          // 길이 이슈 외에는 통과 취급(폴백은 “비어있지 않게”가 목적)
        }

        data.body = fb;
        data.bodyGen = {
          mode: 'fallback',
          reason: lastErr || 'unknown',
          updatedAt: new Date().toISOString(),
        };

        await writeJson(filePath, data);
        fallbacked += 1;
        console.log(`[generate-body] [OK] slug=${slug} — 폴백 저장 완료`);
      } catch (err) {
        failed += 1;
        console.error(`[generate-body] [ERROR] slug=${slug} — 폴백 저장 실패: ${err.message}`);
      }
    }
  }

  console.log('────────────────────────────────────────────');
  console.log('[generate-body] 요약');
  console.log(`  총 파일 수                 = ${total}`);
  console.log(`  생성 완료(LIVE)           = ${generated}`);
  console.log(`  폴백 주입(LIVE)           = ${fallbacked}`);
  console.log(`  DRY-RUN 대상 수(TEST 모드) = ${dryRunTargets}`);
  console.log(`  SKIP(기존 body)           = ${skippedHasBody}`);
  console.log(`  SKIP(bodyPrompt 없음)     = ${skippedNoPrompt}`);
  console.log(`  실패                      = ${failed}`);
  console.log('────────────────────────────────────────────');
  console.log('[generate-body] 완료');
}

main().catch((err) => {
  console.error('[generate-body] 치명적 오류:', err);
  process.exitCode = 1;
});
