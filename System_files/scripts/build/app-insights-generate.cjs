// System_files/scripts/build/app-insights-generate.cjs
// app-insights-generate: app-reviews 포스트 + review-ratings-next(bySlug) 기반으로 app-insights.json(bySlug)을 생성한다. (네트워크 호출 없음)

'use strict';
require('./lib/env.cjs'); // ✅ 공통 규칙: env 로더 최우선

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // System_files
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const REVIEWS_DIR = path.join(ROOT, 'content', 'reviews');

const OUT_PATH = path.join(REVIEWS_DIR, 'app-insights.json');
const RATINGS_NEXT_PATH = path.join(REVIEWS_DIR, 'review-ratings-next.json');

const isLive = (() => {
  const v = String(process.env.DRY_RUN ?? 'true').trim().toLowerCase();
  return (v === 'false' || v === '0');
})();

function log(...a) { console.log('[app-insights]', ...a); }
function warn(...a) { console.warn('[app-insights][WARN]', ...a); }
function fatal(...a) { console.error('[app-insights][FATAL]', ...a); process.exit(1); }

function nowYmdKst() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    warn(`read/parse failed: ${path.basename(file)} -> ${e.message || e}`);
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function listPostDocs() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    const p = path.join(POSTS_DIR, f);
    const j = safeReadJson(p, null);
    if (!j || typeof j !== 'object') continue;
    const slug = String(j.slug || f.replace(/\.json$/, '')).trim();
    if (!slug) continue;
    j.slug = slug;
    out.push(j);
  }
  return out;
}

function isAppReviewDoc(doc) {
  const label = String(doc.label || '').trim().toLowerCase();
  const labels = Array.isArray(doc.labels) ? doc.labels.map(x => String(x).toLowerCase()) : [];
  return label === 'app-reviews' || labels.includes('app-reviews');
}

function pickAppCategory(doc) {
  // What: 앱 카테고리(6종) 추출
  // Why: 룰 기반 인사이트 문장 선택
  // I/O: R(doc fields), W(none)
  // Invariants: 6개 외 값은 default로 폴백
  const raw =
    doc.appCategory ||
    doc.seedMeta?.appCategory ||
    doc.category ||
    doc.seedMeta?.category ||
    null;

  const v = String(raw || '').trim().toLowerCase();
  const allow = new Set(['productivity', 'finance', 'shopping', 'entertainment', 'utility', 'service']);
  if (allow.has(v)) return v;
  return 'productivity'; // default(가장 범용)
}

