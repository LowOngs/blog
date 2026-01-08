'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const TEMPLATE = path.join(ROOT, 'templates', 'about-trust.html');

const DIST_DIR = path.join(ROOT, 'dist');
const OUT_DIR = path.join(DIST_DIR, 'pages');
const OUT_FILE = path.join(OUT_DIR, 'trust.html');

// authority.json 위치는 환경/빌드 상태에 따라 다를 수 있어 2곳을 순서대로 탐색
const AUTH_CANDIDATES = [
  path.join(DIST_DIR, 'ai', 'authority.json'),
  path.join(ROOT, 'ai', 'authority.json'),
];

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function escapeHtml(s) {
  return String(s || '')
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
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in data ? String(data[k]) : ''));
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
    console.error('[trust][FAIL] authority.json missing in candidates:\n- ' + AUTH_CANDIDATES.join('\n- '));
    process.exit(1);
  }

  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  const auth = readJson(authFile);

  const focusTopics = Array.isArray(auth.focusTopics) ? auth.focusTopics : [];
  const claimSentences = Array.isArray(auth.claimSentences) ? auth.claimSentences : [];

  const focusPills = focusTopics.map(t => `<span class="pill">${escapeHtml(t)}</span>`).join('');
  const claimLis = claimSentences.map(s => `<li>${escapeHtml(s)}</li>`).join('\n');

  const canonicalBase = String(auth.canonical || auth.siteUrl || 'https://ongsblog.com').replace(/\/+$/,'');
  const canonical = canonicalBase + '/p/trust.html'; // Blogger "Page" 기본 경로 가정 (나중에 실제 페이지 경로로 바꿔도 됨)

  const html = render(tpl, {
    siteName: escapeHtml(auth.siteName || 'Ongs Blog'),
    tagline: escapeHtml(auth.tagline || ''),
    updateFrequency: escapeHtml(auth.updateFrequency || 'Regular'),
    yearsActive: escapeHtml(String(auth.yearsActive || '')),
    citationsCount: escapeHtml(String(auth.citationsCount || '')),
    trustScore: escapeHtml(String(auth.trustScore || '')),
    lastUpdated: escapeHtml(auth.lastUpdated || ''),
    editorialPolicyURL: escapeHtml(auth.editorialPolicyURL || canonicalBase + '/p/editorial-policy.html'),
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
