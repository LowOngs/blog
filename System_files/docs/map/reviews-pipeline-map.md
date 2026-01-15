# Review Pipeline Map (SSOT) — 상세판 (Review Bundle 전용 지도)
- Path (SSOT): System_files/docs/map/review-pipeline-map.md
- Last Updated: 2026-01-15 (+0900)

목표
- “리뷰 히스토그램/인사이트/평점” 문제는 템플릿만으로 해결하지 않는다.
- 리뷰는 반드시 “번들(수집→next→merge→SSOT→inject→QA)”로 사고한다.
- 어디가 비었는지(=왜 app만 나오거나, 더미만 나오거나, next가 비는지)를 즉시 좁히는 지도.

────────────────────────────────────────────────────────────
0) Ground Rules (리뷰 전용)
────────────────────────────────────────────────────────────
- Review SSOT는 content/reviews/review-ratings.json(bySlug) 단 하나를 최종 신뢰한다.
- *-ratings-next.json / *-insights.json 등은 “중간재(next 구성요소)”이며 최종 출력은 SSOT 기준으로만 한다.
- “실제 리뷰 목록을 찾아서 뽑아오는 엔진”이 없으면:
  - next/SSOT가 비거나 더미 수준에 머문다.
  - 따라서 injector/템플릿을 만져도 근본 해결이 아니다(표면만 바뀜).

────────────────────────────────────────────────────────────
1) Review Data Layers (파일 층위/역할)
────────────────────────────────────────────────────────────
[A] Bucket Raw / Partial (중간재 조각들)
- content/reviews/app-ratings.json                (현존: 앱별 rating/histogram 등)
- content/reviews/device-ratings.json
- content/reviews/subscription-ratings.json

- content/reviews/app-ratings-next.json           (교체됨: skeleton updatedAt/bySlug)
- content/reviews/device-ratings-next.json        (교체됨)
- content/reviews/subscription-ratings-next.json  (교체됨)

- content/reviews/app-insights.json               (교체됨: skeleton)
- content/reviews/device-insights.json            (교체됨)
- content/reviews/subscription-insights.json      (교체됨, 철자 고정 파일명 유지 정책 포함)

- content/reviews/review-sources.json             (bySlug sources stub/upsert 대상)

[B] Unified NEXT (통합 후보)
- content/reviews/review-ratings-next.json        (다음에 SSOT로 병합될 “후보 통합본”)

[C] Unified SSOT (최종 신뢰 원본)
- content/reviews/review-ratings.json             (bySlug, injector/renderer가 최종 참조)

[D] dist 산출물(리포트/큐)
- dist/reviews/due-90days.json                    (90일 갱신 대상 리스트: 리포트/작업큐 성격)