const DICT = {
  productivity: {
    pos: [
      '기능 구조상 빠른 작업 입력과 정리 흐름을 만들기 쉬운 형태입니다.',
      '여러 기기/환경에서 같은 작업 목록을 유지하기에 유리한 구성으로 보입니다.',
      '반복 작업을 줄이는 데 필요한 기본 도구(분류/우선순위/리마인드)가 갖춰진 편입니다.',
      '장기 사용을 전제로 한 워크플로 설계에 맞는 UI 흐름으로 보입니다.',
      '단일 도구로 작업 관리 루틴을 유지하려는 경우에 적합한 타입입니다.',
      '협업/공유를 붙이기 좋은 구조(리스트/프로젝트 중심)로 보입니다.'
    ],
    neg: [
      '초기 설정(분류/규칙/알림)이 많아지면 진입 장벽이 생길 수 있습니다.',
      '고급 기능은 유료 구간에 집중되는 경우가 있어 비용 판단이 필요합니다.',
      '알림/규칙을 과하게 켜면 오히려 피로도가 늘 수 있습니다.',
      '기능이 풍부한 만큼, 최소주의 사용자에게는 복잡하게 느껴질 수 있습니다.',
      '작업 관리 습관이 없으면 기능보다 루틴이 먼저 필요할 수 있습니다.',
      '팀 기능을 쓰지 않는다면 일부 기능은 과잉일 수 있습니다.'
    ]
  },
  finance: {
    pos: [
      '보안/인증 흐름이 명확하게 설계된 타입이면 신뢰감 형성에 유리합니다.',
      '알림 기반으로 변동을 빠르게 확인하는 루틴에 적합한 구조로 보입니다.',
      '내역 확인과 탐색이 쉬운 UI면 일상 관리에 도움이 되는 편입니다.',
      '기본 기능(조회/알림/정리)이 분리되어 있으면 사용 흐름이 안정적입니다.',
      '자주 쓰는 기능을 빠르게 접근할 수 있게 설계된 경우 효율이 올라갑니다.',
      '정기 확인(월말/주간) 루틴을 만들기 쉬운 구성으로 보입니다.'
    ],
    neg: [
      '인증 단계가 자주 바뀌면 사용 피로가 커질 수 있습니다.',
      '오류 발생 시 대응 채널이 약하면 불안 요소가 됩니다.',
      'UI 개편이 잦으면 학습 비용이 반복될 수 있습니다.',
      '알림이 과하면 불필요한 스트레스를 만들 수 있습니다.',
      '기기/OS 버전에 따라 안정성이 달라질 수 있습니다.',
      '보안 강도가 높을수록 편의성과의 균형을 확인해야 합니다.'
    ]
  },
  shopping: {
    pos: [
      '가격/배송/혜택 정보를 한 화면에서 정리해 주면 선택이 빨라집니다.',
      '배송 추적 흐름이 단순하면 반복 확인 비용을 줄일 수 있습니다.',
      '리뷰/상세정보 접근성이 좋으면 비교 시간이 줄어드는 편입니다.',
      '검색/필터가 강하면 원하는 조건을 빠르게 좁힐 수 있습니다.',
      '구매 이력/찜/장바구니 관리가 안정적이면 재구매가 편해집니다.',
      '혜택/쿠폰 적용 과정이 명확하면 체감 만족도가 올라갑니다.'
    ],
    neg: [
      '광고/추천 노출이 과하면 탐색이 방해될 수 있습니다.',
      '리뷰 품질 편차가 커서 판단에 주의가 필요할 수 있습니다.',
      '반품/환불 프로세스가 복잡하면 비용(시간)이 늘 수 있습니다.',
      '푸시 알림이 과하면 피로도가 올라갈 수 있습니다.',
      '상품 페이지 구성이 복잡하면 비교가 오히려 느려질 수 있습니다.',
      '혜택 조건이 자주 바뀌면 체감 가치가 흔들릴 수 있습니다.'
    ]
  },
  entertainment: {
    pos: [
      '콘텐츠 탐색/재생 흐름이 단순하면 몰입 유지에 유리합니다.',
      '콘텐츠 폭이 넓으면 취향에 맞는 선택지를 찾기 쉬운 편입니다.',
      '성능 최적화가 잘 되어 있으면 장시간 사용 부담이 줄어듭니다.',
      '추천/분류가 명확하면 원하는 장르로 빠르게 이동할 수 있습니다.',
      '오프라인/저장 기능이 있으면 이동 중 사용이 편해집니다.',
      '계정/기기 전환이 부드러우면 연속성이 좋아집니다.'
    ],
    neg: [
      '과금 유도 UI가 강하면 사용 만족도가 떨어질 수 있습니다.',
      '배터리/발열 부담이 큰 타입이면 장시간 사용이 어렵습니다.',
      '알림/이벤트가 잦으면 집중을 방해할 수 있습니다.',
      '콘텐츠 품질 편차가 크면 탐색 시간이 늘 수 있습니다.',
      '네트워크 품질에 따라 체감이 크게 달라질 수 있습니다.',
      '저장 공간 사용량이 커질 수 있어 관리가 필요합니다.'
    ]
  },
  utility: {
    pos: [
      '단일 기능에 집중된 도구는 사용 흐름이 빠르고 명확한 편입니다.',
      '즉시 실행/즉시 결과를 주는 구조면 일상 사용성이 올라갑니다.',
      '권한/설정이 단순하면 유지 관리 비용이 줄어듭니다.',
      '가벼운 UI면 구형 기기에서도 체감이 안정적일 수 있습니다.',
      '짧은 작업을 자주 하는 사용자에게 특히 유리한 타입입니다.',
      '기능 범위가 명확하면 학습 비용이 낮습니다.'
    ],
    neg: [
      '유사 기능 앱이 많아 차별점이 약하면 교체 가능성이 큽니다.',
      '광고/추적 요소가 강하면 거부감이 생길 수 있습니다.',
      'OS 업데이트에 따라 기능이 흔들릴 수 있습니다.',
      '권한 요청이 과하면 신뢰 이슈가 생길 수 있습니다.',
      '기능이 단순한 만큼 확장성은 제한될 수 있습니다.',
      '위젯/단축 기능이 없으면 반복 작업이 늘 수 있습니다.'
    ]
  },
  service: {
    pos: [
      '지속 업데이트/개선 흐름이 있는 서비스는 장기 사용에 유리합니다.',
      '플랫폼 연동이 많으면 업무/일상 도구로 자리잡기 쉽습니다.',
      '지원 채널이 명확하면 문제 발생 시 리스크가 줄어듭니다.',
      '정책/요금제가 투명하면 비용 판단이 쉬워집니다.',
      '데이터 이동/내보내기가 가능하면 락인 리스크가 줄어듭니다.',
      '관리자/팀 기능이 필요할 때 확장하기 쉬운 구조일 수 있습니다.'
    ],
    neg: [
      '가격 인상이 발생할 수 있어 장기 비용 점검이 필요합니다.',
      '해지/환불 동선이 불명확하면 불만 요인이 될 수 있습니다.',
      '유료 기능 잠금이 강하면 체감 가치가 갈릴 수 있습니다.',
      '요금제 구성이 복잡하면 선택 비용이 늘 수 있습니다.',
      '정책 변경이 잦으면 사용자 경험이 흔들릴 수 있습니다.',
      '팀 기능을 쓰지 않으면 일부는 과잉 기능일 수 있습니다.'
    ]
  }
};

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const v = String(s || '').trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function pickN(list, n, seedKey) {
  // What: 결정론적 선택(정렬 기반)
  // Why: 동일 입력에서 같은 출력(재현성)
  // I/O: R(list/seedKey), W(none)
  // Invariants: 랜덤 금지
  const arr = Array.isArray(list) ? list.slice() : [];
  arr.sort((a, b) => {
    const A = String(a), B = String(b);
    // seedKey를 섞어 tie-breaker
    const aKey = `${seedKey}::${A}`;
    const bKey = `${seedKey}::${B}`;
    return aKey.localeCompare(bKey);
  });
  return arr.slice(0, n);
}

