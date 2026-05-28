#!/usr/bin/env node
'use strict';

/**
 * ============================================================
 * System_files/scripts/build/queue-to-posts.cjs
 * ============================================================
 *
 * 역할(SSOT 기준):
 * - dist/queue/today.json 또는 trend.today.json 을 입력으로 받아
 *   content/posts/*.json (포스트 SSOT)을 "신규 생성만" 수행한다.
 *
 * trend 연동 추가:
 * - trend.today.json 지원
 * - trendQueue 입력 지원
 * - trend seed 메타 전달
 * - entity / trendContext / angle / audience 전달
 * - generate-content 연동용 bodyPrompt 강화
 *
 * 절대 하지 말아야 할 것:
 * - 기존 posts 덮어쓰기
 * - queue 구조 변경
 * - pageId 생성/수정
 */

require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const slugPolicy = require('./lib/slug-policy.cjs');

const {
  ALLOWED_LABEL_SET,
  assertAllowedLabel,
  getCanonicalPrefixByLabel,
  buildSlug,
} = slugPolicy;

/* ============================================================
 * 경로
 * ============================================================ */
const ROOT = path.resolve(__dirname, '..', '..');

const QUEUE_DIR = path.join(ROOT, 'dist', 'queue');

const DEFAULT_QUEUE_FILE = path.join(
  QUEUE_DIR,
  'today.json'
);

const TREND_QUEUE_FILE = path.join(
  QUEUE_DIR,
  'trend.today.json'
);

const QUEUE_EXPANDED_FILE = path.join(
  QUEUE_DIR,
  'today.expanded.json'
);

const CONTENT_DIR = path.join(
  ROOT,
  'content',
  'posts'
);

const MANIFESTS_DIR = path.join(
  ROOT,
  'manifests'
);

const ISSUE_SEQ_FILE = path.join(
  MANIFESTS_DIR,
  'issue-seq.json'
);

fs.mkdirSync(CONTENT_DIR, {
  recursive: true,
});

const MAX_NEW_POSTS_PER_DATE_LABEL = 1;

/* ============================================================
 * util
 * ============================================================ */
function log(...a) {
  console.log('[seed→post]', ...a);
}

function fatal(msg) {
  console.error('[seed→post][FATAL]', msg);
  process.exit(1);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, {
      recursive: true,
    });
  }
}

function normalizeText(v) {
  return String(v || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(file, 'utf8')
    );
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  const tmp = `${filePath}.tmp`;

  fs.writeFileSync(
    tmp,
    JSON.stringify(obj, null, 2) + '\n',
    'utf8'
  );

  fs.renameSync(tmp, filePath);
}

/* ============================================================
 * queue source 판별
 * ============================================================ */
function resolveQueueInput() {
  if (fs.existsSync(TREND_QUEUE_FILE)) {
    const trend = readJsonSafe(
      TREND_QUEUE_FILE,
      null
    );

    if (
      trend &&
      trend.type === 'trendQueue'
    ) {
      return {
        file: TREND_QUEUE_FILE,
        queue: trend,
        queueType: 'trendQueue',
      };
    }
  }

  if (!fs.existsSync(DEFAULT_QUEUE_FILE)) {
    return null;
  }

  const queue = readJsonSafe(
    DEFAULT_QUEUE_FILE,
    null
  );

  if (!queue) {
    return null;
  }

  return {
    file: DEFAULT_QUEUE_FILE,
    queue,
    queueType: 'schedulerQueue',
  };
}

/* ============================================================
 * label
 * ============================================================ */
const ALLOWED_LABELS =
  ALLOWED_LABEL_SET || new Set();

function isReviewLabel(label) {
  return (
    label === 'app-reviews' ||
    label === 'device-reviews' ||
    label === 'subscription-services'
  );
}

/* ============================================================
 * labels.json
 * ============================================================ */
const SEEDPOOL_DIR = path.join(
  ROOT,
  'seedpool'
);

const PROFILES_DIR = path.join(
  SEEDPOOL_DIR,
  'profiles'
);

const LABELS_FILE = path.join(
  PROFILES_DIR,
  'labels.json'
);

function loadLabelToProfileMapStrict() {
  if (!fs.existsSync(LABELS_FILE)) {
    fatal(
      `profile 매핑 SSOT 없음: ${LABELS_FILE}`
    );
  }

  let raw;

  try {
    raw = JSON.parse(
      fs.readFileSync(
        LABELS_FILE,
        'utf8'
      )
    );
  } catch (e) {
    fatal(
      `labels.json 파싱 실패: ${e.message || e}`
    );
  }

  const out = {};

  for (const [k, v] of Object.entries(raw)) {
    out[String(k).trim()] =
      String(v).trim();
  }

  return out;
}

const LABEL_TO_PROFILE_ID =
  loadLabelToProfileMapStrict();

function getProfileIdForLabel(label) {
  return LABEL_TO_PROFILE_ID[label] || null;
}

