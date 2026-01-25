# reviews-pipeline-map.md (SSOT, publishable)
> 목적: AOIA 리뷰 파이프라인의 “실행 순서(package 기준)” 및 “기능 덩어리(클러스터) 기준” 세포급 맵을 기록한다.  
> 원칙: 완성형 문서이므로 크리티컬/검토/리스크/추정/의심은 배제하고, 사실 기반(입력·출력·역할·계약·연결)만 기술한다.

---

## 0) 용어 / 디렉토리 기준 (SSOT)
- 루트(SSOT): `System_files/`
- 리뷰 SSOT: `System_files/content/reviews/`
- 포스트 SSOT: `System_files/content/posts/`
- 템플릿: `System_files/templates/`
- 빌드 스크립트: `System_files/scripts/build/`
- 빌드 라이브러리: `System_files/scripts/build/lib/`
- 배포 산출물: `System_files/dist/`
- 매니페스트: `System_files/manifests/`
- 로그: `System_files/logs/`

---

## 1) 파이프라인 덩어리(클러스터) 인덱스
리뷰 파이프라인은 아래 덩어리들로 구성된다.  
각 덩어리는 “연결된 파일 묶음 + 입출력 + 중심 파일의 처리 방식”을 하나의 단위로 기록한다.

### A. 실행 환경/규칙 로딩 덩어리
- (중심) `scripts/build/lib/env.cjs`
- (참조) `.env`, GitHub Secrets

### B. Seed → Queue(리뷰 대상 선택) 덩어리
- `seedpool/*` 및 `scripts/build/seed-scheduler.cjs` 계열
- `dist/queue/today.json`, `dist/queue/origin-today.json` 등 “오늘 실행 대상”을 만든다

### C. IDs/PageId(식별자 부여) 덩어리
- (중심) `scripts/build/lib/page-ids.cjs`
- (참조) `manifests/page-ids*.json`, `manifests/pageid-journal.jsonl`

### D. 리뷰 데이터 수집/정규화(Next 생성) 덩어리
- (중심) `scripts/build/review-build-next.cjs`
- (입력) ratings-next/insights/sources 조각 파일
- (출력) `content/reviews/review-ratings-next.json`

### E. 리뷰 SSOT 병합(Next → SSOT) 덩어리
- (중심) `scripts/build/review-ssot-merge.cjs`
- (입력) `content/reviews/review-ratings-next.json` + `content/reviews/review-ratings.json`
- (출력) `content/reviews/review-ratings.json` 갱신

### F. 리뷰 해석/주입 준비(메타 블록 생성) 덩어리
- (중심) `scripts/build/review-meta-block.cjs`
- (참조) `content/reviews/review-ratings.json` (SSOT)

### G. 포스트 렌더(템플릿 결합) 덩어리
- (중심) `scripts/build/render-posts.cjs`
- (핵심 라이브러리) `scripts/build/lib/blocks.cjs`
- (템플릿) `templates/post.html`
- (출력) `dist/posts/*.html`

### H. 리뷰 주입(HTML 섹션 치환) 덩어리
- (중심) `scripts/build/inject-reviews-from-ssot.cjs`
- (입력) `content/reviews/review-ratings.json` + `dist/posts/*.html`
- (출력) `dist/posts/*.html` 내 리뷰 섹션 2개 치환
  - `<section id="review-rating-block">...</section>`
  - `<section id="review-insights-block">...</section>`

### I. QA/검증(발행 적합성 판정) 덩어리
- (중심) `scripts/build/qa-check.cjs`
- (입력) `dist/posts/*.html`
- (출력) `logs/qa-report*.json` + 종료코드(파이프라인 게이트)

---

## 2) 실행 순서(package 기준, 리뷰 중심)
아래는 “리뷰 파이프라인이 의미 있게 성립하는” 표준 실행 순서다.
(실제 npm script 명칭은 repo마다 다를 수 있으나, **순서와 의존성**은 동일하게 유지한다.)

1) A. env 로딩 (모든 단계 공통)
2) B. Seed → Queue (오늘 작업 대상 결정)
3) C. IDs/PageId (포스트 식별자 확정)
4) D. review-build-next (Next 생성)
5) E. review-ssot-merge (SSOT 갱신)
6) F. review-meta-block (리뷰 블록 생성/준비)
7) G. render-posts (포스트 HTML 생성)
8) H. inject-reviews-from-ssot (HTML 리뷰 섹션 치환)
9) I. qa-check (최종 판정)

---

## 3) 덩어리 상세 기록(Part 1/6 범위)
Part 1에서는 A~C 덩어리를 세포급으로 기록한다.
(Part 2부터 D~I를 순서대로 기록한다.)

---

# A) 실행 환경/규칙 로딩 덩어리
## A-1. 연결 파일 묶음
- (중심) `System_files/scripts/build/lib/env.cjs`
- (입력) 프로젝트 루트 `.env` (로컬), GitHub Secrets(Actions)
- (출력) 런타임 환경 변수(모든 스크립트에서 공통 사용)