function statsInsightsFromRating(rating, votes) {
  // What: 별점/표본수 기반 보조 문장(근거 오해 방지)
  // Why: 룰 부족 시 플레이스홀더 비중을 낮춤
  // I/O: R(rating/votes), W(none)
  // Invariants: “사용자 리뷰” 직접 언급 금지
  const out = [];
  const r = Number(rating);
  const v = Number(votes);

  if (Number.isFinite(r) && r > 0) {
    if (r >= 4.5) out.push('평점 수준이 높은 편인 경우, 기본 품질 기대치가 비교적 안정적일 수 있습니다.');
    else if (r >= 4.0) out.push('평점이 중상 수준이면, 기능-사용성 균형이 무난한 타입일 가능성이 있습니다.');
    else if (r >= 3.5) out.push('평점이 중간 구간이면, 강점과 약점이 사용자 환경에 따라 갈릴 수 있습니다.');
    else out.push('평점이 낮은 편이면, 설치 전 핵심 제약(광고/성능/정책)을 먼저 확인하는 편이 안전합니다.');
  }

  if (Number.isFinite(v) && v > 0) {
    if (v >= 100000) out.push('표본수가 큰 경우, 업데이트/정책 변화에 대한 체감 반응이 빨리 누적될 수 있습니다.');
    else if (v >= 1000) out.push('표본수가 일정 수준이면, 업데이트에 따른 체감 변화가 비교적 명확히 나타날 수 있습니다.');
    else out.push('표본수가 적은 경우, 환경 차이에 따른 편차가 더 크게 보일 수 있습니다.');
  }

  return out.slice(0, 2);
}

function buildPlaceholders() {
  // What: 최후 안전망 문장
  // Why: 네트워크 부재/데이터 부족에서도 출력 보장
  // Invariants: 점점점(...) 금지, 품질 안내 문구 사용
  return [
    '현재는 품질 좋은 리뷰 인사이트가 확보되는 과정이며, 확보되면 최신 내용으로 업데이트됩니다.',
    '기본 기능 구조 기준으로 안내하며, 세부 사용 경험은 개인 환경에 따라 차이가 있을 수 있습니다.'
  ];
}

