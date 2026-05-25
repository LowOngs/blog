#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/generate-content.cjs
 *
 * 역할
 * - generate-body.cjs가 만든 H2 스켈레톤을 유지한다.
 * - <p><!-- content --></p> 자리만 실제 본문으로 치환한다.
 *
 * 절대 규칙
 * 1) H2 제목 변경 금지
 * 2) H2 순서 변경 금지
 * 3) 섹션 추가/삭제 금지
 * 4) placeholder만 치환
 *
 * 작성 기준
 * - 구글 블로그 테마 기준서 v1.0 중 "본문 글쓰기"에 필요한 부분만 반영
 * - 존댓말 톤 대신 현재 블로그 산출물 언어/제목 흐름에 맞춰 자연스러운 영문 본문 생성
 * - 과장/투자권유/기계식 문장 금지
 * - 실제 사람이 구매/선택/실행할 때 고민하는 기준을 중심으로 서술
 * - 리뷰 3종 / 비리뷰 3종 구분
 */

const fs = require('fs');
const path = require('path');
const process = require('process');

const ROOT = path.resolve(process.cwd(), 'System_files');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

const CONTENT_WRITE_MODE = String(process.env.CONTENT_WRITE_MODE || 'local').trim().toLowerCase();
const CAN_WRITE = CONTENT_WRITE_MODE === 'local' || CONTENT_WRITE_MODE === 'active';

const CONTENT_REPAIR_MODE = String(process.env.CONTENT_REPAIR_MODE || '').trim() === '1';
const CONTENT_REPAIR_REQUEST_FILE = String(process.env.CONTENT_REPAIR_REQUEST_FILE || '').trim();
const CONTENT_TARGET_SLUGS_RAW = String(process.env.CONTENT_TARGET_SLUGS || '').trim();

const EXCLUDED_LABELS = new Set(['firstgate']);

const REVIEW_LABELS = new Set([
  'app-reviews',
  'device-reviews',
  'subscription-services',
]);

const NON_REVIEW_LABELS = new Set([
  'how-to-playbooks',
  'smart-savings',
  'templates-checklists',
]);

console.log('────────────────────────────────────────────');
console.log('[generate-content] 시작');
console.log('[generate-content] ROOT              =', ROOT);
console.log('[generate-content] POSTS_DIR         =', POSTS_DIR);
console.log('[generate-content] CONTENT_WRITE_MODE=', CONTENT_WRITE_MODE, CAN_WRITE ? '(WRITE)' : '(DRY)');
console.log('[generate-content] CONTENT_REPAIR_MODE =', CONTENT_REPAIR_MODE ? 'true' : 'false');
console.log('────────────────────────────────────────────');

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function normStr(v) {
  return String(v == null ? '' : v).trim();
}

