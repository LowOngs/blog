// inject-sources-from-ssot.cjs — DRY_RUN 파서 통일 + today 스코프 옵션 + sources 게이트(soft/strict)

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const SSOT_PATH = path.join(ROOT, 'content', 'reviews', 'review-sources.json');
const TODAY_PATH = path.join(ROOT, 'dist', 'queue', 'today.json');
const LOG_DIR = path.join(ROOT, 'logs');

const REVIEW_LABELS = new Set(['app-reviews', 'device-reviews', 'subscription-services']);

function log(...a) {
  console.log('[inject-sources]', ...a);
}
function warn(...a) {
  console.warn('[inject-sources][WARN]', ...a);
}

/**
 * DRY_RUN 단일 파서
 * - false/0 만 "live"
 * - 그 외 전부 "dry-run"
 */
function parseDryRun(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return !(s === 'false' || s === '0');
}

const DRY_RUN_RAW = process.env.DRY_RUN;
const DRY_RUN = parseDryRun(DRY_RUN_RAW);
const LIVE_MODE = !DRY_RUN;

/**
 * 게이트 모드
 * - 기본: soft(중단하지 않음)
 * - SOURCES_STRICT=true|1 이면 strict(리뷰 sources<2 발생 시 종료코드 1)
 */
function parseStrict(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === '1';
}
const SOURCES_STRICT = parseStrict(process.env.SOURCES_STRICT);

/**
 * 대상 스코프
 * - live 기본: today (today.json publishable slug만 처리)
 * - test 기본: all (기존 동작 유지)
 * - TARGET_SCOPE=all 로 강제 가능
 */
function parseScope(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'all' ? 'all' : 'today';
}
const TARGET_SCOPE = parseScope(process.env.TARGET_SCOPE ?? (LIVE_MODE ? 'today' : 'all'));

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    warn('JSON parse failed:', filePath, e.message);
    return fallback;
  }
}

/** today.json에서 publishable slug 집합을 뽑기(유연 포맷 지원) */
function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}
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

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/\n/g, ' ');
}

/** SSOT 입력 형태를 slug → sources[] 형태로 정규화 */
function normalizeSources(raw) {
  const outBySlug = {};
  if (!raw) return outBySlug;

  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (!row || typeof row !== 'object') continue;
      const slug = row.slug;
      const srcs = row.sources || row.items || row.list;
      if (!slug) continue;
      outBySlug[slug] = normalizeSourcesArray(srcs);
    }
    return outBySlug;
  }

  if (typeof raw === 'object') {
    const bySlug = raw.bySlug && typeof raw.bySlug === 'object' ? raw.bySlug : null;
    if (bySlug) {
      for (const slug of Object.keys(bySlug)) {
        outBySlug[slug] = normalizeSourcesArray(bySlug[slug]);
      }
      return outBySlug;
    }

    for (const slug of Object.keys(raw)) {
      if (slug === 'meta') continue;
      outBySlug[slug] = normalizeSourcesArray(raw[slug]);
    }
  }

  return outBySlug;
}

function normalizeSourcesArray(v) {
  const arr = Array.isArray(v) ? v : (v ? [v] : []);
  const out = [];

  for (const s of arr) {
    if (!s) continue;

    if (typeof s === 'string') {
      const t = s.trim();
      if (!t) continue;
      out.push({ url: t, label: t, note: '' });
      continue;
    }

    if (typeof s === 'object') {
      const url = String(s.url || s.href || '').trim();
      const label = String(s.label || s.name || url || '').trim();
      const note = String(s.note || '').trim();
      if (!url && !label) continue;
      out.push({ url, label, note });
    }
  }

  return out.filter((x) => x.url && x.label);
}

function buildSourcesUlHtml(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return '';

  const items = sources.map((s) => {
    const url = escapeAttr(s.url);
    const label = escapeHtml(s.label || s.url);
    const note = s.note ? ` — ${escapeHtml(s.note)}` : '';
    return `<li><a href="${url}" target="_blank" rel="nofollow noopener noreferrer">${label}</a>${note}</li>`;
  });

  return `<ul>\n${items.join('\n')}\n</ul>`;
}

