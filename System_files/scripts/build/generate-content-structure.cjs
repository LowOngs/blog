#!/usr/bin/env node
'use strict';

/**
 * ============================================================
 * System_files/scripts/build/validate-content-structure.cjs
 * ============================================================
 *
 * 역할
 * - generate-content.cjs 이후, render 이전 단계에서
 *   content/posts/*.json 의 body 구조/품질을 점검한다.
 *
 * 정책
 * - 무인 파이프라인 특성상 "즉시 중단"보다 "1회 보정 기회"를 우선한다.
 * - 검사 결과가 기준 미달이면:
 *   1) repair request 로그를 생성한다
 *   2) generate-content.cjs 를 1회 재호출한다(보정 모드)
 *   3) 재검사한다
 *   4) 그래도 미달이면 WARN으로 남기고 통과한다
 *
 * 절대 원칙
 * - 이 파일은 본문을 직접 수정하지 않는다
 * - 수정 권한은 generate-content.cjs 에만 있다
 * - 이 파일은 검사 / 요청 / 재검사 / 로그까지만 담당한다
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(process.cwd(), 'System_files');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const LOGS_DIR = path.join(ROOT, 'logs');

const GENERATE_CONTENT_FILE = path.join(ROOT, 'scripts', 'build', 'generate-content.cjs');
const REPAIR_REQUEST_FILE = path.join(LOGS_DIR, 'content-repair-request.json');
const REPORT_FILE = path.join(LOGS_DIR, 'content-structure-report.json');

const EXCLUDED_LABELS = new Set(['firstgate']);

const REVIEW_LABELS = new Set([
  'app-reviews',
  'device-reviews',
  'subscription-services',
]);

const FAIL_MIN_TEXT_LENGTH = 600;
const WARN_MIN_TEXT_LENGTH = 1200;

console.log('────────────────────────────────────────────');
console.log('[validate-content-structure] 시작');
console.log('[validate-content-structure] ROOT       =', ROOT);
console.log('[validate-content-structure] POSTS_DIR  =', POSTS_DIR);
console.log('[validate-content-structure] REQUEST    =', REPAIR_REQUEST_FILE);
console.log('[validate-content-structure] REPORT     =', REPORT_FILE);
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

function ensureArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function extractLabel(post) {
  const direct = normStr(post.label);
  if (direct) return direct;

  const labels = ensureArray(post.labels).map(normStr).filter(Boolean);
  if (labels.length === 1) return labels[0];
  if (labels.length > 0) return labels[0];

  const seedLabel = normStr(post.seedMeta && post.seedMeta.label);
  if (seedLabel) return seedLabel;

  return '';
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countMatches(s, re) {
  const m = String(s || '').match(re);
  return m ? m.length : 0;
}

function parseSections(bodyHtml) {
  const html = String(bodyHtml || '');
  const re = /<h2>(.*?)<\/h2>([\s\S]*?)(?=<h2>|$)/gi;
  const out = [];
  let m;

  while ((m = re.exec(html)) !== null) {
    out.push({
      h2: normStr(m[1]),
      html: normStr(m[2]),
      text: stripHtml(m[2]),
      hasParagraph: /<p\b[^>]*>[\s\S]*?<\/p>/i.test(m[2]),
      hasList: /<(ul|ol)\b[^>]*>[\s\S]*?<\/(ul|ol)>/i.test(m[2]),
      hasTable: /<table\b[^>]*>[\s\S]*?<\/table>/i.test(m[2]),
    });
  }

  return out;
}

function hasPlaceholder(bodyHtml) {
  return /<!--\s*content\s*-->/i.test(String(bodyHtml || ''));
}

function hasRobotPattern(text) {
  return /\b(lorem ipsum|generated content|placeholder|template text|test content)\b/i.test(String(text || ''));
}

function inspectGeneric(slug, body, sections) {
  const issues = [];

  if (!body || !normStr(body)) {
    issues.push({ level: 'fail', code: 'BODY_EMPTY', message: 'body 비어 있음' });
    return issues;
  }

  if (hasPlaceholder(body)) {
    issues.push({ level: 'fail', code: 'PLACEHOLDER_REMAINS', message: '<!-- content --> 잔존' });
  }

  if (!sections.length) {
    issues.push({ level: 'fail', code: 'NO_H2_SECTION', message: 'h2 섹션 없음' });
  }

  for (const sec of sections) {
    if (!sec.hasParagraph && !sec.hasList && !sec.hasTable) {
      issues.push({
        level: 'fail',
        code: 'SECTION_EMPTY',
        message: `섹션 본문 비어 있음: ${sec.h2}`,
      });
    }

    if (!sec.text || sec.text.length < 40) {
