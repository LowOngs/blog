#!/usr/bin/env node
'use strict';

/**
 * check-content-blocks.cjs
 * - dist/posts/*.html에서 "본문 블록 깨짐"을 사전 탐지
 *
 * 체크 목표
 * 1) "[object Object]" 문자열이 HTML에 남아있으면 무조건 실패
 * 2) 템플릿 플레이스홀더 "{{faq}}" 같은 잔재가 남아있으면 실패
 * 3) TL;DR/KeyFacts/FAQ/Sources 섹션이 존재할 때,
 *    내부가 비어있는데 '노출'되어 있다면 WARN (템플릿 정책에 따라 조정 가능)
 *
 * 동작
 * - 기본: FAIL 조건만 exit 1
 * - WARN은 exit 0 (로그만 남김)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const DIST = path.join(ROOT, 'dist', 'posts');

function listHtmlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.html')).sort();
}

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

function hasPlaceholder(html) {
  // 템플릿 잔재 탐지
  const needles = ['{{tldr}}', '{{keyfacts}}', '{{body}}', '{{faq}}', '{{sources}}'];
  return needles.some(n => html.includes(n));
}

function extractSection(html, id) {
  // 아주 안전하게: id="xxx"가 포함된 구간 근처만 스니펫으로 검사
  const idx = html.indexOf(`id="${id}"`);
  if (idx === -1) return '';
  const start = Math.max(0, idx - 800);
  const end = Math.min(html.length, idx + 2000);
  return html.slice(start, end);
}

function isEmptyListSection(snippet) {
  // li가 하나도 없으면 빈 리스트일 가능성
  if (!snippet) return true;
  return !snippet.includes('<li');
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[check-content] ROOT =', ROOT);
  console.log('[check-content] DIST =', DIST);

  const files = listHtmlFiles(DIST);
  console.log('[check-content] HTML files =', files.length);

  if (!files.length) {
    console.log('[check-content] no files → exit 0');
    process.exit(0);
  }

  let fail = 0;
  let warn = 0;

  const fails = [];
  const warns = [];

  for (const f of files) {
    const p = path.join(DIST, f);
    const html = readFile(p);

    // 1) 치명: [object Object]
    if (html.includes('[object Object]')) {
      fail++;
      fails.push(`${f}: contains "[object Object]"`);
      continue;
    }

    // 2) 치명: 템플릿 잔재
    if (hasPlaceholder(html)) {
      fail++;
      fails.push(`${f}: contains template placeholders ({{...}})`);
      continue;
    }

    // 3) 경고: 섹션은 있는데 실제 내용이 비어 보이는 경우(정책 따라 warn)
    // (템플릿이 "비어있으면 숨김"을 제대로 못하면 여기서 잡힘)
    const tldr = extractSection(html, 'tldr');
    if (tldr && isEmptyListSection(tldr)) {
      warn++;
      warns.push(`${f}: TL;DR section exists but appears empty`);
    }

    const keyfacts = extractSection(html, 'keyfacts');
    if (keyfacts && isEmptyListSection(keyfacts)) {
      warn++;
      warns.push(`${f}: Key Facts section exists but appears empty`);
    }

    const faq = extractSection(html, 'faq');
    // faq는 <article class="faq-item"> 같은 렌더를 기대
    if (faq && !faq.includes('faq-item') && faq.includes('id="faq"')) {
      warn++;
      warns.push(`${f}: FAQ section exists but has no rendered items`);
    }

    const sources = extractSection(html, 'sources');
    if (sources && !sources.includes('<a ') && isEmptyListSection(sources)) {
      warn++;
      warns.push(`${f}: Sources section exists but appears empty`);
    }
  }

  console.log('────────────────────────────────────────────');
  console.log(`[check-content] done: warn=${warn} fail=${fail}`);

  if (warns.length) {
    console.log('[check-content][WARN] items:');
    for (const w of warns) console.log(' -', w);
  }

  if (fails.length) {
    console.log('[check-content][FAIL] items:');
    for (const e of fails) console.log(' -', e);
    process.exit(1);
  }

  console.log('[check-content] OK: no fatal content-block issues found.');
}

if (require.main === module) {
  main();
}
