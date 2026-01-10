# Reviews Pipeline Map (SSOT)
Last updated: 2026-01-10
Owner: Ongs System (AOIA Phase-1)

이 문서는 “리뷰 파이프라인의 단일 지도(SSOT)”입니다.
개별 스크립트 주석은 참고용이며, 파이프라인의 의도/규칙/금지/계약은 반드시 이 파일을 우선으로 합니다.

────────────────────────────────────────────────────────────
0) 핵심 결론(한 줄)
────────────────────────────────────────────────────────────
리뷰 데이터의 단일 진실(SSOT)은 content/reviews/review-ratings.json 이며,
렌더는 review-resolver.cjs를 통해 “SSOT → blocks → dist/posts”로만 흘러갑니다.

────────────────────────────────────────────────────────────
1) 구성요소(파일 역할 지도)
────────────────────────────────────────────────────────────

[A] SSOT (Single Source of Truth)
1) content/reviews/review-ratings.json
- 구조(최소):
  {
    "meta": { "updatedAt": "ISO", "source": "script-name" },
    "bySlug": {
      "<slug>": {
        "lastChecked": "YYYY-MM-DD or ISO",
        "status": "ok|n/a|...",
        "store": "multi|apple|google|...",
        "ratingCurrent": number,
        "votesCurrent": number,
        "ratingPrevious": number|null,
        "votesPrevious": number|null,
        "ratingDiff": number|null,
        "votesDiff": number|null,
        "histogram": { "5": number, "4": number, "3": number, "2": number, "1": number } | null,
        "insights": [ "string", ... ]
      }
    }
  }

