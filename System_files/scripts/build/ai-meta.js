
// scripts/build/ai-meta.js
// 각 post JSON에 AIO + SEO 메타 필드를 자동 삽입합니다.

import fs from "fs";
import path from "path";
import fg from "fast-glob";

const POSTS_DIR = "content/posts";

function generateMeta(post) {
  const title = post.title || "Untitled";
  const summary = post.summary || post.content?.slice(0, 80) || "";
  const slug = post.slug || title.toLowerCase().replace(/\s+/g, "-");

  const tldr = post.tldr || [title, "핵심 요약", "핵심 포인트"];
  const keyFacts = [
    `${title}는(은) 주요 기능을 쉽게 다룰 수 있는 방법을 제공합니다.`,
    "공식 문서와 지원 페이지 링크를 포함합니다."
  ];

  const sources = post.sources || [
    { name: "공식 문서", url: "https://example.com" }
  ];

  const faq = post.faq || [
    { q: `${title} 관련 자주 묻는 질문`, a: "본문에서 답변을 확인하세요." }
  ];

  return {
    title: `${title} - Ongs Blog`,
    description: summary,
    aio: {
      tldr,
      keyFacts,
      sources,
      faq
    },
    og: {
      type: "article",
      image: `https://cdn.ongsblog.com/images/${slug}_cover.jpg`
    },
    schema: {
      "@context": "https://schema.org",
      "@type": "Article",
      "headline": title,
      "description": summary,
      "author": { "@type": "Person", "name": "Ongs" },
      "datePublished": post.updated_at || new Date().toISOString(),
      "mainEntityOfPage": `https://ongsblog.com/${slug}`
    }
  };
}

async function main() {
  const files = await fg([`${POSTS_DIR}/**/*.json`]);
  let updated = 0;

  for (const file of files) {
    const raw = await fs.promises.readFile(file, "utf8");
    const post = JSON.parse(raw);
    if (!post.meta) post.meta = {};

    const newMeta = generateMeta(post);
    post.meta = { ...post.meta, ...newMeta };

    await fs.promises.writeFile(file, JSON.stringify(post, null, 2), "utf8");
    console.log(`✔️ meta inserted → ${path.basename(file)}`);
    updated++;
  }

  console.log(`✅ AIO+SEO meta complete. (${updated} files updated)`);
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
