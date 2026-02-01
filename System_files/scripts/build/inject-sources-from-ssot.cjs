#!/usr/bin/env node
'use strict';

/** inject-sources-from-ssot: Sources 섹션을 SSOT(포스트 JSON) 기준으로 dist/posts에 보정 주입 */

require('./lib/env.cjs'); // ✅ 공통 규칙: env 로더 최우선

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const LOGS_DIR = path.join(ROOT, 'logs');

// What: dist/posts/*.html에 <section id="sources">...</section>을 "항상" 존재시키고, SSOT로 채움
// Why : 현재 sources가 중복 id로 생성되는 케이스가 있어, dist 단계에서 "1개로 정리 + 교체"로 무결성 보장
// I/O : READ content/posts/{slug}.json, dist/posts/{slug}.html
//       WRITE dist/posts/{slug}.html (in-place overwrite), logs/inject-sources-report-YYYY-MM-DD.json
// Invariants:
//   - id="sources"는 최종 HTML에 정확히 1개만 존재해야 함(중복 생성 금지)
//   - SSOT가 비어도 <section id="sources"> 자체는 유지(계약 보장)
//   - ✅ "없으면 삽입"은 하지 않는다(템플릿 SSOT 전제). 중복(2개 이상)만 정리한다.
//   - review/faq 등 다른 섹션은 건드리지 않음(수정 범위 최소화)

const { parseDryRun } = require('./lib/env.cjs'); // env.cjs에 있으면 재사용(없어도 아래 fallback으로 안전)
const blocks = require('./lib/blocks.cjs');

function safeParseDryRun(v) {
  try {
    if (typeof parseDryRun === 'function') return parseDryRun(v);
  } catch {}
  const s = String(v ?? '').trim().toLowerCase();
  return !(s === 'false' || s === '0');
}

const DRY_RUN = safeParseDryRun(process.env.DRY_RUN);
const LIVE_MODE = !DRY_RUN;

// 로컬 확인/출력 성격이므로 기본 all 유지(스코프 추가로 복잡도 올리지 않음)
const TARGET_SCOPE = String(process.env.TARGET_SCOPE || 'all').trim().toLowerCase() === 'today'
  ? 'today'
  : 'all';

const TODAY_PATH = path.join(ROOT, 'dist', 'queue', 'today.json');

function log(...a) { console.log('[inject-sources]', ...a); }
function warn(...a) { console.warn('[inject-sources][WARN]', ...a); }

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

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

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function nowKstDate() {
  const d = new Date();
  const k = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return k.toISOString().slice(0, 10);
}

/** today.json에서 publishable slug set 추출(유연 포맷 지원) */
function loadPublishableSlugsFromToday() {
  const raw = readJsonSafe(TODAY_PATH, null);
  if (!raw) return { slugs: new Set(), loaded: false, source: TODAY_PATH };

  const out = new Set();

  if (Array.isArray(raw)) {
    for (const it of raw) {
      if (typeof it === 'string' && it.trim()) out.add(it.trim());
      if (it && typeof it === 'object' && typeof it.slug === 'string' && it.slug.trim()) out.add(it.slug.trim());
    }
    return { slugs: out, loaded: true, source: TODAY_PATH };
  }

  const candidates = []
    .concat(asArray(raw.items))
    .concat(asArray(raw.posts))
    .concat(asArray(raw.queue))
    .concat(asArray(raw.publishables));

  for (const it of candidates) {
    if (!it) continue;
    if (typeof it === 'string' && it.trim()) out.add(it.trim());
    if (typeof it === 'object' && typeof it.slug === 'string' && it.slug.trim()) out.add(it.slug.trim());
  }

  return { slugs: out, loaded: true, source: TODAY_PATH };
}

/** SSOT(post json)에서 sources 후보를 통합 추출 */
function extractSourcesFromPostJson(postJson) {
  const aio = (postJson && postJson.aio && typeof postJson.aio === 'object') ? postJson.aio : {};
  const s1 = aio.sources;
  const s2 = postJson.sources;
  return []
    .concat(asArray(s1))
    .concat(asArray(s2))
    .filter(Boolean);
}

