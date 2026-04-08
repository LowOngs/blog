// System_files/scripts/build/firstgate-queue-to-post.cjs
// firstgate queue(dist/queue/firstgate.json) → content/posts/*.json 생성(labels 정규화)

require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DIST_QUEUE_DIR = path.join(ROOT, 'dist', 'queue');
const DIST_QUEUE_FILE = path.join(DIST_QUEUE_DIR, 'firstgate.json');
const CONTENT_POSTS_DIR = path.join(ROOT, 'content', 'posts');

/** firstgate에서 허용되는 라벨(6개) */
const ALLOWED_LABELS = new Set([
  'app-reviews',
  'device-reviews',
  'subscription-services',
  'how-to-playbooks',
  'smart-savings',
  'templates-checklists',
]);

function fatal(msg) {
  console.error('[firstgate-queue-to-post][FATAL]', msg);
  process.exit(1);
}

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
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

function writeJsonAtomic(p, data) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
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

function normalizeCutoff(v) {
  const s = String(v || '').trim();
  return /^\d{2}:\d{2}$/.test(s) ? s : '10:00';
}

function resolveUpdatedIsoKst(queueDate, cutoffHHMM) {
  return `${queueDate}T${cutoffHHMM}:00+09:00`;
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

function assertAllowedLabel(label, context) {
  const v = String(label || '').trim();
  if (!v) fatal(`label missing (${context})`);
  if (!ALLOWED_LABELS.has(v)) fatal(`label not allowed: "${v}" (${context})`);
  return v;
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

function normalizeQueueLabel(queue) {
  // 우선순위: queue.label → queue.seed.label
  const seed = queue.seed || {};
  const label = queue.label || seed.label || '';
  return assertAllowedLabel(label, 'queue file label');
}

/**
 * [국부 추가]
 * - 기존 firstgate post가 이미 있을 때도 운영 필수 메타만 최소 보강
 * - 기존 값은 유지하고, 없을 때만 채운다
 * - unrelated 필드 수정 금지
 */
function patchExistingPostMinimum(targetPath, label, queueDate, queueCutoff, nowIso) {
  const post = loadJson(targetPath);
  if (!post || typeof post !== 'object') {
    return { patched: false, reason: 'no-existing-doc' };
  }

  let changed = false;

  if (!post.seedMeta || typeof post.seedMeta !== 'object') {
    post.seedMeta = {};
    changed = true;
  }

  if (!String(post.seedMeta.queueDate || '').trim()) {
    post.seedMeta.queueDate = queueDate;
    changed = true;
  }

  if (!String(post.seedMeta.label || '').trim()) {
    post.seedMeta.label = label;
    changed = true;
  }

  if (!String(post.seedMeta.cutoff || '').trim()) {
    post.seedMeta.cutoff = queueCutoff;
    changed = true;
  }

  if (!String(post.updated || '').trim()) {
    post.updated = resolveUpdatedIsoKst(queueDate, queueCutoff);
    changed = true;
  }

  if (!String(post.updatedAt || '').trim()) {
    post.updatedAt = nowIso;
    changed = true;
  }

  if (!changed) {
    return { patched: false, reason: 'already-present' };
  }

  writeJsonAtomic(targetPath, post);
  return { patched: true, reason: 'patched-operational-meta' };
}

function main() {
  console.log('[firstgate-queue-to-post] Start');

  const queue = loadJson(DIST_QUEUE_FILE);
  if (!queue) {
    console.log(`[firstgate-queue-to-post] Queue not found: ${DIST_QUEUE_FILE}. Nothing to do.`);
    return;
  }

  if (queue.source !== 'firstgate') {
    console.log(`[firstgate-queue-to-post] source is not "firstgate" (source=${queue.source}). Nothing to do.`);
    return;
  }

  const label = normalizeQueueLabel(queue);
  const seed = queue.seed || {};
  const seedId = String(queue.seedId || seed.id || 'fg-unknown').trim();
  const queueDate = queue.date || getTodayUtcDate();
  const queueCutoff = normalizeCutoff(queue.cutoff || '10:00');
  const nowIso = nowUtcIso();

  const slug = buildSlug(label, seedId, queueDate);
  const filename = `${slug}.json`;
  const targetPath = path.join(CONTENT_POSTS_DIR, filename);

  if (fileExists(targetPath)) {
    const patchResult = patchExistingPostMinimum(
      targetPath,
      label,
      queueDate,
      queueCutoff,
      nowIso
    );

    console.log(`[firstgate-queue-to-post] Target already exists, skipping: ${targetPath}`);
    console.log(`[firstgate-queue-to-post] patched=${patchResult.patched} reason=${patchResult.reason}`);
    return;
  }

  // ✅ posts SSOT: labels만 사용(단일 label 필드 금지)
  const post = {
    slug,
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
      seedId,
      warehouseKey: `${label}::${seedId}`,
      pickedAt: queue.pickedAt || null,
      queueDate,
      cutoff: queueCutoff,

      // 라벨은 메타로만 유지(표시/추적용)
      label,

      priority: typeof seed.priority === 'number' ? seed.priority : null,
      angle: seed.angle || null,
      audience: seed.audience || null,
      notes: seed.notes || null,
    },

    createdAt: nowIso,
    updatedAt: nowIso,

    // [국부 추가] 후속 날짜 기반 파이프라인과 정합성 유지
    updated: resolveUpdatedIsoKst(queueDate, queueCutoff),
  };

  saveJson(targetPath, post);

  console.log(`[firstgate-queue-to-post] Created post JSON: ${targetPath}`);
  console.log(`[firstgate-queue-to-post] labels=[${label}]`);
  console.log('[firstgate-queue-to-post] Done');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[firstgate-queue-to-post] ERROR:', err && err.message ? err.message : err);
    process.exit(1);
  }
}
