#!/usr/bin/env node
'use strict';

/**
 * ============================================================
 * System_files/scripts/build/validate-content-structure.cjs
 * ============================================================
 *
 * 역할
 * - generate-content.cjs 이후, render 이전 단계에서
 *   content/posts/*.json 의 body 구조/품질을 점검한다.
 *
 * 정책
 * - 무인 파이프라인 특성상 "즉시 중단"보다 "1회 보정 기회"를 우선한다.
 * - 검사 결과가 기준 미달이면:
 *   1) repair request 로그를 생성한다
 *   2) generate-content.cjs 를 1회 재호출한다(보정 모드)
 *   3) 재검사한다
 *   4) 그래도 미달이면 WARN으로 남기고 통과한다
 *
 * 절대 원칙
 * - 이 파일은 본문을 직접 수정하지 않는다
 * - 수정 권한은 generate-content.cjs 에만 있다
 * - 이 파일은 검사 / 요청 / 재검사 / 로그까지만 담당한다
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(process.cwd(), 'System_files');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const LOGS_DIR = path.join(ROOT, 'logs');

const GENERATE_CONTENT_FILE = path.join(ROOT, 'scripts', 'build', 'generate-content.cjs');
const REPAIR_REQUEST_FILE = path.join(LOGS_DIR, 'content-repair-request.json');
const REPORT_FILE = path.join(LOGS_DIR, 'content-structure-report.json');
const TODAY_EXPANDED_FILE = path.join(ROOT, 'dist', 'queue', 'today.expanded.json');

const CONTENT_VALIDATE_MODE_RAW = String(process.env.CONTENT_VALIDATE_MODE || 'latest').trim().toLowerCase();
const CONTENT_VALIDATE_MODE = CONTENT_VALIDATE_MODE_RAW === 'full' ? 'full' : 'latest';

const EXCLUDED_LABELS = new Set(['firstgate']);

const REVIEW_LABELS = new Set([
  'app-reviews',
  'device-reviews',
  'subscription-services',
]);

const FAIL_MIN_TEXT_LENGTH = 600;
const WARN_MIN_TEXT_LENGTH = 1200;

console.log('────────────────────────────────────────────');
console.log('[validate-content-structure] 시작');
console.log('[validate-content-structure] ROOT       =', ROOT);
console.log('[validate-content-structure] POSTS_DIR  =', POSTS_DIR);
console.log('[validate-content-structure] REQUEST    =', REPAIR_REQUEST_FILE);
console.log('[validate-content-structure] REPORT     =', REPORT_FILE);
console.log('[validate-content-structure] MODE       =', CONTENT_VALIDATE_MODE);
console.log('────────────────────────────────────────────');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function normStr(v) {
  return String(v == null ? '' : v).trim();
}

function ensureArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function extractLabel(post) {
  const direct = normStr(post.label);
  if (direct) return direct;

  const labels = ensureArray(post.labels).map(normStr).filter(Boolean);
  if (labels.length === 1) return labels[0];
  if (labels.length > 0) return labels[0];

  const seedLabel = normStr(post.seedMeta && post.seedMeta.label);
  if (seedLabel) return seedLabel;

  return '';
}

function isExcludedLabel(label) {
  return EXCLUDED_LABELS.has(normStr(label));
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countMatches(s, re) {
  const m = String(s || '').match(re);
  return m ? m.length : 0;
}

function parseSections(bodyHtml) {
  const html = String(bodyHtml || '');
  const re = /<h2>(.*?)<\/h2>([\s\S]*?)(?=<h2>|$)/gi;
  const out = [];
  let m;

  while ((m = re.exec(html)) !== null) {
    out.push({
      h2: normStr(m[1]),
      html: normStr(m[2]),
      text: stripHtml(m[2]),
      hasParagraph: /<p\b[^>]*>[\s\S]*?<\/p>/i.test(m[2]),
      hasList: /<(ul|ol)\b[^>]*>[\s\S]*?<\/(ul|ol)>/i.test(m[2]),
      hasTable: /<table\b[^>]*>[\s\S]*?<\/table>/i.test(m[2]),
    });
  }

  return out;
}

function hasPlaceholder(bodyHtml) {
  return /<!--\s*content\s*-->/i.test(String(bodyHtml || ''));
}

function hasRobotPattern(text) {
  return /\b(lorem ipsum|generated content|placeholder|template text|test content)\b/i.test(String(text || ''));
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeBodyText(body) {
  return stripHtml(body)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractClassificationHints(post) {
  const seedMeta = post && post.seedMeta && typeof post.seedMeta === 'object' ? post.seedMeta : {};
  const direct = post && post.classificationHints && typeof post.classificationHints === 'object'
    ? post.classificationHints
    : null;

  return seedMeta.classificationHints || direct || {};
}

function extractMaturityHints(post) {
  const hints = extractClassificationHints(post);

  return hints && hints.maturityHints && typeof hints.maturityHints === 'object'
    ? hints.maturityHints
    : {};
}

function extractEvidence(post) {
  const seedMeta = post && post.seedMeta && typeof post.seedMeta === 'object' ? post.seedMeta : {};
  const direct = post && post.evidence && typeof post.evidence === 'object'
    ? post.evidence
    : null;

  return seedMeta.evidence || direct || {};
}

function extractUnknowns(post) {
  const evidence = extractEvidence(post);
  const seedMeta = post && post.seedMeta && typeof post.seedMeta === 'object' ? post.seedMeta : {};
  const trendContext = seedMeta.trendContext && typeof seedMeta.trendContext === 'object'
    ? seedMeta.trendContext
    : {};

  return [
    ...ensureArray(evidence.unknowns),
    ...ensureArray(trendContext.evidenceUnknowns),
  ]
    .map(normStr)
    .filter(Boolean);
}

function extractMarketStage(post) {
  const maturityHints = extractMaturityHints(post);
  const seedMeta = post && post.seedMeta && typeof post.seedMeta === 'object' ? post.seedMeta : {};
  const trendContext = seedMeta.trendContext && typeof seedMeta.trendContext === 'object'
    ? seedMeta.trendContext
    : {};

  return normStr(
    maturityHints.marketStage ||
    trendContext.marketStage ||
    ''
  );
}

function isEarlyOrUncertainMarketStage(stage) {
  const s = normStr(stage).toLowerCase();

  if (!s) return false;

  return (
    s.includes('concept') ||
    s.includes('prototype') ||
    s.includes('candidate') ||
    s.includes('pre-commercial') ||
    s.includes('unverified')
  );
}

function hasUncertaintySignals(post) {
  const unknowns = extractUnknowns(post);
  const stage = extractMarketStage(post);
  const entity = post && post.entity && typeof post.entity === 'object' ? post.entity : {};
  const reviewEntity = post && post.reviewEntity && typeof post.reviewEntity === 'object' ? post.reviewEntity : {};
  const confidence = normStr(entity.confidence || reviewEntity.confidence).toLowerCase();
  const status = normStr(entity.status || reviewEntity.status).toLowerCase();

  return (
    unknowns.length > 0 ||
    isEarlyOrUncertainMarketStage(stage) ||
    confidence === 'low' ||
    status === 'candidate'
  );
}

function inspectQualityGate(post, label, body, sections) {
  const issues = [];
  const text = normalizeBodyText(body);
  const lower = text.toLowerCase();
  const marketStage = extractMarketStage(post);
  const unknowns = extractUnknowns(post);
  const uncertain = hasUncertaintySignals(post);
  const title = normStr(post && post.title);
  const entityName = normStr(
    post &&
    post.entity &&
    post.entity.name
  ) || normStr(
    post &&
    post.reviewEntity &&
    post.reviewEntity.name
  );

  const leakagePatterns = [
    {
      code: 'INSTRUCTION_LEAKAGE_SHOULD_BE_READ_AS',
      re: /\bshould be read as\b/i,
      message: '본문에 작성 지시문형 문장(should be read as)이 남아 있음',
    },
    {
      code: 'INSTRUCTION_LEAKAGE_TREATED_HERE_AS',
      re: /\bis treated here as\b/i,
      message: '본문에 작성 지시문형 문장(is treated here as)이 남아 있음',
    },
    {
      code: 'INSTRUCTION_LEAKAGE_THE_GOAL_IS',
      re: /\bthe goal is\b/i,
      message: '본문에 작성 목표 설명문(The goal is)이 남아 있음',
    },
    {
      code: 'INSTRUCTION_LEAKAGE_WRITING_DIRECTION',
      re: /\bwriting direction\b/i,
      message: '본문에 bodyPrompt/guidance 누수 표현이 남아 있음',
    },
    {
      code: 'INSTRUCTION_LEAKAGE_PROMPT_PHRASE',
      re: /\b(write a practical|avoid robotic filler|use natural human explanation|focus on decision context)\b/i,
      message: '본문에 프롬프트 원문 계열 문구가 남아 있음',
    },
  ];

  for (const item of leakagePatterns) {
    if (item.re.test(text)) {
      issues.push({
        level: 'fail',
        code: item.code,
        message: item.message,
      });
    }
  }

  const metaWritingPatterns = [
    {
      code: 'META_WRITING_THIS_ARTICLE',
      re: /\b(this article|the article)\b/i,
      message: '본문이 제품/문제가 아니라 article 자체를 설명하는 문장으로 흐름',
    },
    {
      code: 'META_WRITING_THIS_SECTION',
      re: /\b(this section|the section)\b/i,
      message: '본문이 section 자체를 설명하는 문장으로 흐름',
    },
    {
      code: 'META_WRITING_REVIEW_SHOULD',
      re: /\b(the review should|this review should|a useful review should)\b/i,
      message: '본문이 실제 리뷰가 아니라 리뷰 작성법을 설명하는 문장으로 흐름',
    },
  ];

  for (const item of metaWritingPatterns) {
    if (item.re.test(text)) {
      issues.push({
        level: 'fail',
        code: item.code,
        message: item.message,
      });
    }
  }

  const aiSelfExplanationPatterns = [
    {
      code: 'AI_SELF_EXPLANATION',
      re: /\b(as an ai|i cannot|i do not have access|i don't have access|based on the information provided|as a language model)\b/i,
      message: 'AI 자기설명 또는 한계 고백 문장이 본문에 포함됨',
    },
    {
      code: 'SOURCELESS_CLAIM_FRAME',
      re: /\b(no real-world data is available|without real-world data|there is no information available)\b/i,
      message: '자료 한계를 본문 품질 문장으로 처리하지 못하고 설명문으로 노출함',
    },
  ];

  for (const item of aiSelfExplanationPatterns) {
    if (item.re.test(text)) {
      issues.push({
        level: 'fail',
        code: item.code,
        message: item.message,
      });
    }
  }

  if (REVIEW_LABELS.has(label) && uncertain) {
    const cautionTokens = /\b(if released|if it reaches|would need to|needs proof|verify|verification|conditional|early|concept|prototype|not ready|must be proven|should not treat|still needs)\b/i;
    if (!cautionTokens.test(text)) {
      issues.push({
        level: 'fail',
        code: 'UNCERTAIN_REVIEW_WITHOUT_CAUTION',
        message: '불확실/초기 단계 리뷰인데 조건부·검증형 표현이 부족함',
      });
    }

    const overclaimPatterns = [
      {
        code: 'UNVERIFIED_REAL_USE_CLAIM',
        re: /\b(i used|we tested|hands-on|in our test|during testing|real-world test showed)\b/i,
        message: '실제 사용/테스트 근거가 없는 대상에서 써본 척 표현이 감지됨',
      },
      {
        code: 'UNVERIFIED_SUPERIORITY_CLAIM',
        re: /\b(is better than|performs better than|outperforms|beats|is the best|is a proven replacement|is ready to replace)\b/i,
        message: '불확실 대상에서 우열/대체 가능성을 단정하는 표현이 감지됨',
      },
      {
        code: 'UNVERIFIED_PURCHASE_CLAIM',
        re: /\b(is worth buying|you should buy|buy it|is a safe buy|clear buy recommendation)\b/i,
        message: '불확실 대상에서 구매 권고를 단정하는 표현이 감지됨',
      },
    ];

    for (const item of overclaimPatterns) {
      if (item.re.test(text)) {
        issues.push({
          level: 'fail',
          code: item.code,
          message: item.message,
        });
      }
    }
  }

  if (entityName && title && title.length > 80) {
    const repeatedTitleCount = countMatches(text, new RegExp(escapeRegExp(title), 'gi'));
    const repeatedEntityCount = countMatches(text, new RegExp(escapeRegExp(entityName), 'gi'));

    if (repeatedTitleCount >= 3 && repeatedEntityCount < repeatedTitleCount) {
      issues.push({
        level: 'warn',
        code: 'TITLE_REPETITION_IN_BODY',
        message: '긴 title이 본문에서 반복됨. entity.name 중심 표현 권장',
      });
    }
  }

  if (unknowns.length > 0) {
    const missingUnknownMentions = unknowns
      .filter(item => item.length >= 3)
      .filter(item => !new RegExp(escapeRegExp(item), 'i').test(text));

    if (missingUnknownMentions.length >= Math.min(3, unknowns.length)) {
      issues.push({
        level: 'warn',
        code: 'UNKNOWNS_NOT_REFLECTED',
        message: `unknowns가 본문 판단에 충분히 반영되지 않음: ${missingUnknownMentions.slice(0, 5).join(', ')}`,
      });
    }
  }

  if (REVIEW_LABELS.has(label) && sections.length > 0) {
    const sectionNames = sections.map(s => s.h2);
    const hasVerdict = sectionNames.includes('Verdict');
    const hasBestFor = sectionNames.includes('Best For / Not For');

    if (hasVerdict) {
      const verdict = sections.find(s => s.h2 === 'Verdict');
      if (verdict && uncertain && !/\bconditional|verify|watch|wait|proof|not ready|if it reaches|if released\b/i.test(verdict.text)) {
        issues.push({
          level: 'warn',
          code: 'VERDICT_NOT_CAUTION_AWARE',
          message: '불확실 대상의 Verdict가 조건부 판단을 충분히 드러내지 않음',
        });
      }
    }

    if (hasBestFor) {
      const bestFor = sections.find(s => s.h2 === 'Best For / Not For');
      if (bestFor && !/\bbest for\b/i.test(bestFor.text)) {
        issues.push({
          level: 'warn',
          code: 'BEST_FOR_SECTION_WEAK',
          message: 'Best For / Not For 섹션의 추천/비추천 구분이 약함',
        });
      }
    }
  }

  return issues;
}

function inspectGeneric(slug, body, sections) {
  const issues = [];

  if (!body || !normStr(body)) {
    issues.push({ level: 'fail', code: 'BODY_EMPTY', message: 'body 비어 있음' });
    return issues;
  }

  if (hasPlaceholder(body)) {
    issues.push({ level: 'fail', code: 'PLACEHOLDER_REMAINS', message: '<!-- content --> 잔존' });
  }

  if (!sections.length) {
    issues.push({ level: 'fail', code: 'NO_H2_SECTION', message: 'h2 섹션 없음' });
  }

  for (const sec of sections) {
    if (!sec.hasParagraph && !sec.hasList && !sec.hasTable) {
      issues.push({
        level: 'fail',
        code: 'SECTION_EMPTY',
        message: `섹션 본문 비어 있음: ${sec.h2}`,
      });
    }

    if (!sec.text || sec.text.length < 40) {
      issues.push({
        level: 'warn',
        code: 'SECTION_THIN',
        message: `섹션 텍스트가 매우 짧음: ${sec.h2}`,
      });
    }
  }

  const totalText = stripHtml(body);
  if (totalText.length < FAIL_MIN_TEXT_LENGTH) {
    issues.push({
      level: 'fail',
      code: 'TEXT_TOO_SHORT_FAIL',
      message: `전체 본문 텍스트가 너무 짧음(${totalText.length}자)`,
    });
  } else if (totalText.length < WARN_MIN_TEXT_LENGTH) {
    issues.push({
      level: 'warn',
      code: 'TEXT_TOO_SHORT_WARN',
      message: `전체 본문 텍스트가 권장보다 짧음(${totalText.length}자)`,
    });
  }

  if (hasRobotPattern(totalText)) {
    issues.push({
      level: 'warn',
      code: 'ROBOT_PATTERN',
      message: '기계식/테스트성 패턴 의심',
    });
  }

  return issues;
}

function inspectByLabel(label, sections, body) {
  const issues = [];

  const hasTable = /<table\b[^>]*>[\s\S]*?<\/table>/i.test(body);
  const hasList = /<(ul|ol)\b[^>]*>[\s\S]*?<\/(ul|ol)>/i.test(body);

  if (label === 'smart-savings') {
    if (!hasTable) {
      issues.push({
        level: 'fail',
        code: 'SAVINGS_TABLE_REQUIRED',
        message: 'smart-savings 글에 비교표/테이블 없음',
      });
    }
    if (!hasList) {
      issues.push({
        level: 'fail',
        code: 'SAVINGS_LIST_REQUIRED',
        message: 'smart-savings 글에 절약 팁/리스트 없음',
      });
    }
  }

  if (label === 'how-to-playbooks') {
    if (!hasList) {
      issues.push({
        level: 'fail',
        code: 'HOWTO_LIST_REQUIRED',
        message: 'how-to-playbooks 글에 체크리스트/리스트 없음',
      });
    }
  }

  if (label === 'templates-checklists') {
    if (!hasTable) {
      issues.push({
        level: 'fail',
        code: 'TEMPLATE_TABLE_REQUIRED',
        message: 'templates-checklists 글에 표/양식 없음',
      });
    }
  }

  if (REVIEW_LABELS.has(label)) {
    const h2Names = sections.map(s => s.h2);
    if (!h2Names.includes('Overview')) {
      issues.push({
        level: 'warn',
        code: 'REVIEW_OVERVIEW_MISSING',
        message: '리뷰 글에 Overview 섹션 없음',
      });
    }
    if (!h2Names.includes('Specs & ROI')) {
      issues.push({
        level: 'warn',
        code: 'REVIEW_ROI_MISSING',
        message: '리뷰 글에 Specs & ROI 섹션 없음',
      });
    }
    if (!h2Names.includes('Verdict')) {
      issues.push({
        level: 'warn',
        code: 'REVIEW_VERDICT_MISSING',
        message: '리뷰 글에 Verdict 섹션 없음',
      });
    }
  }

  return issues;
}

function dedupeIssues(issues) {
  const seen = new Set();
  const out = [];
  for (const issue of issues) {
    const key = `${issue.level}|${issue.code}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

function inspectPostFile(fullPath) {
  const post = readJSON(fullPath);
  const slug = normStr(post.slug) || path.basename(fullPath, '.json');
  const label = extractLabel(post);
  const body = String(post.body || '');
  const sections = parseSections(body);

  const genericIssues = inspectGeneric(slug, body, sections);
  const labelIssues = inspectByLabel(label, sections, body);
  const qualityIssues = inspectQualityGate(post, label, body, sections);
  const issues = dedupeIssues([...genericIssues, ...labelIssues, ...qualityIssues]);

  const failCount = issues.filter(x => x.level === 'fail').length;
  const warnCount = issues.filter(x => x.level === 'warn').length;

  return {
    slug,
    label,
    title: normStr(post.title),
    file: fullPath,
    failCount,
    warnCount,
    totalTextLength: stripHtml(body).length,
    h2Count: countMatches(body, /<h2>/gi),
    issues,
  };
}

function writeRepairRequest(items) {
  ensureDir(LOGS_DIR);
  const doc = {
    generatedAt: new Date().toISOString(),
    requestedBy: 'validate-content-structure.cjs',
    mode: 'repair-once',
    validateMode: CONTENT_VALIDATE_MODE,
    items: items.map(x => ({
      slug: x.slug,
      label: x.label,
      failCount: x.failCount,
      warnCount: x.warnCount,
      issues: x.issues,
    })),
  };
  writeJSON(REPAIR_REQUEST_FILE, doc);
}

function rerunGenerateContent(targets) {
  if (!targets.length) return { ok: true, ran: false, code: 0 };

  if (!fs.existsSync(GENERATE_CONTENT_FILE)) {
    return { ok: false, ran: false, code: -1, error: 'generate-content.cjs 없음' };
  }

  const targetSlugs = targets.map(x => x.slug).join(',');

  console.log('────────────────────────────────────────────');
  console.log('[validate-content-structure] repair request 감지 → generate-content 1회 재호출');
  console.log('[validate-content-structure] TARGET_SLUGS =', targetSlugs);
  console.log('────────────────────────────────────────────');

  const res = cp.spawnSync(
    process.execPath,
    [GENERATE_CONTENT_FILE],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        CONTENT_REPAIR_MODE: '1',
        CONTENT_REPAIR_REQUEST_FILE: REPAIR_REQUEST_FILE,
        CONTENT_TARGET_SLUGS: targetSlugs,
      },
    }
  );

  return {
    ok: res.status === 0,
    ran: true,
    code: typeof res.status === 'number' ? res.status : -1,
  };
}

function downgradeRemainingFailsToWarn(reportItems) {
  return reportItems.map(item => {
    const downgradedIssues = item.issues.map(issue => {
      if (issue.level !== 'fail') return issue;
      return {
        ...issue,
        level: 'warn',
        code: `${issue.code}_WARN_AFTER_REPAIR`,
        message: `${issue.message} (1회 보정 후에도 미달 → WARN 통과)`,
      };
    });

    return {
      ...item,
      failCount: 0,
      warnCount: downgradedIssues.filter(x => x.level === 'warn').length,
      issues: downgradedIssues,
      finalStatus: downgradedIssues.length ? 'WARN' : 'PASS',
    };
  });
}

function buildInitialReport(files) {
  return files.map(full => inspectPostFile(full));
}

function loadLatestTargetSlugSet() {
  if (CONTENT_VALIDATE_MODE !== 'latest') return null;
  if (!fs.existsSync(TODAY_EXPANDED_FILE)) return new Set();

  try {
    const doc = readJSON(TODAY_EXPANDED_FILE);
    const items = Array.isArray(doc && doc.items) ? doc.items : [];

    const slugs = items
      .map(item => normStr(item && (item.generatedSlug || item.slug)))
      .filter(Boolean);

    return new Set(slugs);
  } catch {
    return new Set();
  }
}

function shouldIncludeByMode(slug, latestSlugSet) {
  if (CONTENT_VALIDATE_MODE === 'full') return true;
  if (!latestSlugSet) return false;
  return latestSlugSet.has(slug);
}

function main() {
  ensureDir(LOGS_DIR);

  if (!fs.existsSync(POSTS_DIR)) {
    console.log('[validate-content-structure] posts 없음 -> 종료');
    process.exit(0);
  }

  const files = fs.readdirSync(POSTS_DIR)
    .filter(f => f.toLowerCase().endsWith('.json'))
    .map(f => path.join(POSTS_DIR, f))
    .sort();

  console.log('[validate-content-structure] JSON 파일 수 =', files.length);

  const latestSlugSet = loadLatestTargetSlugSet();
  if (CONTENT_VALIDATE_MODE === 'latest') {
    console.log('[validate-content-structure] latest 대상 slug 수 =', latestSlugSet ? latestSlugSet.size : 0);
  }

  const targetFiles = [];
  for (const full of files) {
    let post;
    try {
      post = readJSON(full);
    } catch (e) {
      console.error('[validate-content-structure][WARN] JSON 파싱 실패:', full, e.message);
      continue;
    }

    const label = extractLabel(post);
    if (isExcludedLabel(label)) continue;

    const slug = normStr(post.slug) || path.basename(full, '.json');
    if (!shouldIncludeByMode(slug, latestSlugSet)) continue;

    targetFiles.push(full);
  }

  let firstPass = buildInitialReport(targetFiles);
  const firstFailTargets = firstPass.filter(x => x.failCount > 0);

  let repairResult = { ok: true, ran: false, code: 0 };

  if (firstFailTargets.length > 0) {
    writeRepairRequest(firstFailTargets);
    repairResult = rerunGenerateContent(firstFailTargets);
  }

  let secondPass = buildInitialReport(targetFiles);

  const finalItems = downgradeRemainingFailsToWarn(
    secondPass.map(item => ({
      ...item,
      finalStatus: item.failCount > 0 ? 'FAIL' : (item.warnCount > 0 ? 'WARN' : 'PASS'),
    }))
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    validateMode: CONTENT_VALIDATE_MODE,
    firstPassFailTargets: firstFailTargets.length,
    repairTriggered: repairResult.ran,
    repairOk: repairResult.ok,
    repairExitCode: repairResult.code,
    checked: finalItems.length,
    pass: finalItems.filter(x => x.finalStatus === 'PASS').length,
    warn: finalItems.filter(x => x.finalStatus === 'WARN').length,
    fail: 0,
  };

  writeJSON(REPORT_FILE, {
    summary,
    items: finalItems,
  });

  for (const item of finalItems) {
    console.log(`파일: ${path.basename(item.file)}`);
    console.log(`상태: ${item.finalStatus}`);
    for (const issue of item.issues) {
      console.log(`  - [${issue.level.toUpperCase()}] ${issue.code} → ${issue.message}`);
    }
    if (!item.issues.length) {
      console.log('  - [PASS] 구조 기준 충족');
    }
    console.log('');
  }

  console.log('────────────────────────────────────────────');
  console.log('[validate-content-structure] 결과');
  console.log('  mode    =', summary.validateMode);
  console.log('  checked =', summary.checked);
  console.log('  pass    =', summary.pass);
  console.log('  warn    =', summary.warn);
  console.log('  fail    =', summary.fail);
  console.log('  repair  =', summary.repairTriggered ? `triggered (exit=${summary.repairExitCode})` : 'not-needed');
  console.log(`[validate-content-structure] report saved → ${REPORT_FILE}`);
  console.log('────────────────────────────────────────────');

  process.exitCode = 0;
}

if (require.main === module) main();
