# AOIA Flow Map (SSOT) — 상세판 (원본 유지 + 추가분 병합본)
- Path (SSOT): System_files/docs/aoia-flow-map.md
- Last Updated: 2026-01-15 (+0900)

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
- “중복 파일 생성”을 막기 위해: 새 파일 만들기 전에 지도에서 기존 책임자를 먼저 찾는다.

────────────────────────────────────────────────────────────
1) System Boundaries (SSOT / 산출물 / 장부)
────────────────────────────────────────────────────────────
[SSOT(진짜 원본) — 변경 시 파급 큼]
- content/            : posts 원본(JSON), reviews SSOT
- seedpool/           : seed 원본(warehouse/first-gate/trend/evergreen 포함)
- templates/          : 렌더 템플릿(화면 구조 SSOT)
- manifests/          : pageId, images 등 파이프라인 메타 SSOT
- logs/               : 장부(Seed Ledger 등) — 운영 진실(SSOT)

[산출물(언제든 재생성 가능) — 원칙적으로 덮어써도 OK]
- dist/posts/         : 렌더 HTML
- dist/images/        : 생성 이미지(og/body)
- dist/queue/         : today/today.expanded 등 “오늘 실행 스코프” 산출물
- dist/ai/            : feed/authority 등 외부노출 산출물