/** <section id="sources">...</section> 교체/제거 */
function replaceSourcesSection(html, newUlHtml) {
  const sectionRe = /<section\b[^>]*\bid=["']sources["'][^>]*>[\s\S]*?<\/section>/i;

  if (!sectionRe.test(html)) {
    return { html, changed: false, missing: true };
  }

  if (!newUlHtml) {
    const replaced = html.replace(sectionRe, '');
    return { html: replaced, changed: true, removed: true };
  }

  const rebuilt = [
    '<section id="sources" class="sources">',
    '  <h3>Sources</h3>',
    `  ${newUlHtml.replace(/\n/g, '\n  ')}`,
    '</section>',
  ].join('\n');

  const replaced = html.replace(sectionRe, rebuilt);
  return { html: replaced, changed: true, removed: false };
}

/** content/posts/{slug}.json 기준으로 라벨 확인 */
function loadPostLabels(slug) {
  const p = path.join(POSTS_DIR, `${slug}.json`);
  const j = readJsonSafe(p, null);
  if (!j) return [];
  const labels = Array.isArray(j.labels) ? j.labels : (j.label ? [j.label] : []);
  return labels.filter(Boolean);
}

function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });

  log('ROOT           =', ROOT);
  log('DIST           =', DIST_DIR);
  log('SSOT           =', SSOT_PATH);
  log('today          =', TODAY_PATH);
  log('dry_run(raw)   =', (DRY_RUN_RAW === undefined ? '(undefined)' : JSON.stringify(String(DRY_RUN_RAW))));
  log('dry_run(parsed)=', DRY_RUN);
  log('mode           =', LIVE_MODE ? 'live' : 'test(no_live)');
  log('scope          =', TARGET_SCOPE);
  log('gate           =', SOURCES_STRICT ? 'strict' : 'soft');

  if (!fs.existsSync(DIST_DIR)) {
    warn('dist/posts 없음. 먼저 posts:render를 실행하세요.');
    process.exit(0);
  }

  const ssotRaw = readJsonSafe(SSOT_PATH, null);
  const bySlug = normalizeSources(ssotRaw);

  const files = fs.readdirSync(DIST_DIR).filter((f) => f.endsWith('.html'));

  // today 스코프면 대상 slug 집합 로드
  let publishableSet = null;
  if (TARGET_SCOPE === 'today') {
    const pub = loadPublishableSlugsFromToday();
    publishableSet = pub.slugs;

    log('publishable loaded =', pub.loaded);
    log('publishable count  =', publishableSet.size);

    // today 스코프인데 today.json이 비었으면 "0개 처리"가 더 안전
    if (!pub.loaded || publishableSet.size === 0) {
      warn('today scope인데 publishable 비어있음 → 0개 처리로 종료');
      return;
    }
  }

  const targetFiles = (TARGET_SCOPE === 'today')
    ? files.filter((f) => publishableSet.has(path.basename(f, '.html')))
    : files;

  log('HTML files(all)   =', files.length);
  log('HTML files(target)=', targetFiles.length);

  let updated = 0;
  let removed = 0;
  let missingSection = 0;
  let ssotMissing = 0;

  let liveFail = 0;
  let reviewChecked = 0;
  const liveFailSlugs = [];

  for (const f of targetFiles) {
    const slug = path.basename(f, '.html');
    const full = path.join(DIST_DIR, f);

    let html = fs.readFileSync(full, 'utf8');

    const sources = bySlug[slug];
    if (!sources) {
      ssotMissing += 1;

      const r0 = replaceSourcesSection(html, '');
      if (r0.missing) {
        missingSection += 1;
        continue;
      }
      if (r0.changed) {
        fs.writeFileSync(full, r0.html, 'utf8');
        removed += 1;
      }
      continue;
    }

    // 리뷰 3라벨이면 최소 2개 체크(게이트는 soft/strict)
    const labels = loadPostLabels(slug);
    const isReview = labels.some((l) => REVIEW_LABELS.has(l));
    if (isReview) {
      reviewChecked += 1;
      if (sources.length < 2) {
        const msg = `REVIEW sources<2 → slug=${slug} sources=${sources.length}`;
        if (LIVE_MODE) {
          warn('[LIVE]', msg);
          liveFail += 1;
          liveFailSlugs.push(slug);
        } else {
          warn('[TEST]', msg);
        }
      }
    }

    const ulHtml = buildSourcesUlHtml(sources);
    const r = replaceSourcesSection(html, ulHtml);

    if (r.missing) {
      missingSection += 1;
      continue;
    }

    if (r.changed) {
      fs.writeFileSync(full, r.html, 'utf8');
      updated += 1;
    }
  }

  // 리포트 기록(운영 점검용)
  const report = {
    ts: new Date().toISOString(),
    mode: LIVE_MODE ? 'live' : 'test',
    scope: TARGET_SCOPE,
    dryRun: DRY_RUN,
    sourcesStrict: SOURCES_STRICT,
    counts: {
      htmlAll: files.length,
      htmlTarget: targetFiles.length,
      updated,
      removed,
      missingSection,
      ssotMissing,
      reviewChecked,
      reviewSourcesTooFew: liveFail,
    },
    reviewSourcesTooFewSlugs: liveFailSlugs,
  };

  const date = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(LOG_DIR, `inject-sources-report-${date}.json`);
  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    log('report saved =', reportPath);
  } catch (e) {
    warn('report save failed:', e.message || e);
  }

  log(
    'done:',
    `updated=${updated}`,
    `removed=${removed}`,
    `missingSection=${missingSection}`,
    `ssotMissing=${ssotMissing}`,
    `reviewChecked=${reviewChecked}`,
    `reviewSourcesTooFew=${liveFail}`
  );

  // strict 게이트일 때만 중단
  if (LIVE_MODE && SOURCES_STRICT && liveFail > 0) {
    process.exitCode = 1;
  }
}

main();
