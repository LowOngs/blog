# AOIA Flow Map (SSOT) — 상세판
- Path: System_files/docs/aoia-flow-map.md
- Last Updated: 2026-01-15 (+0900)

목표:
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
3) Pipeline Trunk (큰 줄기: Pick → Queue → Posts → IDs → Render → Inject → QA → Upload → Publish)
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
  - 경로가 google-blog 등 과거 루트로 흘러가 파일을 못 찾음

────────────────────────────
4.2 Queue / 스케줄(시드 선택 → 오늘 실행 범위)
────────────────────────────
(2) scripts/build/seed-scheduler.cjs
- 역할 범위: seedpool에서 “오늘 발행 계획(Plan SSOT)”을 선택/생성
- R: seedpool/*.json(라벨별 운영본/warehouse), publish-guard/ledger 류(프로젝트 정책에 따라)
- W: dist/queue/today.json
- 결합: ★★★★☆ (파이프라인 첫 관문)
- 파급: “오늘 어떤 라벨이 몇 개 나오느냐”가 전체 산출물을 좌우
- 대표 증상:
  - 평일인데 how-to만 선택됨(요일→라벨 매핑/선택 로직 문제)
  - seed 부족이 아닌데 특정 라벨이 계속 0건

(3) scripts/build/today-expand.cjs (권장: Execution SSOT 생성기)
- 역할 범위: today.json을 “실행용 확정 스코프(슬러그/라벨/프로필/시퀀스)”로 고정
- R: dist/queue/today.json, labels.json(프로필 매핑이 있다면)
- W: dist/queue/today.expanded.json
- 결합: ★★★★☆ (스코프 혼선 방지 핵심)
- 파급: ids/render/publish가 “무엇을 대상으로 돌지”를 결정
- 대표 증상:
  - today.expanded와 today의 스코프 불일치
  - slug 충돌/중복, prefix 규칙 혼선, 라벨 6개가 “단일로 뭉개지는” 현상

(4) dist/queue/today.json
- 역할 범위: “오늘 계획 SSOT”
- 특징: 계획(Plan)이라 실행용(파일명/슬러그 확정) 정보가 부족할 수 있음

(5) dist/queue/today.expanded.json
- 역할 범위: “오늘 실행 스코프 SSOT”(Execution)
- 특징: publishableSlugs 기준으로 ids/render/publish 범위를 잠근다.

────────────────────────────
4.3 Posts JSON 생성/보정(SSOT)
────────────────────────────
(6) scripts/build/queue-to-posts.cjs
- 역할 범위: 오늘 큐를 content/posts/*.json으로 변환(신규 생성 + 필요한 필드 강제)
- R: dist/queue/today(.expanded).json, labels/profile 매핑, 템플릿용 기본 값
- W: content/posts/{slug}.json (신규 생성 중심, 정책상 덮어쓰기 제한)
- 결합: ★★★★☆ (posts SSOT 만드는 공장)
- 파급: 이후 모든 단계(ids/render/review/feed)가 posts JSON에 의존
- 대표 증상:
  - labels가 비어있거나 잘못 들어감 → 리뷰/라벨 기반 로직 전부 오작동
  - title/description 누락 → render/meta에서 FAIL 또는 빈 페이지

(7) scripts/build/generate-body.cjs
- 역할 범위: posts JSON의 body를 실제 본문으로 채움(모드/overwrite 정책 중요)
- R: content/posts/*.json, bodyPrompt 등
- W: content/posts/*.json(body 필드)
- 결합: ★★★☆☆
- 파급: “본문 공백(스켈레톤)” 문제의 1차 원인 후보
- 대표 증상:
  - <p><!-- content --></p> 같은 skeleton만 존재

(8) scripts/build/normalize-body.cjs
- 역할 범위: body HTML/마크다운 정리, 표준화(후속 렌더 안전성)
- R/W: content/posts/*.json
- 결합: ★★★☆☆
- 파급: 렌더 깨짐/태그 불량/중복 마커 문제
- 대표 증상:
  - 본문 태그 깨짐, 예상치 못한 중복 변환

(9) scripts/build/markdown-list.cjs
- 역할 범위: body 내부 마크다운 스타일을 HTML 블록으로 정규화(<!--MD_NORMALIZED--> 마커로 멱등)
- R/W: content/posts/*.json
- 결합: ★★☆☆☆
- 파급: 본문 리스트/헤딩/특수 라인 표현 통일
- 대표 증상:
  - 같은 변환이 반복 적용되거나(마커 미작동) 리스트가 엉킴

(10) scripts/build/patch-missing-labels.cjs
- 역할 범위: content/posts의 labels 누락을 slug prefix로 복구(단일 라벨만 주입)
- R/W: content/posts/*.json
- 결합: ★★★☆☆ (응급복구)
- 파급: 라벨 기반 로직(리뷰/스케줄/프로필 매핑) 전반
- 대표 증상:
  - labels=[] 때문에 스케줄/리뷰가 인식 안됨 → 임시복구 가능

(11) scripts/build/slug-builder.cjs
- 역할 범위: content/posts 파일명 스캔해 다음 slug 시퀀스 산출(콘솔 출력)
- R: content/posts/*.json(파일명)
- W: 없음
- 결합: ★★☆☆☆
- 파급: slug 충돌/NNN 증가 규칙에 영향(날짜/타임존 주의)
- 대표 증상:
  - 같은 날짜/라벨에서 NNN 충돌 또는 날짜 기준이 엇갈림

────────────────────────────
4.4 IDs / PageId / Ledger (발급·연속성·장부)
────────────────────────────
(12) scripts/build/ids.cjs  ★ pageId 발급 책임자
- 역할 범위:
  - pageId가 없는 posts에 pageId 할당
  - “active 모드”에서 오늘 publishable slug만 발급(폭주 방지)
  - Seed Ledger(status=assigned) 업서트
- R:
  - content/posts/*.json
  - (active) dist/queue/today.json 또는 today.expanded.json(운영 설정에 따라) — publishableSet
- W:
  - content/posts/*.json(pageId)
  - manifests/page-ids.json(+ local 변형 가능)
  - manifests/pageid-journal.jsonl
  - logs/seed-ledger.jsonl(assigned)
- 결합: ★★★★★ (pageId 정책의 핵심, 여기 무너지면 전부 무너짐)
- 파급: render/meta/canonical/manifest/발행 URL 등 전부 연쇄 영향
- 대표 증상:
  - pageId 결번/중복/리셋
  - 오늘 스코프 외 파일까지 발급되는 폭주
  - “validate 단계에서 발급” 같은 금지 위반 의심

(13) scripts/build/lib/page-ids.cjs
- 역할 범위: pageId 검증/할당 유틸(SSOT: manifests/page-ids.json 관리)
- 결합: ★★★★☆

(14) logs/seed-ledger.jsonl  ★ 운영 SSOT 장부
- 역할 범위: seedId/slug/pageId/상태(assigned/published 등) 운영 진실 기록
- 파급: “이미 사용한 seed 재사용”, “발행 여부 추적”, “pageId 연속성” 판단 근거
- 대표 증상:
  - 발행했는데 ledger 미기록 → 재발행/중복 가능
  - assigned는 있는데 published가 없음 → publish 단계 문제

────────────────────────────
4.5 Render / Templates / Blocks (화면 구조 + 메타 생성)
────────────────────────────
(15) scripts/build/render-posts.cjs
- 역할 범위:
  - posts JSON + templates + meta/blocks를 합쳐 dist/posts HTML 생성
  - 계약: pageId 없으면 ids 1회 재시도, 그래도 없으면 FAIL(원칙)
- R: content/posts/*.json, templates/post.html, lib/meta.cjs, lib/blocks.cjs, manifests/*
- W: dist/posts/*.html
- 결합: ★★★★★ (화면/메타/슬롯 구조의 최종 조립기)
- 파급: HTML 구조가 바뀌면 이후 “inject/validate/images-manifest”가 전부 영향
- 대표 증상:
  - 슬롯 ID가 사라져 review-meta-block이 못 치환
  - canonical/og/url 깨짐, hero 구조 변경으로 images-manifest 추출 실패

(16) templates/post.html  ★ 화면 구조 SSOT
- 역할 범위: 섹션/슬롯/hero/광고 위치 등 “HTML 뼈대”
- R: (렌더 시 읽힘)
- W: (템플릿 수정)
- 결합: ★★★★★
- 파급: 섹션 ID/구조가 바뀌면 injector/validator/manifest가 연쇄 파손
- 대표 증상:
  - review 섹션이 “empty placeholder”로만 남음(슬롯 구조 불일치 가능)
  - hero figure 구조 변경으로 validate-repair의 이미지 패치/manifest 추출 영향

(17) scripts/build/lib/blocks.cjs
- 역할 범위: TLDR/KeyFacts/FAQ/Sources/Review 등 블록 렌더 함수(“내용 블록의 구현체”)
- R: posts JSON의 tldr/keyfacts/faq/sources/reviewData 등
- W: 없음(HTML 문자열 생성)
- 결합: ★★★★☆
- 파급: “블록 출력 규칙”과 “ID/클래스/슬롯”의 일치성
- 대표 증상:
  - FAQ에 [object Object]가 나온다(블록 렌더 정책 문제)
  - 특정 라벨의 고정/랜덤 중제목 삽입이 안 된다(블록/템플릿 어디인지 구분 필요)

(18) scripts/build/lib/meta.cjs
- 역할 범위: canonical/og/twitter/JSON-LD/updated_time 등 메타 생성기
- 결합: ★★★★☆
- 파급: SEO/OG/스키마 및 images-manifest의 필수 태그 추출에 영향
- 대표 증상:
  - og:image 중복/누락, datePublished/dateModified 불일치

(19) scripts/build/ai-meta.js
- 역할 범위: AI/검색/크롤러용 메타 보강(프로젝트 정의에 따름)
- 결합: ★★☆☆☆

────────────────────────────
4.6 Images (OG/Body 생성·치환·인덱싱)
────────────────────────────
(20) scripts/build/images-build-og.cjs
- 역할 범위: OG 이미지 생성(또는 준비) → dist/images 및 업로드 대상 구성
- R: posts JSON, manifests/images-manifest(또는 생성 규칙), 템플릿/메타
- W: dist/images/*
- 결합: ★★★☆☆
- 파급: og:image 경로/크기/일관성 → 공유 썸네일/링크 미리보기
- 대표 증상:
  - OG 이미지 깨짐/404, 크기 태그 불일치

(21) scripts/build/images-build-body.cjs
- 역할 범위: 본문 최소 1장 이미지 생성/준비(“본문 이미지 파이프라인” 핵심)
- R/W: dist/images/*, manifests/images-body-manifest.json(있다면)
- 결합: ★★★☆☆
- 파급: 본문 이미지 삽입/치환 단계와 맞물림
- 대표 증상:
  - 본문 이미지가 0장(규칙/주입 위치/manifest 불일치)

(22) scripts/build/images-renew.cjs
- 역할 범위: 이미지 재생성/갱신(정책에 따라)
- 결합: ★★☆☆☆

(23) scripts/build/rewrite-images.cjs (또는 rewrite-images.js)
- 역할 범위: dist/posts HTML의 이미지 URL을 CDN_BASE 기준으로 치환(멱등 중요)
- R: dist/posts/*.html, CDN_BASE
- W: dist/posts/*.html
- 결합: ★★★★☆
- 파급: 실제 브라우저 로딩 경로, 이미지 404/혼재(절대/상대) 문제
- 대표 증상:
  - 로컬 경로/이전 도메인 잔재가 HTML에 남음
  - 반복 실행 시 경로가 꼬임(멱등 실패)

(24) scripts/build/images-manifest.cjs  ★ 이미지 인덱스(SSOT) 생성기
- 역할 범위: dist/posts를 스캔해 manifests/images-manifest.json(SSOT)을 갱신
- R: dist/posts/*.html, 기존 manifests/images-manifest.json
- W: manifests/images-manifest.json
- 결합: ★★★☆☆ (후속 이미지/SEO/검증 참고용)
- 파급: “어떤 페이지의 og:image가 무엇인지”를 SSOT로 제공
- 대표 증상:
  - pageId 추출 실패(속성 순서 의존) → manifest 누락
  - hero 구조 변경 → alt 추출 실패

────────────────────────────
4.7 Review Branch (리뷰 전용 가지 — 상세는 review-pipeline-map.md)
────────────────────────────
- scripts/build/review-resolver.cjs
- scripts/build/review-meta-block.cjs
- scripts/build/review-diff-update.cjs
- scripts/build/update-review-ratings.cjs
- scripts/build/reviews-bootstrap.cjs
- scripts/build/check-review-freshness.cjs
(각 파일 상세는 review-pipeline-map.md에 기록)

────────────────────────────
4.8 Validate / QA (최후 안전망 + 자동발행 판단 근거)
────────────────────────────
(25) scripts/build/validate-repair.cjs  ★ 마지막 안전망 패처
- 역할 범위:
  - dist/posts HTML 후처리 패치
  - (관측) hero overflow, img max-width 스타일 등 인라인 보정
  - (주의) pageId 회수/동기화 관련 로직이 들어가면 “발급 금지 원칙”과 충돌 소지
- R: dist/posts/*.html (+ 필요 시 content/posts, journal)
- W: dist/posts/*.html
- 결합: ★★★★☆ (발행 직전 안전망)
- 파급: HTML이 커지거나, 메타가 중복될 위험(정규식 매칭 한계)
- 대표 증상:
  - og/meta 중복 생성
  - 인라인 스타일 과다로 HTML 비대화
  - validate 단계에서 ids 호출 의심(부작용)

(26) scripts/build/qa-check.cjs
- 역할 범위: dist/posts를 검사해 CRIT/WARN 등 판정 + 리포트 생성(자동발행 제어 근거)
- R: dist/posts/*.html (+ SSOT 검사도 포함 가능)
- W: logs/qa-*.json(리포트)
- 결합: ★★★★☆
- 파급: “발행 대상 제외” 로직의 근거 파일
- 대표 증상:
  - 리뷰 라벨인데 SSOT 누락 → CRIT
  - 필수 블록(TLDR/FAQ/Sources) 누락 → FAIL/CRIT

(27) scripts/build/lib/check-content-blocks.cjs
- 역할 범위: HTML에 필수 블록 ID 존재 여부 1차 검사(없으면 exitCode=1)
- R: dist/posts/*.html
- W: 없음(또는 로그)
- 결합: ★★★☆☆
- 대표 증상:
  - TLDR/KeyFacts/FAQ/Sources 영역 누락 즉시 탐지

(28) scripts/build/check-review-freshness.cjs
- 역할 범위: 리뷰 3라벨의 lastChecked(90일) 경고/누락 통계 출력
- R: dist/posts, content/posts(라벨), content/reviews/review-ratings.json
- W: 없음(콘솔)
- 결합: ★★☆☆☆

────────────────────────────
4.9 Feed / Trust Pages (외부 노출 산출물)
────────────────────────────
(29) scripts/build/build-feed.cjs
- 역할 범위: dist/ai/feed.ndjson 등 AIO 피드 생성(정책에 따라)
- 결합: ★★☆☆☆

(30) scripts/build/validate-feed.cjs
- 역할 범위: feed 포맷/필드 검증
- 결합: ★★☆☆☆

(31) scripts/build/build-trust-page.cjs
- 역할 범위: dist/pages/trust.html 생성(권위/신뢰 페이지)
- 결합: ★★☆☆☆

(32) scripts/build/copy-tools.cjs
- 역할 범위: 배포/툴 파일 복사(정책성)
- 결합: ★☆☆☆☆

────────────────────────────
4.10 Upload / Publish (외부 사이드이펙트)
────────────────────────────
(33) scripts/build/r2-upload.cjs
- 역할 범위: dist/images 등 산출물을 R2로 업로드(외부 호출)
- R: dist/*, manifests/*, env
- W: R2(외부), logs(선택)
- 결합: ★★★★☆
- 파급: DRY_RUN 게이트 위반 시 비용/오염 발생
- 대표 증상:
  - DRY_RUN인데 업로드됨 → env 파서/게이트 문제

(34) scripts/publish/blogger.cjs  ★ 최종 발행자
- 역할 범위:
  - dist/posts HTML을 Blogger에 발행
  - 실행 스코프(today.expanded publishableSlugs)만 발행하도록 가드
  - seed-ledger에 published 결과(upsert) 기록
- R: dist/posts, dist/queue/today(.expanded), env, logs/seed-ledger
- W: Blogger(외부), logs/publish-*.log, logs/seed-ledger.jsonl(upsert)
- 결합: ★★★★★
- 파급: 발행 사고(중복/폭주/429)는 여기서 제어해야 한다.
- 대표 증상:
  - 대량발행/429 → scope/sleep/max_posts 설정 문제
  - 발행했는데 ledger에 published가 안 찍힘 → 업서트 로직 문제

────────────────────────────────────────────────────────────
5) “원인 파일을 바로 찾는” 진단 라우팅(핵심)
────────────────────────────────────────────────────────────
[증상 → 원인 후보 파일]
1) 특정 라벨이 계속 0건 / 평일 라벨 선택이 비정상
- seed-scheduler.cjs (weekday→labels 매핑/선택 로직)
- today-expand.cjs (라벨 6개 강제/슬러그 확정 과정에서 뭉개짐)

2) 라벨이 단일로 뭉개져 인식/보충이 안 됨(현재 핵심 이슈 유형)
- today-expand.cjs (execution 스코프에서 label/prefix/profileId를 “단일화”했는지)
- queue-to-posts.cjs (labels 배열 강제 규칙, profileId 매핑 실패 시 fallback이 단일화되는지)
- patch-missing-labels.cjs (응급복구가 단일 라벨만 넣기 때문에 설계상 “단일화”로 보일 수 있음)

3) 본문이 비어 있음(skeleton)
- generate-body.cjs (fill 모드/overwrite 정책)
- normalize-body.cjs / markdown-list.cjs (마커/정규화로 내용이 지워지는지)

4) 리뷰 섹션이 비어있음 / app만 히스토그램 나옴
- review-meta-block.cjs (slot 치환 대상 섹션 ID/구조)
- templates/post.html (리뷰 슬롯이 bucket=app 전제인지)
- review-ratings.json(bySlug) (SSOT에 slug가 없는지)

5) OG 이미지 깨짐 / 경로 404
- images-build-og.cjs (생성/경로)
- rewrite-images.cjs (치환 규칙)
- lib/meta.cjs (og:image 메타 생성)
- r2-upload.cjs (업로드 누락)

6) DRY_RUN인데 업로드/발행됨
- lib/env.cjs (DRY_RUN 파서)
- r2-upload.cjs / blogger.cjs (게이트 준수 여부)

────────────────────────────────────────────────────────────
6) SSOT Registry (진짜 원본 목록)
────────────────────────────────────────────────────────────
Queue:
- dist/queue/today.json (Plan SSOT)
- dist/queue/today.expanded.json (Execution SSOT)

Posts:
- content/posts/{slug}.json (Post SSOT)

IDs:
- manifests/page-ids.json (+ pageid-journal.jsonl)
- logs/seed-ledger.jsonl (운영 장부 SSOT)

Reviews:
- content/reviews/review-ratings.json (bySlug 통합 SSOT)

Images:
- manifests/images-manifest.json (dist에서 추출해 저장되는 SSOT 인덱스)
- manifests/images-body-manifest.json (본문 1장 주입 SSOT)

End of AOIA Flow Map (Detailed)
