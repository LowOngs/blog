'use strict';

/**
 * build-trust-page.cjs
 * Role: authority.json(SSOT) → dist/pages/trust.html 렌더
 * READ: templates/about-trust.html, ROOT/ai/authority.json (우선), dist/ai/authority.json (fallback)
 * WRITE: dist/pages/trust.html
 * Invariants:
 *  - authority.json 값이 0이어도 화면에 그대로 노출되어야 함
 *  - 사람용(trust.html)과 기계판(authority.json) 수치 불일치 금지
 *  - 운영 SSOT는 ROOT 기준 authority.json 이다
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const TEMPLATE = path.join(ROOT, 'templates', 'about-trust.html');

const DIST_DIR = path.join(ROOT, 'dist');
const OUT_DIR = path.join(DIST_DIR, 'pages');
const OUT_FILE = path.join(OUT_DIR, 'trust.html');

// authority.json 후보
// ✅ 운영 SSOT는 ROOT/ai/authority.json 우선
// ✅ dist/ai/authority.json 은 fallback
const AUTH_CANDIDATES = [
  path.join(ROOT, 'ai', 'authority.json'),
  path.join(DIST_DIR, 'ai', 'authority.json'),
];

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');
}

function pickAuthorityFile() {
  for (const p of AUTH_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function render(template, data) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) =>
    k in data ? String(data[k]) : ''
  );
}

(function main(){
  console.log('────────────────────────────────────────────');
  console.log('[trust] ROOT =', ROOT);

  if (!fs.existsSync(TEMPLATE)) {
    console.error('[trust][FAIL] template missing:', TEMPLATE);
    process.exit(1);
  }

  const authFile = pickAuthorityFile();
  if (!authFile) {
    console.error('[trust][FAIL] authority.json missing:\n- ' + AUTH_CANDIDATES.join('\n- '));
    process.exit(1);
  }

  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  const auth = readJson(authFile);

  // 배열 안전 처리
  const focusTopics = Array.isArray(auth.focusTopics) ? auth.focusTopics : [];
  const claimSentences = Array.isArray(auth.claimSentences) ? auth.claimSentences : [];

  const focusPills = focusTopics
    .map(t => `<span class="pill">${escapeHtml(t)}</span>`)
    .join('');

  const claimLis = claimSentences
    .map(s => `<li>${escapeHtml(s)}</li>`)
    .join('\n');

  /* 🔥 수정 1: canonical 정책 통일 (render-posts와 동일) */
  const canonicalBase = String(
    auth.canonical || auth.siteUrl || 'https://ongsblog.com'
  ).replace(/\/+$/,'');

  // 기존: /p/trust.html → 구조 불일치 가능
  const canonical = canonicalBase + '/pages/trust.html';

  /* 🔥 수정 2: 숫자 필드 안전 정규화 (future 대응) */
  const safeNumber = (v) => (v === 0 ? 0 : v ?? '');

  /* 🔥 수정 3: lastUpdated fallback (없을 경우 깨짐 방지) */
  const safeLastUpdated = auth.lastUpdated || '';

  const html = render(tpl, {
    siteName: escapeHtml(auth.siteName || 'Ongs Blog'),
    tagline: escapeHtml(auth.tagline || ''),
    updateFrequency: escapeHtml(auth.updateFrequency || 'Regular'),

    yearsActive: escapeHtml(safeNumber(auth.yearsActive)),
    citationsCount: escapeHtml(safeNumber(auth.citationsCount)),
    trustScore: escapeHtml(safeNumber(auth.trustScore)),

    lastUpdated: escapeHtml(safeLastUpdated),

    editorialPolicyURL: escapeHtml(
      auth.editorialPolicyURL || canonicalBase + '/about.html'
    ),

    focusPills,
    claimSentences: claimLis,
    canonical: escapeHtml(canonical),
  });

  ensureDir(OUT_DIR);
  fs.writeFileSync(OUT_FILE, html, 'utf8');

  console.log('[trust] authority =', authFile);
  console.log('[trust] output    =', OUT_FILE);
  console.log('────────────────────────────────────────────');
})();
