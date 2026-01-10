# AOIA Flow Map (SSOT) — System_files/docs/aoia-flow-map.md

> 규칙
> - 이 파일이 “지도(SSOT)”입니다. 개별 파일 주석은 참고용이고, 구조/연동/정책은 여기서만 확정합니다.
> - 로직/연동 변경을 제안할 때는 항상 먼저: “지도 맵도 함께 변경할까요?”를 묻고 진행합니다.
> - 파일명은 한 번 정하면 변경 금지(파일명 변경 제안 자체를 원칙 금지).

---

## 0) System_files 루트 구조(핵심 고정)

- ROOT: `System_files/`
- 입력(콘텐츠 SSOT)
  - `seedpool/` (운영 시드)
  - `seedpool/warehouse/` (first-gate / trend / evergreen 창고)
  - `content/posts/` (포스트 JSON SSOT)
  - `content/reviews/` (리뷰 SSOT)
- 빌드 산출물
  - `dist/queue/` (today.json, firstgate.json)
  - `dist/posts/` (렌더된 HTML)
  - `dist/ai/` (feed.ndjson, authority.json 등)
- 메타/장부(SSOT)
  - `manifests/` (page-ids, images-manifest 등)
  - `logs/` (seed-ledger 등)

---

## 1) “오늘 발행 대상” 큐 생성(Queue SSOT)

### 1-A. 일반 시드 스케줄러
- 파일: `scripts/build/seed-scheduler.cjs`
- 입력: `seedpool/{label}.json`
- 출력(SSOT): `dist/queue/today.json`
- 특징
  - 큐 생성은 환경과 무관하게 항상 수행(큐는 만들고, 발행은 별도 게이트에서 통제)
  - fallback 라벨 지원(슬롯에 시드 없을 때 대체 라벨에서 채움)

### 1-B. First-Gate 일일 1개 픽
- 파일: `scripts/build/firstgate-pick.cjs`
- 입력(read-only): `seedpool/warehouse/first-gate/*-firstgate.json`
- 출력: `dist/queue/firstgate.json`
- 사용기록(SSOT): `manifests/firstgate-usage.json`
- 특징
  - warehouse 원본 수정 금지
  - 우선순위/생성일 기준으로 “미사용 1개” 선택

---

## 2) 큐 → content/posts/*.json 생성 (Post JSON SSOT)

- 파일: `scripts/build/queue-to-posts.cjs`
- 입력(SSOT): `dist/queue/today.json`
- 출력(SSOT): `content/posts/*.json`
- 강제 정책(오염 차단)
  - 라벨은 6개만 허용(SSOT)
  - `labels: [label]` 필수 (단일 label 문자열 금지)
  - label → profileId 매핑 필수: `seedpool/profiles/labels.json`
  - title 누락이면 생성 금지(FATAL)

---

## 3) 본문 생성/정규화(Body)

- 파일: `scripts/build/generate-body.cjs` (H2 중제목 SSOT)
- 파일: `scripts/build/normalize-body.cjs` (문단/리스트 정리)
- 입력: `content/posts/*.json`
- 출력: `content/posts/*.json` (body 채움/정리)

> 주의: render 단계에서 본문 생성/변형 금지. (render는 “붙이기”만)

---

## 4) PageId 발급(SSOT + 장부)

- 파일: `scripts/build/ids.cjs` + `scripts/build/lib/page-ids.cjs`
- 입력 기준(원칙): `dist/queue/today.json` 등 “발행 대상만”
- 출력(SSOT): `manifests/page-ids.json` (및 journal/ledger 계열)
- 절대 규칙
  - render 단계에서 pageId 신규 발급 금지
  - pageId 누락 시: render는 ids.cjs “재실행 요청”만 1회 가능(발급/기록은 ids 책임)

---

## 5) 리뷰(Review) 파이프라인 — “리졸버 중심”으로 확정

### 5-0. 결론(같은 일인가?)
- `review-rating.cjs` 와 `review-resolver.cjs`는 **서로 같은 일을 하는 파일이 아닙니다.**
  - `review-rating.cjs` = **리뷰 SSOT를 “갱신하는 생성/업데이트기”**
  - `review-resolver.cjs` = **렌더 단계에서 SSOT를 “읽어 정규화하는 리졸버(읽기 전용)”**

즉,
- “추가 문제를 만드는 연동”이 아니라,
- **잘못될 수 있는 직접참조/파편화 대신 ‘단일 SSOT로 바르게 연결하는 과정’** 입니다.

