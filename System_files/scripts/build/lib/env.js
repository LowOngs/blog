import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// System_files 루트
const ROOT = path.resolve(__dirname, "../../");

// 1순위: System_files/.env, 2순위: 상위 폴더/.env, 마지막으로 기본 동작
const envCandidates = [
  path.join(ROOT, ".env"),
  path.resolve(ROOT, "..", ".env"),
];

let loaded = false;
for (const p of envCandidates) {
  if (!loaded && require("fs").existsSync(p)) {
    dotenv.config({ path: p });
    loaded = true;
  }
}
if (!loaded) {
  dotenv.config();
}

export const PATHS = {
  ROOT,
  POSTS_DIR: path.join(ROOT, process.env.POSTS_DIR || "content/posts"),
  TEMPLATE_PATH: path.join(ROOT, "templates/post.html"),
  OUTPUT_DIR: path.join(ROOT, "dist/posts"),
};

// SITE/CDN 기본값 정규화
const rawSiteBase =
  process.env.SITE_BASE ||
  process.env.CANONICAL_BASE ||
  "https://ongsblog.com";

const SITE_BASE = rawSiteBase.replace(/\/+$/, "");

const rawCdnBase = (process.env.CDN_BASE || `${SITE_BASE}/images`).replace(
  /\/+$/,
  ""
);

export const ENV = {
  SITE_BASE,
  CDN_BASE: rawCdnBase,
  SITE_NAME: process.env.SITE_NAME || "Ongs Blog",
  ARTICLE_AUTHOR: process.env.ARTICLE_AUTHOR || "Ongs",
  PUBLISHER_NAME: process.env.PUBLISHER_NAME || "Ongs Blog",
};