- 규칙:
  - bySlug[slug]가 존재하면 “그 값이 진실”이다.
  - histogram/insights는 별도 수집 루프가 있을 수 있으므로, 자동 갱신 스크립트는 “가능하면 보존”한다.
  - slug 키는 dist/posts/<slug>.html, content/posts/*.json slug와 1:1이어야 한다.

2) content/reviews/app-ratings.json (입력 데이터셋 예)
- 역할: 외부/수동 수집된 스냅샷 원천(SSOT 아님)
- 스크립트가 review-ratings.json으로 “투입”할 수는 있지만, 렌더는 이 파일을 직접 읽지 않는다.

────────────────────────────────────────────────────────────
[B] 렌더 연결(Production Path)
────────────────────────────────────────────────────────────

1) scripts/build/review-resolver.cjs
- 역할:
  - postJson(라벨/slug)에 맞춰 review-ratings SSOT에서 bySlug[slug]를 읽고
  - blocks가 요구하는 공통 포맷으로 정규화(normalize)해서 반환한다.
- 절대 규칙:
  - resolver는 “새 리뷰를 생성하지 않는다”.
  - SSOT가 없으면 null을 반환하거나 “빈 블록” 정책으로 간다(생성 금지).

2) scripts/build/lib/blocks.cjs
- 역할:
  - renderReviewRatingBlock(reviewData)
  - renderReviewInsightsBlock(reviewData)
  - (템플릿 슬롯에 삽입될 HTML 블록 생성)

3) scripts/build/render-posts.cjs
- 역할:
  - content/posts/*.json → dist/posts/*.html 생성
  - review-resolver → blocks → SLOT 주입
- 절대 규칙:
  - render 단계에서 리뷰 SSOT를 만들거나 수정하면 안 된다.
  - render는 “읽기/주입”만 한다.

────────────────────────────────────────────────────────────
[C] 후처리(옵션 Path / 선택)
────────────────────────────────────────────────────────────

1) scripts/build/review-meta-block.cjs
- 역할:
  - dist/posts/*.html 내부의
    <section id="review-rating-block">...</section>
    <section id="review-insights-block">...</section>
    을 SSOT 기준으로 “교체”
- 사용 정책:
  - 기본은 “렌더 단계에서 이미 주입되므로” 필요 없을 수 있다.
  - 다만, “렌더 이후 리뷰만 따로 갱신해야 하는 운영 상황”에서는 유용하다.
- 절대 규칙:
  - 이 스크립트는 SSOT를 수정하지 않는다(HTML만 수정).

────────────────────────────────────────────────────────────
2) 실행 순서(운영 표준)
────────────────────────────────────────────────────────────

[기본(권장) 루프]
1) (선택) 리뷰 입력 수집/병합 → content/reviews/app-ratings.json 등 갱신
2) review-rating.cjs 실행 → review-ratings.json(SSOT) 갱신
3) render-posts.cjs 실행 → dist/posts 생성(리뷰 포함)
4) (선택) review-meta-block.cjs 실행 → dist/posts의 리뷰만 재주입(렌더 생략 가능)

[리뷰만 급히 업데이트(렌더 생략)]
- review-rating.cjs → review-meta-block.cjs

────────────────────────────────────────────────────────────
3) “무조건 지켜야 하는 계약”(삭제/변경 금지 지점)
────────────────────────────────────────────────────────────

[HTML 슬롯 계약]
- dist/posts/*.html에는 다음 ID 섹션이 존재해야 한다(리뷰 라벨에서만 또는 템플릿 정책에 따름):
  - id="review-rating-block"
  - id="review-insights-block"
- 위 섹션 ID는 이름 변경 금지(SSOT 스크립트들이 정규식으로 찾는다).

[SSOT 계약]
- 리뷰 데이터의 최종 출처는 review-ratings.json(bySlug)이며,
  렌더/후처리 스크립트는 반드시 여기만 신뢰한다.

[데이터 보존 계약]
- review-rating.cjs 계열 “갱신 스크립트”는
  기존 bySlug[slug]의 histogram/insights 같은 부가필드를 가능하면 보존한다.
  (그 필드는 다른 수집 루프가 채울 수 있으므로 덮어쓰면 손실)

────────────────────────────────────────────────────────────
4) 금지 사항(사고 방지)
────────────────────────────────────────────────────────────

- render-posts.cjs가 review-ratings.json을 생성/수정하는 행위 금지
- review-resolver.cjs가 SSOT를 생성하는 행위 금지
- HTML의 review 섹션 ID 변경 금지
- 스크립트 파일 합본(한 파일에 shebang 여러개) 금지: 반드시 개별 파일로 분리

────────────────────────────────────────────────────────────
5) 실패 유형별 진단(빠른 트러블슈팅)
────────────────────────────────────────────────────────────

[증상 A] 리뷰 블록이 비어있음
- 원인 1: review-ratings.json에 bySlug[slug] 없음
  - 조치: review-rating.cjs 실행 또는 bySlug에 slug 추가
- 원인 2: 템플릿/렌더 결과에 review 섹션 슬롯이 없음
  - 조치: 템플릿(post.html) SLOT/ID 확인

[증상 B] dist/posts에만 리뷰가 반영 안 됨
- 원인: SSOT는 갱신됐지만 렌더를 안 돌림
  - 조치: render-posts.cjs 또는 review-meta-block.cjs 실행

[증상 C] histogram/insights가 자꾸 사라짐
- 원인: SSOT 갱신 스크립트가 덮어씀
  - 조치: “보존 계약” 위반 여부 확인, 갱신 스크립트에서 기존 필드 merge 방식으로 수정

────────────────────────────────────────────────────────────
6) 지도 파일 유지 규칙(가장 중요)
────────────────────────────────────────────────────────────

- 파이프라인 변경이 필요하면:
  1) 이 지도 파일을 먼저 업데이트한다.
  2) 그 다음에 코드 변경을 한다.
- “지도를 고치지 않은 코드 변경”은 금지한다.
- 개별 파일 주석은 자유롭게 수정돼도 되지만,
  본 파이프라인의 핵심 규칙은 항상 이 파일이 우선한다.

(끝)
