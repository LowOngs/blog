
#!/usr/bin/env node
'use strict';

require('./lib/env.cjs'); // ✅ .env 로드(필수)

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const SSOT_PATH = path.join(ROOT, 'content', 'reviews', 'review-ratings.json');

const STRICT = String(process.env.STRICT_REVIEW_SSOT || '').trim().toLowerCase() === 'true';

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return { ok: false, err: 'file_not_found', data: null };
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { ok: true, err: null, data };
  } catch (e) {
    return { ok: false, err: 'json_parse_error: ' + (e && e.message ? e.message : 'unknown'), data: null };
  }
}

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isFiniteNum(v) {
  return Number.isFinite(Number(v));
}

function warn(msg) {
  console.warn('[validate-review-ssot][WARN]', msg);
}

function info(msg) {
  console.log('[validate-review-ssot]', msg);
}

function validateEntry(slug, ent) {
  const issues = [];

  if (!isObj(ent)) {
    issues.push('entry_not_object');
    return issues;
  }

  // 최소: ratingCurrent/votesCurrent/ratingPrevious/votesPrevious 중 하나라도 있어야 함
  const hasAny =
    ent.ratingCurrent !== undefined ||
    ent.votesCurrent !== undefined ||
    ent.ratingPrevious !== undefined ||
    ent.votesPrevious !== undefined;

  if (!hasAny) issues.push('missing_rating_votes_all');

  if (ent.ratingCurrent !== undefined && !isFiniteNum(ent.ratingCurrent)) issues.push('ratingCurrent_not_number');
  if (ent.ratingPrevious !== undefined && !isFiniteNum(ent.ratingPrevious)) issues.push('ratingPrevious_not_number');
  if (ent.votesCurrent !== undefined && !isFiniteNum(ent.votesCurrent)) issues.push('votesCurrent_not_number');
  if (ent.votesPrevious !== undefined && !isFiniteNum(ent.votesPrevious)) issues.push('votesPrevious_not_number');

  if (ent.histogram !== undefined) {
    if (!isObj(ent.histogram)) issues.push('histogram_not_object');
    else {
      for (const k of ['1', '2', '3', '4', '5']) {
        if (ent.histogram[k] === undefined) continue;
        const v = Number(ent.histogram[k]);
        if (!Number.isFinite(v)) issues.push(`histogram_${k}_not_number`);
        else if (v < 0 || v > 100) issues.push(`histogram_${k}_out_of_range`);
      }
    }
  }

  if (ent.insights !== undefined) {
    if (!Array.isArray(ent.insights)) issues.push('insights_not_array');
  }

  // source 단일 필드 권장(없어도 경고만)
  if (ent.source !== undefined && typeof ent.source !== 'string') issues.push('source_not_string');

  // lastChecked (있으면 string)
  if (ent.lastChecked !== undefined && typeof ent.lastChecked !== 'string') issues.push('lastChecked_not_string');

  // nextCheck 금지(실수 방지)
  if (ent.nextCheck !== undefined) issues.push('nextCheck_should_not_exist');

  return issues;
}

function main() {
  info('────────────────────────────────────────────');
  info('ROOT      = ' + ROOT);
  info('SSOT_PATH = ' + SSOT_PATH);
  info('STRICT    = ' + (STRICT ? 'true' : 'false'));
  info('────────────────────────────────────────────');

  const r = readJsonSafe(SSOT_PATH);
  if (!r.ok) {
    warn(`cannot_read_ssot: ${r.err}`);
    if (STRICT) process.exitCode = 1;
    return;
  }

  const ssot = r.data;
  if (!isObj(ssot)) {
    warn('ssot_root_not_object');
    if (STRICT) process.exitCode = 1;
    return;
  }

  const bySlug = ssot.bySlug;
  if (!isObj(bySlug)) {
    warn('missing_bySlug_object');
    if (STRICT) process.exitCode = 1;
    return;
  }

  const slugs = Object.keys(bySlug);
  if (slugs.length === 0) warn('bySlug_empty');

  let bad = 0;
  for (const slug of slugs) {
    const issues = validateEntry(slug, bySlug[slug]);
    if (issues.length) {
      bad++;
      warn(`slug=${slug} issues=${issues.join(',')}`);
    }
  }

  info(`checked=${slugs.length}, issues=${bad}`);

  if (STRICT && bad > 0) process.exitCode = 1;
}

if (require.main === module) main();
