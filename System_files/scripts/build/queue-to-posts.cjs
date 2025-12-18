// System_files/scripts/build/queue-to-posts.cjs
// dist/queue/today.json → content/posts/*.json 자동 생성기
// ✅ SCHEDULE_MODE 완전 제거 (이제 queue에는 mode가 없습니다)

const fs = require('fs');
const path = require('path');

const ROOT        = path.resolve(__dirname, '..', '..'); // System_files
const QUEUE_DIR   = path.join(ROOT, 'dist', 'queue');
const QUEUE_FILE  = path.join(QUEUE_DIR, 'today.json');
const CONTENT_DIR = path.join(ROOT, 'content', 'posts');

fs.mkdirSync(CONTENT_DIR, { recursive: true });

function log(...a) {
  console.log('[seed→post]', ...a);
}

// ────────────────────────────────────
// 프로필 로딩 (라벨 → profileId 매핑만 사용)
// ────────────────────────────────────
const SEEDPOOL_DIR = path.join(ROOT, 'seedpool');
const PROFILES_DIR = path.join(SEEDPOOL_DIR, 'profiles');
const LABELS_FILE  = path.join(PROFILES_DIR, 'labels.json');

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      log(`경고: ${path.basename(file)} 없음, 기본값 사용.`);
      return fallback;
    }
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[seed→post]', path.basename(file), '읽기/파싱 실패:', e.message || e);
    return fallback;
  }
}

const LABEL_TO_PROFILE_ID = safeReadJson(LABELS_FILE, {});

function getProfileIdForLabel(label) {
  const pid = LABEL_TO_PROFILE_ID[label];
  if (!pid) {
    log(`경고: 라벨에 대한 프로필 ID 없음 → label=${label}`);
    return null;
  }
  return pid;
}

// ────────────────────────────────────
// today.json 로드
// ────────────────────────────────────
if (!fs.existsSync(QUEUE_FILE)) {
  log('today.json 없음. 생성할 포스트가 없어 건너뜀.');
  process.exit(0);
}

let queue;
try {
  const raw = fs.readFileSync(QUEUE_FILE, 'utf8');
  queue = JSON.parse(raw);
} catch (e) {
  console.error('[seed→post] today.json 파싱 실패:', e.message || e);
  process.exit(1);
}

log(`today.json 로드 완료 → date=${queue.date || 'N/A'}`);

const items = Array.isArray(queue.items) ? queue.items : [];
if (!items.length) {
  log('today.json 안에 items가 비어 있음. 건너뜀.');
  process.exit(0);
}

// ────────────────────────────────────
// 라벨 → 파일 prefix 매핑
// (blogger.cjs와 prefix가 어긋나면 slug/라벨 추적이 꼬입니다)
// ────────────────────────────────────
const LABEL_TO_PREFIX = {
  'app-reviews':            'app',
  'device-reviews':         'device',
  'subscription-services':  'subscription',
  'how-to-playbooks':       'howto',
  'smart-savings':          'smartsavings',
  'templates-checklists':   'templates'
};

const counters = {}; // label별 일련번호

function pad3(n) {
  return String(n).padStart(3, '0');
}

// queue.date 또는 item.date, 없으면 오늘 날짜 사용
function getDateString(item) {
  const base =
    item.date ||
    queue.date ||
    new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  return base.replace(/-/g, ''); // "YYYYMMDD"
}

function isoUtcMidnight(dateYYYYMMDD) {
  const y = dateYYYYMMDD.slice(0, 4);
  const m = dateYYYYMMDD.slice(4, 6);
  const d = dateYYYYMMDD.slice(6, 8);
  return `${y}-${m}-${d}T00:00:00Z`;
}

function buildBodyPrompt(item, label) {
  const title = (item.title || '').trim();
  const angle = (item.angle || '').trim();
  const audience = (item.audience || '').trim();
  const intent = (item.intent || '').trim();
  const notes = (item.notes || '').trim();

  const lines = [
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
  ].filter(Boolean);

  return lines.join('\n');
}

let created = 0;
let skipped = 0;

for (const item of items) {
  const label   = item.label;
  const prefix  = LABEL_TO_PREFIX[label] || 'post';
  const ymd     = getDateString(item);

  if (!counters[label]) counters[label] = 1;
  else counters[label]++;

  const idx  = pad3(counters[label]);
  const slug = `${prefix}-${ymd}-${idx}`;

  const targetPath = path.join(CONTENT_DIR, `${slug}.json`);

  if (fs.existsSync(targetPath)) {
    log(`이미 존재 → ${path.basename(targetPath)} , 건너뜀.`);
    skipped++;
    continue;
  }

  const queueDate  = (item.date || queue.date || new Date().toISOString().slice(0, 10));
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

    // 본문 생성기용 프롬프트 (없으면 generate-body가 스킵됨)
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
      label: item.label,
      mode: item.mode,
      profileId,
      id: item.id,
      angle: item.angle,
      audience: item.audience,
      intent: item.intent,
      priority: item.priority,
      notes: item.notes
    }
  };

  fs.writeFileSync(targetPath, JSON.stringify(doc, null, 2), 'utf8');
  log(`created ${path.basename(targetPath)} from seed id=${item.id}`);
  created++;
}

log(`완료: created=${created}, skipped=${skipped}`);
