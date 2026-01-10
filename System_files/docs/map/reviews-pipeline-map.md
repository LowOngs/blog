# System_files/docs/pipeline-map.md
# AOIA Pipeline Map SSOT (includes review-*.cjs bundle)

> This file is the Single Source of Truth (SSOT) for the whole pipeline.
> If something breaks, we diagnose by following this map first (no blind source chasing).

──────────────────────────────────────────────────────────────────────────────
0) Core Principles (Non-negotiable Contracts)
──────────────────────────────────────────────────────────────────────────────

[CONTRACT-1] SSOT 우선
- “어디가 진짜 원본인가”를 각 단계마다 1개로 고정합니다.
- 스크립트는 SSOT를 읽고/쓰는 권한이 명시된 범위에서만 동작합니다.

[CONTRACT-2] pageId 발급은 ids 단계만
- render 단계에서 신규 발급 금지.
- render는 누락 시 ids.cjs 1회 재실행 “요청”만 가능.

[CONTRACT-3] publish 최종 게이트는 blogger 단계에서 강제
- PUBLISH_MODE != enable 이면 API 호출 자체 금지.
- DRY_RUN 파싱 규칙: false/0만 live, 나머지는 전부 dry-run.

[CONTRACT-4] today.json(SSOT) 스코프 기본 고정
- 기본 발행/ids/publish 대상은 today.json의 publishable만.
- 전체(dist/posts 전체) 발행은 수동/위험 옵션으로만 허용.

[CONTRACT-5] 리뷰 파이프라인은 “번들” 단위로 관리
- review-*.cjs는 개별 파일로 흩어져 있어도, 지도에서는 “번들”로 묶어
  (a) SSOT, (b) 생성/병합, (c) 주입, (d) 듀(90days) 관리로 분류합니다.
- Jarvis는 review 관련 변경/디버깅 시 이 번들 섹션부터 봅니다.

──────────────────────────────────────────────────────────────────────────────
1) High-Level Flow (Start → End)
──────────────────────────────────────────────────────────────────────────────

