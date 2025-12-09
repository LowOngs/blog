// System_files/scripts/build/queue-to-posts.cjs
// dist/queue/today.json → content/posts/*.json 자동 생성기

const fs = require('fs');
const path = require('path');

// ────────────────────────────────────
//  경로 설정
// ────────────────────────────────────
const ROOT        = path.resolve(__dirname, '..', '..');           // System_files
const QUEUE_DIR   = path.join(ROOT, 'dist', 'queue');
const QUEUE_FILE  = path.join(QUEUE_DIR, 'today.json');
const CONTENT_DIR = path.join(ROOT, 'content', 'posts');

fs.mkdirSync(CONTENT_DIR, { recursive: true });

function log(...a) {
  console.log('[seed→post]', ...a);
}

// ────────────────────────────────────
//  프로필 로딩 (라벨 → profileId, profile 정의)
// ────────────────────────────────────
const SEEDPOOL_DIR        = path.join(ROOT, 'seedpool');
const PROFILES_DIR        = path.join(SEEDPOOL_DIR, 'profiles');
const LABELS_FILE         = path.join(PROFILES_DIR, 'labels.json');
const LABEL_PROFILES_FILE = path.join(PROFILES_DIR, 'label-profiles.json');

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
const PROFILE_DEFS        = safeReadJson(LABEL_PROFILES_FILE, {});

function getProfileIdForLabel(label) {
  const pid = LABEL_TO_PROFILE_ID[label];
  if (!pid) {
    log(`경고: 라벨에 대한 프로필 ID 없음 → label=${label}`);
    return null;
  }
  if (!PROFILE_DEFS[pid]) {
    log(`경고: 프로필 정의 누락 → label=${label}, profileId=${pid}`);
    return null;
  }
  return pid;
}

// ────────────────────────────────────
//  today.json 존재 여부 확인
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

const items = Array.isArray(queue.items) ? queue.items : [];
if (!items.length) {
  log('today.json 안에 items가 비어 있음. 건너뜀.');
  process.exit(0);
}

// ────────────────────────────────────
//  라벨 → 파일 prefix 매핑
//  (blogger.cjs 의 PREFIX_TO_CODE / CODE_TO_LABEL 와 일관성 유지)
// ────────────────────────────────────
const LABEL_TO_PREFIX = {
  'app-reviews':            'app',
  'device-reviews':         'device',
  'subscription-services':  'sub',
  'how-to-playbooks':       'howto',
  'smart-savings':          'smart',
  'templates-checklists':   'tpl'
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

let created = 0;
let skipped = 0;

for (const item of items) {
  const label   = item.label;
  const prefix  = LABEL_TO_PREFIX[label] || 'post';
  const ymd     = getDateString(item);

  if (!counters[label]) counters[label] = 1;
  else counters[label]++;

  const idx  = pad3(counters[label]);              // 001, 002, ...
  const slug = `${prefix}-${ymd}-${idx}`;          // 예: app-20251121-001

  const targetPath = path.join(CONTENT_DIR, `${slug}.json`);

  if (fs.existsSync(targetPath)) {
    log(`이미 존재 → ${path.basename(targetPath)} , 건너뜀.`);
    skipped++;
    continue;
  }

  const queueDate  = (item.date || queue.date || new Date().toISOString().slice(0, 10));
  const updatedISO = `${queueDate}T00:00:00+09:00`;

  const profileId = getProfileIdForLabel(label);

  const doc = {
    slug,
    title: item.title,
    description: item.angle || item.title,
    labels: [label],
    intent: item.intent || 'review',
    updated: updatedISO,
    aio: {
      tldr: [
        `This article is based on today's planned topic: "${item.title}".`,
        item.angle || 'It focuses on practical, real-world usage rather than theory.',
        `Written for: ${item.audience || 'general readers who want clear, simple guidance'}.`
      ],
      keyfacts: [
        `Label: ${label}, mode: ${item.mode || 'trend'}.`,
        `Priority: ${item.priority ?? 1}.`,
        'Sources will be added from official sites when the full article is written.'
      ],
      faq: [],
      sources: [],
      sourcesNote: '실제 글 작성 시에는 공식 사이트·공식 문서 등 최소 2개 이상 Sources에 추가.'
    },
    body: "",
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