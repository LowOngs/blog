import { esc } from "./escape.js";

/**
 * TL;DR용: 순수 <ul> 내부만 생성
 * - 템플릿: <section class="tldr"> {{tldr}} </section>
 */
export const listToUl = (arr) =>
  Array.isArray(arr) && arr.length
    ? `<ul>${arr.map(x => `<li>${esc(String(x))}</li>`).join("")}</ul>`
    : "";

/**
 * Key Facts용: 순수 <ul>만 생성
 * - 템플릿: <section class="keyfacts"> {{keyfacts}} </section>
 */
export const keyFactsToHtml = (facts) =>
  Array.isArray(facts) && facts.length
    ? `<ul>${facts.map(x => `<li>${esc(String(x))}</li>`).join("")}</ul>`
    : "";

/**
 * FAQ용: <p> 블록들만 생성
 * - 템플릿: <section class="faq"><h3>FAQ</h3> {{faq}} </section>
 */
export const faqToHtml = (faq) =>
  Array.isArray(faq) && faq.length
    ? faq
        .map(
          (f) =>
            `<p><b>${esc(f.q || "")}</b><br>${esc(f.a || "")}</p>`
        )
        .join("")
    : "";

/**
 * Sources용: 순수 <ul>만 생성
 * - 템플릿: <section id="sources" class="sources"><h3>Sources</h3> {{sources}} </section>
 */
export const sourcesToHtml = (src) =>
  Array.isArray(src) && src.length
    ? `<ul>${src
        .map(
          (s) =>
            `<li><a href="${esc(s.url || "#")}" target="_blank" rel="nofollow noopener">${esc(
              s.name || s.url || "source"
            )}</a></li>`
        )
        .join("")}</ul>`
    : "";

/**
 * 본문: 이미 HTML인 필드 우선 사용
 */
export const bodyFrom = (data) =>
  data.body_html || data.body || data.content || "";

/**
 * 출력 파일명
 */
export const outName = (data, baseNoExt) =>
  (data.slug ? String(data.slug) : baseNoExt).replace(/\.html$/i, "");
