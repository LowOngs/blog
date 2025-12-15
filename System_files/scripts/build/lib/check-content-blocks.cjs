#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function listHtmlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.html'));
}

// ✅ 현재 파일 위치: System_files/scripts/build/lib
// lib -> build -> scripts -> System_files  (총 3번 올라가야 System_files)
const ROOT = path.resolve(__dirname, '..', '..', '..'); // System_files
const DIST = path.join(ROOT, 'dist', 'posts');

console.log('────────────────────────────────────────────');
console.log('[check-content] ROOT =', ROOT);
console.log('[check-content] DIST =', DIST);

const files = listHtmlFiles(DIST);
console.log('[check-content] HTML files =', files.length);

if (!files.length) {
  console.log('[check-content] no files → exit 0');
  process.exit(0);
}

// 여기부터는 “파일이 있을 때만” 검사 로직을 돌립니다.
// (옹스님 content-blocks 모듈 구조를 유지하려면, 아래는 최소한으로만 둡니다.)
let missing = 0;

for (const f of files) {
  const p = path.join(DIST, f);
  const html = readFileSafe(p);

  // 매우 가벼운 1차 체크(필요하면 옹스님 기준에 맞춰 더 늘리면 됩니다)
  const hasTLDR = html.includes('id="tldr"') || html.includes("id='tldr'");
  const hasKeyFacts = html.includes('id="keyfacts"') || html.includes("id='keyfacts'");
  const hasFAQ = html.includes('id="faq"') || html.includes("id='faq'");
  const hasSources = html.includes('id="sources"') || html.includes("id='sources'");

  if (!hasTLDR || !hasKeyFacts || !hasFAQ || !hasSources) {
    missing++;
    console.log(`[MISS] ${f} tldr=${hasTLDR} keyfacts=${hasKeyFacts} faq=${hasFAQ} sources=${hasSources}`);
  }
}

console.log('────────────────────────────────────────────');
console.log(`[check-content] done. missing=${missing}/${files.length}`);

if (missing > 0) process.exitCode = 1;