## A-2. 각 파일의 기여/영향 (세포급)
### env.cjs
- 역할: 실행 환경을 “단일 로더”로 통일한다.
- 제공: 문자열/불리언/모드 값들을 표준화하여 다른 스크립트들이 같은 규칙으로 읽게 한다.
- 관장: BODY_WRITE_MODE, PUBLISH_MODE, DRY_RUN 등 실행 안전장치의 공통 해석 기반이 된다.

## A-3. 중심 파일의 입력→처리→결과 (세포급)
### env.cjs 처리 흐름
1) 루트 경로를 System_files 기준으로 고정한다
2) dotenv 로딩(가능하면) 후 process.env를 읽는다
3) 값들을 표준화(소문자/trim 등)하여 반환/노출한다
4) 다른 build 스크립트들은 env.cjs를 통해 동일한 규칙으로 플래그를 해석한다

---

# B) Seed → Queue(리뷰 대상 선택) 덩어리
## B-1. 연결 파일 묶음
- `System_files/seedpool/labels.json`
- `System_files/seedpool/profiles/label-profiles.json`
- `System_files/seedpool/*/*.json` (라벨별 시드)
  - 예: `seedpool/smart-savings.json`, `seedpool/subscription-services.json`, `seedpool/templates-checklists.json`
- `System_files/seedpool/origin/origin-pool.json`
- `System_files/seedpool/warehouse/**` (evergreen/first-gate/trend 창고 파일들)
- (연결 스크립트군) `System_files/scripts/build/seed-scheduler.cjs` 계열
- (출력) `System_files/dist/queue/*.json`

## B-2. 각 파일의 기여/영향 (세포급)
### seedpool/labels.json
- 역할: 라벨(카테고리) → 프로필 버전 키를 매핑한다.
- 영향: 동일 라벨이라도 프로필 버전이 바뀌면 글 구조/규칙 적용 기준이 바뀐다.

### seedpool/profiles/label-profiles.json
- 역할: 특정 라벨군(예: 리뷰 공통)의 글 구조(고정 헤딩, 옵션 헤딩, 톤 규칙)를 규정한다.
- 영향: body 생성/정규화 단계에서 “구조 강제”의 기준 자료로 사용된다.

### seedpool/*.json (예: smart-savings.json 등)
- 역할: 라벨별 seed 아이템(trend/evergreen)을 제공한다.
- 영향: 큐 스케줄러가 “오늘 무엇을 만들지” 결정할 때 후보 풀로 사용한다.

### seedpool/origin/origin-pool.json
- 역할: origin(비회전) seed를 제공한다. 신뢰/소개/기반 문서용.
- 영향: firstgate 전략에서 “항상 있어야 하는 기반 글” 후보로 작동한다.

### seedpool/warehouse/**
- 역할: seed 원천 저장소(창고). evergreen/first-gate/trend로 분류된 원본 모음.
- 영향: seed-scheduler가 실제 큐를 만들 때 라벨별/전략별 제한치(limit)에 맞춰 샘플링한다.

## B-3. 중심 처리(큐 스케줄러) 입력→처리→결과 (세포급)
### seed-scheduler 계열 처리 개념(공통)
1) 라벨/전략별 seed 후보를 로드한다
2) limit(예: trendLimit/evergreenLimit/firstGateLimit) 규칙을 적용한다
3) 오늘 실행할 seed 목록을 결정한다(큐)
4) dist/queue에 “오늘 대상” JSON을 저장한다
   - 이후 posts 생성/렌더 단계는 큐를 기준으로 수행한다

---

# C) IDs/PageId(식별자 부여) 덩어리
## C-1. 연결 파일 묶음
- (중심) `System_files/scripts/build/lib/page-ids.cjs`
- (입출력 SSOT)  
  - `System_files/manifests/page-ids.json` (active)
  - `System_files/manifests/page-ids.local.json` (local)
  - `System_files/manifests/pageid-journal.jsonl` (append log)
- (연결 단계) `scripts/build/ids.cjs` (체인에서 pageId 보장 단계)

## C-2. 각 파일의 기여/영향 (세포급)
### page-ids.cjs
- 역할: slug별 pageId를 멱등 할당하고 ledger에 저장한다.
- 제공: `ensurePageId(slug)` 형태로 pageId를 반환한다.
- 관장: local/active ledger를 분리해 “테스트 번호”와 “실발행 번호”를 분리 운영한다.

### manifests/page-ids*.json
- 역할: pageId SSOT ledger 파일.
- 영향: feed/authority/index/이미지 파일명/페이지 배지 등 “모든 연계 키”의 기준이 된다.

### manifests/pageid-journal.jsonl
- 역할: 변경 추적용 append 로그.
- 영향: 운영 감사/추적에 사용되며, SSOT는 ledger 자체다.

## C-3. 중심 파일(page-ids.cjs) 입력→처리→결과 (세포급)
### page-ids.cjs 처리 흐름
1) BODY_WRITE_MODE에 따라 local 또는 active ledger를 선택한다
2) ledger가 없으면 초기 구조를 생성한다
3) `ensurePageId(slug)` 호출 시
   - 이미 map[slug]에 pageId가 있으면 그대로 반환(멱등)
   - 없으면 next 값을 기반으로 새 pageId를 생성하고 ledger에 저장한다
