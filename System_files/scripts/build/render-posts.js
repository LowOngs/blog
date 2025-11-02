// scripts/build/render-posts.js
// 렌더: content/posts/*.json → System_files/dist/posts/*.html
// 템플릿 슬롯:
//  - <!--TITLE-->, <!--SUMMARY-->, <!--UPDATED_ISO-->, <!--CANONICAL_URL-->, <!--OG_IMAGE-->
//  - <!--SCHEMA-->, <!--SLOT:PAGE_BADGE-->, <!--TLDR-->, <!--BODY-->, <!--FAQ-->, <!--SOURCES-->

import fs from "fs";
import path from "path";
import fg from "fast-glob";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, "../../"); // System_files/
const POSTS_DIR = path.join(ROOT, process.env.POSTS_DIR || "content/posts");
const TEMPLATE_PATH = path.join(ROOT, "templates/post.html");
const OUTPUT_DIR = path.join(ROOT, "dist/posts");

const read = (p) => fs.readFileSync(p, "utf8");
const write = (p, c) => fs.writeFileSync(p, c, "utf8");
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });

// 안전 이스케이프(메타/속성용)
const esc = (s = "") =>
  String(s).replace(/[&<>"]/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[m]));
const toJsonLd = (obj) => { try { return JSON.stringify(obj); } catch { return "{}"; } };

// 템플릿 체크
if (!fs.existsSync(TEMPLATE_PATH)) {
  console.error(`❌ 템플릿을 찾을 수 없습니다: ${TEMPLATE_PATH}`);
  process.exit(1);
}
const template = read(TEMPLATE_PATH);

// 출력 폴더 준비
ensureDir(OUTPUT_DIR);

// 포스트 수집
const files = fg.sync("*.json", { cwd: POSTS_DIR, onlyFiles: true });
if (files.length === 0) {
  console.warn("⚠️  렌더링할 포스트(JSON)가 없습니다. content/posts 폴더 확인.");
  process.exit(0);
}

// 유틸: 블록 변환
const listToUl = (arr) =>
  Array.isArray(arr) && arr.length ? `<section class="tldr"><ul>${arr.map(x=>`<li>${esc(String(x))}</li>`).join("")}</ul></section>` : "";

const faqToHtml = (faq) =>
  Array.isArray(faq) && faq.length
    ? `<section class="faq"><h3>FAQ</h3>${faq.map(f=>`<p><b>${esc(f.q||"")}</b><br>${esc(f.a||"")}</p>`).join("")}</section>` : "";

const sourcesToHtml = (src) =>
  Array.isArray(src) && src.length
    ? `<section class="sources"><h3>Sources</h3><ul>${src.map(s=>`<li><a href="${esc(s.url||"#")}" target="_blank" rel="nofollow noopener">${esc(s.name||s.url||"source")}</a></li>`).join("")}</ul></section>` : "";

const bodyFrom = (data) => data.body_html || data.body || data.content || "";
const outName = (data, baseNoExt) => (data.slug ? String(data.slug) : baseNoExt).replace(/\.html$/i, "");

// 렌더 루프
let rendered = 0;
for (const baseName of files) {
  const fullPath = path.join(POSTS_DIR, baseName);
  const data = JSON.parse(read(fullPath));

  // 기본 메타 소스
  const meta = data.meta || {};
  const title = meta.title || data.title || "";
  const summary = meta.description || data.summary || "";

  // URL/이미지/시간
  const siteBase = process.env.SITE_BASE || "https://your-domain.example";
  const slug = outName(data, path.basename(baseName, ".json"));
  const canonicalUrl =
  data.canonical_url ||
  (meta && meta.canonical) ||
  siteBase;  // 퍼머링크 모르면 안전하게 홈 도메인

  const cdnBase = (process.env.CDN_BASE || "").replace(/\/+$/,"");
  const ogImage = meta?.og?.image || data.og_image || (cdnBase ? `${cdnBase}/og/default_1200x630.jpg` : "");
  const updatedIso = data.updated_at || new Date().toISOString();

  // 페이지 배지
  const pageBadge = data.page_id ? `<div class="page-badge" id="pageId">${esc(String(data.page_id))}</div>` : "";

  // TL;DR/FAQ/Sources
  const tldrBlock = listToUl(meta?.aio?.tldr || data.tldr);
  const faqBlock = faqToHtml(meta?.aio?.faq || data.faq);
  const sourcesBlock = sourcesToHtml(meta?.aio?.sources || data.sources);

  // JSON-LD (Article + FAQ 포함)
  const faqItems = (meta?.aio?.faq || data.faq || []).map(f => ({
    "@type":"Question","name": String(f.q||""), "acceptedAnswer": { "@type":"Answer", "text": String(f.a||"") }
  }));
  const schemaJson = {
    "@context":"https://schema.org",
    "@type":"Article",
    "headline": title,
    "description": summary,
    "dateModified": updatedIso,
    "mainEntityOfPage": canonicalUrl,
    ...(faqItems.length ? { "mainEntity": { "@type":"FAQPage", "mainEntity": faqItems } } : {})
  };
  const schemaTag = `<script type="application/ld+json">${toJsonLd(schemaJson)}</script>`;

  // 템플릿 치환
  const html = template
    .replaceAll("<!--TITLE-->", esc(title))
    .replace("<!--SUMMARY-->", esc(summary))
    .replace("<!--UPDATED_ISO-->", esc(updatedIso))
    .replaceAll("<!--CANONICAL_URL-->", esc(canonicalUrl))
    .replaceAll("<!--OG_IMAGE-->", esc(ogImage))
    .replace("<!--SCHEMA-->", schemaTag) // JSON-LD만 주입
    .replace("<!--SLOT:PAGE_BADGE-->", pageBadge)
    .replace("<!--TLDR-->", tldrBlock)
    .replace("<!--BODY-->", bodyFrom(data))
    .replace("<!--FAQ-->", faqBlock)
    .replace("<!--SOURCES-->", sourcesBlock);

  const outFile = path.join(OUTPUT_DIR, `${slug}.html`);
  write(outFile, html);
  console.log(`✔ Rendered: ${path.basename(outFile)}`);
  rendered++;
}

console.log(`✅ 렌더 완료: ${rendered} 파일`);

