#!/usr/bin/env node

/**
 * generate-body.cjs
 *
 * 역할:
 * - content/posts/*.json 중에서
 *   body가 비어 있고(body가 없거나 빈 문자열),
 *   bodyPrompt가 있는 포스트만 골라서
 *   OpenAI API로 본문을 생성해 body 필드에 채워 넣는다.
 *
 * 사용 전 준비:
 * - 환경변수 OPENAI_API_KEY 필수
 * - (선택) OPENAI_MODEL: 기본값 'gpt-4.1-mini'
 * - (선택) SCHEDULE_MODE: 'live' 일 때만 실제 생성·저장, 그 외는 DRY-RUN
 */

// ✅ 로컬 .env 로드 (GitHub Actions에서는 Secrets가 env로 주입되므로 영향 없음)
try {
  require('dotenv').config();
} catch (_) {
  // dotenv 미설치/미사용 환경에서도 동작하게 조용히 무시
}

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Node 18+에서는 전역 fetch 지원
const fetchFn = global.fetch || require('node-fetch');

// ===== 설정 =====
const ROOT = path.resolve(__dirname, '..', '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

// 스케줄 모드: live 일 때만 실제 본문 생성
const SCHEDULE_MODE = process.env.SCHEDULE_MODE || 'test';
const IS_LIVE = SCHEDULE_MODE === 'live';

// 기본 시스템 프롬프트
const BASE_SYSTEM_PROMPT = [
  'You are a writing assistant for a clear, practical tech/productivity blog.',
  'Write only the HTML fragment for the article body.',
  'Do NOT include <html>, <head>, <body>, or outer <section> wrappers.',
  'Use <h2>, <h3>, <p>, <ul>, <ol>, <li> for structure.',
  'Do NOT repeat TL;DR, Key Facts, FAQ, or Sources sections – they are handled separately.',
  'Paragraphs should be short and easy to scan.'
].join(' ');

// 라벨별 톤/구조 힌트(간단 버전)
function getLabelHint(label) {
  switch (label) {
    case 'app-reviews':
      return 'Style: balanced review, explain strengths, limitations, and ideal users. Include short comparison style language where helpful.';
    case 'device-reviews':
      return 'Style: hardware review with clear pros/cons and trade-offs. Emphasize real-world usage, thermals, battery, and keyboard/screen comfort.';
    case 'subscription-services':
      return 'Style: subscription analysis focused on value for money. Use simple numeric examples where helpful, but do not invent fake brands.';
    case 'how-to-playbooks':
      return 'Style: step-by-step how-to guide. Use ordered lists and headings to break down each phase clearly.';
    case 'smart-savings':
      return 'Style: money-saving guide. Be concrete about trade-offs and show how to reduce costs without breaking workflows.';
    case 'templates-checklists':
      return 'Style: template/checklist article. Present clear sections and bullet lists that readers can reuse directly.';
    default:
      return 'Style: clear, friendly explanatory article. Focus on practical advice and concrete examples.';
  }
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

// OpenAI 호출
async function generateBodyFromPrompt({ slug, label, bodyPrompt }) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set in environment.');
  }

  const systemPrompt = [
    BASE_SYSTEM_PROMPT,
    getLabelHint(label),
    'Write in natural, clear English suitable for a global audience.'
  ].join(' ');

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content:
        'Use the following instructions as the main brief for the article body:\n\n' +
        bodyPrompt
    }
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
    throw new Error(
      `OpenAI API error for slug=${slug}: ${res.status} ${res.statusText} ${text}`
    );
  }

  const data = await res.json();
  const content =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;

  if (!content || typeof content !== 'string') {
    throw new Error(`OpenAI API returned empty content for slug=${slug}`);
  }

  // 양끝 공백 제거
  return content.trim();
}

// ===== 메인 로직 =====

async function main() {
  console.log('────────────────────────────────────────────');
  console.log('[generate-body] 시작');
  console.log(`[generate-body] ROOT        = ${ROOT}`);
  console.log(`[generate-body] POSTS_DIR   = ${POSTS_DIR}`);
  console.log(
    `[generate-body] SCHEDULE_MODE = ${SCHEDULE_MODE} (${IS_LIVE ? 'LIVE' : 'DRY-RUN'})`
  );

  if (!OPENAI_API_KEY) {
    console.error(
      '[generate-body] ERROR: 환경변수 OPENAI_API_KEY 가 설정되어 있지 않습니다.'
    );
    process.exitCode = 1;
    return;
  }

  const files = await listPostFiles();
  console.log(
    `[generate-body] 발견된 포스트 JSON 파일 수 = ${files.length} (content/posts)`
  );

  let total = 0;
  let generated = 0;
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
      console.error(
        `[generate-body] [ERROR] JSON 파싱 실패: ${name} — ${err.message}`
      );
      continue;
    }

    const slug = data.slug || path.basename(name, '.json');

    // 라벨: labels[0] 우선, 없으면 label, 없으면 unknown
    let label = 'unknown';
    if (Array.isArray(data.labels) && data.labels.length > 0) {
      label = String(data.labels[0]);
    } else if (data.label) {
      label = String(data.label);
    }

    const hasExistingBody = hasBody(data);
    const bodyPrompt = data.bodyPrompt;

    if (hasExistingBody) {
      skippedHasBody += 1;
      console.log(
        `[generate-body] [SKIP] slug=${slug} — body 필드가 이미 존재합니다.`
      );
      continue;
    }

    if (!bodyPrompt || typeof bodyPrompt !== 'string') {
      skippedNoPrompt += 1;
      console.log(
        `[generate-body] [SKIP] slug=${slug} — bodyPrompt 가 없어 생성하지 않습니다.`
      );
      continue;
    }

    // DRY-RUN 모드: 대상만 표시하고 실제 생성은 하지 않음
    if (!IS_LIVE) {
      dryRunTargets += 1;
      console.log(
        `[generate-body] [DRY-RUN] slug=${slug}, label=${label} — 본문 생성 대상이지만 SCHEDULE_MODE != "live" 이므로 생성하지 않습니다.`
      );
      continue;
    }

    console.log('────────────────────────────────────────────');
    console.log(
      `[generate-body] [TARGET] slug=${slug}, label=${label} — 본문 생성 시작`
    );

    try {
      const bodyHtml = await generateBodyFromPrompt({
        slug,
        label,
        bodyPrompt
      });

      data.body = bodyHtml;

      await writeJson(filePath, data);
      generated += 1;
      console.log(
        `[generate-body] [OK] slug=${slug} — body 필드 생성 및 저장 완료 (${name})`
      );
    } catch (err) {
      failed += 1;
      console.error(
        `[generate-body] [ERROR] slug=${slug} — 본문 생성 실패: ${err.message}`
      );
    }
  }

  console.log('────────────────────────────────────────────');
  console.log(`[generate-body] 처리 요약:`);
  console.log(`  총 파일 수                 = ${total}`);
  console.log(`  생성 완료(LIVE)           = ${generated}`);
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
