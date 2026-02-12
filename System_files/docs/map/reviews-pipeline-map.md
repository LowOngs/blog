# reviews-pipeline-map.md (SSOT, publishable, offline)
> 목적: AOIA 리뷰 + 시드 + 발행 파이프라인의 “실행 순서” 및 “기능 덩어리(클러스터)”를 세포급으로 기록한다.  
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
- 시드: `System_files/seedpool/`

---

## 1) 파이프라인 덩어리(클러스터) 인덱스

### A. 실행 환경/규칙 로딩 덩어리
- (중심) `scripts/build/lib/env.cjs`

### B. Seed Storage (Seedpool/Warehouse) 덩어리
- `seedpool/*.json` (라벨별 기획/개요 풀)
- `seedpool/warehouse/**` (실재고: trend/evergreen/first-gate)

### C. Refill (재고 채움) 덩어리
- (중심) `scripts/build/seed-refill.cjs`
- (참조) `scripts/build/lib/fingerprint.cjs`, `scripts/build/lib/seed-ledger.cjs`

### D. Seed → Queue(오늘 대상 선택/소비) 덩어리
- (중심) `scripts/build/seed-scheduler.cjs` 계열
- (출력) `dist/queue/*.json`

### E. 번호/식별자 덩어리 (Index + PageId)
- (번호 SSOT) `manifests/issue-seq.json`
- (slug 정책 SSOT) `scripts/build/lib/slug-policy.cjs`
- (pageId SSOT) `scripts/build/lib/page-ids.cjs`

### F. Posts 렌더 덩어리
- `scripts/build/render-posts.cjs`
- `scripts/build/lib/blocks.cjs`
- `templates/post.html`

### G. 리뷰 SSOT 체인 덩어리 (Next → SSOT)
- `scripts/build/review-build-next.cjs`
- `scripts/build/review-ssot-merge.cjs`
- `content/reviews/review-ratings.json` (SSOT)

### H. 리뷰 주입 덩어리
- `scripts/build/inject-reviews-from-ssot.cjs`

### I. QA/검증 덩어리
- `scripts/build/qa-check.cjs`

### J. 피드/AI 메타 덩어리
- `scripts/build/build-feed.cjs`
- `dist/ai/feed.ndjson`

### K. Publish + 사용 이력 기록 덩어리
- `scripts/publish/blogger.cjs`
- `scripts/build/lib/seed-ledger.cjs` (사용 이력 SSOT)

---

## 2) 실행 순서(package 기준, seed+review 포함)

1) A. env 로딩 (모든 단계 공통)
2) B. Seed Storage 로드(Seedpool/Warehouse)
3) C. seed-refill (warehouse 보충)
4) D. seed-scheduler (오늘 큐 생성)
5) E. ids/번호/식별자 확정
   - issue-seq(인덱스), slug-policy(정규화), page-ids(pageId)
6) F. render-posts
7) G. review-build-next → review-ssot-merge
8) H. inject-reviews-from-ssot
9) I. qa-check
10) J. build-feed
11) K. publish/blogger + seed-ledger 기록

---

## 3) 덩어리 상세 기록 (세포급)

# A) 실행 환경/규칙 로딩 덩어리

## A-1. 연결 파일 묶음
- (중심) `System_files/scripts/build/lib/env.cjs`
- (입력) `.env`, GitHub Secrets
- (출력) 런타임 환경 변수 표준화 결과

## A-2. 중심 파일 역할
- 실행 모드(BODY_WRITE_MODE/PUBLISH_MODE/DRY_RUN)를 단일 규칙으로 해석해
  “실번호 소모/실발행” 리스크를 구조적으로 통제한다.


---

# B) Seed Storage (Seedpool/Warehouse) 덩어리

## B-1. seedpool 라벨 파일(기획/개요 풀)
- 경로: `System_files/seedpool/*.json`
- 스키마(확정):
  - `"limits": { "trend": n, "evergreen": n }`
  - `"trend": [...]`
  - `"evergreen": [...]`

## B-2. warehouse 전략 파일(실재고)
- trend: `seedpool/warehouse/trend/*-trend.json`
  - `"limits": { "trend": n }`, `"trend": [...]`
- evergreen: `seedpool/warehouse/evergreen/*-evergreen.json`
  - `"limits": { "evergreen": n }`, `"evergreen": [...]`
- first-gate: `seedpool/warehouse/first-gate/*-first-gate.json`
  - `"limits": { "firstGate": n }`, `"firstGate": [...]`

## B-3. 책임 분리(핵심)
- seedpool: 기획 후보(개요) 저장
- warehouse: 실제 소비할 재고 저장(SSOT)


---

# C) Refill (재고 채움) 덩어리

