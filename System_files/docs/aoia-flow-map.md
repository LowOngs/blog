# AOIA Flow Map (SSOT) — 상세판 (원본 유지 + 2026-01-15~19 추가분 병합본)
- Path (SSOT): System_files/docs/aoia-flow-map.md
- Last Updated: 2026-01-19 (+0900)

목표
- 파일을 열지 않고도 “원인 후보 파일”을 즉시 좁히기 위한 지도.
- 한 파일을 바꾸면 어떤 파일/산출물이 같이 흔들리는지(파급 범위)까지 포함.
- 본 지도에 없는 구조/변경은 사전 합의 없이 반영하지 않는다.

────────────────────────────────────────────────────────────
0) Ground Rules (운영/변경 규칙)
────────────────────────────────────────────────────────────
- 파일명/경로/SSOT는 한번 확정되면 임의 변경 금지(필요 시 지도 선변경 + 합의).
- 변경 제안 시 반드시 먼저:
  1) 변경 범위 2) 대상 파일 3) 이유 4) 전/후 차이 5) 파급 범위
- 주석 없는 블록은 구조 확정 전까지 삭제/변경 금지.
- 공통 주석 규칙(확정):
  - 모든 스크립트는 env 로더를 최상단에 둔다(require('./lib/env.cjs')).
  - 파일 상단에는 변경 요약 1줄만 둔다.
  - 각 기능 블록 바로 위에 반드시 4요소 주석:
    1) What 2) Why 3) I/O(READ/WRITE 경로) 4) Invariants(멱등/게이트 등)
- “중복 파일 생성”을 막기 위해: 새 파일 만들기 전에 지도에서 기존 책임자를 먼저 찾는다.
- pageId 신규 발급은 오직 ids.cjs 책임(렌더/검증/QA 단계에서 발급 금지).
- 최종 주입자(Injector)는 “1개만” 고정(리뷰 주입 중복/덮어쓰기 방지).

────────────────────────────────────────────────────────────
1) System Boundaries (SSOT / 산출물 / 장부)
────────────────────────────────────────────────────────────
[SSOT(진짜 원본) — 변경 시 파급 큼]
- content/            : posts 원본(JSON), reviews 최종 SSOT(review-ratings.json)
- content/ssot/       : SSOT export(reviews.bySlug.json 등) — “배포용/참조용” (원본은 reviews SSOT)
- seedpool/           : seed 원본(warehouse/first-gate/trend/evergreen 포함)
- templates/          : 렌더 템플릿(화면 구조 SSOT)
- manifests/          : pageId, images 등 파이프라인 메타 SSOT
- logs/               : 장부(Seed Ledger 등) — 운영 진실(SSOT)

[산출물(언제든 재생성 가능) — 원칙적으로 덮어써도 OK]
- dist/posts/         : 렌더 HTML
- dist/images/        : 생성 이미지(og/body)
- dist/queue/         : today/firstgate/origin 등 “오늘 실행 스코프” 산출물
- dist/ai/            : feed/authority 등 외부노출 산출물
- dist/pages/         : trust 페이지 등 산출물

