# Review Pipeline Map (SSOT) — 상세판
- Path: System_files/docs/review-pipeline-map.md
- Last Updated: 2026-01-15 (+0900)

목표:
- “리뷰 문제는 어떤 파일에서 구현되었는가”를 파일을 열지 않고 판별.
- SSOT(리뷰 데이터) → normalize → injector → QA(발행 제외 근거)까지의 결합/파급을 명확히 기록.

────────────────────────────────────────────────────────────
0) Review SSOT (Single Source of Truth)
────────────────────────────────────────────────────────────
[Review SSOT]
- System_files/content/reviews/review-ratings.json
  - 구조: bySlug[slug] = { bucket, rating, histogram, insights, lastChecked, ... }
  - “최종 주입 데이터”는 이 파일만 신뢰한다.
  - 다른 원천 파일(버킷별 ratings/insights 등)은 ‘입력/수집/초기화’ 용도이며,
    dist/posts 주입 단계는 review-ratings.json만 읽는다.

[리뷰 대상 라벨(3개만 허용)]
- app-reviews
- device-reviews
- subscription-services
(비리뷰 라벨에 리뷰 주입 금지 = 오염 방지)

────────────────────────────────────────────────────────────
1) Bundle 구성(줄기) — Build/Merge → Resolve → Inject → Freshness/QA
────────────────────────────────────────────────────────────
A) SSOT Build / Merge (원천→통합 SSOT 갱신)
B) Resolver (Read-only normalize)
C) Injector (dist/posts HTML 섹션 치환)
D) Freshness / Due Scheduling (90일 점검 흐름)
E) QA Contract (CRIT면 자동발행 제외 근거)

────────────────────────────────────────────────────────────
2) File Index (리뷰 관련 파일별 “역할/범위/입출력/파급/증상”)
────────────────────────────────────────────────────────────
표기:
- R=READ, W=WRITE
- 결합=Strong Coupling, 파급=수정 영향 범위

────────────────────────────
2.1 Build / Merge (SSOT 갱신 책임자)
────────────────────────────
(1) scripts/build/review-diff-update.cjs
- 역할 범위: 신규 수집/변경분을 review-ratings.json(SSOT)에 안전 병합(upsert)
- 구현 형태: “기존 SSOT 덮어쓰기 금지” 성향(정책에 따라 upsert/merge)
- R: (정책상) next 파일 또는 원천 데이터(리뷰 수집 결과)
- W: content/reviews/review-ratings.json
- 결합: ★★★★☆ (SSOT가 비면 injector가 할 일이 없어짐)
- 파급: SSOT 구조/키/필드 변경 시 resolver/injector/qa 모두 영향
- 대표 증상:
  - slug가 SSOT에 안 들어가서 ssot-missing 증가
  - lastChecked 누락으로 freshness에서 missingDate 증가

