#!/usr/bin/env node
'use strict';

/**
 * ============================================================
 * File: System_files/scripts/build/archive-post-json.cjs
 * Repo role:
 * - Source repo  : LowOngs/blog
 * - Archive repo : LowOngs/post-archive
 * ============================================================
 *
 * 역할
 * - LowOngs/blog 의 최종 post JSON 산출물을
 *   LowOngs/post-archive 저장소로 누적 복사한다.
 *
 * 핵심 원칙
 * 1) source는 항상 LowOngs/blog 의 content/posts/*.json
 * 2) target은 항상 LowOngs/post-archive 의 content/posts/*.json
 * 3) 기본 모드는 latest:
 *    - dist/queue/today.expanded.json 기준 generatedSlug/slug 만 복사
 * 4) full 모드는 전체 JSON 복사
 * 5) 이 파일은 "복사"만 담당한다. 발행/렌더/수정 책임 없음
 *
 * 동작 모드
 * - ARCHIVE_MODE=latest | full
 *   기본값: latest
 *
 * 로컬 경로 주의
 * - 이 파일은 "레포 기준 역할"을 고정해 두되,
 *   실제 로컬 checkout 위치는 환경변수로 조절 가능하다.
 *
 * 기본 로컬 해석
 * - blog repo root         = process.cwd()
 * - archive repo root      = ../post-archive
 *
 * 환경변수
 * - POST_ARCHIVE_ROOT
 *   예: D:\repos\post-archive
 *   지정 시 archive repo root를 강제로 사용
 *
 * 안전장치
 * - archive repo가 없으면 즉시 FAIL
 * - source JSON이 없으면 WARN
 * - latest 대상 slug가 없으면 조용히 종료
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BLOG_REPO_ROOT = path.resolve(process.cwd());
const SYSTEM_ROOT = path.join(BLOG_REPO_ROOT, 'System_files');
const POSTS_DIR = path.join(SYSTEM_ROOT, 'content', 'posts');
const TODAY_EXPANDED_FILE = path.join(SYSTEM_ROOT, 'dist', 'queue', 'today.expanded.json');
const LOGS_DIR = path.join(SYSTEM_ROOT, 'logs');
const REPORT_FILE = path.join(LOGS_DIR, 'archive-post-json-report.json');

const ARCHIVE_MODE_RAW = String(process.env.ARCHIVE_MODE || 'latest').trim().toLowerCase();
const ARCHIVE_MODE = ARCHIVE_MODE_RAW === 'full' ? 'full' : 'latest';

const POST_ARCHIVE_ROOT = String(process.env.POST_ARCHIVE_ROOT || '').trim()
  ? path.resolve(String(process.env.POST_ARCHIVE_ROOT || '').trim())
  : path.resolve(BLOG_REPO_ROOT, '..', 'post-archive');

const ARCHIVE_POSTS_DIR = path.join(POST_ARCHIVE_ROOT, 'content', 'posts');

console.log('────────────────────────────────────────────');
console.log('[archive-post-json] 시작');
console.log('[archive-post-json] SOURCE_REPO   = LowOngs/blog');
console.log('[archive-post-json] TARGET_REPO   = LowOngs/post-archive');
console.log('[archive-post-json] BLOG_ROOT     =', BLOG_REPO_ROOT);
console.log('[archive-post-json] SYSTEM_ROOT   =', SYSTEM_ROOT);
console.log('[archive-post-json] POSTS_DIR     =', POSTS_DIR);
console.log('[archive-post-json] ARCHIVE_ROOT  =', POST_ARCHIVE_ROOT);
console.log('[archive-post-json] ARCHIVE_DIR   =', ARCHIVE_POSTS_DIR);
console.log('[archive-post-json] MODE          =', ARCHIVE_MODE);
console.log('────────────────────────────────────────────');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function normStr(v) {
  return String(v == null ? '' : v).trim();
}

function sha1File(p) {
  const buf = fs.readFileSync(p);
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function fatal(msg) {
  console.error('[archive-post-json][FATAL]', msg);
  process.exit(1);
}

function warn(msg) {
  console.warn('[archive-post-json][WARN]', msg);
}

function info(msg) {
  console.log('[archive-post-json]', msg);
}

function validatePaths() {
  if (!fs.existsSync(SYSTEM_ROOT)) {
    fatal(`System_files 루트 없음: ${SYSTEM_ROOT}`);
  }

  if (!fs.existsSync(POSTS_DIR)) {
    fatal(`source posts 디렉토리 없음: ${POSTS_DIR}`);
  }

  if (!fs.existsSync(POST_ARCHIVE_ROOT)) {
    fatal(`archive repo 루트 없음: ${POST_ARCHIVE_ROOT}`);
  }

  const archiveGitDir = path.join(POST_ARCHIVE_ROOT, '.git');
  if (!fs.existsSync(archiveGitDir)) {
    warn(`archive repo .git 미감지: ${archiveGitDir}`);
    warn('clone 직후 또는 worktree 구조가 다를 수 있음. 계속 진행합니다.');
  }

  ensureDir(ARCHIVE_POSTS_DIR);
  ensureDir(LOGS_DIR);
}

function loadLatestSlugSet() {
  if (ARCHIVE_MODE !== 'latest') return null;
  if (!fs.existsSync(TODAY_EXPANDED_FILE)) {
    warn(`today.expanded.json 없음: ${TODAY_EXPANDED_FILE}`);
    return new Set();
  }

  let doc;
  try {
    doc = readJSON(TODAY_EXPANDED_FILE);
  } catch (e) {
    fatal(`today.expanded.json 파싱 실패: ${e.message || e}`);
  }

  const items = Array.isArray(doc && doc.items) ? doc.items : [];
  const slugs = items
    .map(item => normStr(item && (item.generatedSlug || item.slug)))
    .filter(Boolean);

  return new Set(slugs);
}

function listSourceJsonFiles() {
  return fs.readdirSync(POSTS_DIR)
    .filter(name => name.toLowerCase().endsWith('.json'))
    .sort()
    .map(name => path.join(POSTS_DIR, name));
}

function pickTargetFiles(allFiles, latestSlugSet) {
  if (ARCHIVE_MODE === 'full') return allFiles;

  return allFiles.filter(full => {
    const slug = path.basename(full, '.json');
    return latestSlugSet && latestSlugSet.has(slug);
  });
}

function copyOneFile(sourceFile) {
  const fileName = path.basename(sourceFile);
  const targetFile = path.join(ARCHIVE_POSTS_DIR, fileName);

  const sourceSha = sha1File(sourceFile);
  const targetExists = fs.existsSync(targetFile);
  const targetSha = targetExists ? sha1File(targetFile) : null;

  if (targetExists && sourceSha === targetSha) {
    return {
      file: fileName,
      slug: path.basename(fileName, '.json'),
      status: 'skip-same',
      sourceSha,
      targetSha,
    };
  }

  fs.copyFileSync(sourceFile, targetFile);

  return {
    file: fileName,
    slug: path.basename(fileName, '.json'),
    status: targetExists ? 'updated' : 'created',
    sourceSha,
    targetSha,
  };
}

function main() {
  validatePaths();

  const allFiles = listSourceJsonFiles();
  info(`source JSON 수 = ${allFiles.length}`);

  const latestSlugSet = loadLatestSlugSet();
  if (ARCHIVE_MODE === 'latest') {
    info(`latest 대상 slug 수 = ${latestSlugSet ? latestSlugSet.size : 0}`);
  }

  const targetFiles = pickTargetFiles(allFiles, latestSlugSet);
  info(`archive 대상 JSON 수 = ${targetFiles.length}`);

  if (!targetFiles.length) {
    writeJSON(REPORT_FILE, {
      generatedAt: new Date().toISOString(),
      mode: ARCHIVE_MODE,
      sourceRepo: 'LowOngs/blog',
      targetRepo: 'LowOngs/post-archive',
      sourcePostsDir: POSTS_DIR,
      archivePostsDir: ARCHIVE_POSTS_DIR,
      checked: allFiles.length,
      copied: 0,
      created: 0,
      updated: 0,
      skippedSame: 0,
      items: [],
    });

    console.log('────────────────────────────────────────────');
    console.log('[archive-post-json] 복사 대상 없음');
    console.log(`[archive-post-json] report saved → ${REPORT_FILE}`);
    console.log('────────────────────────────────────────────');
    process.exit(0);
  }

  const results = [];
  let created = 0;
  let updated = 0;
  let skippedSame = 0;

  for (const sourceFile of targetFiles) {
    if (!fs.existsSync(sourceFile)) {
      warn(`source 파일 없음: ${sourceFile}`);
      continue;
    }

    const result = copyOneFile(sourceFile);
    results.push(result);

    if (result.status === 'created') created++;
    else if (result.status === 'updated') updated++;
    else if (result.status === 'skip-same') skippedSame++;

    console.log(`[archive-post-json] ${result.status.toUpperCase()} → ${result.file}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: ARCHIVE_MODE,
    sourceRepo: 'LowOngs/blog',
    targetRepo: 'LowOngs/post-archive',
    sourcePostsDir: POSTS_DIR,
    archivePostsDir: ARCHIVE_POSTS_DIR,
    checked: allFiles.length,
    copied: created + updated,
    created,
    updated,
    skippedSame,
    items: results,
  };

  writeJSON(REPORT_FILE, report);

  console.log('────────────────────────────────────────────');
  console.log('[archive-post-json] 결과');
  console.log('  mode        =', ARCHIVE_MODE);
  console.log('  checked     =', report.checked);
  console.log('  copied      =', report.copied);
  console.log('  created     =', created);
  console.log('  updated     =', updated);
  console.log('  skippedSame =', skippedSame);
  console.log(`[archive-post-json] report saved → ${REPORT_FILE}`);
  console.log('────────────────────────────────────────────');
}

if (require.main === module) {
  main();
}
