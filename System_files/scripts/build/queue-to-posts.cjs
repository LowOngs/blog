// System_files/scripts/build/queue-to-posts.cjs
// dist/queue/today.json → content/posts/*.json
// ✅ SCHEDULE_MODE 제거
// - queue.bodyWriteMode / queue.publishMode 사용
// - 생성 자체는 항상 가능, 발급/발행 차단은 ids/publish 단계에서 통제

const fs = require('fs');
const path = require('path');

// ────────────────────────────────────
// 경로
// ────────────────────────────────────
const ROOT        = path.resolve(__dirname, '..', '..'); // System_files
const QUEUE_DIR   = path.join(ROOT, 'dist', 'queue');
const QUEUE_FILE  = path.join(QUEUE_DIR, 'today.json');
const CONTENT_DIR = path.join(ROOT, 'content', 'posts');

fs.mkdirSync(CONTENT_DIR, { recursive: true });

function log(...a) {
  console.log('[seed→post]', ...a);
}

// ────────────────────────────────────
// 프로필 로딩 (라벨 → profileId)
// ────────────────────────────────────
const SEEDPOOL_DIR = path.join(ROOT, 'seedpool');
const PROFILES_DIR = path.join(SEEDPOOL_DIR, 'profiles');
const LABELS_FILE  = path.join(PROFILES_DIR, 'labels.json');

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const LABEL_TO_PROFILE_ID = safeReadJson(LABELS_FILE, {});
const getProfileIdForLabel = (label) => LABEL_TO_PROFILE_ID[label] || null;

// ────────────────────────────────────
// today.json 로드
// ────────────────────────────────────
if (!fs.existsSync(QUEUE_FILE)) {
  log('today.json 없음 → 종료');
  process.exit(0);
}

let queue;
try {
  queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
} catch (e) {
  console.error('[seed→post] today.json 파싱 실패:', e.message || e);
  process.exit(1);
}

const bodyWriteMode = queue.bodyWriteMode || 'local';   // local | active
const publishMode   = queue.publishMode   || 'disable'; // disable | enable

log(`queue loaded → date=${queue.date || 'N/A'} bodyWriteMode=${bodyWriteMode} publishMode=${publishMode}`);

const items = Array.isArray(queue.items) ? queue.items : [];
if (!items.length) {
  log('items 비어 있음 → 종료');
  process.exit(0);
}

// ────────────────────────────────────
// 라벨 → 파일 prefix
// ────────────────────────────────────
const LABEL_TO_PREFIX = {
  'app-reviews':            'app',
  'device-reviews':         'device',
  'subscription-services':  'subscription',
  'how-to-playbooks':       'howto',
  'smart-savings':          'smartsavings',
  'templates-checklists':   'templates'
};

const counters = {};
const pad3 = (n) => String(n).padStart(3, '0');

function getDateString(item) {
  const base = item.date || queue.date || new Date().toISOString().slice(0, 10);
  return base.replace(/-/g, '');
}

function isoUtcMidnight(yyyymmdd) {
  const y = yyyymmdd.slice(0, 4);
  const m = yyyymmdd.slice(4, 6);
  const d = yyyymmdd.slice(6, 8);
  return `${y}-${m}-${d}T00:00:00Z`;
}

function buildBodyPrompt(item, label) {
  const title = (item.title || '').trim();
  const angle = (item.angle || '').trim();
  const audience = (item.audience || '').trim();
  const intent = (item.intent || '').trim();
  const notes = (item.notes || '').trim();

  return [
    'Write a complete blog post in English for an English-speaking audience.',
    'Use clear headings, short paragraphs, and practical examples.',
    '',
    `Title: ${title || '(Untitled)'}`,
    `Label: ${label}`,
    intent ? `Intent: ${intent}` : '',
    angle ? `Angle: ${angle}` : '',
    audience ? `Audience: ${audience}` : 'Audience: general readers who want clear, simple guidance',
    notes ? `Notes: ${notes}` : '',
    '',
    'Include:',
    '- Do NOT write TL;DR, Key Facts, FAQ, or Sources (they are injected separately).',
    '- Step-by-step guidance (when applicable)',
    '- Common mistakes and quick fixes',
    '- A concise conclusion'
  ].filter(Boolean).join('\n');
}

// ────────────────────────────────────
// 생성
// ────────────────────────────────────
let created = 0;
let skipped = 0;

for (const item of items) {
  const label   = item.label;
  const prefix  = LABEL_TO_PREFIX[label] || 'post';
  const ymd     = getDateString(item);

  counters[label] = (counters[label] || 0) + 1;
  const idx  = pad3(counters[label]);
  const slug = `${prefix}-${ymd}-${idx}`;

  const targetPath = path.join(CONTENT_DIR, `${slug}.json`);
  if (fs.existsSync(targetPath)) {
    log(`exists → ${slug}.json (skip)`);
    skipped++;
    continue;
  }

  const queueDate  = item.date || queue.date || new Date().toISOString().slice(0, 10);
  const ymdISO     = queueDate.replace(/-/g, '');
  const updatedISO = isoUtcMidnight(ymdISO);

  const profileId = getProfileIdForLabel(label);

  const doc = {
    slug,
    title: item.title,
    description: item.angle || item.title,
    labels: [label],
    intent: item.intent || 'review',
    updated: updatedISO,

    bodyPrompt: buildBodyPrompt(item, label),
    body: '',

    aio: {
      tldr: [],
      keyfacts: [],
      faq: [],
      sources: [],
      sourcesNote: 'Add at least 2 official sources when finalizing the post.'
    },

    seedMeta: {
      queueDate,
      label,
      mode: item.mode,
      profileId,
      id: item.id,
      angle: item.angle,
      audience: item.audience,
      intent: item.intent,
      priority: item.priority,
      notes: item.notes,
      bodyWriteMode,
      publishMode
    }
  };

  fs.writeFileSync(targetPath, JSON.stringify(doc, null, 2), 'utf8');
  log(`created ${slug}.json (bodyWriteMode=${bodyWriteMode}, publishMode=${publishMode})`);
  created++;
}

log(`done: created=${created}, skipped=${skipped}`);
