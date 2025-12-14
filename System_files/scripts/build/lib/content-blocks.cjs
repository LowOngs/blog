'use strict';

/**
 * content-blocks.cjs
 * - post JSON에서 TL;DR / KeyFacts / Body / FAQ / Sources 를 "표준 형태"로 정규화
 * - 목적: render-posts가 어떤 입력을 받아도 항상 같은 자료형으로 받게 하기
 *
 * 원칙
 * - 비어있으면 빈 배열/빈 문자열로 정리
 * - [object Object]가 나오는 형태(객체 그대로 출력)를 사전에 방지
 * - FAQ/Sources는 string/object 혼용 입력을 모두 받아 표준 구조로 변환
 */

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = typeof v === 'string' ? v : v;
    if (typeof s === 'string') {
      if (s.trim() !== '') return s;
    } else if (Array.isArray(s)) {
      if (s.length) return s;
    } else if (typeof s === 'object') {
      // object는 빈 객체 여부만 판단
      if (Object.keys(s).length) return s;
    } else {
      return s;
    }
  }
  return '';
}

function normalizeTextList(raw) {
  // TL;DR / KeyFacts 용: string | string[] | mixed → string[]
  const out = [];
  for (const item of asArray(raw)) {
    const s = trimStr(item);
    if (!s) continue;
    out.push(s);
  }
  return out;
}

function normalizeFaq(rawFaq) {
  // 허용 입력:
  // - ["Q? A."] 같은 문자열
  // - [{q, a}] / {question, answer} 등
  const out = [];
  for (const item of asArray(rawFaq)) {
    if (!item) continue;

    if (typeof item === 'string') {
      const s = item.trim();
      if (!s) continue;
      // 문자열만 있으면 q=a 로라도 넣어서 [object Object] 방지
      out.push({ q: s, a: s });
      continue;
    }

    if (typeof item === 'object') {
      const q = trimStr(firstNonEmpty(item.q, item.question, item.Q, item.title, ''));
      const a = trimStr(firstNonEmpty(item.a, item.answer, item.A, item.body, ''));
      if (!q || !a) continue;
      out.push({ q, a });
    }
  }
  return out;
}

function normalizeSources(rawSources) {
  // 허용 입력:
  // - ["https://...", "Doc name - https://..."] 같은 문자열
  // - [{label,url,note}] / {name,href} 등
  const out = [];
  for (const item of asArray(rawSources)) {
    if (!item) continue;

    if (typeof item === 'string') {
      const s = item.trim();
      if (!s) continue;
      // url 판별을 강요하지 않고 label로만 유지
      out.push({ label: s, url: '', note: '' });
      continue;
    }

    if (typeof item === 'object') {
      const url = trimStr(item.url || item.href || item.link || '');
      const label = trimStr(firstNonEmpty(item.label, item.name, item.title, url, ''));
      const note = trimStr(item.note || item.desc || item.description || '');
      if (!label && !url) continue;
      out.push({ label: label || url, url, note });
    }
  }
  return out;
}

function normalizeBlocks(postJson) {
  const aio = postJson && typeof postJson.aio === 'object' ? postJson.aio : {};

  // TL;DR / KeyFacts: aio 우선, 없으면 루트 fallback
  const tldrRaw = firstNonEmpty(aio.tldr, postJson.tldr, []);
  const keyfactsRaw = firstNonEmpty(aio.keyfacts, postJson.keyfacts, []);

  // FAQ / Sources: aio 우선, 없으면 루트 fallback
  const faqRaw = firstNonEmpty(aio.faq, postJson.faq, []);
  const sourcesRaw = firstNonEmpty(aio.sources, postJson.sources, []);

  // Body: 루트 body가 정답
  const body = trimStr(postJson.body || '');

  return {
    tldr: normalizeTextList(tldrRaw),
    keyfacts: normalizeTextList(keyfactsRaw),
    body,
    faq: normalizeFaq(faqRaw),
    sources: normalizeSources(sourcesRaw),
  };
}

module.exports = {
  normalizeBlocks,
};
