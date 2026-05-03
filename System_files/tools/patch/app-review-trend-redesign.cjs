#!/usr/bin/env node
'use strict';

/**
 * System_files/tools/patch/app-review-trend-redesign.cjs
 *
 * 역할:
 * - app-reviews trend 시드를 AOIA trend 기준에 맞게 재구조화한다.
 * - trend를 단순 유행 정보가 아니라 "시점 기반 의사결정 기록 데이터"로 만든다.
 * - intent / title / angle / goal / keyPoints / trendContext / decisionSummary / selectionCriteria / selectionMeta / fingerprint를 보정한다.
 * - 기존 id / priority / entity / reviewEntity 등 무관 필드는 삭제하지 않는다.
 * - intent quota를 유지하면서 app entity가 한 앱에 몰리지 않도록 라운드로빈 분산한다.
 *
 * 사용:
 * - node ./System_files/tools/patch/app-review-trend-redesign.cjs
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const TARGET_FILE = path.join(
  ROOT,
  'seedpool',
  'warehouse',
  'trend',
  'app-reviews-trend.json'
);

const TREND_SCHEMA = {
  schema: 'AOIA',
  label: 'app-reviews',
  mode: 'trend',
  requiredConcept: 'time-stamped decision record',
  requiredFields: [
    'entity',
    'reviewEntity',
    'intent',
    'title',
    'angle',
    'goal',
    'keyPoints',
    'trendContext',
    'decisionSummary',
    'decisionType',
    'selectionCriteria',
    'selectionMeta',
    'fingerprint',
  ],
};

const INTENT_ORDER = [
  'review/update',
  'review/recheck',
  'review/compare-now',
  'review/still-worth',
  'review/switch-or-keep',
  'review/risk-watch',
];

const TARGET_RATIO = {
  'review/update': 0.22,
  'review/recheck': 0.20,
  'review/compare-now': 0.18,
  'review/still-worth': 0.18,
  'review/switch-or-keep': 0.14,
  'review/risk-watch': 0.08,
};

const TREND_REASON_LIBRARY = [
  'recent feature update',
  'pricing or plan change',
  'free-tier limitation',
  'competitor improvement',
  'privacy or account policy change',
  'user sentiment shift',
  'workflow relevance change',
  'AI feature expansion',
  'mobile app experience change',
  'subscription value pressure',
  'market positioning change',
  'platform support change',
];

const APP_TREND_LIBRARY = [
  { name: 'Notion', category: 'productivity', platform: ['web', 'ios', 'android'] },
  { name: 'Evernote', category: 'productivity', platform: ['web', 'ios', 'android'] },
  { name: 'TickTick', category: 'productivity', platform: ['web', 'ios', 'android'] },
  { name: 'Todoist', category: 'productivity', platform: ['web', 'ios', 'android'] },
  { name: 'Google Keep', category: 'notes', platform: ['web', 'ios', 'android'] },
  { name: 'Samsung Notes', category: 'notes', platform: ['android'] },
  { name: 'Obsidian', category: 'notes', platform: ['desktop', 'ios', 'android'] },
  { name: 'OneNote', category: 'notes', platform: ['web', 'desktop', 'ios', 'android'] },
  { name: 'Trello', category: 'project-management', platform: ['web', 'ios', 'android'] },
  { name: 'Asana', category: 'project-management', platform: ['web', 'ios', 'android'] },
  { name: 'ClickUp', category: 'project-management', platform: ['web', 'ios', 'android'] },
  { name: 'Slack', category: 'communication', platform: ['web', 'desktop', 'ios', 'android'] },
  { name: 'Discord', category: 'communication', platform: ['web', 'desktop', 'ios', 'android'] },
  { name: 'Zoom', category: 'video-meetings', platform: ['web', 'desktop', 'ios', 'android'] },
  { name: 'Google Meet', category: 'video-meetings', platform: ['web', 'ios', 'android'] },
  { name: 'Canva', category: 'design', platform: ['web', 'ios', 'android'] },
  { name: 'CapCut', category: 'video-editing', platform: ['desktop', 'ios', 'android'] },
  { name: 'Spotify', category: 'music', platform: ['web', 'desktop', 'ios', 'android'] },
  { name: 'YouTube Music', category: 'music', platform: ['web', 'ios', 'android'] },
  { name: 'Duolingo', category: 'learning', platform: ['web', 'ios', 'android'] },
  { name: 'Google Maps', category: 'navigation', platform: ['web', 'ios', 'android'] },
  { name: 'Uber', category: 'transportation', platform: ['ios', 'android'] },
  { name: 'Lyft', category: 'transportation', platform: ['ios', 'android'] },
  { name: 'Wise', category: 'finance', platform: ['web', 'ios', 'android'] },
  { name: 'PayPal', category: 'finance', platform: ['web', 'ios', 'android'] },
  { name: 'Revolut', category: 'finance', platform: ['web', 'ios', 'android'] },
  { name: 'Robinhood', category: 'finance', platform: ['web', 'ios', 'android'] },
  { name: 'Webull', category: 'finance', platform: ['web', 'ios', 'android'] },
  { name: 'AliExpress', category: 'shopping', platform: ['web', 'ios', 'android'] },
  { name: 'Temu', category: 'shopping', platform: ['web', 'ios', 'android'] },
  { name: 'Shopee', category: 'shopping', platform: ['web', 'ios', 'android'] },
  { name: 'Amazon Shopping', category: 'shopping', platform: ['web', 'ios', 'android'] },
  { name: 'Google Drive', category: 'cloud-storage', platform: ['web', 'desktop', 'ios', 'android'] },
  { name: 'Dropbox', category: 'cloud-storage', platform: ['web', 'desktop', 'ios', 'android'] },
  { name: 'iCloud Drive', category: 'cloud-storage', platform: ['web', 'ios', 'mac'] },
  { name: 'Google Photos', category: 'photo-storage', platform: ['web', 'ios', 'android'] },
  { name: 'Strava', category: 'fitness', platform: ['web', 'ios', 'android'] },
  { name: 'MyFitnessPal', category: 'fitness', platform: ['web', 'ios', 'android'] },
  { name: 'Calm', category: 'wellness', platform: ['ios', 'android'] },
  { name: 'Headspace', category: 'wellness', platform: ['ios', 'android'] },
];

function fatal(message) {
  console.error('[app-review-trend-redesign][FATAL]', message);
  process.exit(1);
}

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function lowerText(value) {
  return normalizeText(value).toLowerCase();
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    fatal(`target file not found: ${filePath}`);
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fatal(`failed to parse JSON: ${filePath} :: ${error.message}`);
  }
}

function writeJson(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function ensureObject(parent, key) {
  if (!parent[key] || typeof parent[key] !== 'object' || Array.isArray(parent[key])) {
    parent[key] = {};
  }

  return parent[key];
}

function ensureArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value == null) {
    return [];
  }

  return [value];
}

function getTrendItems(data) {
  if (Array.isArray(data.trend)) {
    return data.trend;
  }

  if (Array.isArray(data.items)) {
    return data.items;
  }

  if (Array.isArray(data.seeds)) {
    return data.seeds;
  }

  fatal('missing trend/items/seeds array');
}

function setTrendItems(data, items) {
  if (Array.isArray(data.trend)) {
    data.trend = items;
    return;
  }

  if (Array.isArray(data.items)) {
    data.items = items;
    return;
  }

  if (Array.isArray(data.seeds)) {
    data.seeds = items;
    return;
  }

  data.trend = items;
}

function createQuota(total) {
  const quota = {};
  let used = 0;

  for (const intent of INTENT_ORDER) {
    quota[intent] = Math.floor(total * TARGET_RATIO[intent]);
    used += quota[intent];
  }

  let remain = total - used;
  let index = 0;

  while (remain > 0) {
    quota[INTENT_ORDER[index % INTENT_ORDER.length]] += 1;
    remain -= 1;
    index += 1;
  }

  return quota;
}

function collectText(seed) {
  return [
    seed.title,
    seed.angle,
    seed.goal,
    seed.intent,
    seed.entity && seed.entity.name,
    seed.reviewEntity && seed.reviewEntity.name,
    Array.isArray(seed.keyPoints) ? seed.keyPoints.join(' ') : '',
    seed.trendContext && seed.trendContext.changeReason,
    seed.trendContext && seed.trendContext.marketSignal,
  ]
    .flat()
    .map(normalizeText)
    .join(' ');
}

function scoreSeed(seed) {
  const text = lowerText(collectText(seed));
  const scores = {
    'review/update': 0,
    'review/recheck': 0,
    'review/compare-now': 0,
    'review/still-worth': 0,
    'review/switch-or-keep': 0,
    'review/risk-watch': 0,
  };

  if (/update|changed|new feature|feature update|pricing|plan change|free-tier|policy/.test(text)) {
    scores['review/update'] += 10;
  }

  if (/recheck|again|still useful|revisit|current state|recently/.test(text)) {
    scores['review/recheck'] += 10;
  }

  if (/compare|alternative|competitor|versus|vs|switch from|compared with/.test(text)) {
    scores['review/compare-now'] += 10;
  }

  if (/worth|value|still worth|paying|keep using|regular use/.test(text)) {
    scores['review/still-worth'] += 10;
  }

  if (/switch|keep|leave|move to|cancel|replace/.test(text)) {
    scores['review/switch-or-keep'] += 10;
  }

  if (/risk|privacy|security|limitation|restriction|ads|trust|account/.test(text)) {
    scores['review/risk-watch'] += 10;
  }

  if (scores['review/update'] === 0 && /change|latest|recent/.test(text)) {
    scores['review/update'] += 3;
  }

  if (scores['review/recheck'] === 0) {
    scores['review/recheck'] += 1;
  }

  return scores;
}

function rankIntents(scores) {
  return INTENT_ORDER
    .map((intent) => ({ intent, score: scores[intent] || 0 }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return INTENT_ORDER.indexOf(a.intent) - INTENT_ORDER.indexOf(b.intent);
    });
}

function assignIntents(seeds) {
  const quota = createQuota(seeds.length);
  const used = {};
  const assigned = new Map();

  for (const intent of INTENT_ORDER) {
    used[intent] = 0;
  }

  const candidates = seeds.map((seed, index) => {
    const scores = scoreSeed(seed);
    const ranked = rankIntents(scores);
    const confidence = ranked[0].score - ranked[1].score;

    return {
      seed,
      index,
      ranked,
      confidence,
    };
  });

  candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }

    return a.index - b.index;
  });

  for (const item of candidates) {
    let picked = null;

    for (const rank of item.ranked) {
      if (used[rank.intent] < quota[rank.intent]) {
        picked = rank.intent;
        break;
      }
    }

    if (!picked) {
      for (const intent of INTENT_ORDER) {
        if (used[intent] < quota[intent]) {
          picked = intent;
          break;
        }
      }
    }

    if (!picked) {
      picked = 'review/recheck';
    }

    used[picked] += 1;
    assigned.set(item.seed, picked);
  }

  return {
    assigned,
    quota,
    used,
  };
}

function pickApp(index) {
  return APP_TREND_LIBRARY[index % APP_TREND_LIBRARY.length];
}

function pickReason(index) {
  return TREND_REASON_LIBRARY[index % TREND_REASON_LIBRARY.length];
}

function getPeriodLabel(index) {
  const quarter = (index % 4) + 1;
  return `2026-Q${quarter}`;
}

function getContextDate(index) {
  const month = String((index % 12) + 1).padStart(2, '0');
  return `2026-${month}`;
}

function buildTitle(intent, appName, reason, contextDate) {
  if (intent === 'review/update') {
    return `What changed in ${appName} after the ${contextDate} ${reason}?`;
  }

  if (intent === 'review/recheck') {
    return `Should you recheck ${appName} after recent changes?`;
  }

  if (intent === 'review/compare-now') {
    return `How does ${appName} compare now after ${reason}?`;
  }

  if (intent === 'review/still-worth') {
    return `Is ${appName} still worth using after ${reason}?`;
  }

  if (intent === 'review/switch-or-keep') {
    return `Should you keep using ${appName} after ${reason}?`;
  }

  if (intent === 'review/risk-watch') {
    return `What risks should users watch in ${appName} after ${reason}?`;
  }

  return `Should you recheck ${appName} after recent changes?`;
}

function buildAngle(intent, appName, reason, contextDate) {
  if (intent === 'review/update') {
    return `Review ${appName} as a time-stamped update record after the ${contextDate} ${reason}.`;
  }

  if (intent === 'review/recheck') {
    return `Recheck ${appName} because recent changes may affect the user’s previous decision.`;
  }

  if (intent === 'review/compare-now') {
    return `Compare ${appName} against alternatives in the current market context after ${reason}.`;
  }

  if (intent === 'review/still-worth') {
    return `Judge whether ${appName} still provides enough value after ${reason}.`;
  }

  if (intent === 'review/switch-or-keep') {
    return `Help users decide whether to keep using ${appName} or switch based on current signals.`;
  }

  if (intent === 'review/risk-watch') {
    return `Identify decision risks in ${appName} that became more relevant after ${reason}.`;
  }

  return `Review ${appName} as a current decision record rather than a timeless evergreen article.`;
}

function buildGoal(intent, appName, reason) {
  if (intent === 'review/update') {
    return `record what changed in ${appName} and how it affects current users`;
  }

  if (intent === 'review/recheck') {
    return `decide whether ${appName} deserves a fresh look after ${reason}`;
  }

  if (intent === 'review/compare-now') {
    return `compare ${appName} with current alternatives after ${reason}`;
  }

  if (intent === 'review/still-worth') {
    return `decide whether ${appName} is still worth using after ${reason}`;
  }

  if (intent === 'review/switch-or-keep') {
    return `decide whether to keep using ${appName} or switch after ${reason}`;
  }

  if (intent === 'review/risk-watch') {
    return `identify whether ${reason} creates new risk for ${appName} users`;
  }

  return `record the current decision context for ${appName}`;
}

function buildKeyPoints(intent, reason) {
  if (intent === 'review/update') {
    return [
      `what changed: ${reason}`,
      'who is affected by the change',
      'whether the change alters the previous recommendation',
    ];
  }

  if (intent === 'review/recheck') {
    return [
      'why the app deserves a fresh look now',
      `which decision factor changed: ${reason}`,
      'whether existing users should keep their previous choice',
    ];
  }

  if (intent === 'review/compare-now') {
    return [
      'which alternatives now look stronger or weaker',
      `how the comparison changed after ${reason}`,
      'what matters most for current users',
    ];
  }

  if (intent === 'review/still-worth') {
    return [
      `whether ${reason} changes the value calculation`,
      'which users still benefit most',
      'which users should reconsider',
    ];
  }

  if (intent === 'review/switch-or-keep') {
    return [
      'what existing users would lose by switching',
      `what changed because of ${reason}`,
      'when switching becomes reasonable',
    ];
  }

  if (intent === 'review/risk-watch') {
    return [
      `what risk became more visible after ${reason}`,
      'which users should be cautious',
      'what to verify before continuing',
    ];
  }

  return [
    'what changed recently',
    'who is affected',
    'what decision makes sense now',
  ];
}

function buildDecisionType(intent) {
  if (intent === 'review/update') {
    return 'test';
  }

  if (intent === 'review/recheck') {
    return 'test';
  }

  if (intent === 'review/compare-now') {
    return 'compare';
  }

  if (intent === 'review/still-worth') {
    return 'keep';
  }

  if (intent === 'review/switch-or-keep') {
    return 'keep-or-switch';
  }

  if (intent === 'review/risk-watch') {
    return 'watch';
  }

  return 'test';
}

function buildDecisionSummary(intent, appName, reason) {
  if (intent === 'review/update') {
    return `${appName} should be re-evaluated because ${reason} may change the practical recommendation.`;
  }

  if (intent === 'review/recheck') {
    return `${appName} remains a valid option, but users should recheck it because ${reason} changed the context.`;
  }

  if (intent === 'review/compare-now') {
    return `${appName} should be compared again because ${reason} may make alternatives more competitive.`;
  }

  if (intent === 'review/still-worth') {
    return `${appName} may still be worth using, but the value depends on how much ${reason} affects the user.`;
  }

  if (intent === 'review/switch-or-keep') {
    return `${appName} is not automatically obsolete, but users should compare the cost of staying against switching after ${reason}.`;
  }

  if (intent === 'review/risk-watch') {
    return `${appName} requires closer checking because ${reason} may increase user risk or friction.`;
  }

  return `${appName} should be treated as a time-stamped decision record.`;
}

function buildTrendContext(intent, app, reason, index) {
  const contextDate = getContextDate(index);
  const timing = getPeriodLabel(index);

  return {
    timing,
    contextDate,
    changeReason: reason,
    marketSignal: `${reason} created a current decision point for ${app.category} users`,
    decisionContext: `${app.name} needs a time-stamped review because ${reason}`,
    historicalValue: true,
    currentUse: 'current decision support',
    laterUse: 'historical comparison record',
    reviewWindow: '30-90 days',
    sourceType: 'curated trend seed design',
    intent,
  };
}

function buildFingerprint(seed) {
  const trendContext = ensureObject(seed, 'trendContext');

  const source = [
    normalizeText(seed.title).toLowerCase(),
    normalizeText(seed.angle).toLowerCase(),
    normalizeText(seed.audience).toLowerCase(),
    normalizeText(seed.intent).toLowerCase(),
    normalizeText(seed.goal).toLowerCase(),
    normalizeText(trendContext.timing).toLowerCase(),
    normalizeText(trendContext.contextDate).toLowerCase(),
    normalizeText(trendContext.changeReason).toLowerCase(),
  ].join('|');

  return `fp1:${crypto.createHash('sha1').update(source).digest('hex')}`;
}

function patchSeed(seed, intent, appIndex, reasonIndex, timingIndex) {
  let changed = 0;

  const app = pickApp(appIndex);
  const reason = pickReason(reasonIndex);
  const contextDate = getContextDate(timingIndex);

  const entity = ensureObject(seed, 'entity');
  if (entity.name !== app.name) {
    entity.name = app.name;
    changed += 1;
  }

  if (entity.type !== 'app') {
    entity.type = 'app';
    changed += 1;
  }

  if (entity.category !== app.category) {
    entity.category = app.category;
    changed += 1;
  }

  const platforms = ensureArray(app.platform);
  if (!Array.isArray(entity.platform) || entity.platform.join('|') !== platforms.join('|')) {
    entity.platform = platforms;
    changed += 1;
  }

  const reviewEntity = ensureObject(seed, 'reviewEntity');
  if (reviewEntity.name !== app.name) {
    reviewEntity.name = app.name;
    changed += 1;
  }

  if (reviewEntity.type !== 'app') {
    reviewEntity.type = 'app';
    changed += 1;
  }

  if (seed.intent !== intent) {
    seed.intent = intent;
    changed += 1;
  }

  const nextTitle = buildTitle(intent, app.name, reason, contextDate);
  const nextAngle = buildAngle(intent, app.name, reason, contextDate);
  const nextGoal = buildGoal(intent, app.name, reason);
  const nextKeyPoints = buildKeyPoints(intent, reason);
  const nextDecisionType = buildDecisionType(intent);
  const nextDecisionSummary = buildDecisionSummary(intent, app.name, reason);
  const nextTrendContext = buildTrendContext(intent, app, reason, timingIndex);

  if (seed.title !== nextTitle) {
    seed.title = nextTitle;
    changed += 1;
  }

  if (seed.angle !== nextAngle) {
    seed.angle = nextAngle;
    changed += 1;
  }

  if (seed.goal !== nextGoal) {
    seed.goal = nextGoal;
    changed += 1;
  }

  if (!Array.isArray(seed.keyPoints) || seed.keyPoints.join('|') !== nextKeyPoints.join('|')) {
    seed.keyPoints = nextKeyPoints;
    changed += 1;
  }

  if (seed.decisionType !== nextDecisionType) {
    seed.decisionType = nextDecisionType;
    changed += 1;
  }

  if (seed.decisionSummary !== nextDecisionSummary) {
    seed.decisionSummary = nextDecisionSummary;
    changed += 1;
  }

  const trendContext = ensureObject(seed, 'trendContext');
  for (const [key, value] of Object.entries(nextTrendContext)) {
    const current = Array.isArray(trendContext[key]) ? trendContext[key].join('|') : trendContext[key];
    const next = Array.isArray(value) ? value.join('|') : value;

    if (current !== next) {
      trendContext[key] = value;
      changed += 1;
    }
  }

  const criteria = ensureObject(seed, 'selectionCriteria');
  const nextCriteria = {
    recentUpdate: true,
    marketMovement: true,
    decisionRequired: true,
    historicalValue: true,
    timeStamped: true,
    changeReasonRequired: true,
    appTrendReview: true,
    notEvergreen: true,
    entityDistributed: true,
  };

  for (const [key, value] of Object.entries(nextCriteria)) {
    if (criteria[key] !== value) {
      criteria[key] = value;
      changed += 1;
    }
  }

  const meta = ensureObject(seed, 'selectionMeta');
  const nextMeta = {
    validated: true,
    sourceType: 'app trend time-stamped decision redesign rule',
    selectionReason: `redesigned as ${intent} because ${reason}`,
    schema: TREND_SCHEMA.schema,
    mode: TREND_SCHEMA.mode,
  };

  for (const [key, value] of Object.entries(nextMeta)) {
    if (meta[key] !== value) {
      meta[key] = value;
      changed += 1;
    }
  }

  if (!normalizeText(meta.selectedAt)) {
    meta.selectedAt = new Date().toISOString();
    changed += 1;
  }

  const nextFingerprint = buildFingerprint(seed);
  if (seed.fingerprint !== nextFingerprint) {
    seed.fingerprint = nextFingerprint;
    changed += 1;
  }

  return changed;
}

function buildIntentBuckets(seeds, assignment) {
  const buckets = {};

  for (const intent of INTENT_ORDER) {
    buckets[intent] = [];
  }

  for (const seed of seeds) {
    const intent = assignment.assigned.get(seed);
    const key = INTENT_ORDER.includes(intent) ? intent : 'review/recheck';
    buckets[key].push(seed);
  }

  return buckets;
}

function buildRoundRobinPlan(seeds, assignment) {
  const buckets = buildIntentBuckets(seeds, assignment);
  const plan = [];
  let moved = true;
  let globalIndex = 0;

  while (moved) {
    moved = false;

    for (let intentOffset = 0; intentOffset < INTENT_ORDER.length; intentOffset += 1) {
      const intent = INTENT_ORDER[intentOffset];
      const seed = buckets[intent].shift();

      if (!seed) {
        continue;
      }

      plan.push({
        seed,
        intent,
        appIndex: globalIndex,
        reasonIndex: globalIndex + intentOffset,
        timingIndex: globalIndex,
      });

      globalIndex += 1;
      moved = true;
    }
  }

  return plan;
}

function main() {
  console.log('[app-review-trend-redesign] start');
  console.log(`[app-review-trend-redesign] target = ${TARGET_FILE}`);

  const data = readJson(TARGET_FILE);

  if (data.label !== 'app-reviews') {
    fatal(`label mismatch: got=${data.label}, want=app-reviews`);
  }

  const items = getTrendItems(data).filter((seed) => seed && typeof seed === 'object');
  const assignment = assignIntents(items);
  const plan = buildRoundRobinPlan(items, assignment);

  let checked = 0;
  let changed = 0;

  for (const item of plan) {
    checked += 1;
    changed += patchSeed(
      item.seed,
      item.intent,
      item.appIndex,
      item.reasonIndex,
      item.timingIndex
    );
  }

  setTrendItems(data, plan.map((item) => item.seed));

  data.schema = data.schema || TREND_SCHEMA.schema;
  data.mode = 'trend';
  data.trendSchema = TREND_SCHEMA;
  data.updatedAt = new Date().toISOString();

  writeJson(TARGET_FILE, data);

  const byIntent = {};
  const byEntity = {};

  for (const seed of getTrendItems(data)) {
    const intent = normalizeText(seed && seed.intent) || 'missing';
    const entity = normalizeText(seed && seed.entity && seed.entity.name) || 'missing';

    byIntent[intent] = (byIntent[intent] || 0) + 1;
    byEntity[entity] = (byEntity[entity] || 0) + 1;
  }

  console.log('[app-review-trend-redesign] checked =', checked);
  console.log('[app-review-trend-redesign] changed =', changed);

  console.log('[app-review-trend-redesign] target quota =');
  for (const intent of INTENT_ORDER) {
    console.log(`  - ${intent}: ${assignment.quota[intent]}`);
  }

  console.log('[app-review-trend-redesign] actual distribution =');
  Object.keys(byIntent)
    .sort()
    .forEach((intent) => {
      console.log(`  - ${intent}: ${byIntent[intent]}`);
    });

  console.log('[app-review-trend-redesign] entity distribution top =');
  Object.keys(byEntity)
    .sort((a, b) => byEntity[b] - byEntity[a] || a.localeCompare(b))
    .slice(0, 12)
    .forEach((entity) => {
      console.log(`  - ${entity}: ${byEntity[entity]}`);
    });

  console.log('[app-review-trend-redesign] sample =');

  getTrendItems(data)
    .slice(0, 18)
    .forEach((seed) => {
      const ctx = seed.trendContext || {};
      const entity = seed.entity || {};
      console.log(`  - ${seed.id}: ${seed.intent} :: ${entity.name || 'no-entity'} :: ${seed.title} :: ${ctx.contextDate || 'no-date'}`);
    });

  console.log('[app-review-trend-redesign] done');
}

main();
