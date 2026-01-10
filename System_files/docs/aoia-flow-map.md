# AOIA Flow Map (SSOT)
Path: System_files/docs/aoia-flow-map.md

이 문서는 AOIA 파이프라인의 “지도(SSOT)”입니다.
구현/수정 시 개별 파일 주석보다 이 지도를 우선 갱신합니다.

---

## 0) 고정 루트(SSOT)
- System_files 루트:
  - 로컬: C:\google-blog\System_files\
  - GitHub: LowOngs/blog/google-blog/System_files/

- 지도 파일(SSOT):
  - System_files/docs/aoia-flow-map.md

---

## 1) 환경변수(.env) 로딩 규칙(단일화)
### SSOT 로더
- 파일: System_files/scripts/build/lib/env.cjs
- ROOT 고정:
  - __dirname = System_files/scripts/build/lib
  - ROOT = path.resolve(__dirname, '../../..')  → System_files

### 로딩 우선순위
1) System_files/.env
2) repo root(.env)  (System_files/..)
3) dotenv 기본 탐색

### DRY_RUN 파서(단일 규칙)
- 규칙: 값이 "false" 또는 "0" 일 때만 live
- 그 외(미설정 포함) 전부 DRY_RUN=true 취급

---

## 2) 빌드 파이프라인(개요)
### 입력(SSOT)
- 시드/큐: System_files/dist/queue/today.json  (publishable slug 목록)
- 포스트 원천: System_files/content/posts/*.json
- 템플릿: System_files/templates/post.html
- 리뷰 SSOT: System_files/content/reviews/review-ratings.json

### 출력(산출물)
- HTML: System_files/dist/posts/*.html
- 이미지: System_files/dist/images/og/*, body/*
- 로그: System_files/logs/*
- AI feed: System_files/dist/ai/feed.ndjson

---

## 3) Publish 단계(사고 방지 최상위)
### 발행 스코프(SSOT)
- 기본: today.json(publishable)만 발행
- 옵션: PUBLISH_SCOPE=all 은 “수동 위험 옵션”

### 최종 게이트(단일 규칙)
- canPublish = (DRY_RUN=false) AND (PUBLISH_MODE=enable)

의미:
- DRY_RUN=true  → 외부 API 호출 0% (로컬/CI 모두 동일)
- DRY_RUN=false + PUBLISH_MODE=enable → 실발행 가능
- DRY_RUN=false + PUBLISH_MODE!=enable → 실발행 차단(안전 종료)

### 발행 스크립트(SSOT)
- System_files/scripts/publish/blogger.cjs
  - today.json 스코프 적용
  - 라벨 추론
  - 백오프/슬립(429 방지)
  - seed-ledger publish 업서트

---

## 4) R2 업로드 단계
### 업로드 스크립트
- System_files/scripts/build/r2-upload.cjs
  - dist/images/og  → R2 images/og/*
  - dist/images/body → R2 images/body/*
  - DRY_RUN 파서는 env.cjs 단일 규칙 사용

---

## 5) 리뷰 파이프라인(SSOT)
### SSOT
- content/reviews/review-ratings.json

### 갱신기(스냅샷 → SSOT)
- scripts/build/review-rating.cjs
  - app-ratings.json 스냅샷 → review-ratings.json(bySlug) 갱신
  - 기존 insights/histogram 보존

### 리졸버(읽기 전용)
- scripts/build/review-resolver.cjs
  - SSOT 우선 읽기
  - postJson.review/reviews는 fallback
  - insights 규칙:
    - 긍정/부정 최대 6/6
    - 부족하면 있는 만큼만 출력(좌우 꼭 동일할 필요 없음)
    - 한쪽이 “6을 초과”하는 일은 금지

### 렌더
- scripts/build/render-posts.cjs
  - review-resolver 결과를 blocks로 렌더링

---

## 6) 변경 규칙(운영)
- 로직/흐름이 바뀌면 지도도 같이 바꿀지 반드시 먼저 확인한다.
- 파일명은 한 번 정하면 변경 제안 금지(사전 합의 없이는 변경하지 않는다).
- 개별 파일 주석은 “기능 식별” 수준만 유지하고, 핵심 설계는 지도에 기록한다.
