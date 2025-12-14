#!/usr/bin/env node
'use strict';

/**
 * check-og-freshness.cjs
 * - how-to/smart-savings/templates 계열에 대한 OG/산출물 상태 경고
 * - 기준:
 *   A) dist/posts/*.html 내 og:image 존재 여부
 *   B) content/posts/*.json 의 updated(UTC) 우선 사용
 *      - updated 없으면 seedMeta.queueDate(YYYY-MM-DD)를 UTC 00:00:00Z로 임시 해석
 * - WARN: ageDays >= 89
 *
 * 실행:
 *   C:\google-blog> node .\System_files\scripts\build\check-og-freshness.cjs
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const DIST_DIR = path.join(ROOT, 'dist', 'posts');

const TARGET_LABELS = new Set(['how-to-playbooks', 'smart-savings', 'templates-checklists']);
const WARN_DAYS = 89;

function log(...a) { console.log('[og-freshness]', ...a); }
function warn(...a) { console.warn('[og-freshness][WARN]', ...a); }

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    warn('JSON parse failed:', p, e.message);
    return fallback;
  }
}

function parseUtcDate(input) {
  if (!input) return null;
  const d = new Date(String(input));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// queueDate: "YYYY-MM-DD" -> Date("YYYY-MM-DDT00:00:00Z")
function parseQueueDateAsUtc(queueDate) {
  if (!queueDate) return null;
  const s = String(queueDate).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function daysBetweenUtc(a, b) {
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function pickLabel(data) {
  if (Array.isArray(data.labels) && data.labels.length > 0) return String(data.labels[0]);
  if (data.label) return String(data.label);
  if (data.seedMeta && data.seedMeta.label) return String(data.seedMeta.label);
  return 'unknown';
}

function extractOgImage(html) {
  const m = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']\s*\/?>/i);
  return m ? m[1] : '';
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f));
}

function main() {
  log('ROOT =', ROOT);
  log('POSTS =', POSTS_DIR);
  log('DIST  =', DIST_DIR);
  log('LABELS =', Array.from(TARGET_LABELS).join(', '));
  log('WARN_DAYS =', WARN_DAYS);

  if (!fs.existsSync(POSTS_DIR)) {
    warn('content/posts 폴더가 없습니다.');
    process.exit(0);
  }
  if (!fs.existsSync(DIST_DIR)) {
    warn('dist/posts 폴더가 없습니다. render-posts.cjs 먼저 실행하세요.');
    process.exit(0);
  }

  const now = new Date();

  const jsonFiles = listJsonFiles(POSTS_DIR);
  let targets = 0;
  let ogMissing = 0;
  let updatedMissing = 0;
  let warnOld = 0;

  const ogMissingSlugs = [];
  const updatedMissingSlugs = [];
  const warnOldSlugs = [];
  const updatedDerivedSlugs = [];

  for (const p of jsonFiles) {
    const data = readJsonSafe(p, null);
    if (!data) continue;

    const slug = data.slug || path.basename(p, '.json');
    const label = pickLabel(data);
    if (!TARGET_LABELS.has(label)) continue;

    targets += 1;

    // A) OG 존재 체크
    const htmlPath = path.join(DIST_DIR, `${slug}.html`);
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, 'utf8');
      const og = extractOgImage(html);
      if (!og) {
        ogMissing += 1;
        ogMissingSlugs.push(slug);
      }
    } else {
      ogMissing += 1;
      ogMissingSlugs.push(slug);
    }

    // B) updated 체크(없으면 queueDate로 임시 해석)
    let ud = parseUtcDate(data.updated);
    if (!ud) {
      updatedMissing += 1;
      updatedMissingSlugs.push(slug);

      const qd = parseQueueDateAsUtc(data.seedMeta && data.seedMeta.queueDate);
      if (qd) {
        ud = qd;
        updatedDerivedSlugs.push(slug);
      } else {
        // 날짜 기준 자체가 없으면 warnOld 계산 불가
        continue;
      }
    }

    const ageDays = daysBetweenUtc(ud, now);
    if (ageDays >= WARN_DAYS) {
      warnOld += 1;
      warnOldSlugs.push(`${slug}(${ageDays}d)`);
    }
  }

  log('done:', `targets=${targets}`, `ogMissing=${ogMissing}`, `updatedMissing=${updatedMissing}`, `warnOld=${warnOld}`);
  if (ogMissingSlugs.length) log('OG_MISSING slugs:', ogMissingSlugs.join(', '));
  if (updatedMissingSlugs.length) log('UPDATED_MISSING slugs:', updatedMissingSlugs.join(', '));
  if (updatedDerivedSlugs.length) log('UPDATED_DERIVED_FROM_queueDate slugs:', updatedDerivedSlugs.join(', '));
  if (warnOldSlugs.length) log('WARN_OLD slugs:', warnOldSlugs.join(', '));

  if (!ogMissing && !updatedMissing && !warnOld) {
    log('OK: OG + updated freshness checks look good for non-review labels.');
  }
}

main();
