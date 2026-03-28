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

function buildReviewSection(title, label, h2, meta) {
  const productType = inferProductType(label, title);
  const topic = inferTopic(title);
  const timing = meta.timing || 'present';
  const context = meta.context || '';

  if (h2 === 'Overview') {
    return makeParagraphs([
      `${title} should be read as a practical buying decision rather than a headline claim. What matters most at the start is whether this ${productType} fits the way people actually use it, how often they return to it, and whether the provider looks stable enough to keep supporting it over time.`,
      `A short burst of attention is rarely enough in real use. People usually care about whether the service keeps improving, whether the company continues shipping updates, and whether the overall experience feels dependable after the first week of curiosity wears off.${context ? ` In this case, the context is especially relevant for ${context}.` : ''}`
    ]);
  }

  if (h2 === 'Key Features') {
    return [
      makeParagraphs([
        `The useful way to read the feature set is to focus on what changes day-to-day behavior, not what only looks impressive on a landing page. A feature matters when it saves time, reduces friction, or makes a repeated task feel easier to finish.`,
        `That is why the strongest features are usually the ones people keep coming back to after the first impression. In practice, buyers tend to remember stability, speed, clarity, and the ease of reaching the outcome they wanted.`
      ]),
      makeList([
        'Look for features that reduce repeated effort rather than one-time novelty.',
        'Check whether the core function is clear without a long learning curve.',
        'Treat convenience, reliability, and update quality as part of the feature value.'
      ])
    ].join('\n');
  }

  if (h2 === 'Specs & ROI') {
    return [
      makeParagraphs([
        `Price alone does not explain the return on investment (ROI, practical value for the money). The real question is whether the cost stays reasonable after hidden limits, subscription rules, upgrade pressure, or replacement timing are taken into account.`,
        `A lower starting price can still become expensive when restrictions show up later. A more expensive option can make sense when it stays usable longer, receives steady updates, or removes a recurring problem that would otherwise keep costing time or money.`
      ]),
      makeTable(
        ['Factor', 'What to check', 'Why it matters'],
        [
          ['Base cost', 'Entry price or monthly fee', 'Sets the first comparison point'],
          ['Limits', 'Caps, lock-ins, feature restrictions', 'Changes the real value quickly'],
          ['Longevity', 'Update cycle, durability, long-term support', 'Reduces replacement or switching cost']
        ]
      )
    ].join('\n');
  }

  if (h2 === 'Insights') {
    return makeParagraphs([
      `User sentiment usually becomes meaningful when the same themes repeat. People rarely describe a product in formal terms, but they consistently reveal where the friction is: onboarding, update stability, billing clarity, reliability under daily use, or support quality when something goes wrong.`,
      `That is also where long-term trust is formed. A ${productType} that looks polished at first but becomes inconsistent later often creates the same pattern in user feedback: short early excitement, then frustration around stability, pricing rules, or support responsiveness.`
    ]);
  }

  if (h2 === 'Ratings') {
    return makeParagraphs([
      `Ratings are useful when read as direction, not as a verdict by themselves. A strong average score can hide recurring complaints, while a mixed score can still point to a good fit for a specific kind of user.`,
      `The better way to interpret rating data is to ask what the positive and negative sides are actually measuring. If praise centers on convenience but criticism centers on limits or policy changes, the final decision should depend on how sensitive the buyer is to those trade-offs.`
    ]);
  }

  if (h2 === 'Verdict') {
    return makeParagraphs([
      `${title} is best judged by fit, not by hype. For someone whose priorities match the core strengths of this ${productType}, it can be a sensible choice. For someone who values a different workflow, a longer support horizon, or stricter cost predictability, a competing option may be more practical.`,
      `In other words, the right question is not whether it is universally good, but whether it stays useful after the first purchase decision. That is the point where short-term excitement turns into real value.`
    ]);
  }

  if (h2 === 'Pros & Cons') {
    return [
      makeParagraphs([
        `The practical advantage of a pros-and-cons view is that it removes vague praise. A strong point is only meaningful if it changes the real experience. A weak point matters when it creates repeated friction or uncertainty after adoption.`
      ]),
      makeList([
        'Pros should connect to daily convenience, speed, or clarity.',
        'Cons should connect to cost, stability, lock-in, or learning friction.',
        'A balanced decision comes from how those two sides interact in real use.'
      ])
    ].join('\n');
  }

  if (h2 === 'Best For / Not For') {
    return makeParagraphs([
      `A product usually becomes easier to judge when the target user is clear. The best fit is someone whose needs align with the product’s strongest repeated advantage, not someone who only likes its surface appeal.`,
      `The weakest fit is often the person who needs predictability in an area where the product still feels unstable, expensive over time, or too narrow for changing needs.`
    ]);
  }

  if (h2 === 'Alternatives & Comparisons') {
    return makeParagraphs([
      `Alternatives matter not because every option must be compared line by line, but because comparison reveals what this choice emphasizes. One competitor may win on price, another on long-term support, and another on ease of use.`,
      `That makes comparison useful as a decision lens. Instead of asking which option is absolutely best, it is better to ask which one matches the user’s real priorities most closely.`
    ]);
  }

  return makeParagraphs([
    `${title} should still be interpreted through actual use, cost stability, and trust in the provider rather than surface-level promises alone.`,
    `For ${topic}, the sensible approach is to compare convenience, support horizon, and practical trade-offs before making a final choice.`
  ]);
}