4) 발급/저장 후 journal에 append 기록한다
5) 반환된 pageId는 이후:
   - templates/post.html page badge
   - dist/posts/파일 생성
   - 이미지 파일명/매니페스트
   - feed/index/authority
   모든 체인의 키로 사용된다

---

---

# D) 리뷰 데이터 수집/정규화 (Next 생성) 덩어리

## D-1. 연결 파일 묶음
- (중심) `System_files/scripts/build/review-build-next.cjs`
- (입력 조각)
  - `System_files/content/reviews/app-ratings-next.json`
  - `System_files/content/reviews/device-ratings-next.json`
  - `System_files/content/reviews/subscription-ratings-next.json`
  - `System_files/content/reviews/app-insights.json`
  - `System_files/content/reviews/device-insights.json`
  - `System_files/content/reviews/subscription-insights.json`
  - `System_files/content/reviews/review-sources.json`
- (환경)
  - `System_files/scripts/build/lib/env.cjs`
- (출력)
  - `System_files/content/reviews/review-ratings-next.json`

---

## D-2. 각 파일의 기여/영향 (세포급)

### app-ratings-next.json / device-ratings-next.json / subscription-ratings-next.json
- 역할: 라벨별 “평점 원천 데이터”의 Next 단계 입력 파일
- 제공 데이터:
  - bySlug 기준의 rating 값
  - histogram(1~5점 분포) 또는 원시 점수
- 영향:
  - 리뷰 평점 테이블과 히스토그램의 직접 입력값
  - 이후 SSOT 병합 단계에서 정규화 기준이 된다

### app-insights.json / device-insights.json / subscription-insights.json
- 역할: 리뷰에 노출될 “요약 인사이트” 원천
- 제공 데이터:
  - bySlug 기준의 핵심 bullet/문장 리스트
- 영향:
  - 리뷰 인사이트 블록(Pros/Cons/요약 관찰)에 직접 반영된다

### review-sources.json
- 역할: 리뷰 데이터의 출처 목록을 제공
- 제공 데이터:
  - store/market/외부 레퍼런스 URL 및 메타
- 영향:
  - Sources 블록 및 신뢰 메타(authority/투명성)에 연결된다

---

## D-3. 중심 파일의 입력 → 처리 → 결과 (세포급)

### review-build-next.cjs 처리 흐름
1) env.cjs를 통해 실행 환경을 로딩한다
2) ratings-next / insights / sources 파일들을 모두 로드한다
3) 각 입력 파일을 **bySlug 기준**으로 병합한다
4) 병합 중 다음 정규화 규칙을 적용한다
   - histogram 키를 1~5로 강제 정렬
   - 값은 숫자(Number)로 정규화
   - histogram이 비어 있을 경우:
     - 내부 규칙에 따라 **추정 분포(histogram estimate)** 를 생성
5) insights 항목은:
   - 최대 24개로 제한
   - 문자열만 허용(비문자 제거)
6) sources 항목은:
   - 최대 20개로 제한
   - URL/라벨 필드만 유지
7) 각 slug에 대해 최종 리뷰 객체를 구성한다
8) 결과를 `review-ratings-next.json` 단일 파일로 WRITE 한다

---

## D-4. review-ratings-next.json 산출물 구조 (개념)
- 기준 키: `bySlug`
- 각 slug 하위에 포함되는 정보:
  - rating(현재 점수)
  - histogram(1~5)
  - insights(문장 배열)
  - sources(출처 배열)
  - lastChecked(빌드 시점 기준)

이 파일은 **SSOT가 아니며**, 다음 단계(E)에서만 사용되는 **중간 산출물**이다.

---

# E) 리뷰 SSOT 병합 (Next → SSOT) 덩어리

## E-1. 연결 파일 묶음
- (중심) `System_files/scripts/build/review-ssot-merge.cjs`
- (입력)
  - `System_files/content/reviews/review-ratings-next.json`
  - `System_files/content/reviews/review-ratings.json` (기존 SSOT)
- (출력)
  - `System_files/content/reviews/review-ratings.json` (갱신)

---

## E-2. 각 파일의 기여/영향 (세포급)

### review-ratings-next.json
- 역할: “이번 실행에서 새로 계산된 리뷰 결과”
- 성격: 일회성 중간 결과물
- 영향:
  - 병합 대상이 존재할 경우 SSOT를 갱신하는 근거가 된다

### review-ratings.json (SSOT)
- 역할: 리뷰 데이터의 **단일 진실 소스**
- 제공:
  - 모든 리뷰 렌더/주입/QA의 기준 데이터
- 영향:
  - inject-reviews-from-ssot
  - review-meta-block
  - freshness(90days) 체인
  - qa-check
  전부 이 파일을 참조한다

---

## E-3. 중심 파일의 입력 → 처리 → 결과 (세포급)

### review-ssot-merge.cjs 처리 흐름
1) 기존 `review-ratings.json`(SSOT)을 로드한다
2) `review-ratings-next.json`을 로드한다
3) next 파일이 비어 있으면:
   - SSOT를 변경하지 않고 종료한다
