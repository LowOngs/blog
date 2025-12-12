// System_files/scripts/build/firstgate-queue-to-post.cjs

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DIST_QUEUE_DIR = path.join(ROOT, 'dist', 'queue');
const DIST_QUEUE_FILE = path.join(DIST_QUEUE_DIR, 'firstgate.json');
const CONTENT_POSTS_DIR = path.join(ROOT, 'content', 'posts');

function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function loadJson(p) {
  if (!fileExists(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

function saveJson(p, data) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

function getTodayUtcDate() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function nowUtcIso() {
  return new Date().toISOString();
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildSlug(label, seedId, date) {
  const base = `firstgate ${label} ${seedId} ${date}`;
  return slugify(base);
}

function buildBodyPrompt(label, seed) {
  const title = seed.title || '';
  const angle = seed.angle || '';
  const audience = seed.audience || '';
  const intent = seed.intent || '';
  const notes = seed.notes || '';

  return [
    `Write a complete blog post in English for a tech/product blog.`,
    `The post should be based on the following seed:`,
    ``,
    `Title: ${title}`,
    `Label: ${label}`,
    `Intent: ${intent}`,
    `Angle: ${angle}`,
    `Audience: ${audience}`,
    notes ? `Notes: ${notes}` : '',
    ``,
    `Use a clear structure with headings, short paragraphs,`,
    `and practical value for readers who discover this page first.`,
  ]
    .filter(Boolean)
    .join('\n');
}

function main() {
  console.log('[firstgate-queue-to-post] Start');

  const queue = loadJson(DIST_QUEUE_FILE);
  if (!queue) {
    console.log(
      `[firstgate-queue-to-post] Queue file not found: ${DIST_QUEUE_FILE}. Nothing to do.`
    );
    return;
  }

  if (queue.source !== 'firstgate') {
    console.log(
      `[firstgate-queue-to-post] Queue source is not "firstgate" (source=${queue.source}). Nothing to do.`
    );
    return;
  }

  const label = queue.label;
  const seed = queue.seed || {};
  const seedId = queue.seedId || seed.id || 'fg-unknown';
  const queueDate = queue.date || getTodayUtcDate();
  const nowIso = nowUtcIso();

  const slug = buildSlug(label, seedId, queueDate);
  const filename = `${slug}.json`;
  const targetPath = path.join(CONTENT_POSTS_DIR, filename);

  if (fileExists(targetPath)) {
    console.log(
      `[firstgate-queue-to-post] Target file already exists, skipping: ${targetPath}`
    );
    return;
  }

  const post = {
    slug,
    label,
    labels: [label],
    title: seed.title || '(Untitled)',
    tldr: '',
    body: '',
    bodyPrompt: buildBodyPrompt(label, seed),
    intent: seed.intent || '',
    faq: [],
    sources: [],
    isFirstGate: true,
    seedMeta: {
      source: 'firstgate',
      label,
      seedId,
      warehouseKey: `${label}::${seedId}`,
      pickedAt: queue.pickedAt || null,
      queueDate,
      priority:
        typeof seed.priority === 'number' ? seed.priority : null,
      angle: seed.angle || null,
      audience: seed.audience || null,
      notes: seed.notes || null,
    },
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  saveJson(targetPath, post);

  console.log(
    `[firstgate-queue-to-post] Created post JSON: ${targetPath}`
  );
  console.log('[firstgate-queue-to-post] Done');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(
      '[firstgate-queue-to-post] ERROR:',
      err && err.message
    );
    process.exit(1);
  }
}
