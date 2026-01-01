#!/usr/bin/env node
'use strict';

/**
 * System_files/scripts/build/review-due-90days.cjs
 *
 * 목적:
 * - 3버킷(app/device/subscription) ratings 기준으로 "90일 프레시니스 점검 대상" 작업목록(due-list)을 생성합니다.
 *
 * 입력(기본):
 * - content/reviews/app-ratings.json
 * - content/reviews/device-ratings.json
 * - content/reviews/subscription-ratings.json
 *
 * 출력:
 * - dist/reviews/due-90days.json
 * - dist/reviews/due-90days.jsonl
 *
 * 정책:
 * - nextCheck 우선(있으면 사용), 없으면 lastChecked + 90일로 계산
 * - overdue(기한 초과) / dueSoon(임박) / ok 로 분류
 * - 임박 기준은 기본 7일, 환경변수 DUE_SOON_DAYS 로 변경 가능
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..'); // System_files
const REVIEWS_DIR = path.join(ROOT, 'content', 'reviews');
const DIST_DIR = path.join(ROOT, 'dist');
const OUT_DIR = path.join(DIST_DIR, 'reviews');

const BUCKETS = ['app', 'device', 'subscription'];

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonPretty(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function appendJsonl(p, obj) {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8');
}

function parseKstDate(dateStr) {
  // 'YYYY-MM-DD' 또는 'YYYY-MM-DDTHH:mm:ss+09:00' 둘 다 허용
  if (!dateStr || typeof dateStr !== 'string') return null;

  if (dateStr.length >= 10 && dateStr[4] === '-' && dateStr[7] === '-') {
    if (dateStr.includes('T')) {
      const d = new Date(dateStr);
      return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(dateStr + 'T00:00:00+09:00');
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function formatYmdKst(d) {
  // Date를 KST 기준 YYYY-MM-DD로 포맷
  const utc = d.getTime() + 9 * 60 * 60 * 1000;
  const k = new Date(utc);
  const y = k.getUTCFullYear();
  const m = String(k.getUTCMonth() + 1).padStart(2, '0');
  const day = String(k.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDaysYmd(ymd, days) {
  const d = parseKstDate(ymd);
  if (!d) return '';
  d.setDate(d.getDate() + days);
  return formatYmdKst(d);
}

function todayYmd() {
  return formatYmdKst(new Date());
}

function pickRatingsPath(bucket) {
  // 옹스님이 단수 오타를 없앴다고 하셨지만, 안전망으로 단수도 허용
  const p1 = path.join(REVIEWS_DIR, `${bucket}-ratings.json`);
  const p2 = path.join(REVIEWS_DIR, `${bucket}-rating.json`);
  return fs.existsSync(p1) ? p1 : p2;
}

function normalizeRecord(bucket, slug, rec) {
  if (!rec || typeof rec !== 'object') return null;

  const lastChecked = typeof rec.lastChecked === 'string' ? rec.lastChecked : '';
  const nextCheck = typeof rec.nextCheck === 'string' ? rec.nextCheck : '';

  const lcDate = parseKstDate(lastChecked);
  const ncDate = parseKstDate(nextCheck);

  // nextCheck가 있으면 우선, 없으면 lastChecked+90
  let nextCheckYmd = '';
  if (ncDate) nextCheckYmd = formatYmdKst(ncDate);
  else if (lcDate) nextCheckYmd = addDaysYmd(formatYmdKst(lcDate), 90);

  const lastCheckedYmd = lcDate ? formatYmdKst(lcDate) : '';

  // ratingCurrent/votesCurrent는 없어도 due-list는 생성 가능(운영 표시용)
  const ratingCurrent = Number(rec.ratingCurrent);
  const votesCurrent = Number(rec.votesCurrent);

  const platform = rec.store || rec.platform || '';
  const source = rec.source || '';

  return {
    bucket,
    slug,
    status: rec.status || (nextCheckYmd ? 'ok' : 'unknown'),
    lastChecked: lastCheckedYmd,
    nextCheck: nextCheckYmd,
    ratingCurrent: Number.isFinite(ratingCurrent) ? ratingCurrent : null,
    votesCurrent: Number.isFinite(votesCurrent) ? votesCurrent : null,
    platform,
    source,
  };
}

function classify(nowYmd, nextCheckYmd, dueSoonDays) {
  if (!nextCheckYmd) return 'unknown';

  if (nowYmd > nextCheckYmd) return 'overdue';

  // dueSoon: nextCheck - now <= dueSoonDays
  // 날짜 비교용으로 Date로 계산
  const nowD = parseKstDate(nowYmd);
  const ncD = parseKstDate(nextCheckYmd);
  if (!nowD || !ncD) return 'unknown';

  const diffDays = Math.ceil((ncD.getTime() - nowD.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays <= dueSoonDays) return 'dueSoon';
  return 'ok';
}

function main() {
  const now = todayYmd();
  const dueSoonDays = Math.max(1, Number(process.env.DUE_SOON_DAYS || 7) || 7);

  console.log('────────────────────────────────────────────');
  console.log('[review-due] ROOT      =', ROOT);
  console.log('[review-due] REVIEWS   =', REVIEWS_DIR);
  console.log('[review-due] OUT_DIR   =', OUT_DIR);
  console.log('[review-due] today     =', now, `(dueSoonDays=${dueSoonDays})`);
  console.log('────────────────────────────────────────────');

  ensureDir(OUT_DIR);

  const result = {
    generatedAt: new Date().toISOString(),
    today: now,
    dueSoonDays,
    summary: {
      total: 0,
      overdue: 0,
      dueSoon: 0,
      ok: 0,
      unknown: 0,
    },
    buckets: {
      app: { overdue: [], dueSoon: [], ok: [], unknown: [] },
      device: { overdue: [], dueSoon: [], ok: [], unknown: [] },
      subscription: { overdue: [], dueSoon: [], ok: [], unknown: [] },
    },
    flat: {
      overdue: [],
      dueSoon: [],
      ok: [],
      unknown: [],
    }
  };

  const jsonlPath = path.join(OUT_DIR, 'due-90days.jsonl');
  // 매번 새로 생성(이 파일은 로그 성격이라 누적도 가능하지만, 지금은 "오늘분"만 깔끔하게)
  if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath);

  for (const bucket of BUCKETS) {
    const ratingsPath = pickRatingsPath(bucket);
    const db = readJsonSafe(ratingsPath, { bySlug: {} });
    const bySlug = (db && typeof db.bySlug === 'object') ? db.bySlug : {};

    const slugs = Object.keys(bySlug).sort();
    for (const slug of slugs) {
      const rec = normalizeRecord(bucket, slug, bySlug[slug]);
      if (!rec) continue;

      const cls = classify(now, rec.nextCheck, dueSoonDays);
      result.summary.total += 1;
      result.summary[cls] += 1;

      result.buckets[bucket][cls].push(rec);
      result.flat[cls].push(rec);

      appendJsonl(jsonlPath, {
        type: 'due90',
        bucket,
        slug,
        class: cls,
        nextCheck: rec.nextCheck,
        lastChecked: rec.lastChecked,
        ratingCurrent: rec.ratingCurrent,
        votesCurrent: rec.votesCurrent,
        platform: rec.platform,
        source: rec.source,
        ts: new Date().toISOString(),
      });
    }
  }

  // 정렬: overdue(가장 오래된 nextCheck 먼저), dueSoon(가까운 nextCheck 먼저)
  function sortByNextCheckAsc(a, b) {
    return String(a.nextCheck || '').localeCompare(String(b.nextCheck || ''));
  }
  function sortByNextCheckDesc(a, b) {
    return String(b.nextCheck || '').localeCompare(String(a.nextCheck || ''));
  }

  for (const bucket of BUCKETS) {
    result.buckets[bucket].overdue.sort(sortByNextCheckAsc);
    result.buckets[bucket].dueSoon.sort(sortByNextCheckAsc);
    result.buckets[bucket].ok.sort(sortByNextCheckDesc);
    result.buckets[bucket].unknown.sort(sortByNextCheckDesc);
  }
  result.flat.overdue.sort(sortByNextCheckAsc);
  result.flat.dueSoon.sort(sortByNextCheckAsc);
  result.flat.ok.sort(sortByNextCheckDesc);
  result.flat.unknown.sort(sortByNextCheckDesc);

  const outPath = path.join(OUT_DIR, 'due-90days.json');
  writeJsonPretty(outPath, result);

  console.log('[review-due] 저장:', outPath);
  console.log('[review-due] 저장:', jsonlPath);
  console.log('[review-due] summary =', JSON.stringify(result.summary));
  console.log('────────────────────────────────────────────');
}

if (require.main === module) main();
