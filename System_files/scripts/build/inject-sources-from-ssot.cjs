// System_files/scripts/build/inject-sources-from-ssot.cjs
// dist/posts/*.html 의 <section id="sources">...</section>을 SSOT로 교체/정리
// - SSOT: content/reviews/review-sources.json
// - 빈 <ul> 노출 방지(섹션 제거)
// - 리뷰 3라벨(app/device/subscription)에서 sources < 2면 live에서 실패 처리

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const SSOT_PATH = path.join(ROOT, 'content', 'reviews', 'review-sources.json');

const REVIEW_LABELS = new Set([
  'app-reviews',
  'device-reviews',
  'subscription-services'
]);

function log(...a) {
  console.log('[inject-sources]', ...a);
}

function warn(...a) {
  console.warn('[inject-sources][WARN]', ...a);
}

function isLiveMode() {
  // 원칙: DRY_RUN=false면 live 취급
  const v = String(process.env.DRY_RUN ?? 'true').toLowerCase().trim();
  return v === 'false' || v === '0';
}

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

function normalizeSources(raw) {
  // 지원 형태:
  // 1) { bySlug: { slug: [ {url,label,note}, ... ] } }
  // 2) { slug: [ ... ] }  (bySlug 없이)
  // 3) [ { slug, sources:[...] }, ... ]
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

    // bySlug 없는 단순 맵
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
      // 문자열이면 label=url로 처리
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

  // url 없는 항목은 링크로 만들 수 없으니 제거(혹은 그냥 텍스트로 만들 수도 있는데, 지금은 신뢰/형식 통일이 우선)
  return out.filter(x => x.url && x.label);
}

function buildSourcesUlHtml(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return '';

  const items = sources.map(s => {
    const url = escapeAttr(s.url);
    const label = escapeHtml(s.label || s.url);
    const note = s.note ? ` — ${escapeHtml(s.note)}` : '';
    return `<li><a href="${url}" target="_blank" rel="nofollow noopener noreferrer">${label}</a>${note}</li>`;
  });

  return `<ul>\n${items.join('\n')}\n</ul>`;
}

function replaceSourcesSection(html, newUlHtml) {
  // <section id="sources" ...> ... </section> 통째로 교체/제거
  const sectionRe = /<section\b[^>]*\bid=["']sources["'][^>]*>[\s\S]*?<\/section>/i;

  if (!sectionRe.test(html)) {
    return { html, changed: false, missing: true };
  }

  if (!newUlHtml) {
    // 섹션 자체 제거(빈 배열 노출 방지)
    const replaced = html.replace(sectionRe, '');
    return { html: replaced, changed: true, removed: true };
  }

  const rebuilt = [
    '<section id="sources" class="sources">',
    '  <h3>Sources</h3>',
    `  ${newUlHtml.replace(/\n/g, '\n  ')}`,
    '</section>'
  ].join('\n');

  const replaced = html.replace(sectionRe, rebuilt);
  return { html: replaced, changed: true, removed: false };
}

function loadPostLabels(slug) {
  // content/posts/{slug}.json 기준으로 라벨 확인
  const p = path.join(POSTS_DIR, `${slug}.json`);
  const j = readJsonSafe(p, null);
  if (!j) return [];
  const labels = Array.isArray(j.labels) ? j.labels : (j.label ? [j.label] : []);
  return labels.filter(Boolean);
}

function main() {
  log('ROOT =', ROOT);
  log('DIST =', DIST_DIR);
  log('SSOT =', SSOT_PATH);
  log('MODE =', isLiveMode() ? 'live' : 'test(no_live)');

  if (!fs.existsSync(DIST_DIR)) {
    warn('dist/posts 없음. 먼저 posts:render를 실행하세요.');
    process.exit(0);
  }

  const ssotRaw = readJsonSafe(SSOT_PATH, null);
  const bySlug = normalizeSources(ssotRaw);

  const files = fs.readdirSync(DIST_DIR).filter(f => f.endsWith('.html'));
  log('HTML files =', files.length);

  let updated = 0;
  let removed = 0;
  let missingSection = 0;
  let ssotMissing = 0;

  let liveFail = 0;
  let reviewChecked = 0;

  for (const f of files) {
    const slug = path.basename(f, '.html');
    const full = path.join(DIST_DIR, f);

    let html = fs.readFileSync(full, 'utf8');

    const sources = bySlug[slug];
    if (!sources) {
      ssotMissing += 1;
      // SSOT에 없으면 "빈 섹션 제거"만이라도 수행(현재 빈 ul 노출 방지)
      const r0 = replaceSourcesSection(html, '');
      if (r0.missing) {
        missingSection += 1;
        continue;
      }
      if (r0.changed) {
        html = r0.html;
        fs.writeFileSync(full, html, 'utf8');
        removed += 1;
      }
      continue;
    }

    // 리뷰 3라벨이면 최소 2개 강제
    const labels = loadPostLabels(slug);
    const isReview = labels.some(l => REVIEW_LABELS.has(l));
    if (isReview) {
      reviewChecked += 1;
      if (sources.length < 2) {
        const msg = `REVIEW sources<2 → slug=${slug} sources=${sources.length}`;
        if (isLiveMode()) {
          warn('[LIVE-FAIL]', msg);
          liveFail += 1;
          // 그래도 HTML은 "있는 만큼" 넣어서 사람이 확인 가능하게 유지
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

  log('done:', `updated=${updated}`, `removed=${removed}`, `missingSection=${missingSection}`, `ssotMissing=${ssotMissing}`, `reviewChecked=${reviewChecked}`, `liveFail=${liveFail}`);

  if (isLiveMode() && liveFail > 0) {
    // live에서는 “소스 부족 리뷰글” 발행 금지
    process.exitCode = 1;
  }
}

main();
