# (2) System_files/docs/review-pipeline-map.md 에 추가/수정할 내용

────────────────────────────────────────────────────────────
2) File Index (리뷰 관련 파일별 “역할/범위/입출력/파급/증상”)
────────────────────────────────────────────────────────────
표기:
- R=READ, W=WRITE
- 결합=Strong Coupling, 파급=수정 영향 범위

────────────────────────────
2.0 Stub & Next Builders (NEW: “빈칸 엔진”을 실제로 메우는 연결부)
────────────────────────────
(0) scripts/build/review-stub-fill.cjs  ★ STUB UPserter
- 역할 범위:
  - content/posts에서 리뷰 슬러그(app-/device-/subscription-)를 찾아
  - content/reviews의 버킷별 파일들에 최소 구조(stub)를 ‘없을 때만’ 업서트
  - 목표: app만 데이터가 있고 나머지가 텅 비어 “주입할 데이터가 없는 상태” 방지
- R:
  - content/posts/*.json (slug 수집)
  - content/reviews/*.json (기존 파일)
- W:
  - app-ratings.json / app-ratings-next.json / app-insights.json
  - device-ratings.json / device-ratings-next.json / device-insights.json
  - subscription-ratings.json / subscription-ratings-next.json / subsctiption-insights.json
  - review-sources.json
- 결합: ★★★☆☆
- 파급:
  - 파일명/폴더 구조 변경 시 즉시 영향
  - 특히 subsctiption-insights.json 철자 변경은 “지도 선변경+합의” 없이는 금지(실파일명 고정)
- 구현 형태(열지 않고도 판단할 포인트):
  - isReviewSlug: 프리픽스 기반
  - bucketOf: slug→bucket 고정
  - ensureRatingEntry: histogram 1~5 키 포함 + votes/rating 0값 + insights=[]
  - ensureInsightsEntry: { insights: [] }
  - ensureSourcesEntry: [] (sources는 배열)
  - updatedAt: KST YYYY-MM-DD로 갱신
- 대표 증상:
  1) device/subscription bySlug가 계속 {}다
     → posts에 해당 슬러그가 없거나, 스크립트 실행/경로(POSTS_DIR) 문제
  2) subscription insights 파일이 계속 누락/에러
     → subsctiption-insights.json(오타) 실파일명 불일치

(1) scripts/build/review-build-next.cjs  ★ NEXT Aggregator
- 역할 범위:
  - 버킷별 next + insights + sources를 병합/보정하여
  - review-ratings-next.json(bySlug) “단일 통합 next” 생성
  - GPT/API 호출 없음(비용 0), “가공/보정” 전용
- R:
  - app-ratings-next.json / device-ratings-next.json / subscription-ratings-next.json
  - app-insights.json / device-insights.json / subsctiption-insights.json
  - review-sources.json
- W:
  - review-ratings-next.json
- 결합: ★★★★☆
  - 다음 단계가 next→SSOT 병합이면 사실상 필수
- 파급:
  - review-ratings-next.json 스키마가 바뀌면 diff/merge(SSOT 갱신)까지 연쇄 영향
- 구현 형태(열지 않고도 판단할 포인트):
  - mergeEntry:
    · patch 우선
    · histogram 1~5를 Number로 강제(키 보정)
    · insights: 문자열만, 최대 24개
    · sources: {label,url}만, 최대 20개
    · 기본값: status/store/source/lastChecked 보정
  - 병합 순서:
    1) next 3종 병합 → 2) insights 덧씌움 → 3) sources 부착
- 대표 증상:
  1) review-ratings-next.json은 생기는데 insights/sources가 비어 있다
     → 입력(insights/sources) 파일의 bySlug 구조 문제 또는 slug 키 불일치
  2) histogram이 누락/깨짐
     → 입력 next의 histogram 형식이 규약 밖이거나 키가 다름

────────────────────────────
2.1 Build / Merge (SSOT 갱신 책임자)
────────────────────────────
(2) scripts/build/review-diff-update.cjs  ★ SSOT Merger
- 역할 범위:
  - review-ratings-next.json(통합 next)을 읽어
  - review-ratings.json(SSOT)에 안전 병합(upsert)
- R:
  - content/reviews/review-ratings-next.json
  - (필요 시) content/reviews/review-ratings.json(기존 SSOT)
- W:
  - content/reviews/review-ratings.json
- 결합: ★★★★★ (SSOT가 비면 injector가 주입할 것이 0)
- 대표 증상:
  - dist에는 리뷰 글이 있는데 SSOT(bySlug)에 slug가 없다(ssotMissing 증가)
  - lastChecked가 갱신되지 않아 stale/due 판정이 계속 악화

────────────────────────────
2.3 Injector (HTML 섹션 치환)
────────────────────────────
(중요 보강) review-meta-block.cjs의 “app만 나온다” 원인 라우팅
- app만 히스토그램/insights가 출력되는 케이스는 대부분:
  1) SSOT(review-ratings.json) bySlug에 app만 들어있음(병합/수집 결손)
  2) dist slug ↔ bySlug 키 매칭이 app만 성공(슬러그 규칙/파일명 기반 추출 문제)
  3) subsctiption-insights.json 철자 불일치로 subscription insights가 통합 next에 들어오지 못함

────────────────────────────────────────────────────────────
3) 결합/파급(“하나 고치면 어디가 같이 흔들리나”) — NEW 보강
────────────────────────────────────────────────────────────
[리뷰 데이터가 ‘비어있다’는 문제의 원인 후보를 단계별로 즉시 분리]
- 버킷별 파일(bySlug)이 비어있다
  → review-stub-fill.cjs(스텁 업서트 단계) 또는 posts 슬러그 자체 부재

- 통합 next(review-ratings-next.json)가 비어있다
  → review-build-next.cjs(병합 단계) 또는 입력 파일들의 bySlug/키 불일치

- SSOT(review-ratings.json)가 비어있다
  → review-diff-update.cjs(next→SSOT 병합 단계)

- HTML에 안 보인다(placeholder)
  → templates/post.html 섹션 ID/구조 또는 review-meta-block.cjs 치환 실패