────────────────────────────────────────────────────────────
2) Review Pipeline (Trunk) — stub → next → merge → ssot → inject → qa
────────────────────────────────────────────────────────────
Step 1) Stub Fill (SSOT 보호 + 누락 방지)
- scripts/build/review-stub-fill.cjs   [신규]
  - 역할:
    - content/posts에서 리뷰 슬러그(app-/device-/subscription-)를 스캔
    - content/reviews의 bucket별 파일들에 bySlug stub를 “없을 때만” 업서트
    - review-sources.json에도 기본 stub 업서트
  - READ:
    - content/posts/*.json
    - content/reviews/* (기존 내용)
  - WRITE:
    - content/reviews/app-ratings.json / device-ratings.json / subscription-ratings.json (필요 시)
    - content/reviews/*-ratings-next.json (필요 시)
    - content/reviews/*-insights.json (필요 시)
    - content/reviews/review-sources.json
  - 핵심:
    - “SSOT가 비는 현상”을 막는 방화벽(단, 실제 값 수집은 아님)

Step 2) Build Unified NEXT (조각→통합 후보)
- scripts/build/review-build-next.cjs   [신규]
  - 역할:
    - bucket별 *-ratings-next.json + *-insights.json + review-sources.json을 병합/보정
    - content/reviews/review-ratings-next.json 생성(WRITE)
  - READ:
    - content/reviews/app-ratings-next.json, device-ratings-next.json, subscription-ratings-next.json
    - content/reviews/app-insights.json, device-insights.json, subscription-insights.json
    - content/reviews/review-sources.json
  - WRITE:
    - content/reviews/review-ratings-next.json
  - 보정 포인트(정합성):
    - histogram 키/값 숫자화(1~5)
    - insights 길이 제한, sources 길이 제한
    - status/store/source/lastChecked 기본값 채움

Step 3) Merge NEXT → SSOT (변화만 반영)
- scripts/build/review-diff-update.cjs
  - 역할(권장):
    - review-ratings-next.json을 기준으로 review-ratings.json(SSOT)에 변화만 반영(덮어쓰기)
  - 관련 병합기(데이터 폴더 기반이 존재할 수 있음):
    - scripts/build/update-review-ratings.cjs (data/review-ratings*.json 비교/반영)
  - 핵심:
    - “next가 생겼는데 SSOT가 안 바뀌는” 문제는 여기서 끊긴다.

Step 4) Resolve (Read-only Normalize for Render)
- scripts/build/review-resolver.cjs
  - 역할:
    - render-posts가 호출
    - SSOT(review-ratings.json)에서 현재 slug에 맞는 리뷰 데이터를 읽기 전용 정규화하여 반환
  - READ:
    - content/reviews/review-ratings.json
  - WRITE:
    - 없음(함수/라이브러리 성격)

Step 5) Inject into dist/posts (HTML 섹션 치환)
- scripts/build/inject-reviews-from-ssot.cjs
  - 역할:
    - dist/posts/*.html의 아래 섹션을 SSOT 기준으로 교체
      - <section id="review-rating-block">...</section>
      - <section id="review-insights-block">...</section>
    - Freshness(90일) 경고 통계 출력
  - READ:
    - content/reviews/review-ratings.json
    - dist/posts/*.html
  - WRITE:
    - dist/posts/*.html (in-place overwrite)

- scripts/build/review-meta-block.cjs
  - 역할:
    - dist/posts의 리뷰 슬롯을 섹션 단위로 치환(대체 injector 가능)
    - insights를 Positive/Negative 구조로 강제 + 비어도 안내문구 출력
  - 주의:
    - inject-reviews-from-ssot.cjs와 “최종 주입자”가 겹칠 수 있으므로
      워크플로에서 마지막 실행자가 누구인지 반드시 고정해야 함.

Step 6) QA Gate (자동발행 방어)
- scripts/build/qa-check.cjs
  - 역할:
    - 리뷰 라벨인데 SSOT 누락/형식 오류면 CRIT로 발행 제외(가드)
  - 핵심:
    - “리뷰 데이터 더미/누락”이 실발행으로 나가는 것을 여기서 막는다.

────────────────────────────────────────────────────────────
3) Slot Contract (템플릿/HTML 계약)
────────────────────────────────────────────────────────────
- templates/post.html에는 아래 슬롯이 반드시 존재해야 injector가 동작한다:
  - <section id="review-rating-block"> ... </section>
  - <section id="review-insights-block"> ... </section>
- 섹션 ID가 바뀌면:
  - injector는 “slotMissing++ 후 스킵”
  - 결과: 화면에 더미/빈 섹션만 남는다(데이터가 있어도 주입이 안 됨)

────────────────────────────────────────────────────────────
4) Symptoms → Where to look (진단 라우팅)
────────────────────────────────────────────────────────────
1) app만 히스토그램/인사이트가 나오고 device/subscription은 비어있다
- Step 1(stub-fill): 대상 slug가 bucket 파일들에 생성/등록되었는지
- Step 2(build-next): review-ratings-next.json에 device/subscription slug가 들어갔는지
- Step 3(diff-update): SSOT(review-ratings.json)에 반영됐는지
- Step 5(inject): dist/posts에 슬롯이 있는지 + 마지막 주입자가 누구인지

2) review-ratings-next.json이 비어있다
- *-ratings-next.json / *-insights.json이 skeleton만인지(=실데이터 공급원 없음)
- build-next 병합 입력이 전부 빈 bySlug인지

3) SSOT는 있는데 화면이 비어있다
- templates/post.html 섹션 ID/구조 불일치
- injector 실행 순서(나중에 다른 스크립트가 덮어쓴 경우 포함)

────────────────────────────────────────────────────────────
5) Known Constraint (현재 단계의 “본질 제약”)
────────────────────────────────────────────────────────────
- *-ratings-next.json류/insights.json류가 skeleton이 된 상태에서,
  “실제 리뷰 목록을 수집해 next를 채우는 엔진”이 없으면:
  - next/SSOT는 의미 있는 데이터로 성장하지 않는다.
  - 따라서 다음 우선순위는 “수집/갱신 엔진” 또는 “next 생성 규칙(현실 데이터 주입 경로)”를 확정하는 것이다.

End of Review Pipeline Map (SSOT) — 상세판
