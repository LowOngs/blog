#!/usr/bin/env node
/**
 * review-rating.cjs
 *
 * - content/reviews/app-ratings.json 에서 앱별 별점 스냅샷을 읽어온 뒤
 *   content/posts/*.json 의 review.rating 블록을 자동 갱신합니다.
 * - 3개월(90일) 주기로 점검해야 할 날짜(nextCheck)도 함께 계산합니다.
 * - review-meta-block.cjs 가 이 rating 정보를 읽어서 테이블을 그립니다.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const RATINGS_PATH = path.join(ROOT, 'content', 'reviews', 'app-ratings.json');

function log(...args) {
  console.log('[review-rating]', ...args);
}

function loadJsonSafe(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function saveJsonPretty(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * YYYY-MM-DD 형태 문자열을 Date로 변환(+09:00 기준)
 */
function parseKstDate(dateStr) {
  // dateStr: '2025-11-21'
  return new Date(dateStr + 'T00:00:00+09:00');
}

/**
 * Date → YYYY-MM-DD
 */
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * YYYY-MM-DD + days → YYYY-MM-DD
 */
function addDays(dateStr, days) {
  const d = parseKstDate(dateStr);
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

/**
 * YYYY-MM-DD → YYYY-MM-DDT00:00:00+09:00
 */
function toKstIso(dateStr) {
  return `${dateStr}T00:00:00+09:00`;
}

/**
 * 오늘 날짜(로컬) YYYY-MM-DD
 */
function todayLocal() {
  const d = new Date();
  return formatDate(d);
}

function main() {
  console.log('────────────────────────────────────────────');
  log('ROOT      =', ROOT);
  log('POSTS_DIR =', POSTS_DIR);
  log('RATINGS   =', RATINGS_PATH);

  // 1) ratings 저장소 확인
  if (!fs.existsSync(RATINGS_PATH)) {
    log('WARN: app-ratings.json 이 없어 아무 작업도 하지 않습니다.');
    log('TIP : content/reviews/app-ratings.json 파일을 만든 뒤 다시 실행하세요.');
    console.log('────────────────────────────────────────────');
    return;
  }

  ensureDir(POSTS_DIR);

  // 2) posts/*.json 스캔해서 slug → 파일 경로 매핑
  const slugToFile = new Map();
  const postFiles = fs
    .readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith('.json'));

  for (const file of postFiles) {
    const full = path.join(POSTS_DIR, file);
    const data = loadJsonSafe(full, null);
    if (!data || !data.slug) continue;
    slugToFile.set(data.slug, full);
  }

  log('posts 스캔 완료: slug 매핑 수 =', slugToFile.size);

  // 3) ratings 데이터 로드
  const ratings = loadJsonSafe(RATINGS_PATH, []);
  if (!Array.isArray(ratings) || ratings.length === 0) {
    log('WARN: app-ratings.json 에 유효한 데이터가 없습니다.');
    console.log('────────────────────────────────────────────');
    return;
  }

  const today = todayLocal();
  let candidateCount = 0;
  let updatedCount = 0;
  let overdueCount = 0;
  let missingPostCount = 0;

  for (const item of ratings) {
    if (!item || !item.slug) continue;

    const slug = item.slug;
    const snapshots = Array.isArray(item.snapshots) ? item.snapshots : [];

    // 스냅샷 데이터 없으면 스킵
    const validSnapshots = snapshots.filter(
      (s) =>
        s &&
        typeof s.date === 'string' &&
        s.date.length === 10 &&
        typeof s.rating === 'number' &&
        typeof s.votes === 'number'
    );
    if (validSnapshots.length === 0) {
      log('WARN: 유효한 스냅샷이 없어 스킵 → slug =', slug);
      continue;
    }

    candidateCount++;

    const postFile = slugToFile.get(slug);
    if (!postFile) {
      log('WARN: posts 디렉토리에 해당 slug JSON이 없어 스킵 → slug =', slug);
      missingPostCount++;
      continue;
    }

    const post = loadJsonSafe(postFile, null);
    if (!post) {
      log('WARN: JSON 파싱 실패 →', postFile);
      continue;
    }

    // 최신 스냅샷 선택 (date가 가장 큰 것)
    const latest = validSnapshots.reduce((acc, cur) =>
      cur.date > acc.date ? cur : acc
    );
    const lastDate = latest.date; // YYYY-MM-DD
    const nextCheckDate = addDays(lastDate, 90); // 90일 후

    if (!post.review) post.review = {};

    const prevRating = JSON.stringify(post.review.rating || {});

    post.review.rating = {
      overall: Number(latest.rating),
      votes: latest.votes,
      scale: typeof latest.scale === 'number' ? latest.scale : 5,
      lastUpdated: toKstIso(lastDate),
      nextCheck: toKstIso(nextCheckDate),
      platform: item.platform || 'global',
      source: item.source || 'manual',
      storeId: item.storeId || null
    };

    const newRating = JSON.stringify(post.review.rating);

    if (newRating !== prevRating) {
      saveJsonPretty(postFile, post);
      updatedCount++;
      log('UPDATE:', slug, '→ rating', latest.rating, '(', latest.votes, 'votes )');
    }

    // 3개월 점검 기한 초과 여부
    if (today > nextCheckDate) {
      overdueCount++;
      log(
        'OVERDUE:',
        slug,
        `→ last=${lastDate}, nextCheck=${nextCheckDate} (today=${today})`
      );
    }
  }

  console.log('────────────────────────────────────────────');
  log(
    '완료:',
    '후보=', candidateCount,
    '| 갱신=', updatedCount,
    '| 오버듀=', overdueCount,
    '| 매핑실패(slug 없음)=', missingPostCount
  );
}

main();