function buildSavingsSection(title, h2, meta) {
  const topic = inferTopic(title);
  const timing = meta.timing || 'present';

  if (h2 === 'Overview') {
    return makeParagraphs([
      `${title} is best approached as a value decision, not just a price decision. Most people do not want the cheapest option if it creates friction later. They want something that feels fair, predictable, and strong enough for the way they actually use it.`,
      `That is why a useful savings article must compare value, limits, and context together. For ${topic}, the practical question is which choice keeps both cost and inconvenience under control over time.${timing === 'future' ? ' If policy changes are expected, future flexibility matters even more.' : ''}`
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
      `The most common reason a how-to fails is that people jump into action before checking environment, version, or dependency conditions. In ${context}, the setup around the task matters almost as much as the steps themselves.`
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
      `People usually save and reuse a template when it removes friction, prevents omission, and still leaves enough room for personal adjustment.`
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

function buildBodyByLabel(post, h2) {
  const title = normStr(post.title);
  const label = extractLabel(post);
  const meta = {
    intent: extractIntent(post),
    timing: extractTiming(post),
    context: extractContext(post),
  };

  if (REVIEW_LABELS.has(label)) {
    return buildReviewSection(title, label, h2, meta);
  }

  if (label === 'smart-savings') {
    return buildSavingsSection(title, h2, meta);
  }

  if (label === 'how-to-playbooks') {
    return buildHowToSection(title, h2, meta);
  }

  if (label === 'templates-checklists') {
    return buildTemplateSection(title, h2, meta);
  }

  return makeParagraphs([
    `${title} should be read through actual use, realistic constraints, and the quality of the decision it supports.`
  ]);
}

function replacePlaceholderBody(post) {
  const body = String(post.body || '');
  const sectionRegex = /(<h2>(.*?)<\/h2>\s*)<p><!-- content --><\/p>/g;

  return body.replace(sectionRegex, (_m, h2Block, h2Text) => {
    const injected = buildBodyByLabel(post, normStr(h2Text));
    return `${h2Block}${injected}`;
  });
}

function main() {
  if (!fs.existsSync(POSTS_DIR)) {
    console.log('[generate-content] posts 없음 -> 종료');
    process.exit(0);
  }

  const files = fs.readdirSync(POSTS_DIR).filter(f => f.toLowerCase().endsWith('.json')).sort();
  console.log('[generate-content] JSON 파일 수 =', files.length);

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

    if (!hasPlaceholderBody(post)) {
      console.log(`[SKIP] ${slug} — 치환할 placeholder 없음`);
      skipped++;
      continue;
    }

    try {
      const replaced = replacePlaceholderBody(post);

      if (replaced === post.body) {
        console.log(`[SKIP] ${slug} — 본문 변경 없음`);
        skipped++;
        continue;
      }

      post.body = replaced;
      post.contentGen = {
        mode: 'section-content-fill',
        updatedAt: new Date().toISOString(),
        writeMode: CONTENT_WRITE_MODE,
        label: label || '',
      };

      if (CAN_WRITE) {
        writeJSON(full, post);
        console.log(`[OK] ${slug} — 본문 치환 완료`);
        written++;
      } else {
        console.log(`[DRY] ${slug} — 본문 치환만 수행(미저장)`);
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
