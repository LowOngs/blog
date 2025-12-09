// System_files/scripts/build/validate-repair.cjs
// 역할:
//  - dist/posts/*.html 을 돌면서
//  - slug와 pageId를 이용해 og:image / twitter:image를
//    {CDN_BASE}/og/{pageId}_{slug}_1200x630.jpg 규칙으로 강제 통일
//  - 나중에 Article/Breadcrumb 스키마, ISO8601 등은 별도 단계에서 추가 보강

const fs = require('fs');
const path = require('path');

const { ensurePageId } = require('./lib/page-ids.cjs');

// ✅ ROOT를 항상 System_files 기준으로 고정
const ROOT = path.resolve(__dirname, '..', '..'); // C:\google-blog\System_files
const DIST_DIR = path.join(ROOT, 'dist', 'posts');

const SITE_BASE = process.env.SITE_BASE || 'https://ongsblog.com';
const CDN_BASE = process.env.CDN_BASE || 'https://ongsblog.com/images';

function listHtmlFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.html'))
    .map((f) => path.join(dir, f));
}

function updateOgAndTwitterImage(html, slugBase) {
  let changed = false;

  // pageId 계산 (test 모드면 항상 page000001, live 모드면 순차 증가)
  const pageId = ensurePageId(slugBase);
  const ogUrl = `${CDN_BASE}/og/${pageId}_${slugBase}_1200x630.jpg`;

  // og:image 교체 또는 삽입
  const ogMetaRegex =
    /<meta\s+property=["']og:image["']\s+content=["'][^"']*["']\s*\/?>/i;

  if (ogMetaRegex.test(html)) {
    html = html.replace(ogMetaRegex, () => {
      changed = true;
      return `<meta property="og:image" content="${ogUrl}">`;
    });
  } else {
    const headCloseIdx = html.toLowerCase().indexOf('</head>');
    if (headCloseIdx !== -1) {
      const insert = `  <meta property="og:image" content="${ogUrl}">\n`;
      html = html.slice(0, headCloseIdx) + insert + html.slice(headCloseIdx);
      changed = true;
    }
  }

  // twitter:image 교체 또는 삽입
  const twMetaRegex =
    /<meta\s+name=["']twitter:image["']\s+content=["'][^"']*["']\s*\/?>/i;

  if (twMetaRegex.test(html)) {
    html = html.replace(twMetaRegex, () => {
      changed = true;
      return `<meta name="twitter:image" content="${ogUrl}">`;
    });
  } else {
    const headCloseIdx = html.toLowerCase().indexOf('</head>');
    if (headCloseIdx !== -1) {
      const insert = `  <meta name="twitter:image" content="${ogUrl}">\n`;
      html = html.slice(0, headCloseIdx) + insert + html.slice(headCloseIdx);
      changed = true;
    }
  }

  return { html, changed, pageId, ogUrl };
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log(
    '[validate] DIST =',
    DIST_DIR,
    '| SITE_BASE =',
    SITE_BASE,
    'CDN_BASE =',
    CDN_BASE
  );

  const files = listHtmlFiles(DIST_DIR);
  let fixedCount = 0;

  for (const file of files) {
    const filename = path.basename(file);
    const slugBase = filename.replace(/\.html$/i, '');

    let html = fs.readFileSync(file, 'utf8');

    const { html: newHtml, changed, pageId, ogUrl } =
      updateOgAndTwitterImage(html, slugBase);

    if (changed) {
      fs.writeFileSync(file, newHtml, 'utf8');
      fixedCount += 1;
      console.log(
        `FIX ${filename} → pageId=${pageId}, og:image=${ogUrl}`
      );
    }
  }

  console.log(
    `✨ validate-repair 완료 — 수정: ${fixedCount}/${files.length}`
  );
}

main();