### 5-A. SSOT(단일 소스)
- 파일(SSOT): `content/reviews/review-ratings.json`
- 형태: `{ meta, bySlug: { [slug]: { ... } } }`

### 5-B. SSOT 갱신기(스냅샷 → SSOT)
- 파일: `scripts/build/review-rating.cjs`
- 입력: `content/reviews/app-ratings.json` (스냅샷)
- 출력(SSOT): `content/reviews/review-ratings.json`
- 정책
  - `bySlug[slug]` 갱신
  - 기존 `histogram`, `insights`는 **보존**
  - previous(90일 전 근처) 계산 후 diff 산출

### 5-C. 리뷰 리졸버(렌더에서 호출, 읽기 전용)
- 파일: `scripts/build/review-resolver.cjs`
- 입력 우선순위
  1) `content/reviews/review-ratings.json` (SSOT)
  2) fallback: `postJson.review` / `postJson.reviews` (있을 때만)
- 라벨 조건
  - 리뷰 라벨 3종만 활성: `app-reviews`, `device-reviews`, `subscription-services`
- 정규화 규칙(확정)
  - insights는 **총 12개 고정** (긍정/부정 분리 최대치 같은 개념 폐기)
  - sources는 URL만 추출
  - rating/summary/pros/cons/insights 전부 비면 null 처리(리뷰 블록 미출력)

### 5-D. 렌더 주입(HTML)
- 파일: `scripts/build/render-posts.cjs`
- 흐름
  - `resolveReviewData({ ROOT, postJson })` 호출
  - 결과를 `blocks.renderReviewRatingBlock / renderReviewInsightsBlock` 로 출력
- 주의
  - “리뷰 HTML을 dist에 직접 덮어쓰는 별도 인젝터(review-meta-block 계열)”는
    **지도 기준으로는 ‘비권장/레거시’** 로 취급(필요 시 별도 섹션에 격리해서 관리)

---

## 6) 렌더(Render) — content/posts → dist/posts

- 파일: `scripts/build/render-posts.cjs`
- 입력: `content/posts/*.json`, `templates/post.html`
- 출력: `dist/posts/*.html`
- 주입 블록(핵심)
  - TL;DR / Key Facts / FAQ / Sources
  - Review blocks (리졸버 결과 기반)
- 페이지ID 규칙
  - render가 직접 발급 금지
  - 누락 시 ids.cjs 1회 재실행 요청 → 재로딩 → 없으면 FAIL

---

## 7) 검증/수정(Validate/Repair)

- 파일: `scripts/build/validate-repair.cjs`, `scripts/build/qa-check.cjs` 등
- 지도 상 위치
  - 렌더 이후 품질 점검/교정 단계
- 이번 작업 범위 메모
  - “크리티컬 검증기는 패스”는 작업 지시로 반영하되,
    지도에서는 **단계 자체는 유지** (실행 스위치로 on/off)

---

## 8) 발행(Publish) — 최종 게이트

- 파일: `scripts/publish/blogger.cjs`
- 절대 게이트(최상위)
  - `PUBLISH_MODE !== 'enable'` 이면 **API 호출 자체 금지**
  - `DRY_RUN` 파싱 단일화(명시 false/0만 live, 나머지 전부 dry-run)
- 기본 발행 스코프(안전)
  - 기본은 `dist/queue/today.json` publishable slug만
  - 전체 발행은 관리자 수동 옵션

---

## 9) “review-*.cjs가 많다”에 대한 결론(지도 기준)

- 지도 기준으로 “다 넣어야 하냐?”의 답:
  - **필수 최소 세트만 SSOT 라인으로 유지**합니다.
  - 필수:
    1) `review-rating.cjs` (스냅샷→review-ratings SSOT 갱신)
    2) `review-resolver.cjs` (SSOT 읽기/정규화)
    3) `render-posts.cjs` (리졸버 결과 주입)
  - 나머지 review-*.cjs는
    - 기능이 겹치거나(dist HTML 덮어쓰기형),
    - SSOT를 분산시키면
    - 장기적으로 “덮어쓰기 무한 반복”을 유발하므로
    → **레거시/옵션**으로 분리해서 관리합니다(삭제/변경은 지도 합의 후).

---

## 10) 변경 로그(지도 관점)

- 2026-01-10
  - 리뷰 연결을 “리졸버 중심(SSOT 읽기)”으로 확정
  - insights 정책: “총 12개 고정”
  - 파일 루트 고정: `System_files/docs/aoia-flow-map.md`