4) next.bySlug 기준으로 반복 처리한다
5) 각 slug에 대해:
   - 기존 SSOT 항목이 있으면 **업서트(update/overwrite)** 한다
   - 없으면 신규 항목으로 추가한다
6) 병합 시 적용되는 규칙:
   - histogram 키는 항상 1~5만 유지
   - 값은 숫자(Number)로 강제
   - insights는 최대 24개 유지
   - sources는 최대 20개 유지
   - slug prefix(app/device/subscription)에 따라 bucket 정보 보정
7) 병합 완료 후:
   - `review-ratings.json`을 WRITE 한다
8) 이 시점 이후:
   - 리뷰 데이터는 **Next가 아닌 SSOT만** 참조 대상이 된다

---

## E-4. 덩어리 종료 시점의 상태
- 리뷰 데이터는 SSOT에 완전히 반영됨
- 이후 파이프라인은:
  - SSOT를 읽기만 하며
  - Next 파일에는 더 이상 의존하지 않는다

---

---

# F) 리뷰 메타 블록 생성 덩어리

## F-1. 연결 파일 묶음
- (중심)
  - `System_files/scripts/build/review-meta-block.cjs`
- (보조/참조)
  - `System_files/scripts/build/review-resolver.cjs`
  - `System_files/scripts/build/lib/blocks.cjs`
- (입력)
  - `System_files/content/reviews/review-ratings.json` (SSOT)
  - `System_files/content/posts/*.json`
- (출력)
  - 메모리 상 HTML 블록 문자열 (파일 WRITE 없음, 주입용)

---

## F-2. 각 파일의 기여/영향 (세포급)

### review-ratings.json (SSOT)
- 역할: 리뷰 데이터의 유일한 신뢰 소스
- 제공 데이터:
  - bySlug 기준 rating / histogram / insights / lastChecked
- 영향:
  - 리뷰 평점 블록
  - 리뷰 인사이트 블록
  - Freshness 기준 계산
  전부 이 데이터를 직접 사용한다

### content/posts/*.json
- 역할: 리뷰 대상 포스트의 메타 정보 제공
- 제공 데이터:
  - slug
  - label(app/device/subscription 여부)
  - reviewTarget(스토어/앱 식별자)
- 영향:
  - 리뷰 체인을 활성화할지 여부 판단
  - 어떤 slug의 리뷰 데이터를 연결할지 결정

### review-resolver.cjs
- 역할: 포스트 ↔ 리뷰 SSOT 매핑 중계자
- 기능:
  - 포스트 slug 기준으로 SSOT 리뷰 데이터 조회
  - 리뷰 데이터 존재 여부 판정
- 영향:
  - 리뷰 블록 생성 가능 여부를 결정한다

---

## F-3. 중심 파일의 입력 → 처리 → 결과 (세포급)

### review-meta-block.cjs 처리 흐름
1) content/posts JSON을 순회한다
2) 각 포스트에 대해:
   - label이 review 계열(app/device/subscription)인지 판정
3) review-resolver를 통해:
   - 해당 slug의 리뷰 SSOT 데이터 존재 여부 확인
4) 리뷰 데이터가 존재할 경우:
   - 평점 블록용 데이터 추출
   - 인사이트 블록용 데이터 추출
5) blocks.cjs의 헬퍼를 호출해:
   - rating HTML 블록 생성
   - insights HTML 블록 생성
6) 생성되는 HTML은:
   - `<section id="review-rating-block">` 교체용
   - `<section id="review-insights-block">` 교체용
7) HTML 결과는:
   - 파일로 저장하지 않고
   - 이후 inject 단계에서 replaceSection 대상으로 사용된다

---

## F-4. 생성되는 리뷰 블록의 성격
- 템플릿에 이미 존재하는 “실물 섹션 뼈대”를
- **정규식 기반 replaceSection** 으로 완전 치환
- 이 단계에서는:
  - DOM 직접 수정 없음
  - dist/posts 파일 접근 없음
  - 순수 HTML 문자열 생성만 담당

---

# G) 포스트 렌더링 덩어리

## G-1. 연결 파일 묶음
- (중심)
  - `System_files/scripts/build/render-posts.cjs`
- (보조)
  - `System_files/scripts/build/lib/blocks.cjs`
  - `System_files/scripts/build/normalize-body.cjs`
  - `System_files/scripts/build/markdown-list.cjs`
- (입력)
  - `System_files/content/posts/*.json`
  - `System_files/templates/post.html`
- (출력)
  - `System_files/dist/posts/*.html`

---

## G-2. 각 파일의 기여/영향 (세포급)

### content/posts/*.json
- 역할: 렌더링의 단일 입력 SSOT
- 제공 데이터:
  - title / description
  - tldr / keyfacts / faq / sources
  - body (HTML)
  - labels / pageId / updated
- 영향:
  - 렌더 결과 HTML의 모든 내용은 이 파일에 의해 결정된다

### templates/post.html
- 역할: 렌더 결과의 구조 계약서
- 제공:
  - 고정 섹션 뼈대(id 계약)
  - SLOT 위치 정의
- 영향:
  - render-posts는 이 구조를 절대 변경하지 않는다
  - 치환만 수행한다