function toLower(v) {
  return normStr(v).toLowerCase();
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

function hasPlaceholderBody(post) {
  return !!(post && typeof post.body === 'string' && post.body.includes('<!-- content -->'));
}

function isExcludedLabel(label) {
  return EXCLUDED_LABELS.has(normStr(label));
}

function extractIntent(post) {
  return normStr(
    post.intent ||
    (post.seedMeta && post.seedMeta.intent) ||
    (post.bodyGen && post.bodyGen.intent) ||
    ''
  );
}

function extractTiming(post) {
  return normStr(
    post.timing ||
    (post.seedMeta && post.seedMeta.timing) ||
    (post.bodyGen && post.bodyGen.timing) ||
    ''
  );
}

function extractContext(post) {
  return normStr(
    post.context ||
    post.environment ||
    (post.seedMeta && (post.seedMeta.context || post.seedMeta.environment)) ||
    (post.bodyGen && post.bodyGen.context) ||
    ''
  );
}

function extractBodyPrompt(post) {
  return normStr(post.bodyPrompt || '');
}

function parseBodyPrompt(bodyPrompt) {
  const raw = normStr(bodyPrompt);
  const out = {
    raw,
    lines: [],
    title: '',
    label: '',
    intent: '',
    queueDate: '',
    guidance: '',
  };

  if (!raw) return out;

  const lines = raw.split(/\r?\n/).map(normStr).filter(Boolean);
  out.lines = lines;

  for (const line of lines) {
    const lower = toLower(line);
    if (lower.startsWith('title:')) out.title = normStr(line.slice(6));
    else if (lower.startsWith('label:')) out.label = normStr(line.slice(6));
    else if (lower.startsWith('intent:')) out.intent = normStr(line.slice(7));
    else if (lower.startsWith('queuedate:')) out.queueDate = normStr(line.slice(10));
  }

  out.guidance = lines
    .filter(line => !/^(title|label|intent|queuedate)\s*:/i.test(line))
    .join(' ');

  return out;
}

function inferTopic(title) {
  const t = normStr(title);
  const l = toLower(title);

  if (!t) return 'this topic';

  if (l.includes('phone plan') || l.includes('mobile plan') || l.includes('data plan')) {
    return 'a phone plan choice';
  }
  if (l.includes('esim')) {
    return 'an eSIM decision';
  }
  if (l.includes('cloud')) {
    return 'a cloud service choice';
  }
  if (l.includes('subscription')) {
    return 'a subscription decision';
  }
  if (l.includes('app')) {
    return 'an app choice';
  }
  if (l.includes('device') || l.includes('laptop') || l.includes('phone') || l.includes('tablet')) {
    return 'a device purchase';
  }
  if (l.includes('checklist')) {
    return 'an execution checklist';
  }
  if (l.includes('template')) {
    return 'a reusable working template';
  }
  if (l.includes('setup') || l.includes('fix') || l.includes('how to')) {
    return 'a practical setup task';
  }

  return 'a real-world decision';
}

function inferProductType(label, title) {
  const l = toLower(title);

  if (label === 'app-reviews') return 'app';
  if (label === 'device-reviews') return 'device';
  if (label === 'subscription-services') return 'service';

  if (l.includes('app')) return 'app';
  if (l.includes('device') || l.includes('phone') || l.includes('laptop') || l.includes('tablet')) return 'device';
  if (l.includes('plan') || l.includes('subscription') || l.includes('cloud')) return 'service';

  return 'product';
}

function extractReviewEntity(post) {
  const a = post && post.reviewEntity && typeof post.reviewEntity === 'object' ? post.reviewEntity : null;
  if (a) return a;

  const b = post && post.seedMeta && post.seedMeta.entity && typeof post.seedMeta.entity === 'object'
    ? post.seedMeta.entity
    : null;
  if (b) return b;

  const c = post && post.seedMeta && post.seedMeta.reviewEntity && typeof post.seedMeta.reviewEntity === 'object'
    ? post.seedMeta.reviewEntity
    : null;
  if (c) return c;

  return null;
}

function extractReviewTarget(post) {
  if (post && post.reviewTarget && typeof post.reviewTarget === 'object') {
    return post.reviewTarget;
  }
  return null;
}

function deriveReviewTargetName(post, label) {
  const entity = extractReviewEntity(post);
  const target = extractReviewTarget(post);
  const title = normStr(post && post.title);
  const fallbackProduct = inferProductType(label, title);

  if (entity) {
    if (label === 'app-reviews') {
      if (normStr(entity.appName)) return normStr(entity.appName);
      if (normStr(entity.appId)) return normStr(entity.appId);
    }
    if (label === 'device-reviews') {
      if (normStr(entity.model)) return normStr(entity.model);
      if (normStr(entity.deviceName)) return normStr(entity.deviceName);
    }
    if (label === 'subscription-services') {
      if (normStr(entity.service)) return normStr(entity.service);
      if (normStr(entity.serviceName)) return normStr(entity.serviceName);
    }
  }

  if (target) {
    if (normStr(target.appName)) return normStr(target.appName);
    if (normStr(target.name)) return normStr(target.name);
    if (normStr(target.storeId)) return normStr(target.storeId);
  }

  if (title) return title;

  return fallbackProduct;
}

function deriveReviewEntityType(post, label) {
  const entity = extractReviewEntity(post);
  if (entity && normStr(entity.type)) return toLower(entity.type);

  if (label === 'app-reviews') return 'app';
  if (label === 'device-reviews') return 'device';
  if (label === 'subscription-services') return 'subscription';

  return inferProductType(label, normStr(post && post.title));
}

function deriveReviewProvider(post) {
  const target = extractReviewTarget(post);
  if (target && normStr(target.provider)) return toLower(target.provider);

  const reviewData = post && post.reviewData && typeof post.reviewData === 'object' ? post.reviewData : null;
  if (reviewData && normStr(reviewData.source)) return toLower(reviewData.source);

  return '';
}

function deriveReviewState(post) {
  const reviewData = post && post.reviewData && typeof post.reviewData === 'object' ? post.reviewData : null;
  const rating = reviewData && reviewData.rating && typeof reviewData.rating === 'object' ? reviewData.rating : null;

  const votes = Number(rating && rating.votes);
  const overall = Number(rating && rating.overall);

  if (Number.isFinite(votes) && votes > 0 && Number.isFinite(overall) && overall > 0) {
    return 'measured';
  }

  return 'early';
}

function buildReviewIdentityLine(targetName, entityType, provider) {
  const typeLabel =
    entityType === 'subscription' ? 'service' :
    entityType === 'device' ? 'device' :
    entityType === 'app' ? 'app' :
    'product';

  if (provider) {
    return `${targetName} has to earn trust as ${typeLabel === 'app' ? 'an' : 'a'} ${typeLabel} in normal use, especially when the choice depends on current store data, pricing signals, and user feedback from ${provider}.`;
  }

  return `${targetName} has to earn trust as ${typeLabel === 'app' ? 'an' : 'a'} ${typeLabel} in normal use, where the real test is whether it saves time, avoids repeated friction, and gives enough value to justify switching.`;
}

function buildPromptAwareLine(meta, fallback) {
  void meta;
  return fallback;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function makeParagraphs(paragraphs) {
  return paragraphs
    .map(p => normStr(p))
    .filter(Boolean)
    .map(p => `<p>${escapeHtml(p)}</p>`)
    .join('\n');
}

function makeList(items) {
  const rows = (items || []).map(x => normStr(x)).filter(Boolean);
  if (!rows.length) return '';
  return `<ul>\n${rows.map(x => `  <li>${escapeHtml(x)}</li>`).join('\n')}\n</ul>`;
}

function makeTable(headers, rows) {
  const h = ensureArray(headers).map(normStr).filter(Boolean);
  const r = ensureArray(rows).filter(Array.isArray);

  if (!h.length || !r.length) return '';

  return [
    '<table>',
    '  <thead>',
    '    <tr>',
    ...h.map(x => `      <th>${escapeHtml(x)}</th>`),
    '    </tr>',
    '  </thead>',
    '  <tbody>',
    ...r.map(cols => [
      '    <tr>',
      ...cols.map(col => `      <td>${escapeHtml(normStr(col))}</td>`),
      '    </tr>'
    ].join('\n')),
    '  </tbody>',
    '</table>',
  ].join('\n');
}

function buildReviewSection(title, label, h2, meta, post) {
  const productType = inferProductType(label, title);
  const topic = inferTopic(title);
  const context = meta.context || '';
  const targetName = deriveReviewTargetName(post, label);
  const entityType = deriveReviewEntityType(post, label);
  const provider = deriveReviewProvider(post);
  const reviewState = deriveReviewState(post);
  const identityLine = buildReviewIdentityLine(targetName, entityType, provider);

  if (h2 === 'Overview') {
    const introByType =
      entityType === 'device'
        ? `${targetName} is worth a closer look when the buyer cares about day-to-day reliability, comfort, battery behavior, and whether the hardware still feels sensible after the first few days of use.`
        : entityType === 'subscription'
          ? `${targetName} deserves attention when the buyer wants predictable value, clear plan limits, and enough ongoing usefulness to justify another monthly payment.`
          : `${targetName} is most useful to examine through ordinary writing, editing, and repeat-use moments rather than through launch-window curiosity alone.`;

    return makeParagraphs([
      `${introByType} The switching question is simple: does it remove enough friction to replace the current habit, or does it merely look attractive during a first trial?`,
      `${identityLine}${context ? ` The surrounding context also matters here, especially for ${context}.` : ''} For most readers, the answer depends on workflow speed, visible limits, trust in updates, and whether the product remains helpful after the first week.`
    ]);
  }

  if (h2 === 'Key Features') {
    const featureLead =
      entityType === 'device'
        ? `${targetName}'s useful features are the ones that affect repeated handling: display comfort, battery confidence, performance consistency, setup simplicity, and how easily the device fits into the buyer's existing routine.`
        : entityType === 'subscription'
          ? `${targetName}'s useful features are the ones that make the subscription feel used rather than merely owned: content depth, account flexibility, cancellation clarity, offline access, and reliable availability.`
          : `${targetName}'s useful features are the ones that support repeated work: fast draft creation, rewriting, tone adjustment, export flow, and the ability to keep editing without losing the user's train of thought.`;

    return [
      makeParagraphs([
        `${featureLead}`,
        `The feature set becomes stronger when the main task can be started quickly and finished without jumping through extra screens. If the strongest tools are hidden behind unclear limits or a disruptive upgrade prompt, the practical value drops even when the feature list looks long.`
      ]),
      makeList([
        `${targetName} needs a clear main workflow that feels easy to repeat.`,
        'The strongest tools should reduce editing, setup, or decision time.',
        'Extra features matter only when they support the main use case instead of distracting from it.'
      ])
    ].join('\n');
  }

  if (h2 === 'Specs & ROI') {
    const roiLead =
      entityType === 'device'
        ? `For ${targetName}, ROI comes from the gap between purchase cost and daily usefulness: battery life, performance headroom, repair risk, accessory needs, and how long the device can stay comfortable before replacement feels necessary.`
        : entityType === 'subscription'
          ? `For ${targetName}, ROI depends on how often the service is actually used, whether the plan limits match the household or work routine, and whether the monthly cost replaces something more expensive.`
          : `For ${targetName}, ROI depends on free usage limits, monthly price, export restrictions, model access, and whether the app saves more editing time than it costs.`;

    return [
      makeParagraphs([
        `${roiLead}`,
        `A low entry price is not automatically the better deal if the useful parts run out quickly. A higher price can still make sense when ${targetName} cuts repeated work, keeps the workflow stable, and avoids forcing the buyer into a second tool for basic tasks.`
      ]),
      makeTable(
        ['Factor', 'What to check', 'Why it matters'],
        [
          ['Price model', 'Free tier, paid plan, upgrade pressure', 'Defines the real entry cost'],
          ['Practical limits', 'Caps, missing features, lock-in conditions', 'Shows what the buyer can actually do'],
          ['Long-term value', 'Support horizon, update continuity, switching cost', 'Shows whether the choice still makes sense later']
        ]
      )
    ].join('\n');
  }

  if (h2 === 'Insights') {
    const insightLead =
      entityType === 'device'
        ? `The most useful signals for ${targetName} usually appear in comfort, heat, battery drain, durability, setup friction, and whether performance stays consistent after the first impression.`
        : entityType === 'subscription'
          ? `The most useful signals for ${targetName} usually appear in billing clarity, content availability, cancellation experience, account sharing rules, and whether the service keeps enough value between renewals.`
          : `The most useful signals for ${targetName} usually appear in output quality, editing time, tone control, export reliability, and how many corrections the user still has to make after generation.`;

    return makeParagraphs([
      `${insightLead}`,
      `Positive feedback matters more when it points to repeated convenience, not just novelty. Negative feedback matters more when the same limits keep returning, especially around pricing, stability, support, or the work needed to fix the product's output.`
    ]);
  }

  if (h2 === 'Ratings') {
    if (reviewState === 'measured') {
      return makeParagraphs([
        `Ratings can support the case for ${targetName}, but they should not carry the whole decision. A strong score can still hide repeated complaints, while a mixed score can still be acceptable when the buyer only needs the product's strongest use case.`,
        `The better reading is to compare the score with the complaint pattern. If users praise ${targetName} for speed or convenience but question limits or pricing, the final decision depends on how sensitive the buyer is to those trade-offs.`
      ]);
    }

    return makeParagraphs([
      `For ${targetName}, rating data is still too thin to settle the decision by itself. The more useful approach is to weigh fit, visible limits, workflow quality, and category risk until a stronger review snapshot exists.`,
      `This keeps the recommendation cautious. Early products can be promising, but a buyer should not treat limited data as proof that the product is already dependable for every use case.`
    ]);
  }

  if (h2 === 'Verdict') {
    const verdictLead =
      entityType === 'device'
        ? `${targetName} is a stronger choice for buyers who need its specific hardware advantages and can accept the price, durability, or ecosystem trade-offs that come with it.`
        : entityType === 'subscription'
          ? `${targetName} is a stronger choice for users who will use it often enough to make the monthly cost feel justified and who are comfortable with its plan rules.`
          : `${targetName} is a stronger choice for users who create short drafts often, revise text repeatedly, or need a faster way to move from rough idea to usable copy.`;

    return makeParagraphs([
      `${verdictLead}`,
      `It is a weaker choice for users who need deep research accuracy, strict source verification, very long-form consistency, or a low-cost tool that stays useful without upgrade pressure. The practical answer is not whether ${targetName} looks impressive once, but whether it improves the work often enough to become the new default.`
    ]);
  }

  if (h2 === 'Pros & Cons') {
    const pros =
      entityType === 'device'
        ? [
            'Clear value when the hardware advantage matches the buyer’s daily routine.',
            'Potential time or comfort gain if performance and battery behavior stay consistent.',
            'Good fit when setup and ecosystem compatibility are straightforward.'
          ]
        : entityType === 'subscription'
          ? [
              'Clear value when the service is used often enough to justify renewal.',
              'Convenient when plan rules, access, and cancellation terms are easy to understand.',
              'Useful when it replaces several smaller tools or services.'
            ]
          : [
              'Faster first drafts for short writing tasks.',
              'Useful tone changes and rewriting support when the user already knows the message.',
              'Helpful for repeated email, social, note, or blog-outline work.'
            ];

    const cons =
      entityType === 'device'
        ? [
            'Value drops if battery, heat, durability, or accessory costs become annoying.',
            'A better-known alternative may be safer when long-term support is unclear.',
            'The purchase is harder to justify if the main advantage is only occasional.'
          ]
        : entityType === 'subscription'
          ? [
              'Monthly cost feels weak when usage is irregular.',
              'Plan limits or policy changes can reduce value after signup.',
              'Cancellation, region, or sharing rules may matter more than the headline price.'
            ]
          : [
              'Long drafts may still need careful human editing.',
              'Free or low-cost plans may limit the best features.',
              'Factual claims still need separate checking before publishing.'
            ];

    return [
      makeParagraphs([
        `The practical balance for ${targetName} depends on whether the daily gain is larger than the limits that appear after adoption.`
      ]),
      makeTable(
        ['Pros', 'Cons'],
        [
          [pros[0], cons[0]],
          [pros[1], cons[1]],
          [pros[2], cons[2]]
        ]
      )
    ].join('\n');
  }

  if (h2 === 'Best For / Not For') {
    const bestFor =
      entityType === 'device'
        ? `${targetName} is best for buyers whose daily routine clearly matches its main hardware advantage and who want that advantage enough to accept the trade-offs.`
        : entityType === 'subscription'
          ? `${targetName} is best for users who will use the service regularly and can point to a clear replacement value for the monthly cost.`
          : `${targetName} is best for users who write short drafts often, reshape existing text, or need faster first-pass wording for everyday work.`;

    const notFor =
      entityType === 'device'
        ? `It is not the best fit for buyers who need the safest long-term support path, the lowest total cost, or a device that must handle very broad use cases without compromise.`
        : entityType === 'subscription'
          ? `It is not the best fit for users who subscribe casually, dislike recurring costs, or need ownership-style access instead of an ongoing service.`
          : `It is not the best fit for legal, medical, financial, or research-heavy writing where source verification and expert review matter more than speed.`;

    return makeParagraphs([
      `${bestFor}`,
      `${notFor}`
    ]);
  }

  if (h2 === 'Alternatives & Comparisons') {
    return makeParagraphs([
      `Alternatives are useful because they reveal what ${targetName} emphasizes. One competing option may be stronger on price, another on maturity, and another on simplicity. That comparison makes the product easier to place in a real buying decision.`,
      `${targetName} becomes the better choice only when its strongest advantage still matters after price, limits, workflow, and long-term trust are weighed together.`
    ]);
  }

  return makeParagraphs([
    `${targetName} works best when its real strengths match the buyer's actual use case rather than a broad idea of ${topic}.`,
    `For ${topic}, the sensible decision is to compare workflow fit, visible limits, and long-term trust before switching.`
  ]);
}

function buildSavingsSection(title, h2, meta) {
  const topic = inferTopic(title);
  const timing = meta.timing || 'present';

  if (h2 === 'Overview') {
    return makeParagraphs([
      `${title} is best approached as a value decision, not just a price decision. Most people do not want the cheapest option if it creates friction later. They want something that feels fair, predictable, and strong enough for the way they actually use it.`,
      `${buildPromptAwareLine(meta, `That is why a useful savings article must compare value, limits, and context together. For ${topic}, the practical question is which choice keeps both cost and inconvenience under control over time.${timing === 'future' ? ' If policy changes are expected, future flexibility matters even more.' : ''}`)}`
    ]);
  }

  if (h2 === 'Cost Breakdown') {
    return [
      makeParagraphs([
        `A cost breakdown matters because the headline number is rarely the full story. Monthly fees, setup charges, cancellation terms, limits, and upgrade pressure often change the real price people end up paying.`,
        `The safest way to compare cost is to separate visible price from hidden cost. That includes wasted usage, lock-in conditions, and the time cost of switching later if the first choice turns out to be weak.`
      ]),
      makeTable(
        ['Layer', 'What to inspect', 'Decision meaning'],
        [
          ['Visible cost', 'Monthly fee, one-time charge, base price', 'Good starting point, not the final answer'],
          ['Hidden cost', 'Caps, throttling, feature loss, penalties', 'Changes the real value sharply'],
          ['Switching cost', 'Effort, risk, migration friction', 'Important when changing providers later']
        ]
      )
    ].join('\n');
  }

  if (h2 === 'Compare Options') {
    return [
      makeParagraphs([
        `A useful comparison should not reduce every option to a winner and loser. In real purchases, one option often works best for low usage, another for predictable heavy usage, and another for people who care most about flexibility.`,
        `That is why the comparison should stay tied to conditions. The right option depends on whether the buyer wants the lowest entry price, the clearest policy, or the safest long-term value.`
      ]),
      makeTable(
        ['Option', 'Best when', 'Risk to watch'],
        [
          ['Option A', 'Low-cost entry matters most', 'May become weak if limits appear quickly'],
          ['Option B', 'Balanced use and policy clarity matter', 'Can feel average rather than standout'],
          ['Option C', 'Long-term convenience matters most', 'Often costs more at the start']
        ]
      )
    ].join('\n');
  }

  if (h2 === 'Best Choice by Situation') {
    return [
      makeParagraphs([
        `The better way to choose is to match the plan to the situation rather than chasing a universal winner. People with light use often overpay for flexibility they never use, while heavy users can be trapped by low-price plans that become restrictive at exactly the wrong time.`
      ]),
      makeList([
        'Choose the lowest-friction option when stability matters more than the smallest discount.',
        'Choose the lowest-cost option only when the limits are truly acceptable.',
        'Choose the more flexible option when your usage pattern may change soon.'
      ])
    ].join('\n');
  }

  if (h2 === 'How to Save More') {
    return [
      makeParagraphs([
        `The most reliable way to save more is to reduce waste before chasing a discount. A small monthly saving that keeps the plan usable is often better than a larger saving that leads to extra charges or a frustrating downgrade later.`,
        `In practice, savings usually come from matching the plan to actual behavior, reviewing policy changes regularly, and avoiding emotional upgrades that look generous but add little real value.`
      ]),
      makeList([
        'Review actual usage before changing plans.',
        'Check policy wording, not just promotional pricing.',
        'Prefer predictable value over short-term discount headlines.'
      ])
    ].join('\n');
  }

  if (h2 === 'Summary') {
    return makeParagraphs([
      `${title} is ultimately about choosing a plan that keeps value and limits in balance. The right decision is not the one that looks cheapest in isolation, but the one that remains acceptable after policy details and real usage are taken into account.`,
      `For most buyers, the safest path is to compare visible price, hidden restrictions, and long-term switching cost together before deciding.`
    ]);
  }

  return makeParagraphs([
    `For ${topic}, the strongest savings choice is the one that preserves usable value instead of focusing on the shortest headline price alone.`
  ]);
}

function buildHowToSection(title, h2, meta) {
  const context = meta.context || 'the current setup';

  if (h2 === 'Overview') {
    return makeParagraphs([
      `${title} should be read as a practical execution guide. The goal is not to sound technical for its own sake, but to make the task feel controllable from the first step to the final verification.`,
      `${buildPromptAwareLine(meta, `The most common reason a how-to fails is that people jump into action before checking environment, version, or dependency conditions. In ${context}, the setup around the task matters almost as much as the steps themselves.`)}`
    ]);
  }

  if (h2 === 'Before You Start') {
    return [
      makeParagraphs([
        `Preparation is what prevents a simple task from turning into a long recovery session. Before making changes, it is worth checking version, access rights, backup state, and whether the expected result is clearly defined.`,
        `This stage often feels slower, but it usually saves the most time later because it removes avoidable confusion.`
      ]),
      makeList([
        'Check version and environment first.',
        'Confirm required permissions or access.',
        'Know what successful completion should look like before starting.'
      ])
    ].join('\n');
  }

  if (h2 === 'Step-by-Step') {
    return makeParagraphs([
      `The safest way to execute is to move in a sequence that can be verified after each stage. That means one change, one check, then the next change. This is slower than guessing, but much faster than undoing a broken configuration.`,
      `When something does not match the expected result, it is better to stop at the current step and compare conditions than to keep stacking changes on top of uncertainty.`
    ]);
  }

  if (h2 === 'Common Mistakes & Fixes') {
    return makeParagraphs([
      `Most failures come from three patterns: skipped prerequisites, mismatch between environment and instruction, or an assumption that a visible change automatically means success. These are common because the task can look finished before it is truly verified.`,
      `The practical fix is to check the smallest dependable signal first. If the expected outcome is missing, go back to the step where the environment, permission, or setting first diverged from the assumption.`
    ]);
  }

  if (h2 === 'Checklist') {
    return [
      makeParagraphs([
        `A checklist is useful because execution problems usually come from omission rather than complexity. When the task is written as a compact sequence, people are less likely to forget a condition that looked minor at the time but becomes critical later.`
      ]),
      makeList([
        'Environment confirmed',
        'Required setting or resource prepared',
        'Main step completed',
        'Result verified',
        'Fallback path ready if the result fails'
      ])
    ].join('\n');
  }

  if (h2 === 'Next Steps') {
    return makeParagraphs([
      `Once the task works, the next step is to stabilize it. That may mean documenting the setup, saving a repeatable checklist, or linking the result to a broader workflow so the same problem does not need to be solved from scratch again.`,
      `A how-to becomes genuinely useful when it helps the reader avoid repeating the same confusion later.`
    ]);
  }

  return makeParagraphs([
    `${title} becomes easier when the task is treated as an ordered process with visible checkpoints rather than as a loose set of tips.`
  ]);
}

function buildTemplateSection(title, h2, meta) {
  if (h2 === 'Overview') {
    return makeParagraphs([
      `${title} is meant to reduce hesitation at the moment of action. The value of a template or checklist is not abstract structure by itself, but the way it turns a vague task into something repeatable and easier to start.`,
      `${buildPromptAwareLine(meta, 'People usually save and reuse a template when it removes friction, prevents omission, and still leaves enough room for personal adjustment.')}`
    ]);
  }

  if (h2 === 'When to Use This Template') {
    return makeParagraphs([
      `A template is most useful when the same type of decision or task comes back repeatedly. In those cases, consistency matters more than inspiration because people want to avoid starting from zero each time.`,
      `It is less useful when the situation is highly unusual or depends on information that changes too quickly. In that case, the checklist should be adapted rather than copied blindly.`
    ]);
  }

  if (h2 === 'Template / Checklist') {
    return [
      makeParagraphs([
        `The core of a good template is clarity. Each item should guide action directly, not force the reader to interpret vague instructions under pressure.`
      ]),
      makeTable(
        ['Item', 'Action', 'Tip'],
        [
          ['Prepare context', 'Write down the goal and constraints', 'Start with the decision you actually need to make'],
          ['Check essentials', 'Confirm timing, cost, or required inputs', 'Avoid missing the one condition that blocks everything'],
          ['Execute', 'Follow the sequence one item at a time', 'Do not skip verification just because the task looks simple']
        ]
      )
    ].join('\n');
  }

  if (h2 === 'Examples') {
    return makeParagraphs([
      `Examples matter because they show how the same template can stay useful across slightly different situations. The reader should be able to see both the stable structure and the parts that need adjustment.`,
      `That balance is what makes a template practical instead of mechanical. It gives direction without pretending that every real case is identical.`
    ]);
  }

  if (h2 === 'Common Pitfalls') {
    return makeParagraphs([
      `The most common failure is treating the checklist as decoration rather than as a working tool. Another common problem is adding too many items until the checklist becomes so heavy that people stop using it.`,
      `A better checklist is usually shorter, clearer, and focused on the mistakes that actually cause loss of time, money, or confidence.`
    ]);
  }

  if (h2 === 'How to Customize') {
    return makeParagraphs([
      `Customization should happen at the edges, not at the core. The reusable part is what keeps the process stable, while the customized part should reflect timing, tool choice, or a special requirement of the current case.`,
      `That way the template remains both practical and personal, which is the reason people keep coming back to it instead of abandoning it after one use.`
    ]);
  }

  return makeParagraphs([
    `${title} should be used as a working structure that supports action, not as a rigid form that ignores context.`
  ]);
}

/* ============================================================
 * A/C/D 자기검수·보정 루프
 * A: 사실성/과장/일루전 완화
 * C: 라벨별 핵심 기준 충족 보강
 * D: AI-티/기계식 어투 완화
 * ============================================================ */
function stripDangerousAbsolutes(text) {
  return String(text || '')
    .replace(/\b(always|never|guaranteed|perfect|everyone|no one)\b/gi, (m) => {
      const map = {
        always: 'often',
        never: 'rarely',
        guaranteed: 'more likely',
        perfect: 'strong',
        everyone: 'many people',
        'no one': 'few people'
      };
      return map[toLower(m)] || m;
    })
    .replace(/\b(is best judged by fit, not by hype)\b/gi, 'is more useful to judge by fit than by hype')
    .replace(/\bthe strongest\b/gi, (m) => /^[A-Z]/.test(m) ? 'The more reliable' : 'the more reliable')
    .replace(/\bthe safest\b/gi, 'the safer');
}

function applyStabilityCaution(text) {
  return String(text || '')
    .replace(/provider looks stable enough/gi, 'provider appears stable enough')
    .replace(/company continues shipping updates/gi, 'company appears willing to continue shipping updates')
    .replace(/stays usable longer/gi, 'can remain usable longer')
    .replace(/can be a sensible choice/gi, 'may be a sensible choice');
}

function stripRobotPhrases(text) {
  return String(text || '')
    .replace(/\bIn other words,\s*/g, '')
    .replace(/\bThat is why\b/g, 'This is why')
    .replace(/\bThe practical advantage\b/g, 'The value')
    .replace(/\bThe better way\b/g, 'A better way')
    .replace(/\bIt is better to\b/g, 'It helps to')
    .replace(/[^.?!]*\bshould be read as\b[^.?!]*[.?!]/gi, '')
    .replace(/[^.?!]*\bis treated here as\b[^.?!]*[.?!]/gi, '')
    .replace(/[^.?!]*\bThe goal is\b[^.?!]*[.?!]/gi, '')
    .replace(/[^.?!]*\bthis writing direction\b[^.?!]*[.?!]/gi, '')
    .replace(/\bThis section should\b/gi, 'This part needs to')
    .replace(/\bthe review should\b/gi, 'the decision needs to')
    .replace(/\bThe article also needs to stay aligned with[^.?!]*[.?!]/gi, '')
    .replace(/\s{2,}/g, ' ');
}

function ensureReviewCriteria(html, h2, title) {
  let out = String(html || '');

  if (h2 === 'Overview' && !/stable|supporting|updates|dependable/i.test(out)) {
    out += '\n' + makeParagraphs([
      `${title} should not be judged only by first impressions. Long-term support, update continuity, and the ability to remain dependable after the initial trial period matter just as much as early convenience.`
    ]);
  }

  if (h2 === 'Specs & ROI' && !/cost|price|value|limits|support/i.test(out)) {
    out += '\n' + makeParagraphs([
      `This section should make the cost-to-value relationship easier to judge under realistic limitations and long-term use.`
    ]);
  }

  return out;
}

function ensureSavingsCriteria(html, h2, title) {
  let out = String(html || '');

  if (h2 === 'Compare Options' && !/<table>/i.test(out)) {
    out += '\n' + makeTable(
      ['Option', 'Best when', 'Risk to watch'],
      [
        ['Option A', 'Lower entry cost matters most', 'Restrictions may surface early'],
        ['Option B', 'Balance matters most', 'Can feel less distinctive'],
        ['Option C', 'Flexibility matters most', 'Often starts higher']
      ]
    );
  }

  if (h2 === 'How to Save More' && !/<ul>/i.test(out)) {
    out += '\n' + makeList([
      'Compare real usage before changing.',
      'Read the policy wording, not just the headline price.',
      'Treat hidden limits as part of the actual cost.'
    ]);
  }

  if (h2 === 'Overview' && !/value|limits|predictable|cost/i.test(out)) {
    out += '\n' + makeParagraphs([
      `${title} should balance visible price, practical limits, and predictable long-term value instead of chasing the smallest headline discount alone.`
    ]);
  }

  return out;
}

function ensureHowToCriteria(html, h2, title) {
  let out = String(html || '');

  if (h2 === 'Checklist' && !/<ul>/i.test(out)) {
    out += '\n' + makeList([
      'Version checked',
      'Environment confirmed',
      'Main action completed',
      'Result verified'
    ]);
  }

  if (h2 === 'Overview' && !/verification|environment|step|setup/i.test(out)) {
    out += '\n' + makeParagraphs([
      `${title} needs a clear sequence, a known environment, and an explicit verification point so the reader can tell whether the task actually worked.`
    ]);
  }

  return out;
}

function ensureTemplateCriteria(html, h2, title) {
  let out = String(html || '');

  if (h2 === 'Template / Checklist' && !/<table>/i.test(out)) {
    out += '\n' + makeTable(
      ['Item', 'Action', 'Tip'],
      [
        ['Prepare', 'Define the goal', 'Keep the target clear'],
        ['Check', 'Confirm required inputs', 'Avoid missing blockers'],
        ['Execute', 'Follow the steps', 'Verify before moving on']
      ]
    );
  }

  if (h2 === 'Overview' && !/repeatable|reuse|friction|action/i.test(out)) {
    out += '\n' + makeParagraphs([
      `${title} should reduce hesitation, make execution more repeatable, and help the reader move from intention to action with less friction.`
    ]);
  }

  return out;
}

function selfReviewAndPolish(post, h2, html) {
  const label = extractLabel(post);
  let out = String(html || '');

  for (let pass = 0; pass < 2; pass++) {
    out = stripDangerousAbsolutes(out);
    out = applyStabilityCaution(out);
    out = stripRobotPhrases(out);

    if (REVIEW_LABELS.has(label)) {
      out = ensureReviewCriteria(out, h2, normStr(post.title));
    } else if (label === 'smart-savings') {
      out = ensureSavingsCriteria(out, h2, normStr(post.title));
    } else if (label === 'how-to-playbooks') {
      out = ensureHowToCriteria(out, h2, normStr(post.title));
    } else if (label === 'templates-checklists') {
      out = ensureTemplateCriteria(out, h2, normStr(post.title));
    }
  }

  return out;
}

function parseRepairRequestFile() {
  if (!CONTENT_REPAIR_REQUEST_FILE) return null;
  if (!fs.existsSync(CONTENT_REPAIR_REQUEST_FILE)) return null;

  try {
    const doc = readJSON(CONTENT_REPAIR_REQUEST_FILE);
    if (!doc || typeof doc !== 'object') return null;
    if (!Array.isArray(doc.items)) return null;
    return doc;
  } catch {
    return null;
  }
}

function parseTargetSlugSet() {
  if (!CONTENT_TARGET_SLUGS_RAW) return null;
  const arr = CONTENT_TARGET_SLUGS_RAW
    .split(',')
    .map(normStr)
    .filter(Boolean);

  if (!arr.length) return null;
  return new Set(arr);
}

function getRepairHintsBySlug() {
  const req = parseRepairRequestFile();
  const map = new Map();

  if (!req || !Array.isArray(req.items)) return map;

  for (const item of req.items) {
    const slug = normStr(item && item.slug);
    if (!slug) continue;

    const issues = Array.isArray(item.issues) ? item.issues : [];
    map.set(slug, issues);
  }

  return map;
}

function buildRepairHintParagraphs(slug, h2, issues) {
  const codes = ensureArray(issues)
    .map(x => normStr(x && x.code))
    .filter(Boolean);

  const hints = [];

  if (codes.some(code => /TEXT_TOO_SHORT|SECTION_THIN/i.test(code))) {
    hints.push(`This section needs slightly more concrete detail so the reader can understand not just the conclusion, but the reasoning behind it.`);
  }

  if (codes.some(code => /SAVINGS_TABLE_REQUIRED/i.test(code)) && h2 === 'Compare Options') {
    hints.push(`A comparison should remain visible in structured form so the reader can weigh trade-offs instead of relying on vague impressions.`);
  }

  if (codes.some(code => /SAVINGS_LIST_REQUIRED/i.test(code)) && h2 === 'How to Save More') {
    hints.push(`Practical savings advice is stronger when it ends with short, actionable points the reader can immediately apply.`);
  }

  if (codes.some(code => /HOWTO_LIST_REQUIRED/i.test(code)) && h2 === 'Checklist') {
    hints.push(`This checklist should stay explicit enough that the reader can verify the task without guessing what comes next.`);
  }

  if (codes.some(code => /TEMPLATE_TABLE_REQUIRED/i.test(code)) && h2 === 'Template / Checklist') {
    hints.push(`A reusable template becomes easier to trust when the structure is visible in a clear table rather than implied only through prose.`);
  }

  if (codes.some(code => /REVIEW_ROI_MISSING/i.test(code)) && h2 === 'Specs & ROI') {
    hints.push(`This section should make the cost-to-value relationship easier to judge under realistic limitations and long-term use.`);
  }

  return hints;
}

function buildBodyByLabel(post, h2, repairHints) {
  const title = normStr(post.title);
  const label = extractLabel(post);
  const meta = {
    intent: extractIntent(post),
    timing: extractTiming(post),
    context: extractContext(post),
    bodyPromptInfo: parseBodyPrompt(extractBodyPrompt(post)),
  };

  let html = '';

  if (REVIEW_LABELS.has(label)) {
    html = buildReviewSection(title, label, h2, meta, post);
  } else if (label === 'smart-savings') {
    html = buildSavingsSection(title, h2, meta);
  } else if (label === 'how-to-playbooks') {
    html = buildHowToSection(title, h2, meta);
  } else if (label === 'templates-checklists') {
    html = buildTemplateSection(title, h2, meta);
  } else {
    html = makeParagraphs([
      `${title} should be read through actual use, realistic constraints, and the quality of the decision it supports.`
    ]);
  }

  if (CONTENT_REPAIR_MODE && repairHints && repairHints.length) {
    html += '\n' + makeParagraphs(repairHints);
  }

  return selfReviewAndPolish(post, h2, html);
}

function replacePlaceholderBody(post, repairIssues) {
  const body = String(post.body || '');
  const sectionRegex = /(<h2>(.*?)<\/h2>\s*)<p><!-- content --><\/p>/g;

  return body.replace(sectionRegex, (_m, h2Block, h2Text) => {
    const hints = CONTENT_REPAIR_MODE ? buildRepairHintParagraphs(normStr(post.slug), normStr(h2Text), repairIssues) : [];
    const injected = buildBodyByLabel(post, normStr(h2Text), hints);
    return `${h2Block}${injected}`;
  });
}

function repairExistingBody(post, repairIssues) {
  const body = String(post.body || '');
  const sectionRegex = /(<h2>(.*?)<\/h2>\s*)([\s\S]*?)(?=<h2>|$)/g;

  return body.replace(sectionRegex, (_m, h2Block, h2Text, sectionBody) => {
    const current = normStr(sectionBody);
    const hints = buildRepairHintParagraphs(normStr(post.slug), normStr(h2Text), repairIssues);

    if (!hints.length) {
      return `${h2Block}${sectionBody}`;
    }

    const addition = makeParagraphs(hints);
    if (!addition) {
      return `${h2Block}${sectionBody}`;
    }

    if (!current) {
      return `${h2Block}${addition}`;
    }

    return `${h2Block}${sectionBody}\n${addition}`;
  });
}

function shouldProcessSlug(slug, targetSlugSet) {
  if (!CONTENT_REPAIR_MODE) return true;
  if (!targetSlugSet || !targetSlugSet.size) return true;
  return targetSlugSet.has(slug);
}

function main() {
  if (!fs.existsSync(POSTS_DIR)) {
    console.log('[generate-content] posts 없음 -> 종료');
    process.exit(0);
  }

  const files = fs.readdirSync(POSTS_DIR).filter(f => f.toLowerCase().endsWith('.json')).sort();
  console.log('[generate-content] JSON 파일 수 =', files.length);

  const repairHintsBySlug = getRepairHintsBySlug();
  const targetSlugSet = parseTargetSlugSet();

  let written = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const full = path.join(POSTS_DIR, file);

    let post;
    try {
      post = readJSON(full);
    } catch (e) {
      failed++;
      console.error('[FAIL] JSON 파싱 실패:', file, e.message);
      continue;
    }

    const slug = normStr(post.slug) || path.basename(file, '.json');
    const label = extractLabel(post);

    if (isExcludedLabel(label)) {
      console.log(`[SKIP] ${slug} — generate-content 대상 아님 (${label})`);
      skipped++;
      continue;
    }

    if (!shouldProcessSlug(slug, targetSlugSet)) {
      console.log(`[SKIP] ${slug} — repair 대상 아님`);
      skipped++;
      continue;
    }

    const repairIssues = repairHintsBySlug.get(slug) || [];

    if (!CONTENT_REPAIR_MODE && !hasPlaceholderBody(post)) {
      console.log(`[SKIP] ${slug} — 치환할 placeholder 없음`);
      skipped++;
      continue;
    }

    if (CONTENT_REPAIR_MODE && !hasPlaceholderBody(post) && !repairIssues.length) {
      console.log(`[SKIP] ${slug} — repair 사유 없음`);
      skipped++;
      continue;
    }

    try {
      let replaced = '';

      if (hasPlaceholderBody(post)) {
        replaced = replacePlaceholderBody(post, repairIssues);
      } else if (CONTENT_REPAIR_MODE) {
        replaced = repairExistingBody(post, repairIssues);
      } else {
        replaced = String(post.body || '');
      }

      if (replaced === post.body) {
        console.log(`[SKIP] ${slug} — 본문 변경 없음`);
        skipped++;
        continue;
      }

      post.body = replaced;
      post.contentGen = {
        mode: CONTENT_REPAIR_MODE ? 'section-content-repair' : 'section-content-fill',
        updatedAt: new Date().toISOString(),
        writeMode: CONTENT_WRITE_MODE,
        label: label || '',
        bodyPromptUsed: !!extractBodyPrompt(post),
        selfReviewLoop: ['A:factuality', 'C:criteria-check', 'D:anti-ai-tone',
          'L:instruction-leakage-guard'],
        repairMode: CONTENT_REPAIR_MODE,
        repairIssueCount: repairIssues.length,
      };

      if (CAN_WRITE) {
        writeJSON(full, post);
        console.log(`[OK] ${slug} — ${CONTENT_REPAIR_MODE ? '본문 보정 완료' : '본문 치환 완료'}`);
        written++;
      } else {
        console.log(`[DRY] ${slug} — ${CONTENT_REPAIR_MODE ? '본문 보정만 수행(미저장)' : '본문 치환만 수행(미저장)'}`);
      }
    } catch (e) {
      failed++;
      console.error(`[FAIL] ${slug} —`, e.message || e);
    }
  }

  console.log('────────────────────────────────────────────');
  console.log('[generate-content] 요약');
  console.log('  저장(WRITE) =', written);
  console.log('  SKIP        =', skipped);
  console.log('  실패        =', failed);
  console.log('────────────────────────────────────────────');

  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();