[가드 원칙]
- dist/*는 “결과물”이지 “원본”이 아님. 원인을 찾을 때 dist를 SSOT로 착각 금지.
- pageId 신규 발급은 오직 ids.cjs 책임(렌더/검증 단계에서 발급 금지).

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
- 이 게이트를 깨면 “테스트 중 실발행”이 발생한다.

────────────────────────────────────────────────────────────
3) Pipeline Trunk (Pick → Queue → Posts → IDs → Render → Inject → QA → Upload → Publish)
────────────────────────────────────────────────────────────
A) Seed Pick / Schedule
  - seedpool/* → seed-scheduler.cjs → dist/queue/today.json

B) Expand Queue (Execution Scope 고정)
  - today.json → today-expand.cjs(권장/또는 현행 확장 로직) → today.expanded.json

C) Queue → Posts (posts JSON 생성/확장)
  - today.expanded.json → queue-to-posts.cjs → content/posts/*.json

D) Body Fill / Normalize
  - generate-body.cjs + normalize-body.cjs (+ markdown-list.cjs) → posts JSON body 정규화

E) PageId Assignment (발급 책임자)
  - ids.cjs(+lib/page-ids.cjs) → posts JSON + manifests/page-ids.json + seed-ledger(assigned)

F) Render HTML
  - render-posts.cjs(+lib/meta.cjs + lib/blocks.cjs + templates/post.html) → dist/posts/*.html

G) Review Bundle (리뷰 전용 가지)
  - review-* 번들 → dist/posts HTML의 review 섹션 치환

H) Validate / QA
  - validate-repair.cjs → (마지막 안전망 패치)
  - qa-check.cjs + check-content-blocks.cjs → 품질/누락/CRIT 판정

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

────────────────────────────
4.1 ENV / 공통 기반
────────────────────────────
(1) scripts/build/lib/env.cjs
- 역할 범위: ROOT/ENV 로딩, DRY_RUN 파서, 공통 옵션 파싱(모든 스크립트의 전제)
- R: .env, process.env
- W: 없음
- 결합: ★★★★☆ (전 스크립트)
- 파급: “테스트/라이브 분기”, “경로(루트)”, “게이트(canPublish)” 전부 영향
- 대표 증상:
  - DRY_RUN인데 외부 호출 발생
  - 경로가 과거 루트로 흘러가 파일을 못 찾음

────────────────────────────
4.2 Queue / 스케줄(시드 선택 → 오늘 실행 범위)
────────────────────────────
(2) scripts/build/seed-scheduler.cjs
- 역할 범위: seedpool에서 “오늘 발행 계획(Plan SSOT)”을 선택/생성
- R: seedpool/*.json(라벨별 운영본/warehouse)
- W: dist/queue/today.json
- 결합: ★★★★☆
- 파급: “오늘 어떤 라벨이 몇 개 나오느냐”가 전체 산출물을 좌우

(3) scripts/build/today-expand.cjs (권장: Execution SSOT 생성기)
- 역할 범위: today.json을 “실행용 확정 스코프(슬러그/라벨/프로필/시퀀스)”로 고정
- R: dist/queue/today.json, profiles/labels.json, seedpool/profiles/label-profiles.json(존재 시)
- W: dist/queue/today.expanded.json
- 결합: ★★★★☆
- 파급: ids/render/publish가 “무엇을 대상으로 돌지”를 결정

(4) dist/queue/today.json
- 역할 범위: “오늘 계획 SSOT(Plan)”
- 특징: 계획(Plan)이라 실행용(슬러그 확정) 정보가 부족할 수 있음

(5) dist/queue/today.expanded.json
- 역할 범위: “오늘 실행 스코프 SSOT(Execution)”
- 특징: publishableSlugs 기준으로 ids/render/publish 범위를 잠근다.

────────────────────────────
4.3 Posts JSON 생성/보정(SSOT)
────────────────────────────
(6) scripts/build/queue-to-posts.cjs
- 역할 범위: 오늘 큐를 content/posts/*.json으로 변환(신규 생성 + 필요한 필드 강제)
- R: dist/queue/today(.expanded).json, profiles/labels.json(프로필 매핑이 있다면)
- W: content/posts/{slug}.json
- 결합: ★★★★☆

(7) scripts/build/generate-body.cjs
- 역할 범위: posts JSON의 body를 채움(기존 body 있으면 SKIP가 원칙)
- R/W: content/posts/*.json

(8) scripts/build/normalize-body.cjs
- 역할 범위: body HTML/마크다운 정리, 표준화
- R/W: dist/posts/*.html (현재 구현 기준)

(9) scripts/build/markdown-list.cjs
- 역할 범위: posts JSON body 내 마크다운 스타일을 HTML 블록으로 정규화(멱등 마커)
- R/W: content/posts/*.json

(10) scripts/build/patch-missing-labels.cjs
- 역할 범위: labels 누락을 slug prefix로 복구(응급)
- R/W: content/posts/*.json

────────────────────────────
4.4 IDs / PageId / Ledger (발급·연속성·장부)
────────────────────────────
(12) scripts/build/ids.cjs  ★ pageId 발급 책임자
- 역할 범위:
  - pageId 없는 posts에 pageId 할당
  - “active 모드”에서 오늘 publishable slug만 발급(폭주 방지)
  - Seed Ledger(status=assigned) 업서트
- R: content/posts/*.json, dist/queue/today(.expanded).json(스코프)
- W:
  - content/posts/*.json(pageId)
  - manifests/page-ids*.json
  - manifests/pageid-journal.jsonl
  - logs/seed-ledger.jsonl(assigned)

(14) logs/seed-ledger.jsonl  ★ 운영 SSOT 장부
- 역할 범위: seedId/slug/pageId/상태(assigned/published 등) 운영 진실 기록

────────────────────────────
4.5 Render / Templates / Blocks (화면 구조 + 메타 생성)
────────────────────────────
(15) scripts/build/render-posts.cjs
- 역할 범위: posts JSON + templates + meta/blocks로 dist/posts HTML 생성
- R: content/posts/*.json, templates/post.html, lib/meta.cjs, lib/blocks.cjs, manifests/*
- W: dist/posts/*.html
- 결합: ★★★★★

(16) templates/post.html  ★ 화면 구조 SSOT
- 역할 범위: 섹션/슬롯/hero/광고 위치 등 “HTML 뼈대”
- 결합: ★★★★★

(17) scripts/build/lib/blocks.cjs
- 역할 범위: TLDR/KeyFacts/FAQ/Sources/Review 등 블록 렌더 함수
- 결합: ★★★★☆

(18) scripts/build/lib/meta.cjs
- 역할 범위: canonical/og/twitter/JSON-LD/updated_time 등 메타 생성기
- 결합: ★★★★☆

────────────────────────────
4.6 Images (OG/Body 생성·치환·인덱싱)
────────────────────────────
(20) scripts/build/images-build-og.cjs
- 역할 범위: OG 이미지 생성/준비 → dist/images/og 구성
- 결합: ★★★☆☆

(21) scripts/build/images-build-body.cjs
- 역할 범위: 본문 최소 1장 이미지 생성/준비
- 결합: ★★★☆☆

(23) scripts/build/rewrite-images.cjs (또는 rewrite-images.js)
- 역할 범위: dist/posts HTML 이미지 URL을 CDN_BASE로 치환(멱등 중요)
- 결합: ★★★★☆

(24) scripts/build/images-renew.cjs / images-manifest 갱신기
- 역할 범위: dist/posts 스캔 → manifests/images-manifest.json 갱신
- 결합: ★★★☆☆

────────────────────────────
4.7 Review Branch (리뷰 전용 가지 — 상세는 review-pipeline-map.md)
────────────────────────────
- review-stub-fill.cjs (신규)
- review-build-next.cjs (신규)
- review-diff-update.cjs
- inject-reviews-from-ssot.cjs / review-meta-block.cjs
- review-resolver.cjs
- review-due-90days.cjs
- qa-check.cjs (리뷰 SSOT 누락 시 CRIT 방어)

────────────────────────────
4.8 Validate / QA (최후 안전망 + 자동발행 판단 근거)
────────────────────────────
(25) scripts/build/validate-repair.cjs
- 역할 범위: dist/posts HTML 후처리 패치(마지막 안전망)
- 주의: validate 단계 신규 발급 금지 원칙 유지

(26) scripts/build/qa-check.cjs
- 역할 범위: dist/posts 검사 → CRIT/WARN 판정 + 리포트 생성
- 리뷰 라벨의 SSOT 누락/형식 오류는 여기서 “발행 제외”로 방어해야 함

────────────────────────────
4.9 Feed / Trust Pages (외부 노출 산출물)
────────────────────────────
(29) scripts/build/build-feed.cjs → dist/ai/feed.ndjson
(30) scripts/build/validate-feed.cjs
(31) dist/ai/authority.json  ★ 기계판 신뢰 앵커(산출물)
- 역할: AI/크롤러가 사이트 신뢰도를 기계적으로 판단할 기준 데이터
- 성격: dist 산출물(재생성 가능), 사람용 대응은 dist/pages/trust.html

────────────────────────────
4.10 Upload / Publish (외부 사이드이펙트)
────────────────────────────
(33) scripts/build/r2-upload.cjs
- 역할 범위: dist/images 등 산출물을 R2로 업로드(외부 호출)
- DRY_RUN 게이트 위반 시 비용/오염 발생

(34) scripts/publish/blogger.cjs  ★ 최종 발행자
- 역할 범위: dist/posts HTML을 Blogger에 발행 + seed-ledger published 업서트

────────────────────────────────────────────────────────────
5) “원인 파일을 바로 찾는” 진단 라우팅(핵심)
────────────────────────────────────────────────────────────
[증상 → 원인 후보 파일]
1) 특정 라벨이 계속 0건 / 평일 라벨 선택이 비정상
- seed-scheduler.cjs (weekday→labels 매핑/선택 로직)
- today-expand.cjs (execution 스코프에서 라벨/슬러그 확정 과정)

2) 라벨이 단일로 뭉개져 인식/보충이 안 됨
- today-expand.cjs
- queue-to-posts.cjs
- patch-missing-labels.cjs(응급복구의 부작용 가능)

3) 본문이 비어 있음(skeleton)
- generate-body.cjs
- markdown-list.cjs / normalize-body.cjs(정규화로 내용 훼손 여부)

4) 리뷰 섹션이 비어있음 / app만 히스토그램 나옴
- review-pipeline-map.md의 “SSOT/next/merge/inject” 전체 라인 확인
- review-stub-fill.cjs (stub 누락/대상 누락)
- review-build-next.cjs (next 통합 실패)
- review-diff-update.cjs (next→SSOT 반영 실패)
- inject-reviews-from-ssot.cjs / review-meta-block.cjs (슬롯 불일치)

5) OG 이미지 깨짐 / 경로 404
- images-build-og.cjs
- rewrite-images.cjs
- lib/meta.cjs
- r2-upload.cjs

6) DRY_RUN인데 업로드/발행됨
- lib/env.cjs
- r2-upload.cjs / blogger.cjs

────────────────────────────────────────────────────────────
6) SSOT Registry (진짜 원본 목록)
────────────────────────────────────────────────────────────
Queue:
- dist/queue/today.json (Plan SSOT)
- dist/queue/today.expanded.json (Execution SSOT)

Posts:
- content/posts/{slug}.json (Post SSOT)

IDs:
- manifests/page-ids*.json
- manifests/pageid-journal.jsonl
- logs/seed-ledger.jsonl

Reviews:
- content/reviews/review-ratings.json (bySlug 통합 SSOT)

Images:
- manifests/images-manifest.json
- manifests/images-body-manifest.json

Profiles (라벨→프로필 / 프로필→구조 규칙):
- profiles/labels.json
- seedpool/profiles/label-profiles.json

End of AOIA Flow Map (SSOT) — 상세판