### blocks.cjs
- 역할: 각 콘텐츠 블록 HTML 생성기
- 제공 기능:
  - TL;DR 블록 렌더
  - KeyFacts 블록 렌더
  - FAQ 블록 렌더
  - Sources 블록 렌더
- 영향:
  - JSON → HTML 변환 규칙을 중앙에서 통제한다

---

## G-3. 중심 파일의 입력 → 처리 → 결과 (세포급)

### render-posts.cjs 처리 흐름
1) content/posts/*.json을 순회한다
2) 각 포스트 JSON을 로드한다
3) blocks.cjs를 호출해:
   - tldr HTML 생성
   - keyfacts HTML 생성
   - faq HTML 생성
   - sources HTML 생성
4) body 필드는:
   - normalize-body.cjs로 구조 정리
   - markdown-list.cjs로 리스트/문단 정규화
5) templates/post.html을 로드한다
6) 다음 치환을 순차 수행한다:
   - {{title}}, {{description}}
   - {{tldr}}, {{keyfacts}}
   - {{body}}
   - {{faq}}, {{sources}}
   - {{pageId}}, {{updated}}, {{canonical}}
7) 리뷰 블록은:
   - 이 단계에서 생성하지 않는다
   - 템플릿의 빈 섹션을 그대로 유지한다
8) 완성된 HTML을:
   - dist/posts/{slug}.html 로 WRITE 한다

---

## G-4. 덩어리 종료 시점의 상태
- dist/posts/*.html 은:
  - 구조적으로 완전하지만
  - 리뷰 블록은 아직 빈 상태
- 이후 단계에서:
  - inject-reviews-from-ssot.cjs가
  - 리뷰 섹션을 교체 주입한다

---

---

# H) 리뷰 주입 덩어리 (SSOT → dist/posts)

## H-1. 연결 파일 묶음
- (중심)
  - `System_files/scripts/build/inject-reviews-from-ssot.cjs`
- (보조/참조)
  - `System_files/scripts/build/review-meta-block.cjs`
- (입력)
  - `System_files/content/reviews/review-ratings.json` (SSOT)
  - `System_files/dist/posts/*.html`
- (출력)
  - `System_files/dist/posts/*.html` (in-place overwrite)

---

## H-2. 각 파일의 기여/영향 (세포급)

### review-ratings.json (SSOT)
- 역할: 리뷰 콘텐츠의 유일한 신뢰 원천
- 제공 데이터:
  - bySlug 기준 rating / histogram / insights / lastChecked
- 영향:
  - 주입될 리뷰 블록의 내용과 구조를 전적으로 결정한다

### dist/posts/*.html
- 역할: 주입 대상 산출물
- 요구 조건:
  - 템플릿 계약에 따른 고정 섹션 ID 존재
    - `id="review-rating-block"`
    - `id="review-insights-block"`
- 영향:
  - 해당 ID가 존재하지 않으면 주입 대상에서 제외된다

### review-meta-block.cjs
- 역할: 리뷰 블록 HTML 생성 규칙 제공자
- 영향:
  - 주입기는 이 파일이 생성한 HTML 구조를 그대로 삽입한다
  - 자체 렌더 규칙을 재정의하지 않는다

---

## H-3. 중심 파일의 입력 → 처리 → 결과 (세포급)

### inject-reviews-from-ssot.cjs 처리 흐름
1) dist/posts/*.html 파일을 순회한다
2) 각 HTML 파일에서:
   - slug를 추출한다
3) slug 기준으로:
   - review-ratings.json(bySlug)에서 리뷰 데이터 조회
4) 리뷰 데이터가 없으면:
   - 해당 파일은 스킵한다
5) 리뷰 데이터가 있으면:
   - 리뷰 평점 HTML 생성
   - 리뷰 인사이트 HTML 생성
6) 정규식 기반 replaceSection 실행:
   - `<section id="review-rating-block">...</section>` 전체 교체
   - `<section id="review-insights-block">...</section>` 전체 교체
7) 교체된 HTML을:
   - 동일 파일 경로에 overwrite 저장한다

---

## H-4. 리뷰 주입 결과의 성격
- 템플릿의 `.review-block--empty` 상태는 제거된다
- 리뷰 블록은:
  - 시각적으로 활성화
  - 데이터 기반으로만 노출
- 이 단계 이후:
  - dist/posts/*.html 은 “리뷰 포함 완성 본문” 상태가 된다

---

# I) Sources 주입 + 본문 정합성 보정 덩어리

## I-1. 연결 파일 묶음
- (중심)
  - `System_files/scripts/build/inject-sources-from-ssot.cjs`
- (보조)
  - `System_files/scripts/build/validate-repair.cjs`
- (입력)
  - `System_files/content/posts/*.json`
  - `System_files/dist/posts/*.html`
- (출력)
  - `System_files/dist/posts/*.html` (보정 overwrite)

---

## I-2. 각 파일의 기여/영향 (세포급)

### content/posts/*.json
- 역할: Sources 원본 데이터 제공
- 제공 데이터:
  - `sources` 배열
- 영향:
  - 실제 주입될 출처 목록의 기준이 된다

### dist/posts/*.html
- 역할: Sources 삽입 대상
- 요구 조건:
  - `id="sources"` 섹션 존재
- 영향:
  - HTML 구조 계약이 유지되는 한 자동 치환 가능

### validate-repair.cjs
- 역할: 최종 HTML 정합성 보정기
- 기능:
  - canonical / og:url / updated 날짜 보정
  - 누락된 메타 필드 자동 보완
- 영향:
  - 최종 발행물의 메타 일관성을 보장한다

---

## I-3. 중심 파일의 입력 → 처리 → 결과 (세포급)

### inject-sources-from-ssot.cjs 처리 흐름
1) dist/posts/*.html 파일을 순회한다
2) 각 파일의 slug를 기준으로:
   - content/posts/*.json에서 sources 데이터 조회
3) sources 배열이 비어 있지 않으면:
   - HTML `<ul>` 리스트로 변환
4) 정규식 기반 replaceSection 실행:
   - `<section id="sources">...</section>` 전체 교체
5) 결과 HTML을 overwrite 저장한다

---

### validate-repair.cjs 처리 흐름
1) dist/posts/*.html을 다시 순회한다
2) 각 파일에 대해:
   - canonical URL 점검
   - og:url / og:image 존재 여부 점검
   - updated 필드 누락/형식 보정
3) 필요한 경우:
   - 메타 태그를 자동 수정
4) 수정된 HTML을 overwrite 저장한다

---

## I-4. 덩어리 종료 시점의 상태
- dist/posts/*.html 은:
  - 본문 + 리뷰 + Sources가 모두 결합된 상태
  - 메타/URL/날짜가 정합된 상태
- 이후 단계에서는:
  - QA 검사
  - 피드 생성
  - 발행 단계만 남는다

---


---

# J) QA 검사 덩어리 (발행 전 품질 보증)

## J-1. 연결 파일 묶음
- (중심)
  - `System_files/scripts/build/qa-check.cjs`
- (보조)
  - `System_files/scripts/build/check-og-freshness.cjs`
  - `System_files/scripts/build/check-review-freshness.cjs`
- (입력)
  - `System_files/dist/posts/*.html`
  - `System_files/content/reviews/review-ratings.json`
- (출력)
  - `System_files/logs/qa-report.json`
  - `System_files/logs/qa-report-YYYY-MM-DD.json`
  - 프로세스 종료 코드 (PASS/WARN/FAIL/CRIT에 따른 exit)

---

## J-2. 각 파일의 기여/영향 (세포급)

### dist/posts/*.html
- 역할: QA 검사 대상 실물 산출물
- 제공 요소:
  - canonical / og meta / schema / FAQ / Sources / Review 섹션
- 영향:
  - HTML 구조 계약 위반 시 즉시 FAIL 또는 CRIT 판정

### review-ratings.json
- 역할: 리뷰 freshness 판단 기준
- 제공 요소:
  - lastChecked / updatedAt
- 영향:
  - 리뷰 라벨(app/device/subscription) 포스트의 신선도 판정 근거

### check-og-freshness.cjs
- 역할: OG 이미지 최신성 검사기
- 기능:
  - og:image 존재 여부
  - CDN_BASE 기준 URL 일관성
- 영향:
  - LCP/미리보기 품질을 간접 보증

### check-review-freshness.cjs
- 역할: 리뷰 데이터 시간 기반 점검기
- 기능:
  - 90일 기준 경과 여부 계산
- 영향:
  - 리뷰 유지 관리 체인의 정상 동작을 보장

---

## J-3. 중심 파일의 입력 → 처리 → 결과 (세포급)

### qa-check.cjs 처리 흐름
1) dist/posts/*.html 전수 순회
2) 각 파일별로 다음 항목을 검사:
   - canonical 존재 여부
   - og:url / og:image 존재 및 형식
   - Article / BreadcrumbList schema 존재
   - FAQ / Sources 섹션 ID 존재
3) 리뷰 라벨 포스트의 경우:
   - review-rating-block / review-insights-block 존재 여부
   - review-ratings.json 매칭 여부
4) og:image URL에 대해:
   - HEAD 요청으로 200 응답 확인
5) 각 검사 결과를 누적하여:
   - PASS / WARN / FAIL / CRIT 판정
6) 결과를 qa-report.json에 기록
7) FAIL 또는 CRIT 존재 시:
   - 프로세스 exitCode=1 반환

---

## J-4. QA 덩어리 종료 시점의 상태
- QA 통과 시:
  - dist/posts/*.html은 “발행 가능 상태”
- QA 실패 시:
  - 이후 단계(build-feed / publish) 차단
- 이 덩어리는:
  - **자동 발행의 최종 안전장치** 역할을 수행한다

---

# K) AI Feed / Index 생성 덩어리

## K-1. 연결 파일 묶음
- (중심)
  - `System_files/scripts/build/build-feed.cjs`
- (보조)
  - `System_files/scripts/build/lib/feed.cjs`
  - `System_files/scripts/build/ai-meta.js`
- (입력)
  - `System_files/dist/posts/*.html`
  - `System_files/content/posts/*.json`
- (출력)
  - `System_files/dist/ai/feed.ndjson`
  - `System_files/dist/ai/posts-index.json`
  - `System_files/dist/ai/authority.json`

---

## K-2. 각 파일의 기여/영향 (세포급)

### dist/posts/*.html
- 역할: 최종 발행 본문
- 제공 요소:
  - canonical URL
  - title / description
  - updated 날짜
- 영향:
  - AI Feed 항목의 URL 및 시점 결정

### content/posts/*.json
- 역할: 구조적 메타 정보 제공
- 제공 요소:
  - label / intent / pageId
- 영향:
  - AI 분류 및 authorityRef 매핑에 사용

### feed.cjs
- 역할: Feed 항목 생성 유틸
- 기능:
  - NDJSON 라인 생성
  - 필드 정규화
- 영향:
  - build-feed.cjs의 출력 형식을 통제

### ai-meta.js
- 역할: AI 권위 메타 생성기
- 기능:
  - authority.json 생성
- 영향:
  - 외부 AI가 사이트를 신뢰 가능한 소스로 인식하는 기준 제공

---

## K-3. 중심 파일의 입력 → 처리 → 결과 (세포급)

### build-feed.cjs 처리 흐름
1) dist/posts/*.html을 순회
2) 각 포스트에 대해:
   - pageId / canonical / updated 추출
3) content/posts/*.json과 매칭하여:
   - label / intent 보완
4) feed.cjs를 호출하여:
   - NDJSON 한 줄 생성
5) 모든 포스트를 누적하여:
   - feed.ndjson 생성
6) 동시에:
   - posts-index.json 생성 (slug/pageId 인덱스)
7) ai-meta.js를 호출하여:
   - authority.json 생성

---

## K-4. 덩어리 종료 시점의 상태
- dist/ai/ 산출물은:
  - AI 소비 전용 데이터
  - 검색엔진/AI 인용용 SSOT
- 이후 단계에서는:
  - publish 파이프라인에서 참조만 수행
- 이 덩어리는:
  - **AOIA 인지/인용 계층의 출발점** 역할을 한다

---


---

# L) Publish / Blogger 연동 / Seed Ledger 기록 덩어리

## L-1. 연결 파일 묶음

- (중심)
  - `System_files/scripts/publish/blogger.cjs`
- (보조)
  - `System_files/scripts/build/lib/env.cjs`
  - `System_files/scripts/build/lib/page-ids.cjs`
  - `System_files/scripts/build/lib/seed-ledger.cjs`
- (입력)
  - `System_files/dist/posts/*.html`
  - `System_files/manifests/page-ids.json`
  - ENV (OAuth / Blogger / Publish flags)
- (출력)
  - Blogger 실포스트
  - `System_files/logs/seed-ledger.jsonl`
  - `System_files/logs/seed-ledger.index.json`

---

## L-2. 각 파일의 기여 / 영향 (세포급)

### dist/posts/*.html
- 역할: 실발행 대상 HTML 산출물
- 제공 요소:
  - 최종 본문 HTML
  - canonical / og / schema 포함
- 영향:
  - Blogger에 업로드되는 실제 콘텐츠 원본

### env.cjs
- 역할: 실행 환경 통제자
- 제공 요소:
  - SITE_BASE / CDN_BASE
  - DRY_RUN / PUBLISH_MODE 파싱
- 영향:
  - 발행 허용 여부 결정
  - 실번호(pageId) 소모 차단/허용

### page-ids.cjs
- 역할: slug → pageId SSOT 관리자
- 제공 요소:
  - 기존 pageId 조회
  - 신규 pageId 멱등 발급
- 영향:
  - 발행물의 고유 식별자 유지
  - 재발행/수정 시 동일 pageId 보장

### seed-ledger.cjs
- 역할: 발행 이력 SSOT 기록기
- 제공 요소:
  - append-only ledger
  - recordKey(pid/slug) 기반 upsert
- 영향:
  - 발행 상태/단계의 장기 추적 가능
  - 이후 분석/회복/재처리 기준 데이터 제공

---

## L-3. 중심 파일의 입력 → 처리 → 결과 (세포급)

### blogger.cjs 처리 흐름

1) env.cjs 로드
   - PUBLISH_MODE, DRY_RUN 확인
   - 실발행 가능 여부 판단

2) 발행 대상 dist/posts/*.html 순회
   - 파일별 slug 추출
   - page-ids.cjs 통해 pageId 확보
     - 기존 존재 시 재사용
     - 없을 경우 조건 충족 시 신규 발급

3) Blogger API 호출
   - OAuth 토큰 사용
   - HTML 본문 업로드
   - canonical / updated / labels 반영

4) Blogger 응답 수신
   - postId
   - live URL

5) seed-ledger.cjs upsert 호출
   - recordKey 결정
     - pageId 존재 시 pid:pageXXXXXX
     - 임시 상태 시 slug:xxx
   - 병합 필드:
     - slug
     - pageId
     - label
     - status
     - stage
     - postId
     - url
     - updatedAt

6) ledger append + index 갱신
   - seed-ledger.jsonl에 한 줄 추가
   - seed-ledger.index.json offset 업데이트

---

## L-4. Seed Ledger의 내부 역할 (세포급)

### seed-ledger.jsonl
- 성격: append-only SSOT
- 각 라인:
  - 하나의 “상태 스냅샷”
- 의미:
  - 동일 recordKey라도 최신 상태는 항상 마지막 라인

### seed-ledger.index.json
- 성격: 경량 인덱스
- 제공 기능:
  - recordKey → byteOffset
  - slugKey → pidKey alias
- 의미:
  - 대용량에서도 O(1)에 가까운 최신 상태 조회

---

## L-5. 덩어리 종료 시점의 상태

- Blogger:
  - 실 URL 생성
  - 검색엔진/AI 접근 가능 상태
- dist/posts:
  - 발행 완료 산출물로 유지
- seed-ledger:
  - 발행 이력의 불변 기록 축적
- 이 덩어리는:
  - **AOIA 전체 파이프라인의 “현실 세계 접점”**
  - **되돌릴 수 없는 외부 효과를 발생시키는 유일한 구간**

---

(Part 6 끝)


# Reviews Pipeline – Visual Text Map (SSOT 기반)

────────────────────────────────────────
[0] SEEDPOOL / ORIGIN (기획·입구)
────────────────────────────────────────
seedpool/*
 ├─ app-reviews.json
 ├─ device-reviews.json
 ├─ subscription-services.json
 ├─ how-to-playbooks.json
 ├─ smart-savings.json
 ├─ templates-checklists.json
 └─ origin/origin-pool.json
        │
        │  (아이디어 / 주제 / intent / priority)
        ▼
────────────────────────────────────────
[1] FIRST GATE / QUEUE (선별·대기열)
────────────────────────────────────────
first-gate.json
 └─ firstgate-pick.cjs
        │
        │  (priority / limit / trigger)
        ▼
firstgate-queue-to-post.cjs
        │
        │  (slug 생성, seedMeta.queueDate 부여)
        ▼
content/posts/*.json  ← SSOT(Post)

────────────────────────────────────────
[2] IDS / PAGE ID (식별자 확정)
────────────────────────────────────────
ids.cjs
 └─ page-ids.cjs (ledger)
        │
        │  slug → pageId 멱등 할당
        ▼
content/posts/*.json
 (pageId 확정)

────────────────────────────────────────
[3] BODY GENERATION / NORMALIZE
────────────────────────────────────────
generate-body.cjs
 └─ normalize-body.cjs
        │
        │  (본문 HTML 생성 / 정규화)
        ▼
content/posts/*.json
 (body 채워짐)

────────────────────────────────────────
[4] REVIEW SSOT CHAIN (리뷰 전용)
────────────────────────────────────────
review-fetch-official.cjs
review-fetch-insights-secondary.cjs
review-build-next.cjs
review-ssot-merge.cjs
        │
        │  (외부 리뷰 → 통합 → 정규화)
        ▼
content/reviews/review-ratings.json  ← SSOT(Review)

────────────────────────────────────────
[5] RENDER / TEMPLATE
────────────────────────────────────────
render-posts.cjs
 ├─ templates/post.html
 ├─ blocks.cjs
 └─ meta.cjs
        │
        │  (본문 + 메타 + 슬롯 결합)
        ▼
dist/posts/*.html

────────────────────────────────────────
[6] REVIEW INJECTION
────────────────────────────────────────
inject-reviews-from-ssot.cjs
review-meta-block.cjs
        │
        │  (SSOT 리뷰 → HTML 섹션 치환)
        ▼
dist/posts/*.html
 (리뷰 블록 실물화)

────────────────────────────────────────
[7] IMAGE PIPELINE
────────────────────────────────────────
images-build-body.cjs
images-build-og.cjs
images-renew.cjs
r2-upload.js
        │
        │  (이미지 생성 / 매니페스트 / CDN)
        ▼
dist/images/*
manifests/images-*.json

────────────────────────────────────────
[8] VALIDATION / QA
────────────────────────────────────────
validate-body-images.cjs
validate-repair.cjs
qa-check.cjs
        │
        │  (메타 / 스키마 / 리뷰 계약 검사)
        ▼
PASS → 다음 단계
FAIL → 중단

────────────────────────────────────────
[9] FEED / AI META
────────────────────────────────────────
build-feed.cjs
ai-meta.js
        │
        │  (AI/검색용 데이터 산출)
        ▼
dist/ai/feed.ndjson
dist/ai/authority.json

────────────────────────────────────────
[10] PUBLISH (외부 세계 접점)
────────────────────────────────────────
publish/blogger.cjs
 ├─ env.cjs
 ├─ page-ids.cjs
 └─ seed-ledger.cjs
        │
        │  (OAuth / 실발행 / URL 생성)
        ▼
Blogger Live Post
        │
        │  (발행 결과 기록)
        ▼
logs/seed-ledger.jsonl
logs/seed-ledger.index.json

────────────────────────────────────────
[11] RECOVERY / MAINTENANCE (보조)
────────────────────────────────────────
fill-updated-from-queuedate.cjs
workers/rewrite-post.js
        │
        │  (수정 / 복구 / 재작성)
        ▼
content/posts SSOT 유지