/** <section id="sources">...</section>을 "단일 섹션"으로 재구성 */
function buildSourcesSectionHtml(sourcesArr) {
  let inner = '';
  try {
    inner = blocks.renderSources(asArray(sourcesArr)) || '';
  } catch {
    inner = '';
  }

  // blocks.renderSources가 이미 <section id="sources"...>까지 포함하는 경우 그대로 사용
  const looksLikeSection = /<section\b[^>]*\bid=["']sources["']/i.test(inner);
  if (looksLikeSection) return inner.trim();

  if (!inner.trim()) inner = '<!-- sources: empty -->';

  return [
    '<section id="sources" class="sources">',
    '  <h3>Sources</h3>',
    `  ${inner.replace(/\n/g, '\n  ')}`,
    '</section>',
  ].join('\n');
}

/** HTML에서 sources 섹션(들) 찾기 */
function findSourcesSections(html) {
  const re = /<section\b[^>]*\bid=["']sources["'][^>]*>[\s\S]*?<\/section>/gi;
  const matches = [];
  let m;
  while ((m = re.exec(String(html || '')))) {
    matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return matches;
}

/**
 * ✅ 중복 sources 섹션 복구
 * - sources 섹션이 2개 이상이면: 첫 번째만 남기고 나머지 섹션은 삭제
 * - 목적: 이후 replace가 "정상적으로 1개"만 유지되게 만들기
 */
function removeDuplicateSourcesSections(html) {
  const secs = findSourcesSections(html);
  if (secs.length <= 1) return { html, removed: 0 };

  // 첫 번째는 보존, 나머지는 뒤에서부터 제거(인덱스 보존)
  let out = String(html);
  let removed = 0;

  for (let i = secs.length - 1; i >= 1; i--) {
    out = out.slice(0, secs[i].start) + out.slice(secs[i].end);
    removed += 1;
  }
  return { html: out, removed };
}

/** HTML에서 기존 sources 섹션을 교체(있으면) */
function replaceSourcesSection(html, newSectionHtml) {
  const sectionRe = /<section\b[^>]*\bid=["']sources["'][^>]*>[\s\S]*?<\/section>/i;
  if (sectionRe.test(html)) {
    return { html: html.replace(sectionRe, newSectionHtml), changed: true, mode: 'replaced' };
  }
  return { html, changed: false, mode: 'missing' };
}

/** ✅ 최종 sources 섹션 개수(실제 section만 카운트) */
function countSourcesSections(html) {
  return findSourcesSections(html).length;
}

function main() {
  ensureDir(LOGS_DIR);

  log('ROOT        =', ROOT);
  log('DIST        =', DIST_DIR);
  log('POSTS_DIR   =', POSTS_DIR);
  log('TODAY       =', TODAY_PATH);
  log('DRY_RUN     =', DRY_RUN);
  log('MODE        =', LIVE_MODE ? 'live' : 'test(no_live)');
  log('SCOPE       =', TARGET_SCOPE);

  if (!fs.existsSync(DIST_DIR)) {
    warn('dist/posts 없음. posts:render 먼저 실행하세요.');
    process.exit(0);
  }
  if (!fs.existsSync(POSTS_DIR)) {
    warn('content/posts 없음. 종료합니다.');
    process.exit(0);
  }

  const allHtmlFiles = fs.readdirSync(DIST_DIR).filter((f) => f.toLowerCase().endsWith('.html')).sort();

  let targetSet = null;
  if (TARGET_SCOPE === 'today') {
    const pub = loadPublishableSlugsFromToday();
    targetSet = pub.slugs;
    log('publishable loaded =', pub.loaded);
    log('publishable count  =', targetSet.size);

    if (!pub.loaded || targetSet.size === 0) {
      warn('today scope인데 publishable 비어있음 → 0개 처리로 종료');
      return;
    }
  }

  const targetFiles = (TARGET_SCOPE === 'today')
    ? allHtmlFiles.filter((f) => targetSet.has(path.basename(f, '.html')))
    : allHtmlFiles;

  log('HTML files(all)   =', allHtmlFiles.length);
  log('HTML files(target)=', targetFiles.length);

  let updated = 0;
  let replaced = 0;
  let postMissing = 0;

  // ✅ 이번에 바뀐 핵심 통계
  let deduped = 0;
  let dupGuarded = 0;
  let missingSection = 0; // 템플릿 SSOT 전제 위반(관측용)

  for (const f of targetFiles) {
    const slug = path.basename(f, '.html');
    const htmlPath = path.join(DIST_DIR, f);
    const postPath = path.join(POSTS_DIR, `${slug}.json`);

    const html0 = readTextSafe(htmlPath);
    if (html0 == null) continue;

    const postJson = readJsonSafe(postPath, null);
    if (!postJson) {
      postMissing += 1;
      continue;
    }

    const sourcesArr = extractSourcesFromPostJson(postJson);
    const newSection = buildSourcesSectionHtml(sourcesArr);

    // ✅ 0) 먼저 “중복 섹션(2개 이상)”이면 1개로 정리
    let baseHtml = html0;
    const d0 = removeDuplicateSourcesSections(baseHtml);
    baseHtml = d0.html;
    if (d0.removed > 0) deduped += 1;

    // ✅ 1) 기존 <section id="sources">가 있으면 교체 (없으면 아무것도 하지 않음)
    let html = baseHtml;
    const r1 = replaceSourcesSection(html, newSection);
    html = r1.html;

    if (!r1.changed) {
      // 템플릿 SSOT 전제 위반: 여기서 "삽입"하지 않고 관측만 남김
      missingSection += 1;
      continue;
    }

    // ✅ 2) 최종 가드: 실제 sources 섹션이 정확히 1개여야 함
    const cnt = countSourcesSections(html);
    if (cnt !== 1) {
      dupGuarded += 1;
      warn(`sources section guarded: slug=${slug} count=${cnt} (write skipped)`);
      continue;
    }

    // 변경이 있거나(교체), dedupe가 있었으면 write
    if (r1.changed || d0.removed > 0) {
      fs.writeFileSync(htmlPath, html, 'utf8');
      updated += 1;
      replaced += 1;
    }
  }

  const report = {
    ts: new Date().toISOString(),
    mode: LIVE_MODE ? 'live' : 'test',
    scope: TARGET_SCOPE,
    dryRun: DRY_RUN,
    counts: {
      htmlAll: allHtmlFiles.length,
      htmlTarget: targetFiles.length,
      updated,
      replaced,
      postMissing,
      deduped,
      dupGuarded,
      missingSection,
    },
  };

  const date = nowKstDate();
  const reportPath = path.join(LOGS_DIR, `inject-sources-report-${date}.json`);
  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    log('report saved =', reportPath);
  } catch (e) {
    warn('report save failed:', e.message || e);
  }

  log('done:',
    `updated=${updated}`,
    `replaced=${replaced}`,
    `postMissing=${postMissing}`,
    `deduped=${deduped}`,
    `dupGuarded=${dupGuarded}`,
    `missingSection=${missingSection}`
  );
}

if (require.main === module) main();
