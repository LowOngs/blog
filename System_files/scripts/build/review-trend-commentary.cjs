#!/usr/bin/env node
'use strict';

require('./lib/env.cjs');

/**
 * ============================================================
 * File: System_files/scripts/build/review-trend-commentary.cjs
 * Role: Review metrics snapshot append + trend commentary generator
 * ============================================================
 *
 * 목적
 * - review-ratings.json 현재 수치를 history jsonl 원장에 append 저장
 * - 저장된 수치 원장을 기반으로 90일 단위(90/180/270/360) 통계 해설 생성
 * - 원본 review SSOT를 직접 수정하지 않고 별도 산출물로 분리
 *
 * 모드
 * - REVIEW_TREND_MODE=snapshot   → 현재 스냅샷만 history에 append
 * - REVIEW_TREND_MODE=commentary → history만 읽어서 commentary 생성
 * - REVIEW_TREND_MODE=both       → snapshot + commentary (기본)
 *
 * 출력 산출물
 * - content/reviews/review-metrics-history.jsonl      (append-only 원장)
 * - content/reviews/review-trend-commentary.json      (생성 결과)
 *
 * 원칙
 * - review 본문 텍스트 분석 금지
 * - 원인 추정 금지
 * - 숫자 변화/분포/안정성 해설만 허용
 * - 거짓 없는 보수적 표현 유지
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const REVIEWS_DIR = path.join(ROOT, 'content', 'reviews');

const REVIEW_SSOT_FILE = path.join(REVIEWS_DIR, 'review-ratings.json');
const HISTORY_FILE = path.join(REVIEWS_DIR, 'review-metrics-history.jsonl');
const COMMENTARY_FILE = path.join(REVIEWS_DIR, 'review-trend-commentary.json');

const MODE = String(process.env.REVIEW_TREND_MODE || 'both').trim().toLowerCase();
const ALLOWED_MODES = new Set(['snapshot', 'commentary', 'both']);
const WINDOWS = [90, 180, 270, 360];

if (!ALLOWED_MODES.has(MODE)) {
  console.error('[review-trend-commentary][FATAL] invalid REVIEW_TREND_MODE:', MODE);
  process.exit(1);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function appendLine(p, line) {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, `${line}\n`, 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function todayKstYmd() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function normStr(v) {
  return String(v == null ? '' : v).trim();
}

function normalizeDateYmd(v) {
  const s = normStr(v);
  if (!s) return '';
  const ymd = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : '';
}

function parseDateYmd(ymd) {
  const s = normalizeDateYmd(ymd);
  if (!s) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetweenYmd(aYmd, bYmd) {
  const a = parseDateYmd(aYmd);
  const b = parseDateYmd(bYmd);
  if (!a || !b) return null;
  return Math.floor((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

function toNonNegativeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function round1(v) {
  return Math.round(Number(v || 0) * 10) / 10;
}

function formatRating(v) {
  const n = round1(toNonNegativeNumber(v));
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

function formatInt(v) {
  return Math.round(toNonNegativeNumber(v)).toLocaleString('en-US');
}

function ensureHistogram(v) {
  const src = v && typeof v === 'object' ? v : {};
  return {
    '1': toNonNegativeNumber(src['1']),
    '2': toNonNegativeNumber(src['2']),
    '3': toNonNegativeNumber(src['3']),
    '4': toNonNegativeNumber(src['4']),
    '5': toNonNegativeNumber(src['5']),
  };
}

function sumHistogram(hist) {
  return ['1', '2', '3', '4', '5'].reduce((acc, k) => acc + toNonNegativeNumber(hist[k]), 0);
}

function hashInt(seed) {
  const h = crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 8);
  return parseInt(h, 16);
}

function pickVariant(seed, arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  const idx = hashInt(seed) % arr.length;
  return arr[idx];
}

function dedupeStrings(list) {
  const out = [];
  const seen = new Set();

  for (const raw of Array.isArray(list) ? list : []) {
    const s = normStr(raw);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }

  return out;
}

function isReviewSlug(slug) {
  const s = normStr(slug).toLowerCase();
  return s.startsWith('app-') || s.startsWith('device-') || s.startsWith('subscription-');
}

function readHistoryJsonl(p) {
  if (!fs.existsSync(p)) return [];

  const raw = fs.readFileSync(p, 'utf8');
  const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

  const out = [];
  for (const line of lines) {
    try {
      const j = JSON.parse(line);
      if (j && typeof j === 'object') out.push(j);
    } catch {
      // skip broken line
    }
  }
  return out;
}

function normalizeHistoryRecord(rec) {
  const slug = normStr(rec.slug);
  const effectiveDate = normalizeDateYmd(rec.effectiveDate || rec.lastChecked || rec.capturedAt);
  if (!slug || !effectiveDate) return null;

  return {
    slug,
    capturedAt: normStr(rec.capturedAt) || nowIso(),
    effectiveDate,
    bucket: normStr(rec.bucket),
    status: normStr(rec.status).toLowerCase(),
    store: normStr(rec.store).toLowerCase(),
    source: normStr(rec.source).toLowerCase(),
    storeId: normStr(rec.storeId),
    ratingCurrent: toNonNegativeNumber(rec.ratingCurrent),
    votesCurrent: toNonNegativeNumber(rec.votesCurrent),
    histogram: ensureHistogram(rec.histogram),
    histogramMetaSource: normStr(rec.histogramMetaSource || rec.histogramSource || '').toLowerCase(),
  };
}

function buildCurrentSnapshotRecords() {
  const ssot = readJsonSafe(REVIEW_SSOT_FILE, { bySlug: {} });
  const bySlug = ssot && typeof ssot === 'object' && ssot.bySlug && typeof ssot.bySlug === 'object'
    ? ssot.bySlug
    : {};

  const capturedAt = nowIso();
  const out = [];

  for (const [slug, raw] of Object.entries(bySlug)) {
    if (!isReviewSlug(slug)) continue;
    if (!raw || typeof raw !== 'object') continue;

    const effectiveDate =
      normalizeDateYmd(raw.lastChecked) ||
      normalizeDateYmd(raw.updatedAt) ||
      todayKstYmd();

    out.push({
      slug,
      capturedAt,
      effectiveDate,
      bucket: normStr(raw.bucket),
      status: normStr(raw.status).toLowerCase(),
      store: normStr(raw.store).toLowerCase(),
      source: normStr(raw.source).toLowerCase(),
      storeId: normStr(raw.storeId),
      ratingCurrent: toNonNegativeNumber(raw.ratingCurrent),
      votesCurrent: toNonNegativeNumber(raw.votesCurrent),
      histogram: ensureHistogram(raw.histogram),
      histogramMetaSource: normStr(raw.histogramMeta && raw.histogramMeta.source).toLowerCase(),
    });
  }

  return out;
}

function sameSnapshot(a, b) {
  if (!a || !b) return false;

  return (
    a.slug === b.slug &&
    a.effectiveDate === b.effectiveDate &&
    round1(a.ratingCurrent) === round1(b.ratingCurrent) &&
    Math.round(a.votesCurrent) === Math.round(b.votesCurrent) &&
    JSON.stringify(ensureHistogram(a.histogram)) === JSON.stringify(ensureHistogram(b.histogram)) &&
    normStr(a.status) === normStr(b.status) &&
    normStr(a.store) === normStr(b.store) &&
    normStr(a.source) === normStr(b.source) &&
    normStr(a.storeId) === normStr(b.storeId)
  );
}

function appendCurrentSnapshots() {
  ensureDir(path.dirname(HISTORY_FILE));

  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, '', 'utf8');
  }

  const existing = readHistoryJsonl(HISTORY_FILE)
    .map(normalizeHistoryRecord)
    .filter(Boolean);

  const latestBySlug = new Map();
  for (const rec of existing) {
    const prev = latestBySlug.get(rec.slug);
    if (!prev) {
      latestBySlug.set(rec.slug, rec);
      continue;
    }

    const prevKey = `${prev.effectiveDate}|${prev.capturedAt}`;
    const currKey = `${rec.effectiveDate}|${rec.capturedAt}`;
    if (currKey > prevKey) latestBySlug.set(rec.slug, rec);
  }

  const current = buildCurrentSnapshotRecords();

  let appended = 0;
  let skippedSame = 0;

  for (const rec of current) {
    const latest = latestBySlug.get(rec.slug);
    if (latest && sameSnapshot(latest, rec)) {
      skippedSame += 1;
      continue;
    }

    appendLine(HISTORY_FILE, JSON.stringify(rec));
    appended += 1;
  }

  return {
    scanned: current.length,
    appended,
    skippedSame,
  };
}

function groupHistoryBySlug() {
  const rows = readHistoryJsonl(HISTORY_FILE)
    .map(normalizeHistoryRecord)
    .filter(Boolean);

  const bySlug = new Map();

  for (const rec of rows) {
    if (!bySlug.has(rec.slug)) bySlug.set(rec.slug, []);
    bySlug.get(rec.slug).push(rec);
  }

  for (const [slug, arr] of bySlug.entries()) {
    arr.sort((a, b) => {
      const ka = `${a.effectiveDate}|${a.capturedAt}`;
      const kb = `${b.effectiveDate}|${b.capturedAt}`;
      return ka.localeCompare(kb);
    });

    const dedup = [];
    const lastByDate = new Map();
    for (const rec of arr) {
      lastByDate.set(rec.effectiveDate, rec);
    }
    for (const rec of Array.from(lastByDate.values()).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))) {
      dedup.push(rec);
    }
    bySlug.set(slug, dedup);
  }

  return bySlug;
}

function pickBaselineForWindow(records, latest, windowDays) {
  const latestDate = latest.effectiveDate;
  let best = null;

  for (const rec of records) {
    if (rec.effectiveDate >= latestDate) continue;

    const diff = daysBetweenYmd(rec.effectiveDate, latestDate);
    if (diff == null) continue;
    if (diff < windowDays) continue;

    if (!best) {
      best = rec;
      continue;
    }

    if (rec.effectiveDate > best.effectiveDate) {
      best = rec;
    }
  }

  return best;
}

function analyzeWindow(latest, baseline, windowDays) {
  if (!latest || !baseline) return null;

  const coverageDays = daysBetweenYmd(baseline.effectiveDate, latest.effectiveDate);
  if (coverageDays == null || coverageDays < windowDays) return null;

  const ratingDelta = round1(latest.ratingCurrent - baseline.ratingCurrent);
  const votesDelta = Math.round(latest.votesCurrent - baseline.votesCurrent);

  const latestHigh = toNonNegativeNumber(latest.histogram['4']) + toNonNegativeNumber(latest.histogram['5']);
  const latestLow = toNonNegativeNumber(latest.histogram['1']) + toNonNegativeNumber(latest.histogram['2']);
  const baseHigh = toNonNegativeNumber(baseline.histogram['4']) + toNonNegativeNumber(baseline.histogram['5']);
  const baseLow = toNonNegativeNumber(baseline.histogram['1']) + toNonNegativeNumber(baseline.histogram['2']);

  const highDelta = Math.round(latestHigh - baseHigh);
  const lowDelta = Math.round(latestLow - baseLow);

  const histogramComparable =
    normStr(latest.histogramMetaSource) !== 'estimated' &&
    normStr(baseline.histogramMetaSource) !== 'estimated' &&
    sumHistogram(latest.histogram) > 0 &&
    sumHistogram(baseline.histogram) > 0;

  return {
    windowDays,
    latestDate: latest.effectiveDate,
    baselineDate: baseline.effectiveDate,
    coverageDays,
    ratingDelta,
    votesDelta,
    histogramComparable,
    highDelta,
    lowDelta,
    latestRating: round1(latest.ratingCurrent),
    latestVotes: Math.round(latest.votesCurrent),
    baselineRating: round1(baseline.ratingCurrent),
    baselineVotes: Math.round(baseline.votesCurrent),
  };
}

function buildCurrentStateSentence(latest, seedBase) {
  const r = latest.ratingCurrent;
  const v = latest.votesCurrent;

  let ratingBand = 'mid';
  if (r >= 4.5) ratingBand = 'high';
  else if (r >= 3.8) ratingBand = 'good';
  else if (r >= 3.0) ratingBand = 'mixed';
  else ratingBand = 'low';

  const pools = {
    high: [
      'The current rating sits in a clearly positive range.',
      'At the moment, the overall rating remains comfortably on the strong side.',
      'The latest score still reads as a high-rating result rather than a borderline one.',
    ],
    good: [
      'The current rating is solid rather than extreme.',
      'At the moment, the score stays in a generally favorable range.',
      'The latest rating is positive overall, though not unusually elevated.',
    ],
    mixed: [
      'The current rating looks mixed rather than decisively strong.',
      'At the moment, the score suggests a more balanced response than a clearly positive one.',
      'The latest rating falls into a moderate range that calls for a more careful read.',
    ],
    low: [
      'The current rating is on the weaker side.',
      'At the moment, the score trends low enough to justify caution.',
      'The latest rating does not read as a strong consensus result.',
    ],
  };

  const volumePools = v >= 1000
    ? [
        `The review count is large enough to read the score as a meaningful signal rather than a tiny sample (${formatInt(v)} reviews).`,
        `With ${formatInt(v)} reviews on record, the current score is backed by a broad enough sample to take seriously.`,
        `The present rating sits on top of a substantial review base of ${formatInt(v)}.`,
      ]
    : v >= 100
      ? [
          `The current score is supported by a moderate review base of ${formatInt(v)}.`,
          `There is enough review volume (${formatInt(v)}) to treat the rating as informative, while still reading it with some care.`,
          `The review base is neither tiny nor massive at ${formatInt(v)} responses.`,
        ]
      : [
          `The review count is still limited at ${formatInt(v)}, so the score should be read conservatively.`,
          `Because the sample remains small (${formatInt(v)} reviews), the rating deserves a cautious interpretation.`,
          `The score is based on a relatively small review pool of ${formatInt(v)}.`,
        ];

  return [
    pickVariant(`${seedBase}|current-rating|${ratingBand}`, pools[ratingBand]),
    pickVariant(`${seedBase}|current-volume|${v}`, volumePools),
  ];
}

function buildWindowSentence(windowInfo, seedBase) {
  if (!windowInfo) return [];

  const w = windowInfo.windowDays;
  const rd = windowInfo.ratingDelta;
  const vd = windowInfo.votesDelta;

  const out = [];

  if (rd === 0 && vd > 0) {
    out.push(
      pickVariant(`${seedBase}|w${w}|stable-volume-up`, [
        `Over the last ${w} days, review volume increased while the rating itself stayed broadly stable.`,
        `Across the past ${w} days, the score held steady even as review volume continued to rise.`,
        `The ${w}-day picture shows a stable rating paired with growing review volume.`,
      ])
    );
  } else if (rd > 0 && vd >= 0) {
    out.push(
      pickVariant(`${seedBase}|w${w}|rating-up`, [
        `Across the last ${w} days, the rating improved slightly while review activity did not contract.`,
        `The ${w}-day view shows a mild upward move in rating rather than a weakening trend.`,
        `Over the past ${w} days, the score edged upward on a non-declining review base.`,
      ])
    );
  } else if (rd < 0 && vd >= 0) {
    out.push(
      pickVariant(`${seedBase}|w${w}|rating-down`, [
        `Across the last ${w} days, the rating softened somewhat even though review activity remained present.`,
        `The ${w}-day trend shows a mild rating pullback rather than outright stability.`,
        `Over the past ${w} days, the score eased slightly while new reviews still accumulated.`,
      ])
    );
  } else if (rd === 0 && vd === 0) {
    out.push(
      pickVariant(`${seedBase}|w${w}|flat`, [
        `The last ${w} days show very little numerical movement in either score or review count.`,
        `Across the past ${w} days, both rating and review volume remained broadly unchanged.`,
        `The ${w}-day window reads as numerically quiet rather than eventful.`,
      ])
    );
  } else if (vd < 0 && rd === 0) {
    out.push(
      pickVariant(`${seedBase}|w${w}|volume-down`, [
        `Across the last ${w} days, the rating stayed stable while visible review volume eased slightly.`,
        `The ${w}-day pattern shows a steady score with somewhat lower review activity.`,
        `Over the past ${w} days, score stability mattered more than review-count growth.`,
      ])
    );
  } else {
    out.push(
      pickVariant(`${seedBase}|w${w}|generic`, [
        `The ${w}-day figures suggest movement, but not enough to justify an exaggerated reading.`,
        `Across the last ${w} days, the numbers changed, though the overall signal remains best read conservatively.`,
        `The ${w}-day comparison points to some numerical shift without supporting a dramatic conclusion.`,
      ])
    );
  }

  if (windowInfo.histogramComparable) {
    if (windowInfo.highDelta > 0 && windowInfo.lowDelta <= 0) {
      out.push(
        pickVariant(`${seedBase}|w${w}|hist-better`, [
          `Within the comparable rating distribution, higher-star feedback gained relative weight over this period.`,
          `The comparable distribution data for ${w} days leans a bit more toward higher-star feedback than before.`,
          `Distribution-wise, the ${w}-day comparison tilts modestly toward stronger ratings.`,
        ])
      );
    } else if (windowInfo.lowDelta > 0 && windowInfo.highDelta <= 0) {
      out.push(
        pickVariant(`${seedBase}|w${w}|hist-worse`, [
          `Comparable distribution data shows lower-star feedback becoming more visible over this period.`,
          `The ${w}-day distribution comparison leaves some evidence that lower ratings have become more noticeable.`,
          `Within the comparable star split, weaker ratings carry slightly more weight than they did before.`,
        ])
      );
    }
  }

  return out;
}

function buildCurrentDistributionSentence(latest, seedBase) {
  const hist = ensureHistogram(latest.histogram);
  const total = sumHistogram(hist);
  if (total <= 0) return [];

  const high = hist['4'] + hist['5'];
  const low = hist['1'] + hist['2'];

  if (high > low * 2) {
    return [
      pickVariant(`${seedBase}|dist|positive`, [
        'In the current distribution, higher-star ratings still outweigh lower-star ratings by a comfortable margin.',
        'The present star split remains more concentrated in 4–5 star territory than in the lower bands.',
        'Current rating distribution still leans clearly toward the higher end of the scale.',
      ])
    ];
  }

  if (low > high) {
    return [
      pickVariant(`${seedBase}|dist|caution`, [
        'The current distribution still leaves visible room for caution because lower-star ratings are not trivial.',
        'Lower-score feedback remains meaningful enough in the current split to avoid an overly cheerful reading.',
        'The present distribution is not one-sidedly positive, so caution remains appropriate.',
      ])
    ];
  }

  return [
    pickVariant(`${seedBase}|dist|balanced`, [
      'The current rating split looks more balanced than overwhelmingly positive.',
      'Distribution-wise, the present picture is mixed rather than one-directional.',
      'The current star mix does not suggest a fully one-sided consensus.',
    ])
  ];
}

function buildCautionSentence(latest, seedBase) {
  const votes = latest.votesCurrent;
  const source = normStr(latest.source).toLowerCase();

  const out = [];

  if (votes < 100) {
    out.push(
      pickVariant(`${seedBase}|caution|small-sample`, [
        'Because the sample is still limited, this should be treated as an informed signal rather than a final verdict.',
        'The relatively small review base still calls for a conservative interpretation.',
        'This is usable signal, but not the kind of sample size that removes all uncertainty.',
      ])
    );
  }

  if (source === 'manual') {
    out.push(
      pickVariant(`${seedBase}|caution|manual`, [
        'This record should also be read with the understanding that the source classification is manual rather than fully official.',
        'Source handling here is manual, which supports caution in interpretation.',
        'Because the record is not classified as fully official, a more careful reading is appropriate.',
      ])
    );
  }

  return out;
}

function buildCommentaryForSlug(records) {
  if (!Array.isArray(records) || records.length === 0) return null;

  const latest = records[records.length - 1];
  const seedBase = `${latest.slug}|${latest.effectiveDate}|${latest.ratingCurrent}|${latest.votesCurrent}`;

  const windows = {};
  for (const d of WINDOWS) {
    const baseline = pickBaselineForWindow(records, latest, d);
    windows[String(d)] = analyzeWindow(latest, baseline, d);
  }

  const lines = [];
  lines.push(...buildCurrentStateSentence(latest, seedBase));
  lines.push(...buildWindowSentence(windows['90'], seedBase));
  lines.push(...buildCurrentDistributionSentence(latest, seedBase));
  lines.push(...buildCautionSentence(latest, seedBase));

  const insights = dedupeStrings(lines).slice(0, 4);

  return {
    latest: {
      effectiveDate: latest.effectiveDate,
      ratingCurrent: round1(latest.ratingCurrent),
      votesCurrent: Math.round(latest.votesCurrent),
      bucket: latest.bucket || null,
      status: latest.status || null,
      store: latest.store || null,
      source: latest.source || null,
      storeId: latest.storeId || null,
    },
    windows,
    insights,
  };
}

function generateCommentary() {
  const grouped = groupHistoryBySlug();
  const bySlug = {};

  for (const [slug, records] of grouped.entries()) {
    const built = buildCommentaryForSlug(records);
    if (!built) continue;
    bySlug[slug] = built;
  }

  const out = {
    updatedAt: nowIso(),
    windows: WINDOWS,
    bySlug,
  };

  writeJsonAtomic(COMMENTARY_FILE, out);

  return {
    slugs: Object.keys(bySlug).length,
    outFile: COMMENTARY_FILE,
  };
}

function main() {
  console.log('────────────────────────────────────────────');
  console.log('[review-trend-commentary] ROOT     =', ROOT);
  console.log('[review-trend-commentary] MODE     =', MODE);
  console.log('[review-trend-commentary] SSOT     =', REVIEW_SSOT_FILE);
  console.log('[review-trend-commentary] HISTORY  =', HISTORY_FILE);
  console.log('[review-trend-commentary] OUTPUT   =', COMMENTARY_FILE);
  console.log('────────────────────────────────────────────');

  let snapshotResult = null;
  let commentaryResult = null;

  if (MODE === 'snapshot' || MODE === 'both') {
    snapshotResult = appendCurrentSnapshots();
    console.log(
      `[review-trend-commentary] snapshot: scanned=${snapshotResult.scanned}, appended=${snapshotResult.appended}, skippedSame=${snapshotResult.skippedSame}`
    );
  }

  if (MODE === 'commentary' || MODE === 'both') {
    commentaryResult = generateCommentary();
    console.log(
      `[review-trend-commentary] commentary: slugs=${commentaryResult.slugs}, output=${commentaryResult.outFile}`
    );
  }

  console.log('────────────────────────────────────────────');
  console.log('[review-trend-commentary] done');
  console.log('────────────────────────────────────────────');
}

if (require.main === module) {
  main();
}
