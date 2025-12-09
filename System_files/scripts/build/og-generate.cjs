#!/usr/bin/env node
/* og-generate.cjs
 * dist/posts/*.html에서 og:title / article:section / og:image 메타를 읽어
 * 1200x630 카드형 OG 이미지를 자동 생성한다.
 * - 배경: 짙은 네이비(#111827)
 * - 상단 배지: 라벨(카테고리)
 * - 중앙: 제목 2~3줄
 * - 하단: ongsblog.com
 */

const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST_DIR = path.join(ROOT, 'dist', 'posts');
const ASSETS_DIR = path.join(ROOT, 'assets', 'images');

// assets/images/og 디렉토리 보장
fs.mkdirSync(path.join(ASSETS_DIR, 'og'), { recursive: true });

/**
 * 메타 태그에서 값 추출
 * - property="..."/name="..." 순서 뒤바뀜까지 허용
 * - content 먼저 나와도 허용
 */
function extractMeta(html, prop) {
  // 1) property="prop" + content="..."
  let re = new RegExp(
    `<meta[^>]+property=["']${prop}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    'i',
  );
  let m = html.match(re);
  if (m) return m[1].trim();

  // 2) name="prop" + content="..."
  re = new RegExp(
    `<meta[^>]+name=["']${prop}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    'i',
  );
  m = html.match(re);
  if (m) return m[1].trim();

  // 3) content="..." + (property|name)="prop" (역순)
  re = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]*(property|name)=["']${prop}["'][^>]*>`,
    'i',
  );
  m = html.match(re);
  if (m) return m[1].trim();

  // 4) 마지막 fallback: 태그 안에 prop 문자열이 있고 content="..."가 있으면 사용
  re = new RegExp(
    `<meta[^>]+${prop.replace(
      /[-:]/g,
      (c) => '\\' + c,
    )}[^>]*content=["']([^"']+)["'][^>]*>`,
    'i',
  );
  m = html.match(re);
  if (m) return m[1].trim();

  return null;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function labelFromSection(section) {
  if (!section) return 'Ongs Blog';

  const s = section.toLowerCase();
  if (s.includes('conquer')) return 'HOW-TO PLAYBOOKS';
  if (s.includes('smart') || s.includes('choice')) return 'SMART SAVINGS';
  if (s.includes('review')) return 'REVIEWS & GUIDES';
  if (s.includes('playbook')) return 'TEMPLATES & CHECKLISTS';

  return section;
}

function splitTitleLines(title) {
  if (!title) return ['Untitled'];

  const maxLen = 32; // 한 줄 최대 글자수(대략)
  const words = title.split(/\s+/);
  const lines = [];
  let current = '';

  for (const w of words) {
    const next = current ? current + ' ' + w : w;
    if (next.length > maxLen && current) {
      lines.push(current);
      current = w;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);

  // 최대 3줄까지만 사용
  return lines.slice(0, 3);
}

async function generateOgImage(destPath, section, title) {
  // 이미 파일이 있으면 건너뜀 (수동/기존 이미지 보호)
  if (fs.existsSync(destPath)) {
    console.log(`[og-generate] SKIP (이미 존재): ${path.basename(destPath)}`);
    return false;
  }

  const width = 1200;
  const height = 630;

  const labelText = labelFromSection(section);
  const titleLines = splitTitleLines(title);

  const svg = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style type="text/css">
      <![CDATA[
        .bg { fill: #111827; }
        .badge { fill: #f97316; }
        .badge-text {
          fill: #ffffff;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 26px;
          font-weight: 600;
        }
        .title {
          fill: #ffffff;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 40px;
          font-weight: 700;
        }
        .brand {
          fill: #9ca3af;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 24px;
          font-weight: 500;
        }
      ]]>
    </style>
  </defs>
  <rect class="bg" x="0" y="0" width="${width}" height="${height}" rx="32" />

  <!-- 상단 라벨 배지 -->
  <rect class="badge" x="60" y="70" width="540" height="56" rx="12" />
  <text class="badge-text" x="80" y="108">${escapeHtml(labelText)}</text>

  <!-- 제목(최대 3줄) -->
  ${titleLines
    .map((line, idx) => {
      const y = 220 + idx * 60;
      return `<text class="title" x="60" y="${y}">${escapeHtml(line)}</text>`;
    })
    .join('\n  ')}

  <!-- 하단 브랜드 -->
  <text class="brand" x="60" y="${height - 60}">ongsblog.com</text>
</svg>
`;

  const svgBuffer = Buffer.from(svg);
  const image = sharp(svgBuffer);

  // JPG 생성 (현재 og:image가 .jpg를 바라보고 있음)
  await image.jpeg({ quality: 82, chromaSubsampling: '4:4:4' }).toFile(destPath);

  console.log(`[og-generate] CREATED: ${path.basename(destPath)}`);
  return true;
}

async function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error(`[og-generate] dist/posts 폴더가 없습니다: ${DIST_DIR}`);
    process.exit(1);
  }

  const files = fg.sync('*.html', { cwd: DIST_DIR, onlyFiles: true });
  if (!files.length) {
    console.log('[og-generate] 대상 HTML이 없습니다.');
    return;
  }

  let created = 0;

  for (const file of files) {
    const full = path.join(DIST_DIR, file);
    const html = fs.readFileSync(full, 'utf8');

    const ogImageUrl = extractMeta(html, 'og:image');
    const ogTitle = extractMeta(html, 'og:title');
    const section = extractMeta(html, 'article:section');

    if (!ogImageUrl) {
      console.warn(`[og-generate] og:image 없음, 건너뜀: ${file}`);
      continue;
    }

    let relPath;
    try {
      const u = new URL(ogImageUrl);
      // /images/og/... 형태만 처리
      if (!u.pathname.includes('/images/og/')) {
        console.warn(
          `[og-generate] og:image 경로가 /images/og/가 아님, 건너뜀: ${ogImageUrl}`,
        );
        continue;
      }
      // /images/ 이후만 상대 경로로 사용: og/...
      relPath = u.pathname.replace(/^\/?images\//, '');
    } catch (e) {
      console.warn(
        `[og-generate] og:image URL 파싱 실패, 건너뜀: ${ogImageUrl} (${e.message})`,
      );
      continue;
    }

    const destPath = path.join(ASSETS_DIR, relPath); // assets/images/og/...
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const made = await generateOgImage(destPath, section, ogTitle);
    if (made) created++;
  }

  console.log('────────────────────────────────────────────');
  console.log(`[og-generate] 완료: created=${created}, total=${files.length}`);
  console.log('────────────────────────────────────────────');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[og-generate] 치명적 오류:', err);
    process.exit(1);
  });
}