## C-1. 연결 파일 묶음
- (중심) `System_files/scripts/build/seed-refill.cjs`
- (입력)
  - `System_files/seedpool/warehouse/**`
  - `System_files/logs/seed-ledger.jsonl`
- (참조)
  - `System_files/scripts/build/lib/fingerprint.cjs`
- (출력)
  - `System_files/seedpool/warehouse/**` 갱신(보충)

## C-2. 책임/계약
- refill은 “보충만” 수행한다.
- 중복은 fingerprint + seed-ledger(사용 이력) 기준으로 차단한다.
- 번호/인덱스는 issue-seq가 담당한다(분리).


---

# D) Seed → Queue (소비/오늘 대상) 덩어리

## D-1. 연결
- (중심) `scripts/build/seed-scheduler.cjs` 계열
- (입력) warehouse 재고
- (출력) `dist/queue/today.json`

## D-2. 책임
- scheduler는 “소비/선별”만 한다.
- refill처럼 재고를 늘리지 않는다.


---

# E) 번호/식별자 덩어리 (IssueSeq + SlugPolicy + PageId)

## E-1. 번호 SSOT
FILE: `System_files/manifests/issue-seq.json`
- 날짜×라벨 단위 인덱스 영속 관리
- queue-to-posts에서 증가/저장

## E-2. slug 정책 SSOT
FILE: `System_files/scripts/build/lib/slug-policy.cjs`
- label/prefix/slug 정규화 단일 정책

## E-3. pageId SSOT
FILE: `System_files/scripts/build/lib/page-ids.cjs`
- slug→pageId 멱등 할당(실번호/로컬 분리)


---

# F) 포스트 렌더 덩어리

- (중심) `scripts/build/render-posts.cjs`
- (템플릿) `templates/post.html`
- (블록 생성) `scripts/build/lib/blocks.cjs`
- (출력) `dist/posts/*.html`

(이 덩어리는 기존 계약 그대로 유지: 구조 생성 금지, 치환만)


---

# G) 리뷰 SSOT 체인 덩어리 (Next → SSOT)

- (중심) `review-build-next.cjs` → `review-ssot-merge.cjs`
- (출력 SSOT) `content/reviews/review-ratings.json`


---

# H) 리뷰 주입 덩어리

- (중심) `inject-reviews-from-ssot.cjs`
- (입력) review SSOT + dist/posts
- (출력) dist/posts overwrite


---

# I) QA/검증 덩어리

- (중심) `qa-check.cjs`
- (입력) dist/posts
- (출력) qa report + exit code


---

# J) 피드/AI 메타 덩어리

- (중심) `build-feed.cjs`
- (출력) `dist/ai/feed.ndjson` 등


---

# K) Publish + 사용 이력 기록 덩어리

## K-1. publish
- (중심) `scripts/publish/blogger.cjs`
- (입력) dist/posts + env + oauth
- (출력) Blogger live post

## K-2. 사용 이력 SSOT
- (중심) `scripts/build/lib/seed-ledger.cjs`
- (출력) `logs/seed-ledger.jsonl`, `logs/seed-ledger.index.json`


---

## 4) 전체 흐름(텍스트 맵, seed+review 포함)

────────────────────────────────────────
[0] SEED STORAGE (SSOT)
────────────────────────────────────────
seedpool/*.json (기획/개요 풀)
seedpool/warehouse/** (실재고)
        │
        ▼
────────────────────────────────────────
[1] REFILL (보충 전용)
────────────────────────────────────────
seed-refill.cjs
 ├─ fingerprint.cjs
 └─ seed-ledger.cjs(사용 이력 기반 중복 차단)
        │
        ▼
warehouse 갱신(evergreen/trend/first-gate)
        │
        ▼
────────────────────────────────────────
[2] SCHEDULER (소비/오늘 큐)
────────────────────────────────────────
seed-scheduler.cjs
        │
        ▼
dist/queue/today.json
        │
        ▼
────────────────────────────────────────
[3] SLUG/ISSUE/ID (식별자)
────────────────────────────────────────
queue-to-posts.cjs
 ├─ issue-seq.json (번호 SSOT)
 └─ slug-policy.cjs (정규화 SSOT)
ids.cjs
 └─ page-ids.cjs (pageId SSOT)
        │
        ▼
content/posts/*.json
        │
        ▼
────────────────────────────────────────
[4] REVIEW SSOT CHAIN
────────────────────────────────────────
review-build-next.cjs
review-ssot-merge.cjs
        │
        ▼
content/reviews/review-ratings.json (SSOT)
        │
        ▼
────────────────────────────────────────
[5] RENDER / INJECT / QA / FEED / PUBLISH
────────────────────────────────────────
render-posts.cjs → dist/posts
inject-reviews-from-ssot.cjs → dist/posts overwrite
qa-check.cjs
build-feed.cjs → dist/ai
publish/blogger.cjs
seed-ledger.cjs 기록