/* ============================================================
 * queue load
 * ============================================================ */
const queueInput = resolveQueueInput();

if (!queueInput) {
  log('queue 없음. 종료.');
  process.exit(0);
}

const QUEUE_FILE = queueInput.file;
const queue = queueInput.queue;
const queueType = queueInput.queueType;

const items = Array.isArray(queue.items)
  ? queue.items
  : [];

if (!items.length) {
  log('queue items 비어 있음.');
  process.exit(0);
}

/* ============================================================
 * validation
 * ============================================================ */
function requireValidLabel(label, idx) {
  const v = normalizeText(label);

  if (!v) {
    fatal(`items[${idx}] label 누락`);
  }

  if (!ALLOWED_LABELS.has(v)) {
    fatal(
      `items[${idx}] label 비정상: ${v}`
    );
  }

  try {
    assertAllowedLabel(
      v,
      `items[${idx}].label`
    );
  } catch (e) {
    fatal(e.message || String(e));
  }

  return v;
}

function requireValidTitle(title, idx) {
  const t = normalizeText(title);

  if (!t) {
    fatal(`items[${idx}] title 누락`);
  }

  return t;
}

/* ============================================================
 * date
 * ============================================================ */
function normalizeCutoff(v) {
  const s = normalizeText(v);

  return /^\d{2}:\d{2}$/.test(s)
    ? s
    : '10:00';
}

function resolveQueueDate(
  item,
  queueObj
) {
  const d = String(
    item?.date ||
    queueObj?.queueDate ||
    queueObj?.date ||
    ''
  ).slice(0, 10);

  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return d;
  }

  const now = new Date(
    Date.now() +
    9 * 60 * 60 * 1000
  );

  return now
    .toISOString()
    .slice(0, 10);
}