(2) scripts/build/update-review-ratings.cjs
- 역할 범위: review-ratings.json / review-ratings-next.json 등을 “생성/갱신”하는 주체(수집/갱신 파트)
- R/W: content/reviews/* (프로젝트 정책에 따름)
- 결합: ★★★☆☆
- 파급: “next 생성/병합 흐름”이 바뀌면 review-diff-update와 결합 변화
- 대표 증상:
  - next가 생성되지 않거나, 갱신이 멈춰 SSOT가 오래됨

(3) scripts/build/review-diff-update.cjs
- 역할 범위: next→SSOT 병합/초기화 방지(“안전 병합”)
- R: review-ratings-next.json(등)
- W: review-ratings.json
- 결합: ★★★★☆
- 대표 증상:
  - 갱신이 있는데도 SSOT가 안 바뀜(병합 조건/키 매칭 실패)

(4) scripts/build/reviews-bootstrap.cjs (부트스트랩/초기 골격)
- 역할 범위:
  - content/posts에서 리뷰 라벨 slug를 수집
  - bucket별 ratings/insights/next 템플릿 파일 생성/병합
  - 원칙: 기존 레코드 덮어쓰기 금지(없는 slug만 주입), FORCE_FILL=1은 최소 필드만 채움
- R: content/posts/*.json
- W: content/reviews/{bucket}-ratings.json, {bucket}-insights.json, {bucket}-ratings-next.json
- 결합: ★★☆☆☆ (초기화/보조 도구)
- 파급: 운영 루프 필수는 아니나, SSOT 결손을 “메우는” 도구로 중요
- 대표 증상:
  - 새 리뷰 포스트가 생겼는데 관련 레코드가 전혀 없음(초기 주입 필요)

────────────────────────────
2.2 Resolver (읽기 전용 normalize)
────────────────────────────
(5) scripts/build/review-resolver.cjs
- 역할 범위:
  - review-ratings.json(bySlug)을 읽어 렌더/주입이 쓰기 쉬운 형태로 normalize
  - 정책: 파일 저장 금지(리졸버는 read-only)
- R: content/reviews/review-ratings.json
- W: 금지
- 결합: ★★★☆☆ (포맷 정리 계층)
- 파급: insights 규칙(positive/negative 분리, 최대 6개 제한 등)을 바꾸면 출력 형태가 달라짐
- 대표 증상:
  - insights가 한쪽으로 몰림/중복 제거 안 됨/빈 안내문구 정책 불일치

────────────────────────────
2.3 Injector (HTML 섹션 치환 — “화면에 보이는 리뷰”의 최종 책임자)
────────────────────────────
(6) scripts/build/review-meta-block.cjs  ★ INJECTOR
- 역할 범위:
  - dist/posts/*.html에서 리뷰 슬롯(섹션) 전체를 정규식으로 교체(replaceSection)
  - slug는 dist/posts/{slug}.html 파일명에서 추출 → bySlug[slug] 매핑
  - rating 슬롯/insights 슬롯이 “있을 때만” 독립적으로 치환
- R: content/reviews/review-ratings.json(bySlug)
- W: dist/posts/*.html (직접 수정/저장)
- 교체 대상(섹션 ID 고정):
  - <section id="review-rating-block"> ... </section>
  - <section id="review-insights-block"> ... </section>
- 결합: ★★★★★ (템플릿 슬롯 구조와 강결합)
- 파급:
  - templates/post.html에서 섹션 ID/구조가 바뀌면 즉시 작동 불가
  - 출력 HTML 구조 변경은 validate/qa/manifest에도 영향
- 대표 증상(원인 후보 즉시 판별):
  - “리뷰가 empty placeholder” → 섹션 ID가 없거나, 정규식 매칭 실패
  - “app만 히스토그램 나옴” → bySlug 데이터가 app만 존재하거나, slug 매칭이 app만 성공
  - updated=1, ssot-missing=7 → dist에 슬러그는 있는데 SSOT(bySlug)가 없음(=데이터 문제)

(7) templates/post.html (리뷰 슬롯을 제공하는 쪽)
- 역할 범위: review-rating-block / review-insights-block 섹션(슬롯) 제공
- 결합: ★★★★★ (injector가 여기 구조를 전제로 함)
- 대표 증상:
  - 섹션 ID가 바뀌거나 빠지면 injector는 “slotMissing++”로 전부 스킵

────────────────────────────
2.4 Freshness / Due Scheduling (90일 점검 흐름)
────────────────────────────
(8) scripts/build/check-review-freshness.cjs (90일 경고기)
- 역할 범위:
  - dist/posts에서 리뷰 라벨 대상 slug만 골라
  - SSOT(bySlug).lastChecked로 ageDays 계산
  - fresh/warn/stale/missingDate/ssotMissing 통계 출력
- R:
  - dist/posts/*.html (대상 슬러그 선정)
  - content/posts/*.json (라벨 매핑)
  - content/reviews/review-ratings.json (lastChecked)
- W: 없음(콘솔)
- 결합: ★★☆☆☆
- 대표 증상:
  - ssotMissing 증가 → SSOT 데이터 병합/부트스트랩/수집 흐름 문제

(9) scripts/build/review-due-90days.cjs
- 역할 범위: “90일 점검 필요 slug 목록” 산출
- R: review-ratings.json(lastChecked), (선정 정책에 따라) posts/dist
- W: dist/queue/review-due.json 또는 logs/review-due.json (둘 중 1개로 고정 필요)
- 결합: ★★★☆☆
- 파급: 리뷰 갱신 자동화(다음 대상 선택/수집 루프)에 영향
- 대표 증상:
  - due 파일이 비거나, stale인데도 due에 안 잡힘(lastChecked 파싱/UTC 처리)

(10) scripts/build/review-next-from-due.cjs
- 역할 범위: due 목록에서 다음 실행 대상 1개(or N개) pick
- R: review-due.json
- W: dist/queue/review-next.json
- 결합: ★★☆☆☆

────────────────────────────
2.5 QA Contract (CRIT면 자동발행 제외 근거)
────────────────────────────
(11) scripts/build/qa-check.cjs (리뷰 관련 판정 포함)
- 역할 범위:
  - 리뷰 라벨(슬러그 프리픽스 app-/device-/subscription-)인데
  - HTML 내부에 missing-ssot 신호가 있으면 CRIT 처리
- R: dist/posts/*.html
- W: logs/qa-*.json
- 결합: ★★★★☆
- 대표 증상:
  - CRIT가 떠서 자동발행에서 빠짐(=정상 동작)

[missing-ssot 신호(권장)]
- data-review-status="missing-ssot"
- reviewStatus="missing-ssot"
- 또는 최후 방어용 placeholder 주석/문구

────────────────────────────────────────────────────────────
3) 결합/파급(“하나 고치면 어디가 같이 흔들리나”)
────────────────────────────────────────────────────────────
[SSOT 구조 변경(필드명/키/slug 규칙) → 파급 최상]
- review-ratings.json 스키마 변경
  → review-resolver.cjs
  → review-meta-block.cjs(HTML 출력)
  → qa-check.cjs(누락 신호)
  → check-review-freshness.cjs(날짜 파싱)

[템플릿 슬롯 구조 변경 → injector 즉사]
- templates/post.html에서 섹션 ID/구조 변경
  → review-meta-block.cjs slotMissing 폭증
  → 결과: 화면에 리뷰 0% 출력

[slug 규칙 변경 → 데이터는 있는데 매핑 실패]
- dist 파일명 slug 추출 규칙이 바뀜
  → review-meta-block.cjs에서 bySlug 매핑 실패(ssotMissing처럼 보임)

[lastChecked(UTC) 처리 변경 → due/freshness 오판]
- 날짜 포맷/타임존 처리 변경
  → stale 판단 / due 생성 / 경고 통계 전부 흔들림

────────────────────────────────────────────────────────────
4) “원인 파일을 바로 찾는” 증상별 라우팅(리뷰 전용)
────────────────────────────────────────────────────────────
1) 리뷰 섹션이 통째로 안 보임
- 1순위: templates/post.html (섹션 ID 존재/구조)
- 2순위: review-meta-block.cjs (정규식 섹션 치환 성공 여부)
- 3순위: dist/posts HTML에 섹션이 실제로 있는지(render 단계)

2) app만 히스토그램/insights가 들어감
- 1순위: review-ratings.json(bySlug)에서 device/subscription slug 레코드 존재 여부
- 2순위: content/posts 라벨/slug 매칭(라벨 누락이면 대상 선정이 틀어짐)
- 3순위: review-meta-block.cjs의 slug 추출 방식(파일명 기반)

3) ssot-missing이 많이 찍힘
- “dist에는 파일이 있는데 SSOT에 bySlug가 없다” 의미
- 원인 후보:
  - review-diff-update.cjs 병합 로직(키 매칭 실패)
  - update-review-ratings.cjs 수집/갱신 중단
  - reviews-bootstrap.cjs 초기 주입 미실행(새 slug가 SSOT에 들어가지 않음)

4) CRIT(리뷰 SSOT 누락)로 자동발행 제외됨
- 정상 방어 동작.
- 해결은 qa-check를 약화시키는 게 아니라,
  bySlug 레코드를 SSOT에 넣는 것(부트스트랩/병합/수집)로 해결해야 한다.

End of Review Pipeline Map (Detailed)
