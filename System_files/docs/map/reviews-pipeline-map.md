# Review Pipeline Map (SSOT)
- Path: System_files/docs/review-pipeline-map.md
- Last Updated: 2026-01-13 (+0900)

리뷰 파이프라인은 “번들(Review Bundle)” 단위로만 다룹니다.
리뷰 관련 변경/디버깅/자동화는 이 지도를 기준으로 합니다.

────────────────────────────────────────────────────────────
0) SSOT (Single Source of Truth)
────────────────────────────────────────────────────────────
[Review SSOT]
- content/reviews/review-ratings.json
  - bySlug[slug] 형태로 rating/histogram/insights 등 “최종 주입 데이터”를 보관
  - 렌더/주입 단계는 이 파일만 신뢰한다(원천 파일 직접 참조 금지)

[Review 대상 라벨]
- app-reviews / device-reviews / subscription-services
  - 이 3라벨만 “리뷰 블록”이 존재해야 한다.
  - 비리뷰 라벨에 리뷰 블록 주입 금지(오염 방지)

────────────────────────────────────────────────────────────
1) Bundle Classification (번들 구성)
────────────────────────────────────────────────────────────
A) SSOT Build / Merge (원천 → 통합 SSOT)
- scripts/build/review-diff-update.cjs
  - 역할: 신규 수집/변경분을 review-ratings.json에 안전 병합(upsert)
  - output: content/reviews/review-ratings.json 갱신

- scripts/build/reviews-bootstrap.cjs (선택)
  - 역할: SSOT가 없을 때 골격 생성(초기화 도구)
  - 정책: 운영 루프 필수 아님(수동/초기 1회)

B) Resolver (Read-only normalize)
- scripts/build/review-resolver.cjs
  - 역할: review-ratings.json을 읽고 blocks/render가 쓰기 쉬운 형태로 normalize
  - 정책: 파일 저장 금지(리졸버는 읽기 전용)

  [insights 정책(고정)]
  - 긍정/부정 분리 + 각각 최대 6개(총 최대 12개)
  - 한쪽만 12개로 채워지는 형태 금지
  - 부족하면: 한쪽 6 + 반대 있는대로(최대 6)

C) Inject (SSOT → dist/posts HTML 교체)
- scripts/build/review-meta-block.cjs  (INJECTOR)
  - input : content/reviews/review-ratings.json (SSOT)
  - output: dist/posts/*.html (섹션 교체)
  - 교체 대상 섹션:
    - <section id="review-rating-block">...</section>
    - <section id="review-insights-block">...</section>

D) Due / 90days Scheduling (점검 대상 선정)
- scripts/build/review-due-90days.cjs
  - 역할: “90일 점검이 필요한 slug 목록” 산출
  - output: dist/queue/review-due.json (또는 logs/review-due.json)
  - 정책: 산출물 위치는 1개로 고정(혼선 금지)

- scripts/build/review-next-from-due.cjs
  - 역할: due 목록에서 다음 실행 대상 1개(or N개) pick
  - output: dist/queue/review-next.json

────────────────────────────────────────────────────────────
2) Minimal Operating Set (운영 최소 구성, 권장)
────────────────────────────────────────────────────────────
(1) review-diff-update.cjs     : SSOT 병합(upsert)
(2) review-due-90days.cjs      : 점검 대상 산출
(3) review-next-from-due.cjs   : 다음 대상 선택
(4) review-meta-block.cjs      : dist/posts 주입(섹션 교체)

※ 위 4개가 자동화 루프에 들어가고,
   나머지는 테스트/보조/레거시로 번들 안에서 통제합니다.

────────────────────────────────────────────────────────────
3) QA Contract (리뷰 라벨 SSOT 누락은 CRIT)
────────────────────────────────────────────────────────────
- qa-check.cjs 규칙(핵심):
  - 파일명이 리뷰 프리픽스(app-/device-/subscription-)인데
    HTML 내부에 missing-ssot 신호가 있으면 CRIT
  - CRIT는 “자동발행 제외” 판단 근거가 된다.

[missing-ssot 신호(권장)]
- reviewStatus="missing-ssot" 또는 data-review-status="missing-ssot"
- 또는 주석/플레이스홀더 문구(최후 방어)

────────────────────────────────────────────────────────────
4) Write Permissions (쓰기 권한)
────────────────────────────────────────────────────────────
review-diff-update.cjs
- READ : (원천 데이터, 정책에 따라)
- WRITE: content/reviews/review-ratings.json (SSOT)

review-resolver.cjs
- READ : content/reviews/review-ratings.json
- WRITE: 금지(메모리 내 normalize만)

review-meta-block.cjs
- READ : content/reviews/review-ratings.json
- WRITE: dist/posts/*.html (review 섹션 교체)

qa-check.cjs
- READ : dist/posts/*.html
- WRITE: logs/qa-*.json (리포트) + 콘솔 요약

────────────────────────────────────────────────────────────
End of Review Pipeline Map (SSOT)
────────────────────────────────────────────────────────────