A. Seed Pick / Schedule
  1) warehouse/first-gate (read-only)
      └─ scripts/build/firstgate-pick.cjs
         output: dist/queue/firstgate.json (SSOT for firstgate pick)
         usage: manifests/firstgate-usage.json (SSOT usage ledger)

  2) seedpool/*.json
      └─ scripts/build/seed-scheduler.cjs
         output: dist/queue/today.json (SSOT for today plan)

B. Queue → Posts (JSON)
  3) dist/queue/today.json (SSOT)
      └─ scripts/build/queue-to-posts.cjs
         output: content/posts/*.json (post SSOT per slug)
         contract:
           - labels: 반드시 6개 중 1개 (labels:[label] 형태)
           - profileId: labels.json 매핑 필수(없으면 FAIL)
           - title 누락이면 FAIL

C. Body / Content Generation (depends on your current body generator)
  4) content/posts/*.json
      └─ (example) scripts/build/generate-body.cjs, normalize-body.cjs
         output: content/posts/*.json (body 채움, overwrite 정책은 별도 규칙 준수)

D. IDs (pageId assignment)
  5) content/posts/*.json + dist/queue/today.json
      └─ scripts/build/ids.cjs (+ lib/page-ids.cjs)
         output:
           - content/posts/*.json 에 pageId 반영(또는 seedMeta.pageId)
           - manifests/page-ids.json + journal(있다면) (SSOT)
         contract:
           - render에서 신규 발급 금지
           - ids가 발급/기록 책임

E. Render (HTML)
  6) content/posts/*.json + templates/post.html + manifests/*
      └─ scripts/build/render-posts.cjs
         output: dist/posts/*.html
         contract:
           - meta.cjs(buildMeta) 결과 사용(placeholder 금지)
           - TLDR/KeyFacts/FAQ/Sources/Review 슬롯은 blocks.cjs를 통해 렌더
           - pageId 누락 시 ids.cjs 1회 재실행 후 재로딩, 그래도 없으면 FAIL
           - body-image SSOT: manifests/images-body-manifest.json (있으면 1장 주입, 없으면 skip)

F. Review Bundle (SSOT → Inject into dist/posts)
  7) content/reviews/* (SSOT)
      └─ (bundle scripts) review-*.cjs
         output: dist/posts/*.html 내 review 섹션 갱신/주입

G. Validate / QA
  8) dist/posts/*.html
      └─ validate-repair.cjs / qa-check.cjs / content-blocks check
         output: logs/* (리포트)

H. Upload (R2 etc.)
  9) dist/* + manifests/*
      └─ scripts/build/r2-upload.cjs (DRY_RUN 준수 필수)

I. Publish (Blogger)
  10) dist/posts/*.html + dist/queue/today.json (SSOT scope)
      └─ scripts/publish/blogger.cjs
         output: Blogger posts + logs/publish-*.log + seed-ledger upsert

──────────────────────────────────────────────────────────────────────────────
2) SSOT Registry (What is “the” source of truth?)
──────────────────────────────────────────────────────────────────────────────

Queue SSOT:
- dist/queue/today.json                : 오늘 발행 계획(라벨/시드/슬롯)
- dist/queue/firstgate.json            : first-gate 오늘 선택 결과(단일)

Post SSOT:
- content/posts/{slug}.json            : 포스트 원본(JSON)

ID SSOT:
- manifests/page-ids.json (+ journal)  : pageId 연속성/기록

Review SSOT:
- content/reviews/review-ratings.json  : (권장) slug별 rating/insights 통합 SSOT
- (라벨별 원천이 추가로 존재할 수 있음: app/device/subscription 각각)
  단, “최종 주입”은 review-ratings.json(or normalized SSOT)을 기준으로 한다.

Image SSOT:
- manifests/images-manifest.json       : OG/hero 등 추출 SSOT
- manifests/images-body-manifest.json  : 본문 1장 주입 SSOT

Ledgers/Logs:
- logs/seed-ledger.jsonl               : pageId↔seedId↔slug↔label↔publish 결과 장부(SSOT)
- logs/publish-blogger-YYYY-MM-DD.log  : 상세 로그
- logs/publish-summary-YYYY-MM-DD.log  : 요약 로그

──────────────────────────────────────────────────────────────────────────────
3) Review Bundle (review-*.cjs) — MUST be handled as one group
──────────────────────────────────────────────────────────────────────────────

[Goal]
- 리뷰 3종 라벨(app/device/subscription)의 “별점/히스토그램/인사이트”를
  90일 주기로 갱신하고, dist/posts/*.html의 두 섹션을 최신 값으로 교체한다.
  - <section id="review-rating-block">...</section>
  - <section id="review-insights-block">...</section>

[Bundle Classification]
A) Review SSOT Build / Normalize (원천 → 통합 SSOT)
- reviews-bootstrap.cjs
  - 역할: (초기) reviews SSOT 파일/골격 생성(없으면 만들어 주는 도구)
  - output 예: content/reviews/review-ratings.json (빈 구조라도)

- review-resolver.cjs
  - 역할: 라벨별 원천(앱/디바이스/구독)을 읽고 “공통 포맷”으로 정규화해서 render/blocks에 공급
  - output: 메모리 내 resolveReviewData() 결과 (파일 저장이 아니라 resolver)

- review-diff-update.cjs
  - 역할: 신규 수집/변경분을 SSOT(review-ratings.json)에 안전 병합(upsert)
  - output: content/reviews/review-ratings.json 갱신

B) Due / 90days Scheduling (점검 대상 선정)
- review-due-90days.cjs
  - 역할: “90일 점검이 필요한 slug 리스트” 계산(또는 스냅샷 비교 기준 생성)
  - output 예: dist/queue/review-due.json 또는 logs/review-due.json (프로젝트 정책에 맞춰 1개로 고정 권장)

- review-next-from-due.cjs
  - 역할: due 목록에서 다음 실행 대상 1개(or N개) pick
  - output 예: dist/queue/review-next.json

C) Inject / Render-time Blocks (SSOT → dist/posts)
- review-meta-block.cjs  (INJECTOR)
  - 역할: content/reviews/review-ratings.json을 읽어서 dist/posts/*.html의
          review-rating-block / review-insights-block 섹션을 교체한다.
  - input: content/reviews/review-ratings.json (SSOT)
  - output: dist/posts/*.html (섹션 교체)

D) Legacy / Specialized (존재는 인정, 지도에서 “묶음으로 통제”)
- review-rating.cjs
  - 역할(추정 범위): 과거에 “posts.json에 review.rating 블록 갱신”에 쓰이던 스크립트.
  - 정책:
    - 최종 SSOT가 review-ratings.json으로 확정이면,
      review-rating.cjs는 “SSOT 생성/병합 파트에 흡수”되거나 “비활성(수동)”로 둔다.
    - 단, 현재 실제 운용 중이라면 번들 A 또는 B로 재분류 후 계약에 편입해야 한다.

- reviews-clean-sample.cjs / reviews-seed-sample.cjs
  - 역할: 샘플/테스트 데이터 정리/주입용 유틸(운영 파이프라인 필수 단계 아님)
  - 정책: 운영 루프에 자동 연결 금지(수동 실행만)

[Minimal Operating Set (운영 최소 구성, 권장)]
- (A) review-diff-update.cjs  : SSOT 병합
- (B) review-due-90days.cjs   : 점검 대상 산출
- (B) review-next-from-due.cjs: 다음 대상 선택
- (C) review-meta-block.cjs   : dist/posts 주입

※ 위 4개가 “실제 자동화 루프”에 들어가고,
   나머지는 테스트/보조/레거시로 번들 안에서 통제합니다.

──────────────────────────────────────────────────────────────────────────────
4) What must be written where (Write Permissions)
──────────────────────────────────────────────────────────────────────────────

seed-scheduler.cjs
- READ: seedpool/*.json
- WRITE: dist/queue/today.json

firstgate-pick.cjs
- READ: seedpool/warehouse/first-gate/*.json
- WRITE: dist/queue/firstgate.json, manifests/firstgate-usage.json

queue-to-posts.cjs
- READ: dist/queue/today.json, seedpool/profiles/labels.json
- WRITE: content/posts/*.json (create only)

ids.cjs
- READ: dist/queue/today.json, content/posts/*.json
- WRITE: pageId 기록(SSOT: manifests/page-ids.json + journal), post json pageId 반영

render-posts.cjs
- READ: content/posts/*.json, templates/post.html, manifests/images-body-manifest.json
- WRITE: dist/posts/*.html
- MUST NOT: 신규 pageId 발급(only rerun ids once if missing)

review-meta-block.cjs
- READ: content/reviews/review-ratings.json
- WRITE: dist/posts/*.html (review sections)

blogger.cjs
- READ: dist/queue/today.json, dist/posts/*.html
- WRITE: Blogger API publish (only if PUBLISH_MODE=enable and DRY_RUN=false)
- WRITE: logs/publish-*.log, logs/seed-ledger.jsonl (upsert)

──────────────────────────────────────────────────────────────────────────────
5) Debug Playbook (How Jarvis should diagnose)
──────────────────────────────────────────────────────────────────────────────

Case-1) “대량 발행/429” 발생
- Check: blogger.cjs scope today.json 고정 여부 + MAX_POSTS + POST_SLEEP_MS
- Map step: I(Publish) ← A/B(Queue SSOT) ← dist/queue/today.json

Case-2) “pageId 누락 / 깨짐”
- Check: ids.cjs가 today publishable에만 발급하는지
- Check: render-posts.cjs가 ensurePageId 직접 호출 금지 지키는지
- Map step: D(IDs) ← B(Posts) ← A(Queue)

Case-3) “리뷰 섹션이 비어있음”
- Check: review-ratings.json에 bySlug[slug] 존재?
- Check: dist/posts html에 slot(section id) 존재?
- Run order: (A) SSOT merge → (C) inject
- Map step: F(Review Bundle) ← Review SSOT

Case-4) “DRY_RUN인데 실제 업로드/발행”
- Check: DRY_RUN 파서( false/0만 live )
- Check: PUBLISH_MODE final gate in blogger.cjs
- Map step: I(Publish) + H(Upload)

──────────────────────────────────────────────────────────────────────────────
End of Map (SSOT)
──────────────────────────────────────────────────────────────────────────────