[가드 원칙]
- dist/*는 “결과물”이지 “원본”이 아님. 원인을 찾을 때 dist를 SSOT로 착각 금지.
- validate/qa는 “수정/판정”만: 신규 발급/외부 사이드이펙트 금지.

────────────────────────────────────────────────────────────
2) Root & ENV (환경/게이트 단일화)
────────────────────────────────────────────────────────────
[ROOT]
- System_files/ 가 절대 루트.

[ENV Loader 단일화]
- scripts/build/lib/env.cjs
  - 모든 스크립트가 동일 파서/동일 루트 규칙을 사용하도록 강제하는 핵심 파일.
  - 여기서 어긋나면 “DRY_RUN인데 업로드/발행됨” 같은 사고가 난다.

[DRY_RUN 규칙(단일)]
- false 또는 "0" 만 live
- 그 외 전부 dry-run

[PUBLISH 최종 게이트(단일)]
- canPublish = (DRY_RUN=false) AND (PUBLISH_MODE=enable)
- 이 게이트를 깨면 “테스트 중 실발행/실업로드”가 발생한다.

────────────────────────────────────────────────────────────
3) Pipeline Trunk (Pick → Queue → Posts → IDs → Render → Inject → QA → Upload → Publish)
────────────────────────────────────────────────────────────
A) Seed Pick / Schedule
  - seedpool/* → seed-scheduler.cjs → dist/queue/today.json
  - (별도) firstgate-pick.cjs → dist/queue/firstgate.json (first-gate 전용 1건 픽)
  - (별도) origin-pick.cjs → dist/queue/origin-today.json (origin 전용 1건 픽)

B) Expand Queue (Execution Scope 고정)
  - today.json → today-expand.cjs(권장/또는 현행 확장 로직) → today.expanded.json

C) Queue → Posts (posts JSON 생성/확장)
  - today.expanded.json → queue-to-posts.cjs → content/posts/*.json

D) Body Fill / Normalize
  - generate-body.cjs + markdown-list.cjs → posts JSON body 채움/정규화
  - normalize-body.cjs → dist/posts/*.html 본문 표준화(현재 구현 기준)

E) PageId Assignment (발급 책임자)
  - ids.cjs(+lib/page-ids.cjs) → posts JSON + manifests/page-ids.json + seed-ledger(assigned)

F) Render HTML (슬롯/뼈대 생성)
  - render-posts.cjs(+lib/meta.cjs + lib/blocks.cjs + templates/post.html) → dist/posts/*.html
  - NOTE: 리뷰 실제 데이터 “최종 반영”은 Injector가 책임(렌더는 슬롯/기본 섹션 생성)

G) Review Bundle (리뷰 전용 가지 — 2026-01-18~19 확정 업데이트)
  - review-stub-fill.cjs            : 리뷰 대상 slug 감지 → bucket/insights/sources에 stub 업서트(없을 때만)
  - review-fetch-official.cjs       : 공식 API(provider) 수집 → *-ratings-next.json + review-sources.json 업서트
  - review-fetch-insights-secondary.cjs : 네트워크 없이 rule-based 인사이트 보완(2차)
  - review-build-next.cjs           : bucket next + insights + sources 병합 → review-ratings-next.json 생성
  - build-ssot-reviews.cjs          : review-ratings-next → review-ratings(SSOT) 멱등 병합 + export(bySlug)
  - inject-reviews-from-ssot.cjs    : dist/posts 리뷰 섹션 치환(최종 주입자 고정) + freshness 통계
  - (대체 주입자) review-meta-block.cjs : 사용 가능하나 최종 주입자 1개 고정 원칙

H) Validate / QA
  - validate-repair.cjs → (마지막 안전망 패치)
  - qa-check.cjs + check-content-blocks.cjs → 품질/누락/CRIT 판정 + logs 리포트(운영 근거)

I) Upload (R2)
  - r2-upload.cjs → dist/images + 필요 산출물 업로드

J) Publish (Blogger)
  - scripts/publish/blogger.cjs → Blogger 발행 + seed-ledger(published upsert)

────────────────────────────────────────────────────────────
4) File Index (“열지 않고 판단”용) — 역할/입출력/결합/파급/증상
────────────────────────────────────────────────────────────
표기:
- R = READ, W = WRITE
- 결합(Strong Coupling) = 이 파일 없거나 규약 깨지면 연쇄 고장
- 파급(Blast Radius) = 수정 시 같이 흔들리는 영역
- 대표 증상 = 원인 후보를 바로 찾기 위한 키워드

(중요 추가) 리뷰/SSOT 관련 “현재 운영 사실”
- inject-reviews-from-ssot.cjs는 baseline SSOT = content/reviews/review-ratings.json 을 읽는다.
- 따라서 next를 만들기만 하면 안 되고(=review-ratings-next.json), 반드시 SSOT 반영(build-ssot-reviews / diff-update)이 필요하다.
- “slotMissing=0 + ratingMissing=0”이면 템플릿 섹션 ID 계약 및 SSOT 참조는 정상이라고 판단한다.

────────────────────────────
4.1 ENV / 공통 기반
────────────────────────────
(1) scripts/build/lib/env.cjs
- 역할 범위: ROOT/ENV 로딩, DRY_RUN 파서, 공통 옵션 파싱(모든 스크립트의 전제)
- R: .env, process.env
- W: 없음
- 결합: ★★★★★

────────────────────────────
4.4 IDs / PageId / Ledger (발급·연속성·장부)
────────────────────────────
(12) scripts/build/ids.cjs  ★ pageId 발급 책임자
- active 모드: publishable slug만 발급(폭주 방지)
- DRY_RUN 규칙 통일: false/'0'만 live

────────────────────────────
4.5 Render / Templates / Blocks (화면 구조 + 메타 생성)
────────────────────────────
(15) scripts/build/render-posts.cjs
- 역할 범위: posts JSON + templates + meta/blocks로 dist/posts HTML 생성
- R: content/posts/*.json, templates/post.html, lib/meta.cjs, lib/blocks.cjs, manifests/*
- W: dist/posts/*.html
- 결합: ★★★★★

(16) templates/post.html  ★ 화면 구조 SSOT
- review 섹션 placeholder(id="review-rating-block", id="review-insights-block")는 Injector 치환 앵커로 사용됨(절대 변경 금지)

────────────────────────────
4.7 Review Branch (리뷰 전용 가지 — 최신 확정판)
────────────────────────────
- scripts/build/review-stub-fill.cjs
- scripts/build/review-fetch-official.cjs
- scripts/build/review-fetch-insights-secondary.cjs
- scripts/build/review-build-next.cjs
- scripts/build/build-ssot-reviews.cjs
- scripts/build/inject-reviews-from-ssot.cjs  (최종 주입자 고정)
- scripts/build/review-meta-block.cjs (대체 가능, 중복 실행 금지)

────────────────────────────
4.8 Validate / QA (최후 안전망 + 자동발행 판단 근거)
────────────────────────────
(26) scripts/build/qa-check.cjs
- 역할: dist/posts 검사 → FAIL/WARN/CRIT 판정 + logs/qa-report.json 저장
- NOTE: og:image HEAD 체크 불안정 패치는 “정리 후 착수”로 보류

────────────────────────────────────────────────────────────
5) “원인 파일을 바로 찾는” 진단 라우팅(핵심)
────────────────────────────────────────────────────────────
[증상 → 원인 후보 파일]
- 리뷰 섹션이 비어있음 / app만 나옴:
  - review-stub-fill.cjs → review-build-next.cjs → build-ssot-reviews.cjs → inject-reviews-from-ssot.cjs
  - templates/post.html 섹션 ID 계약 유지 여부(슬롯)
- next 존재 but SSOT 변화 0:
  - next==baseline 동일 / next 생성 실패 / slug mismatch
  - build-ssot-reviews.cjs가 WARN로 알려줌

────────────────────────────────────────────────────────────
6) SSOT Registry (진짜 원본 목록)
────────────────────────────────────────────────────────────
Reviews:
- content/reviews/review-ratings.json (최종 SSOT)
- content/reviews/review-ratings-next.json (후보)
- content/ssot/reviews.bySlug.json (export)

End of AOIA Flow Map (SSOT) — 상세판
