# Review Pipeline Map (SSOT) — 상세판 (원본 유지 + 2026-01-15~19 추가분 병합본)
- Path (SSOT): System_files/docs/map/review-pipeline-map.md
- Last Updated: 2026-01-19 (+0900)

목표
- 리뷰 히스토그램/인사이트/평점 문제는 템플릿만으로 해결하지 않는다.
- 리뷰는 반드시 “번들(Stub→Fetch→BuildNext→MergeSSOT→Inject→QA)”로 사고한다.
- 어디가 비었는지(=왜 app만 나오거나, 더미만 나오거나, next가 비는지)를 즉시 좁히는 지도.

────────────────────────────────────────────────────────────
0) Ground Rules (리뷰 전용)
────────────────────────────────────────────────────────────
- Review SSOT는 content/reviews/review-ratings.json(bySlug) 단 하나를 최종 신뢰한다.
- *-ratings-next.json / *-insights.json / review-sources.json 등은 “중간재”.
- 최종 출력은 SSOT 기준으로만 한다.
- 최종 주입자(Injector)는 1개로 고정(중복 실행 금지).
- AOIA 1단계 정책(확정): Amazon PA-API는 정상화하지 않고, 실패 원인을 에러 로그/ledger에 남긴다(망각 방지). 정상화는 AOIA 2단계 실판매 후.

────────────────────────────────────────────────────────────
1) Review Data Layers (파일 층위/역할)
────────────────────────────────────────────────────────────
[A] Bucket Raw / Partial (중간재 조각)
- content/reviews/app-ratings.json
- content/reviews/device-ratings.json
- content/reviews/subscription-ratings.json

- content/reviews/app-ratings-next.json
- content/reviews/device-ratings-next.json
- content/reviews/subscription-ratings-next.json

- content/reviews/app-insights.json
- content/reviews/device-insights.json
- content/reviews/subscription-insights.json (철자 고정 유지)

- content/reviews/review-sources.json (sources stub/upsert 대상)

[B] Unified NEXT (통합 후보)
- content/reviews/review-ratings-next.json

[C] Unified SSOT (최종 신뢰 원본)
- content/reviews/review-ratings.json (bySlug)

[D] Export
- content/ssot/reviews.bySlug.json (SSOT export)

────────────────────────────────────────────────────────────
2) Review Pipeline (Trunk) — Stub → Fetch → BuildNext → Merge → Inject → QA
────────────────────────────────────────────────────────────
Step 1) Stub Fill (SSOT 보호 + 누락 방지)
- scripts/build/review-stub-fill.cjs
  - 역할:
    - content/posts에서 리뷰 슬러그(app-/device-/subscription-)를 스캔
    - bucket/insights/sources에 bySlug stub를 “없을 때만” 업서트
  - READ:
    - content/posts/*.json
    - content/reviews/* (기존 내용)
  - WRITE:
    - content/reviews/* (stub 업서트)
    - content/reviews/review-sources.json

Step 2) Fetch Official (수치 데이터 SSOT 공급자)
- scripts/build/review-fetch-official.cjs
  - 역할:
    - provider 공식 API에서 rating/votes/histogram 수집
    - *-ratings-next.json 업서트 + review-sources.json 기록
  - 원칙:
    - HTML/렌더 단계 관여 금지
    - DRY_RUN, MAX_CALLS, throttle로 비용/차단 방지
    - Amazon PA-API는 1단계 정상화 금지(실패 로그 유지)

Step 3) Fetch Insights Secondary (정성 보조 엔진)
- scripts/build/review-fetch-insights-secondary.cjs
  - 역할:
    - 외부 네트워크 없이 rule-based 인사이트 보완
    - insights는 rating과 독립

Step 4) Build Unified NEXT (조각→통합 후보)
- scripts/build/review-build-next.cjs
  - 역할:
    - bucket별 ratings-next + insights + sources 병합/정규화
    - content/reviews/review-ratings-next.json 생성
  - 정합성:
    - histogram 키/값 정규화(1~5 숫자화)
    - insights/sources 길이 제한
    - status/store/lastChecked 기본값 채움

Step 5) Merge NEXT → SSOT (최종 반영)
- scripts/build/build-ssot-reviews.cjs
  - 역할:
    - review-ratings-next.json을 baseline SSOT(review-ratings.json)에 멱등 병합
    - export(content/ssot/reviews.bySlug.json)도 동일 저장
  - 특징:
    - next가 존재하지만 변화 0건이면 WARN(동일/생성 실패/slug mismatch 후보)

(대체/병행 가능) scripts/build/review-diff-update.cjs
- 역할:
  - next→SSOT 변화량 기반 반영(정밀 diff/로그)
- 주의:
  - build-ssot와 병행 시 “최종 반영자 1개”로 고정(중복 반영 방지)

Step 6) Resolve (Read-only Normalize for Render)
- scripts/build/review-resolver.cjs
  - 역할:
    - render-posts가 호출하는 read-only 정규화 함수
  - READ:
    - content/reviews/review-ratings.json
  - WRITE:
    - 없음

Step 7) Inject into dist/posts (HTML 섹션 치환)
- scripts/build/inject-reviews-from-ssot.cjs  ★ 최종 주입자 고정
  - 역할:
    - dist/posts/*.html의 섹션을 SSOT 기준으로 교체:
      - <section id="review-rating-block">...</section>
      - <section id="review-insights-block">...</section>
    - Freshness 통계 출력 + 리뷰가 아닌 파일은 skippedNotReview로 분리 집계
  - READ:
    - content/reviews/review-ratings.json
    - dist/posts/*.html
  - WRITE:
    - dist/posts/*.html (in-place overwrite)

(대체 주입자) scripts/build/review-meta-block.cjs
- 동일 역할 가능하나 “최종 주입자 1개” 원칙 위반 시 덮어쓰기/중복 위험.

Step 8) QA Gate (자동발행 방어)
- scripts/build/qa-check.cjs
  - 역할:
    - 리뷰 라벨인데 SSOT 누락/형식 오류면 CRIT로 판정(자동발행 제외 근거)
    - logs/qa-report.json 저장

────────────────────────────────────────────────────────────
3) Slot Contract (템플릿/HTML 계약)
────────────────────────────────────────────────────────────
- templates/post.html에는 아래 섹션이 반드시 존재해야 injector가 동작한다:
  - <section id="review-rating-block" ...></section>
  - <section id="review-insights-block" ...></section>
- 섹션 ID가 바뀌면 injector는 slotMissing++ 후 스킵 → 화면이 빈 섹션만 남을 수 있음.

────────────────────────────────────────────────────────────
4) Symptoms → Where to look (진단 라우팅)
────────────────────────────────────────────────────────────
1) app만 나오고 device/subscription이 비어있다
- stub-fill: bucket 등록 여부
- build-next: review-ratings-next.json 포함 여부
- build-ssot: SSOT(review-ratings.json) 반영 여부
- inject: 최종 주입자 실행 여부/순서

2) review-ratings-next.json이 비어있다
- *-ratings-next / *-insights가 skeleton만인지(=실데이터 공급원 없음)
- fetch-official/provider adapter가 실패하고 있는지(로그 확인)

3) SSOT는 있는데 화면이 비어있다
- templates/post.html 섹션 ID 계약 위반
- 최종 주입자 미실행 또는 다른 스크립트가 나중에 덮어씀

End of Review Pipeline Map (SSOT) — 상세판
