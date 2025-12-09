#!/usr/bin/env node

/**
 * slug-builder.cjs
 *
 * 규칙: {label}-{YYYYMMDD}-{NNN}
 *  - label: app / device / subs / howto / save / tpl ...
 *  - YYYYMMDD: 오늘 날짜(기본) 또는 인자로 받은 날짜
 *  - NNN: 같은 label+날짜에서 001, 002, 003... 순서
 *
 * 사용예:
 *   node System_files/scripts/build/slug-builder.cjs app
 *   node System_files/scripts/build/slug-builder.cjs app 20251205
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

/** zero-padding */
function pad3(n) {
  const s = String(n | 0);
  if (s.length >= 3) return s;
  return ('000' + s).slice(-3);
}

/** 오늘 날짜를 YYYYMMDD 로 반환 (로컬 타임존 기준) */
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const mm = m < 10 ? '0' + m : '' + m;
  const dd = day < 10 ? '0' + day : '' + day;
  return '' + y + mm + dd;
}

/** YYYYMMDD 유효성 간단 체크 */
function isValidDateStr(s) {
  return typeof s === 'string' && /^[0-9]{8}$/.test(s);
}

/**
 * 주어진 label, dateStr 기준으로 다음 슬러그를 생성한다.
 * posts 디렉터리의 *.json 파일명을 기준으로 중복을 피한다.
 */
function buildSlug(label, dateStr) {
  if (!label || typeof label !== 'string') {
    throw new Error('label 이 필요합니다. 예: app / device / howto ...');
  }
  const safeLabel = label.trim();

  let date = dateStr;
  if (!date) {
    date = todayStr();
  }
  if (!isValidDateStr(date)) {
    throw new Error('date 형식이 잘못되었습니다. YYYYMMDD 형식으로 입력하세요. 예: 20251205');
  }

  const basePrefix = `${safeLabel}-${date}-`;

  let maxIndex = 0;
  let files = [];
  try {
    files = fs.readdirSync(POSTS_DIR, { withFileTypes: true })
      .filter((ent) => ent.isFile() && ent.name.endsWith('.json'))
      .map((ent) => ent.name);
  } catch (err) {
    throw new Error(`[slug-builder] posts 디렉터리 읽기 실패: ${POSTS_DIR}\n${err.message}`);
  }

  for (const name of files) {
    if (!name.startsWith(basePrefix) || !name.endsWith('.json')) continue;
    // 예: app-20251205-003.json
    const core = name.slice(0, -5); // .json 제거
    const parts = core.split('-');  // [app, 20251205, 003]
    const idxStr = parts[2];
    const idx = parseInt(idxStr, 10);
    if (!isNaN(idx) && idx > maxIndex) {
      maxIndex = idx;
    }
  }

  const nextIndex = maxIndex + 1;
  const slug = `${basePrefix}${pad3(nextIndex)}`;

  return {
    slug,
    label: safeLabel,
    date,
    index: nextIndex,
    postsDir: POSTS_DIR,
  };
}

/** CLI 엔트리 */
function main() {
  const [, , labelArg, dateArg] = process.argv;

  try {
    console.log('────────────────────────────────────────────');
    console.log('[slug-builder] 시작');
    console.log('[slug-builder] ROOT      =', ROOT);
    console.log('[slug-builder] POSTS_DIR =', POSTS_DIR);

    const { slug, label, date, index } = buildSlug(labelArg, dateArg);

    console.log('[slug-builder] label     =', label);
    console.log('[slug-builder] date      =', date);
    console.log('[slug-builder] base      =', `${label}-${date}-`);
    console.log('[slug-builder] next idx  =', pad3(index));
    console.log('────────────────────────────────────────────');
    console.log('[slug-builder] 결과 slug =', slug);
    console.log(''); // 마지막 줄은 slug만 필요하면 아래 라인을 사용
    console.log(slug); // 다른 스크립트에서 stdout 마지막 줄만 파싱해서 사용 가능
  } catch (err) {
    console.error('[slug-builder] ERROR:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    buildSlug,
  };
}
