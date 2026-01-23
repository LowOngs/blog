// System_files/scripts/build/ai-meta.js
// 역할: content/posts/*.json 에 "AIO + SEO 메타(특히 OG)" 필드를 자동 보강(upsert)합니다.
// 주의: slug/pageId를 임의 생성하지 않습니다(기존 SSOT를 존중).
// OG 이미지 URL은 AOIA 규칙( pageId + slug + 1200x630 )에 맞춰 "실제 경로"로 타게팅합니다.

import fs from "fs";
import path from "path";
import fg from "fast-glob";

const ROOT = process.cwd(); // ✅ workflow/로컬 모두: working-directory=System_files 기준
const POSTS_DIR = path.join(ROOT, "content", "posts");

/** 문자열 안전 처리(메타 필드 저장용) */
function asString(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

/** https://... 형태로 끝 슬래시 제거 */
function normalizeBase(url, fallback) {
  const raw = asString(url || "").trim() || fallback;
  return raw.replace(/\/+$/, "");
}

/** CANONICAL_BASE / CDN_BASE 추출 (env 우선) */
function resolveBases() {
  const siteBase = normalizeBase(
    process.env.CANONICAL_BASE || process.env.SITE_BASE,
    "https://ongsblog.com"
  );

  // CDN_BASE는 프로젝트에서 "images 베이스"로 쓰는 관례가 있으므로 기본값은 siteBase + "/images"
  const cdnBase = normalizeBase(
    process.env.CDN_BASE,
    siteBase + "/images"
  );

  return { siteBase, cdnBase };
}

/** postJson에서 slug/pageId를 "존재하는 값만" 사용 */
function resolveIdentity(post) {
  const slug =
    asString(post.slug).trim() ||
    asString(post?.seedMeta?.slug).trim() ||
    "";

  const pageId =
    asString(post.pageId).trim() ||
    asString(post.page_id).trim() ||
    asString(post?.seedMeta?.pageId).trim() ||
    "";

  return { slug, pageId };
}

/** OG 이미지 URL 생성(프로젝트 규칙) */
function buildOgImageUrl({ cdnBase, slug, pageId }) {
  if (!slug || !pageId) return "";
  // 예: https://ongsblog.com/images/og/page000001_app-20251207-001_1200x630.jpg
  return `${cdnBase}/og/${pageId}_${slug}_1200x630.jpg`;
}

/** AIO 블록 보강(없을 때만 최소 생성, 기존 값 우선 보존) */
function buildAioBlock(post) {
  const title = asString(post.title).trim() || "Untitled";
  const desc =
    asString(post.description).trim() ||
    asString(post.summary).trim() ||
    asString(post.excerpt).trim() ||
    "";

  // 기존 값이 있으면 존중
  const existingAio = (post.aio && typeof post.aio === "object") ? post.aio : {};
  const tldr = Array.isArray(existingAio.tldr) ? existingAio.tldr : (Array.isArray(post.tldr) ? post.tldr : []);
  const keyfacts = Array.isArray(existingAio.keyfacts) ? existingAio.keyfacts : (Array.isArray(post.keyfacts) ? post.keyfacts : []);
  const faq = Array.isArray(existingAio.faq) ? existingAio.faq : (Array.isArray(post.faq) ? post.faq : []);
  const sources = Array.isArray(existingAio.sources) ? existingAio.sources : (Array.isArray(post.sources) ? post.sources : []);

  // 정말 아무것도 없을 때만 “최소치”를 채움(임의 URL/임의 소스는 넣지 않음)
  const safeTldr = tldr.length ? tldr : [title];
  const safeKeyfacts = keyfacts.length ? keyfacts : (desc ? [desc] : []);
  const safeFaq = faq;
  const safeSources = sources;

  return {
    tldr: safeTldr,
    keyfacts: safeKeyfacts,
    faq: safeFaq,
    sources: safeSources,
  };
}

/** meta.og/meta.twitter/meta.schema를 "실제 값 기반"으로 upsert */
function buildMetaBlock(post, bases, identity) {
  const title = asString(post.title).trim() || identity.slug || "Untitled";
  const description =
    asString(post.description).trim() ||
    asString(post.summary).trim() ||
    asString(post.excerpt).trim() ||
    "";

  const canonical = identity.slug ? `${bases.siteBase}/${identity.slug}` : "";

  const ogImage = buildOgImageUrl({
    cdnBase: bases.cdnBase,
    slug: identity.slug,
    pageId: identity.pageId,
  });

  // meta 객체는 “우리 파일 내부” 표준 키로만 저장(다른 모듈이 읽을 수도 있으니 일관 유지)
  const existingMeta = (post.meta && typeof post.meta === "object") ? post.meta : {};

  const og = (existingMeta.og && typeof existingMeta.og === "object") ? existingMeta.og : {};
  const twitter = (existingMeta.twitter && typeof existingMeta.twitter === "object") ? existingMeta.twitter : {};
  const schema = (existingMeta.schema && typeof existingMeta.schema === "object") ? existingMeta.schema : {};

  const nextOg = {
    ...og,
    type: og.type || "article",
    url: canonical || og.url || "",
    title: og.title || title,
    description: og.description || description,
    image: og.image || ogImage,          // ✅ 실제 OG 파일 규칙으로 타게팅
    imageAlt: og.imageAlt || description || title,
    imageWidth: og.imageWidth || 1200,
    imageHeight: og.imageHeight || 630,
  };

  const nextTwitter = {
    ...twitter,
    card: twitter.card || "summary_large_image",
    title: twitter.title || nextOg.title,
    description: twitter.description || nextOg.description,
    image: twitter.image || nextOg.image,
    imageAlt: twitter.imageAlt || nextOg.imageAlt,
  };

  // schema는 “임의 생성” 대신, 기존 값 존중 + 없을 때만 최소치
  const nextSchema = Object.keys(schema).length
    ? schema
    : {
        "@context": "https://schema.org",
        "@type": "Article",
        headline: title,
        description: description,
        mainEntityOfPage: canonical || "",
      };

  return {
    ...existingMeta,
    canonical: existingMeta.canonical || canonical,
    og: nextOg,
    twitter: nextTwitter,
    schema: nextSchema,
  };
}

async function main() {
  const bases = resolveBases();

  const files = await fg([path.join(POSTS_DIR, "*.json")]);
  let updated = 0;
  let skipped = 0;

  for (const file of files) {
    const raw = await fs.promises.readFile(file, "utf8");
    const post = JSON.parse(raw);

    const identity = resolveIdentity(post);

    // slug/pageId 없으면 "임의 생성"하지 않고 스킵(오염 방지)
    if (!identity.slug || !identity.pageId) {
      skipped++;
      continue;
    }

    // AIO 보강(없을 때만 최소)
    const aio = buildAioBlock(post);

    // meta 보강(실제 값 기반)
    const meta = buildMetaBlock(post, bases, identity);

    post.aio = aio;
    post.meta = meta;

    await fs.promises.writeFile(file, JSON.stringify(post, null, 2), "utf8");
    updated++;
  }

  console.log(`✅ ai-meta: updated=${updated}, skipped(no slug/pageId)=${skipped}`);
}

main().catch((err) => {
  console.error("❌ ai-meta error:", err);
  process.exit(1);
});
