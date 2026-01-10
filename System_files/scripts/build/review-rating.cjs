#!/usr/bin/env node
'use strict';

/** review-rating: app-ratings 스냅샷 → review-ratings(SSOT) bySlug 갱신(기존 insights/histogram 보존) */

require('./lib/env.cjs');

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SRC_PATH = path.join(ROOT, 'content', 'reviews', 'app-ratings.json');
const OUT_PATH = path.join(ROOT, 'content', 'reviews', 'review-ratings.json');

function log(...a) {
  console.log('[review-rating]', ...a);
}

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonPretty(p, obj) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function toIso(v) {
  return v ? String(v) : new Date().toISOString();
}

function parseDateMs(yyyyMMdd) {
  // yyyy-mm-dd
  const t = Date.parse(`${yyyyMMdd}T00:00:00Z`);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * latest 기준 90일 전 근처(previous) 스냅샷 선택
 * - targetMs = latestMs - 90days
 * - targetMs 이하 중 가장 가까운 스냅샷
 */
function pickPreviousSnapshot(snaps, latestMs) {
  const targetMs = latestMs - 90 * 86400000;

  const candidates = snaps
    .map(s => ({ s, ms: parseDateMs(s.date) }))
    .filter(x => x.ms > 0 && x.ms <= targetMs);

  if (!candidates.length) return null;

  candidates.sort((a, b) => Math.abs(targetMs - a.ms) - Math.abs(targetMs - b.ms));
  return candidates[0].s;
}

function main() {
  log('────────────────────────────────────────────');
  log('SRC =', SRC_PATH);
  log('OUT =', OUT_PATH);

  const src = readJsonSafe(SRC_PATH, []);
  if (!Array.isArray(src) || src.length === 0) {
    log('WARN: app-ratings.json 비어있음 → 종료');
    return;
  }

  const base = readJsonSafe(OUT_PATH, { bySlug: {} });
  const bySlug = (base && typeof base.bySlug === 'object' && base.bySlug) ? base.bySlug : {};

  let updated = 0;
  let skipped = 0;

  for (const item of src) {
    if (!item || !item.slug) continue;

    const slug = String(item.slug).trim();
    const snapshots = Array.isArray(item.snapshots) ? item.snapshots : [];

    const valid = snapshots
      .filter(s =>
        s &&
        typeof s.date === 'string' &&
        s.date.length === 10 &&
        typeof s.rating === 'number' &&
        typeof s.votes === 'number'
      )
      .sort((a, b) => (a.date > b.date ? 1 : -1));

    if (!valid.length) {
      skipped++;
      continue;
    }

    const latest = valid[valid.length - 1];
    const latestMs = parseDateMs(latest.date);
    const prev = pickPreviousSnapshot(valid, latestMs);

    const prevRating = prev ? Number(prev.rating) : null;
    const prevVotes = prev ? Number(prev.votes) : null;

    const curRating = Number(latest.rating);
    const curVotes = Number(latest.votes);

    const ratingDiff = (prevRating === null) ? null : (curRating - prevRating);
    const votesDiff = (prevVotes === null) ? null : (curVotes - prevVotes);

    const existed = bySlug[slug] && typeof bySlug[slug] === 'object' ? bySlug[slug] : {};

    // ✅ 기존 histogram/insights 보존
    const next = {
      ...existed,
      lastChecked: toIso(latest.date),
      status: item.status || existed.status || 'ok',
      store: item.store || existed.store || item.platform || 'multi',

      ratingCurrent: curRating,
      votesCurrent: curVotes,

      ratingPrevious: prevRating,
      votesPrevious: prevVotes,

      ratingDiff,
      votesDiff,

      // histogram/insights는 기존 값 유지(없으면 그대로 없음)
      histogram: existed.histogram || null,
      insights: Array.isArray(existed.insights) ? existed.insights : [],
      source: item.source || existed.source || 'manual',
    };

    const before = JSON.stringify(existed);
    const after = JSON.stringify(next);

    if (before !== after) {
      bySlug[slug] = next;
      updated++;
    }
  }

  const out = {
    meta: {
      updatedAt: new Date().toISOString(),
      source: 'review-rating.cjs',
    },
    bySlug,
  };

  writeJsonPretty(OUT_PATH, out);

  log('────────────────────────────────────────────');
  log(`DONE: updated=${updated}, skipped(no snapshots)=${skipped}, total=${src.length}`);
}

main();