function resolveUpdatedIsoKst(
  queueDate,
  cutoffHHMM
) {
  return `${queueDate}T${cutoffHHMM}:00+09:00`;
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

/* ============================================================
 * ulid
 * ============================================================ */
function ulidNow() {
  return crypto
    .randomBytes(16)
    .toString('hex')
    .slice(0, 26);
}

/* ============================================================
 * expanded snapshot
 * ============================================================ */
function writeExpandedSnapshot(
  queueObj,
  expandedItems
) {
  const expanded = {
    ...queueObj,
    expandedAt:
      new Date().toISOString(),
    items: expandedItems,
  };

  fs.writeFileSync(
    QUEUE_EXPANDED_FILE,
    JSON.stringify(
      expanded,
      null,
      2
    ) + '\n',
    'utf8'
  );

  log(
    `expanded queue written → ${QUEUE_EXPANDED_FILE}`
  );
}

/* ============================================================
 * issue seq
 * ============================================================ */
function loadIssueSeq() {
  return readJsonSafe(
    ISSUE_SEQ_FILE,
    {
      version: 1,
      updatedAt: null,
      byDate: {},
    }
  );
}

function saveIssueSeq(seq) {
  ensureDir(MANIFESTS_DIR);

  fs.writeFileSync(
    ISSUE_SEQ_FILE,
    JSON.stringify(
      {
        ...seq,
        updatedAt:
          new Date().toISOString(),
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
}

function nextIndexFor(
  dateYYYYMMDD,
  label,
  seq
) {
  const d = String(
    dateYYYYMMDD
  ).slice(0, 10);

  if (!seq.byDate[d]) {
    seq.byDate[d] = {};
  }

  const next =
    Number(
      seq.byDate[d][label] || 0
    ) + 1;

  seq.byDate[d][label] = next;

  return next;
}

/* ============================================================
 * bodyPrompt
 * ============================================================ */
function buildBodyPrompt(
  item,
  label,
  queueDate
) {
  const lines = [
    `Title: ${normalizeText(item.title)}`,
    `Label: ${label}`,
    `QueueDate: ${queueDate}`,
  ];

  if (item.intent) {
    lines.push(
      `Intent: ${normalizeText(item.intent)}`
    );
  }

  if (item.angle) {
    lines.push(
      `Angle: ${normalizeText(item.angle)}`
    );
  }

  if (item.audience) {
    lines.push(
      `Audience: ${normalizeText(item.audience)}`
    );
  }

  if (item.goal) {
    lines.push(
      `Goal: ${normalizeText(item.goal)}`
    );
  }

  lines.push(
    '',
    'Write a practical and realistic article.',
    'Avoid robotic filler.',
    'Use natural human explanation.',
    'Focus on decision context and usefulness.'
  );

  return lines.join('\n');
}

/* ============================================================
 * main
 * ============================================================ */
const queueCutoff =
  normalizeCutoff(
    queue.cutoff || '10:00'
  );

const expandedItems = items.map(
  (it) =>
    (
      it &&
      typeof it === 'object'
    )
      ? { ...it }
      : it
);

const issueSeq = loadIssueSeq();

let created = 0;
let skipped = 0;

for (let i = 0; i < items.length; i++) {
  const item = items[i] || {};

  const outItem =
    expandedItems[i];

  const label =
    requireValidLabel(
      item.label,
      i
    );

  requireValidTitle(
    item.title,
    i
  );

  const canonicalPrefix =
    getCanonicalPrefixByLabel(
      label
    );

  const queueDate =
    resolveQueueDate(
      item,
      queue
    );

  const ymd =
    queueDate.replace(/-/g, '');

  const existingCount =
    0;

  if (
    queueType !== 'trendQueue' &&
    existingCount >=
      MAX_NEW_POSTS_PER_DATE_LABEL
  ) {
    skipped++;
    continue;
  }

  let slug = '';

  while (true) {
    const idx =
      nextIndexFor(
        queueDate,
        label,
        issueSeq
      );

    slug = buildSlug({
      label,
      yyyymmdd: ymd,
      index3: pad3(idx),
    });

    const targetPath =
      path.join(
        CONTENT_DIR,
        `${slug}.json`
      );

    if (!fs.existsSync(targetPath)) {
      break;
    }
  }

  const postId =
    ulidNow();

  const reviewId =
    isReviewLabel(label)
      ? ulidNow()
      : null;

  if (outItem) {
    outItem.generatedSlug =
      slug;

    outItem.postId =
      postId;

    if (
      isReviewLabel(label)
    ) {
      outItem.reviewId =
        reviewId;
    }
  }

  const profileId =
    getProfileIdForLabel(
      label
    );

  if (!profileId) {
    fatal(
      `profileId 없음: ${label}`
    );
  }

  const entity =
    item.entity &&
    typeof item.entity === 'object'
      ? item.entity
      : null;

  const doc = {
    postId,
    reviewId,

    slug,

    title:
      normalizeText(
        item.title
      ),

    labels: [label],

    updated:
      resolveUpdatedIsoKst(
        queueDate,
        queueCutoff
      ),

    bodyPrompt:
      buildBodyPrompt(
        item,
        label,
        queueDate
      ),

    body: '',

    entity,

    seedMeta: {
      queueDate,
      cutoff:
        queueCutoff,

      label,

      profileId,

      id:
        item.id ||
        null,

      intent:
        normalizeText(
          item.intent
        ) || null,

      angle:
        normalizeText(
          item.angle
        ) || null,

      audience:
        normalizeText(
          item.audience
        ) || null,

      goal:
        normalizeText(
          item.goal
        ) || null,

      fingerprint:
        normalizeText(
          item.fingerprint
        ) || null,

      rawConceptKey:
        normalizeText(
          item.seedMeta &&
          item.seedMeta
            .rawConceptKey
        ) || null,

      rawFingerprint:
        normalizeText(
          item.seedMeta &&
          item.seedMeta
            .rawFingerprint
        ) || null,

sourceLayer:
  normalizeText(
    item.seedMeta &&
    item.seedMeta
      .sourceLayer
  ) ||
  'entity-candidate-bridge',

trendBuilderLayer:
  normalizeText(
    item.seedMeta &&
    item.seedMeta
      .trendBuilderLayer
  ) || null,

queueBuilderLayer:
  normalizeText(
    item.seedMeta &&
    item.seedMeta
      .queueBuilderLayer
  ) || null,

trendContext:
  item.seedMeta &&
  item.seedMeta
    .trendContext
    ? item.seedMeta
        .trendContext
    : null,

classificationHints:
  item.seedMeta &&
  item.seedMeta
    .classificationHints
    ? item.seedMeta
        .classificationHints
    : null,

hardwareHints:
  item.seedMeta &&
  item.seedMeta
    .hardwareHints
    ? item.seedMeta
        .hardwareHints
    : null,

interactionHints:
  item.seedMeta &&
  item.seedMeta
    .interactionHints
    ? item.seedMeta
        .interactionHints
    : null,

maturityHints:
  item.seedMeta &&
  item.seedMeta
    .maturityHints
    ? item.seedMeta
        .maturityHints
    : null,

ecosystemHints:
  item.seedMeta &&
  item.seedMeta
    .ecosystemHints
    ? item.seedMeta
        .ecosystemHints
    : null,

evidence:
  item.seedMeta &&
  item.seedMeta
    .evidence
    ? item.seedMeta
        .evidence
    : null,
 
      entity,

      postId,
      reviewId,
    },
  };

  if (
    entity &&
    isReviewLabel(label)
  ) {
    doc.reviewEntity =
      entity;
  }

  const targetPath =
    path.join(
      CONTENT_DIR,
      `${slug}.json`
    );

  fs.writeFileSync(
    targetPath,
    JSON.stringify(
      doc,
      null,
      2
    ) + '\n',
    'utf8'
  );

  created++;
}

writeExpandedSnapshot(
  queue,
  expandedItems
);

saveIssueSeq(issueSeq);

log(
  `queueType=${queueType}`
);

log(
  `완료: created=${created}, skipped=${skipped}`
);