function buildInsightsForSlug(slug, category, ssotEntry) {
  const dict = DICT[category] || DICT.productivity;

  const rating = Number(ssotEntry && ssotEntry.ratingCurrent);
  const votes = Number(ssotEntry && ssotEntry.votesCurrent);

  const hasRating = Number.isFinite(rating) && rating > 0;
  const hasVotes = Number.isFinite(votes) && votes > 0;

  // 기본 목표: 최대 3문장 (pos/neg 균형은 rating/votes에 따라)
  let wantPos = 2;
  let wantNeg = 1;

  if (hasRating && rating < 3.8) { wantPos = 1; wantNeg = 2; }
  if (hasVotes && votes < 100) { wantPos = 1; wantNeg = 1; } // 표본 적으면 과한 단정 줄임

  const pos = pickN(dict.pos, wantPos, `pos::${slug}`);
  const neg = pickN(dict.neg, wantNeg, `neg::${slug}`);

  let out = uniq([...pos, ...neg]);

  // 통계 보조(최대 2문장) — 룰이 부족할 때만 보강
  if (out.length < 2) {
    out = uniq([...out, ...statsInsightsFromRating(rating, votes)]);
  }

  // 플레이스홀더(최후)
  let source = 'rule';
  let confidence = 0.6;

  if (out.length < 2) {
    const ph = buildPlaceholders();
    out = uniq([...out, ...ph]).slice(0, 3);
    source = 'placeholder';
    confidence = 0.3;
  } else {
    // rule + stats면 confidence 상향
    const stats = statsInsightsFromRating(rating, votes);
    if (stats.length && out.some(x => stats.includes(x))) confidence = 0.8;
  }

  // 항상 최대 3개
  out = out.slice(0, 3);

  return { insights: out, source, confidence };
}

function main() {
  log('────────────────────────────────────────────');
  log('[app-insights] start');
  log(`[app-insights] ROOT = ${ROOT}`);
  log(`[app-insights] POSTS = ${POSTS_DIR}`);
  log(`[app-insights] REVIEWS = ${REVIEWS_DIR}`);
  log(`[app-insights] OUT = ${OUT_PATH}`);
  log(`[app-insights] RATINGS_NEXT = ${RATINGS_NEXT_PATH}`);
  log(`[app-insights] DRY_RUN = ${isLive ? 'false(live)' : 'true(dry-run)'}`);
  log('────────────────────────────────────────────');

  const ymd = nowYmdKst();

  const ratingsNext = safeReadJson(RATINGS_NEXT_PATH, { bySlug: {} }) || { bySlug: {} };
  const bySlugRatings = (ratingsNext.bySlug && typeof ratingsNext.bySlug === 'object') ? ratingsNext.bySlug : {};

  const docs = listPostDocs().filter(isAppReviewDoc);

  const out = {
    updatedAt: ymd,
    bySlug: {}
  };

  let scanned = 0;
  let built = 0;
  let placeholders = 0;

  for (const doc of docs) {
    const slug = String(doc.slug || '').trim();
    if (!slug) continue;
    if (!slug.startsWith('app-')) continue; // app 버킷만

    scanned += 1;

    const cat = pickAppCategory(doc);
    const ssotEntry = bySlugRatings[slug] || null;

    const r = buildInsightsForSlug(slug, cat, ssotEntry);
    out.bySlug[slug] = {
      insights: r.insights,
      source: r.source,
      confidence: r.confidence
    };

    built += 1;
    if (r.source === 'placeholder') placeholders += 1;
  }

  if (isLive) {
    writeJson(OUT_PATH, out);
  } else {
    // DRY_RUN은 WRITE 금지
    log(`[app-insights] DRY_RUN preview: slugs=${built} placeholders=${placeholders}`);
    const sample = Object.keys(out.bySlug).slice(0, 3);
    for (const s of sample) {
      log(`DRY_RUN sample: ${s} -> ${out.bySlug[s].source} (${out.bySlug[s].insights.length})`);
    }
  }

  log('────────────────────────────────────────────');
  log(`[app-insights] done: scanned=${scanned} built=${built} placeholders=${placeholders}`);
  log('────────────────────────────────────────────');
}

main();
