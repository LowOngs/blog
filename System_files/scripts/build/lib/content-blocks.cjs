#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/lib/content-blocks.cjs
 * - dist/posts/*.html에서 핵심 블록(id 기반) 존재 여부를 점검하는 유틸
 * - ROOT 계산은 "lib -> build -> scripts -> System_files" (3단계 업)
 */

const fs = require('fs');
const path = require('path');

// ✅ 현재 파일 위치: System_files/scripts/build/lib
// lib -> build -> scripts -> System_files
const ROOT = path.resolve(__dirname, '..', '..', '..'); // System_files
const DIST_POSTS_DIR = path.join(ROOT, 'dist', 'posts');

// 옹스 고정 규칙 핵심 ID (필요하면 추가)
const REQUIRED_IDS = [
  'tldr',
  'keyfacts',
  'faq',
  'sources',
];

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

function hasId(html, id) {
  if (!html) return false;
  // id="x" 또는 id='x' 둘 다 허용
  return html.includes(`id="${id}"`) || html.includes(`id='${id}'`);
}

/**
 * HTML 1개 검사 → 누락 id 목록 반환
 */
function checkHtmlString(html, options = {}) {
  const requiredIds = options.requiredIds || REQUIRED_IDS;

  const missingIds = [];
  for (const id of requiredIds) {
    if (!hasId(html, id)) missingIds.push(id);
  }

  return {
    ok: missingIds.length === 0,
    missingIds,
  };
}

/**
 * 파일 1개 검사
 */
function checkHtmlFile(filePath, options = {}) {
  const html = readFileSafe(filePath);
  const res = checkHtmlString(html, options);
  return {
    filePath,
    fileName: path.basename(filePath),
    ...res,
  };
}

/**
 * dist/posts 전체 검사
 */
function checkDistPosts(options = {}) {
  const dir = options.dir || DIST_POSTS_DIR;
  const files = listHtmlFiles(dir);

  const results = [];
  for (const f of files) {
    const p = path.join(dir, f);
    results.push(checkHtmlFile(p, options));
  }

  const missingCount = results.reduce((acc, r) => acc + (r.ok ? 0 : 1), 0);

  return {
    root: ROOT,
    dir,
    total: files.length,
    missingCount,
    results,
  };
}

module.exports = {
  ROOT,
  DIST_POSTS_DIR,
  REQUIRED_IDS,
  checkHtmlString,
  checkHtmlFile,
  checkDistPosts,
};
