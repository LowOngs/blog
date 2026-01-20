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
// Why : 템플릿 뼈대는 템플릿이 담당하지만(원칙), 현 상태에서 sources가 통째로 비어 QA에서 CRIT 가능
//       → 최소패치로 pipeline 무결성(핵심 블록 계약)을 보장하기 위해, dist 단계에서 sources를 보정한다.
// I/O : READ content/posts/{slug}.json, dist/posts/{slug}.html
//       WRITE dist/posts/{slug}.html (in-place overwrite), logs/inject-sources-report-YYYY-MM-DD.json
// Invariants:
//   - id="sources"는 최종 HTML에 정확히 1개만 존재해야 함(중복 생성 금지)
//   - SSOT가 비어도 <section id="sources"> 자체는 유지(계약 보장)
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

// 기본 스코프 정책:
// - live(운영): today.json publishable만 처리하는 게 안전하지만,
//   이 스크립트는 "dist/posts"를 보정하는 성격이라, 기본은 all 유지.
// - 필요 시: TARGET_SCOPE=today 로 좁힐 수 있음.
const TARGET_SCOPE = String(process.env.TARGET_SCOPE || 'all').trim().toLowerCase() === 'today'
  ? 'today'
  : 'all';

const TODAY_PATH = path.join(ROOT, 'dist', 'queue', 'today.json');

function log(...a) {
  console.log('[inject-sources]', ...a);
}
function warn(...a) {
  console.warn('[inject-sources][WARN]', ...a);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readTextSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
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
  const sources = []
    .concat(asArray(s1))
    .concat(asArray(s2))
    .filter(Boolean);
  return sources;
}

/** <section id="sources">...</section>을 "단일 섹션"으로 재구성 */
function buildSourcesSectionHtml(sourcesArr) {
  // blocks.renderSources가 이미 <section id="sources"> 를 만들 수도 있고(구현에 따라),
  // ul만 만들 수도 있음. 여기서는 "섹션 외형"을 우리가 확정해서 중복/누락을 막는다.
  // -> 내부는 blocks.renderSources를 최대한 활용.
  let inner = '';
  try {
    inner = blocks.renderSources(asArray(sourcesArr)) || '';
  } catch {
    inner = '';
  }

  // blocks.renderSources가 <section id="sources"...>까지 포함해버리는 경우를 대비해 "섹션 한 번 더 감싸기" 방지
  // - 이미 section을 반환하면, 그걸 그대로 사용하되, 최종적으로 id="sources" 1개만 유지하도록 replace 단계에서 정규화
  const looksLikeSection = /<section\b[^>]*\bid=["']sources["']/i.test(inner);

  if (looksLikeSection) {
    // 그대로 반환(이후 replace/insert에서 section 단위로 처리)
    return inner.trim();
  }

  // SSOT가 비어도 섹션 자체는 존재해야 함(핵심 블록 계약)
  if (!inner.trim()) {
    inner = '<!-- sources: empty -->';
  }

  return [
    '<section id="sources" class="sources">',
    '  <h3>Sources</h3>',
    `  ${inner.replace(/\n/g, '\n  ')}`,
    '</section>',
  ].join('\n');
}

/** HTML에서 기존 sources 섹션을 교체(있으면) */
function replaceSourcesSection(html, newSectionHtml) {
  const sectionRe = /<section\b[^>]*\bid=["']sources["'][^>]*>[\s\S]*?<\/section>/i;

  if (sectionRe.test(html)) {
    const replaced = html.replace(sectionRe, newSectionHtml);
    return { html: replaced, changed: true, mode: 'replaced' };
  }

  return { html, changed: false, mode: 'missing' };
}

/** SLOT 마커 뒤에 삽입 */
function injectAfterSlot(html, slotMarker, insertHtml) {
  const idx = html.indexOf(slotMarker);
  if (idx === -1) return { html, changed: false, injected: false };
  const after = idx + slotMarker.length;
  const out = html.slice(0, after) + '\n' + insertHtml + html.slice(after);
  return { html: out, changed: true, injected: true };
}

/** sources id 중복 감지(안전가드) */
function countSourcesId(html) {
  const re = /\bid=["']sources["']/gi;
  let n = 0;
  while (re.exec(String(html || ''))) n++;
  return n;
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
  let inserted = 0;
  let replaced = 0;
  let slotMissing = 0;
  let postMissing = 0;
  let dupGuarded = 0;

  const slotMarker = '<!--SLOT:SOURCES_WRAPPER-->';

  for (const f of targetFiles) {
    const slug = path.basename(f, '.html');
    const htmlPath = path.join(DIST_DIR, f);
    const postPath = path.join(POSTS_DIR, `${slug}.json`);

    const html0 = readTextSafe(htmlPath);
    if (html0 == null) continue;

    const postJson = readJsonSafe(postPath, null);
    if (!postJson) {
      // dist는 있는데 post json이 없으면 "삽입을 시도"해도 근거가 없어 위험
      postMissing += 1;
      continue;
    }

    const sourcesArr = extractSourcesFromPostJson(postJson);
    const newSection = buildSourcesSectionHtml(sourcesArr);

    // 1) 기존 <section id="sources">가 있으면 교체
    let html = html0;
    const r1 = replaceSourcesSection(html, newSection);
    html = r1.html;

    let changed = false;

    if (r1.changed) {
      changed = true;
      replaced += 1;
    } else {
      // 2) 없으면 SLOT 뒤로 삽입
      const r2 = injectAfterSlot(html, slotMarker, newSection);
      if (r2.injected) {
        html = r2.html;
        changed = true;
        inserted += 1;
      } else {
        slotMissing += 1;
      }
    }

    // 3) 중복 id 가드: id="sources"가 2개 이상이면 변경 적용 금지(오염 방지)
    const cnt = countSourcesId(html);
    if (cnt > 1) {
      dupGuarded += 1;
      warn(`dup sources id guarded: slug=${slug} count=${cnt} (write skipped)`);
      continue;
    }

    if (changed) {
      fs.writeFileSync(htmlPath, html, 'utf8');
      updated += 1;
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
      inserted,
      replaced,
      slotMissing,
      postMissing,
      dupGuarded,
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
    `inserted=${inserted}`,
    `replaced=${replaced}`,
    `slotMissing=${slotMissing}`,
    `postMissing=${postMissing}`,
    `dupGuarded=${dupGuarded}`
  );
}

if (require.main === module) main();
