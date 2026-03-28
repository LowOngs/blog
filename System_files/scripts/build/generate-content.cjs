#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/generate-content.cjs
 *
 * 역할:
 * - generate-body가 만든 H2 스켈레톤 유지
 * - <!-- content --> 부분만 "구글 기준서 기반 본문"으로 치환
 *
 * 절대 규칙:
 * 1) H2 구조 변경 금지
 * 2) 순서 변경 금지
 * 3) section 추가/삭제 금지
 * 4) <!-- content -->만 교체
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.cwd(), 'System_files');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

const WRITE_MODE = String(process.env.CONTENT_WRITE_MODE || 'local').toLowerCase();
const CAN_WRITE = WRITE_MODE === 'local' || WRITE_MODE === 'active';

// ─────────────────────────────────────────────
// 기본 문단 생성 (구글 기준서 적용)
// ─────────────────────────────────────────────
function buildParagraph({ title, label, h2 }) {

  // 공통 톤 (존댓말 + 분석형)
  const base = `
${title}에 대해 ${h2.toLowerCase()} 관점에서 살펴보면, 단순한 정보 나열이 아니라 실제 사용 상황에서 어떤 선택이 더 합리적인지를 중심으로 이해하는 것이 중요합니다. 
특히 이 글에서는 사용 환경과 목적에 따라 달라질 수 있는 조건을 함께 고려하여 설명합니다.
`.trim();

  // 라벨별 전략 분기
  if (label === 'smart-savings') {
    return `
${base}
이 항목에서는 비용 구조와 제한 조건을 함께 비교하면서 어떤 선택이 실제로 더 효율적인지 판단하는 기준을 제공합니다. 
단순히 가격만 보는 것이 아니라, 장기적인 유지 비용과 숨겨진 제한까지 함께 고려해야 합니다.
`.trim();
  }

  if (label === 'how-to-playbooks') {
    return `
${base}
이 단계에서는 실제 실행 과정에서 문제가 발생하지 않도록 사전 조건과 순서를 함께 설명합니다. 
특히 환경 설정이나 버전에 따라 결과가 달라질 수 있기 때문에, 반드시 현재 상태를 먼저 확인하는 것이 중요합니다.
`.trim();
  }

  if (label === 'templates-checklists') {
    return `
${base}
이 구조는 바로 적용할 수 있는 형태로 설계되어 있으며, 실제 상황에서 빠르게 사용할 수 있도록 구성되어 있습니다. 
각 항목은 실수 방지와 실행 효율을 동시에 고려하여 정리되었습니다.
`.trim();
  }

  // 리뷰 계열
  return `
${base}
실제 사용 관점에서 중요한 요소는 기능 자체보다, 얼마나 안정적으로 유지되고 지속적으로 개선되는지입니다. 
단기적인 성능뿐 아니라 장기적인 활용 가능성까지 함께 고려하는 것이 필요합니다.
`.trim();
}

// ─────────────────────────────────────────────
// body 치환
// ─────────────────────────────────────────────
function injectContent(post) {
  let body = post.body;
  if (!body.includes('<!-- content -->')) return body;

  const label = (post.seedMeta && post.seedMeta.label) || post.label || '';
  const title = post.title || '';

  // H2 단위로 분리
  const parts = body.split(/(<h2>.*?<\/h2>)/g);

  let result = '';

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    // H2 제목
    if (part.startsWith('<h2>')) {
      const h2 = part.replace(/<\/?h2>/g, '');
      const next = parts[i + 1] || '';

      if (next.includes('<!-- content -->')) {
        const content = buildParagraph({ title, label, h2 });

        result += part + '\n<p>' + content + '</p>';
        i++; // 다음 skip
      } else {
        result += part;
      }
    } else {
      result += part;
    }
  }

  return result;
}

// ─────────────────────────────────────────────
// main
// ─────────────────────────────────────────────
function main() {

  if (!fs.existsSync(POSTS_DIR)) {
    console.log('[generate-content] posts 없음');
    return;
  }

  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'));

  let updated = 0;

  for (const file of files) {
    const full = path.join(POSTS_DIR, file);
    const post = JSON.parse(fs.readFileSync(full, 'utf8'));

    if (!post.body || !post.body.includes('<!-- content -->')) {
      console.log(`[SKIP] ${post.slug} — content 이미 존재`);
      continue;
    }

    const newBody = injectContent(post);
    post.body = newBody;

    if (CAN_WRITE) {
      fs.writeFileSync(full, JSON.stringify(post, null, 2));
      console.log(`[OK] ${post.slug} — content 생성 완료`);
      updated++;
    } else {
      console.log(`[DRY] ${post.slug}`);
    }
  }

  console.log('────────────────────────────────────────────');
  console.log('[generate-content] 완료:', updated);
}

main();
