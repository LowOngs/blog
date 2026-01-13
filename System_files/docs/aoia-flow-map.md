# AOIA Flow Map (SSOT)
- Path: System_files/docs/aoia-flow-map.md
- Last Updated: 2026-01-13 (+0900)

본 문서는 AOIA 파이프라인의 최상위 지도(SSOT)입니다.
지도에 없는 구조/변경은 사전 합의 없이 반영하지 않습니다.

────────────────────────────────────────────────────────────
0) Ground Rules (변경/운영 규칙)
────────────────────────────────────────────────────────────
- 파일명은 한번 정하면 되돌릴 수 없음(변경 제안 금지, 필요 시 사전 합의 필수).
- 기존 파일 수정은 항상:
  (1) 변경 범위 (2) 대상 파일 (3) 이유 (4) 전후 차이
  를 먼저 밝히고 진행한다.
- 주석 없는 블록은 구조 확정 전까지 삭제/변경하지 않는다.
- 로직 변경 제안이 발생하면 반드시 먼저:
  “지도 맵도 함께 변경할까요?”
  를 확인한 뒤 진행한다.

────────────────────────────────────────────────────────────
1) Root & ENV Loader (루트/환경 단일화)
────────────────────────────────────────────────────────────
[ROOT 고정]
- System_files 루트가 파이프라인 기준 ROOT이다.

[ENV 로더 단일화]
- 모든 빌드/퍼블리시 스크립트는 단일 로더를 사용한다.
  - System_files/scripts/build/lib/env.cjs

[DRY_RUN 파서 단일 규칙]
- 규칙: false 또는 0 만 “live”, 그 외 전부 “dry-run”
  - DRY_RUN=true/undefined/"true"/"1"/기타 => dry-run
  - DRY_RUN=false/"0" => live

[PUBLISH 최종 게이트 단일화]
- canPublish = (DRY_RUN=false) AND (PUBLISH_MODE=enable)
- DRY_RUN=true인 경우:
  - 외부 API 호출(발행/업로드 등)은 0% 보장
  - 로컬 산출물 생성(dist/*)과 로그 기록은 허용

────────────────────────────────────────────────────────────
2) Directory Roles (폴더 역할 고정: 소스 vs 산출물)
────────────────────────────────────────────────────────────
[소스/정의 영역: System_files/*]
- System_files/content/       : 원천 데이터(포스트 JSON, 리뷰 SSOT 등)
- System_files/templates/     : 템플릿(HTML)
- System_files/scripts/       : 빌드/검증/발행 스크립트
- System_files/manifests/     : SSOT 메타(페이지ID, 이미지 manifest 등)
- System_files/logs/          : 장부/로그(Seed Ledger 등)
- System_files/docs/          : 지도/기준 문서(본 파일 포함)

[산출물/배포 영역: System_files/dist/*]
- dist/posts/                 : 렌더된 HTML 산출물
- dist/images/                : 생성된 이미지 산출물(og/body)
- dist/queue/                 : 스케줄/발행 스코프 SSOT(today*.json 등)
- dist/ai/                    : AI/크롤러 외부 노출 산출물(feed/authority)

────────────────────────────────────────────────────────────
3) Queue SSOT (A안 분리: today.json + today.expanded.json)
────────────────────────────────────────────────────────────
[SSOT - 계획]
- dist/queue/today.json
  - “오늘 발행 계획(시드/라벨/슬롯)”의 원본 SSOT
  - seed-scheduler.cjs가 생성

[SSOT - 확장(실행용)]
- dist/queue/today.expanded.json
  - “실행용 확장 큐”
  - 목적: 워크플로 오류(스코프/slug 불일치)를 감내하지 않기 위해,
          today.json의 items를 기반으로 생성될 slug/파일명/스코프를 ‘고정’한다.
  - 포함(권장 필드):
    - date
    - items[]: { id, label, mode, title, ... }
    - expanded[]: { slug, label, sourceItemId, prefix, ymd, seq, profileId, queueDate, ... }
    - publishableSlugs[] (또는 expanded[].slug 로 대체 가능)

[생성기]
- (신규 또는 기존 스텝) scripts/build/today-expand.cjs  (권장)
  - input:  dist/queue/today.json
  - output: dist/queue/today.expanded.json
  - 계약:
    - label 6개 강제
    - profileId(labels.json) 매핑 필수
    - slug 규칙(라벨→prefix + ymd + seq) 결정론적
    - 중복 slug 금지

────────────────────────────────────────────────────────────
4) High-Level Flow (Start → End)
────────────────────────────────────────────────────────────
A) Seed Pick / Schedule
  1) seedpool/*.json
    └─ scripts/build/seed-scheduler.cjs
       output: dist/queue/today.json  (Plan SSOT)

  2) (A안 분리) Expand Queue
    └─ scripts/build/today-expand.cjs
       input : dist/queue/today.json
       output: dist/queue/today.expanded.json  (Execution SSOT)

B) Queue → Posts (JSON SSOT)
  3) dist/queue/today.expanded.json (Execution SSOT)
    └─ scripts/build/queue-to-posts.cjs
       output: content/posts/*.json (slug 기반 신규 생성만)
       contract:
         - labels: 반드시 6개 중 1개 (labels:[label])
         - profileId: labels.json 매핑 필수(없으면 FAIL)
         - title 누락이면 FAIL

C) Body / Content Generation
  4) content/posts/*.json
    └─ scripts/build/generate-body.cjs, normalize-body.cjs
       output: content/posts/*.json (body 채움, overwrite 정책 준수)

D) IDs (pageId assignment)
  5) content/posts/*.json + dist/queue/today.expanded.json
    └─ scripts/build/ids.cjs (+ lib/page-ids.cjs)
       output:
         - post json에 pageId 반영
         - manifests/page-ids.json(+ journal) (SSOT)
       contract:
         - render에서 신규 발급 금지
         - ids가 발급/기록 책임

E) Render (HTML)
  6) content/posts/*.json + templates/post.html + manifests/*
    └─ scripts/build/render-posts.cjs
       output: dist/posts/*.html
       contract:
         - pageId 누락 시 ids.cjs 1회 재실행 후 재로딩, 그래도 없으면 FAIL
         - TLDR/KeyFacts/FAQ/Sources/Review 슬롯은 blocks로 렌더
         - 이미지 SSOT(manifests/*) 기준

F) Review Pipeline (Bundle)
  7) content/reviews/review-ratings.json (SSOT)
    └─ scripts/build/review-*.cjs (번들)
       output: dist/posts/*.html 내 리뷰 섹션 갱신/주입
       (상세는 review-pipeline-map.md 참조)

G) Validate / QA
  8) dist/posts/*.html
    └─ scripts/build/validate-repair.cjs
    └─ scripts/build/qa-check.cjs   (✅ 리포트 파일 출력 포함)
       output: logs/* (리포트/요약/상세)

H) Upload (R2)
  9) dist/* + manifests/*
    └─ scripts/build/r2-upload.cjs
       contract: DRY_RUN 파서 단일화 준수

I) Publish (Blogger)
  10) dist/posts/*.html + dist/queue/today.expanded.json (Execution SSOT scope)
    └─ scripts/publish/blogger.cjs
       contract:
         - canPublish 게이트 강제 (DRY_RUN=false AND PUBLISH_MODE=enable)
         - 기본 스코프: today(expanded) 기반 publishableSlugs만
         - all(전체 발행)은 수동/위험 옵션으로만
       output: Blogger posts + logs/publish-*.log + seed-ledger upsert

────────────────────────────────────────────────────────────
5) SSOT Registry
────────────────────────────────────────────────────────────
Queue SSOT:
- dist/queue/today.json                 : 오늘 발행 계획(Plan SSOT)
- dist/queue/today.expanded.json        : 실행용 확장 큐(Execution SSOT)

Post SSOT:
- content/posts/{slug}.json             : 포스트 원본(JSON)

ID SSOT:
- manifests/page-ids.json (+ journal)   : pageId 연속성/기록

Review SSOT:
- content/reviews/review-ratings.json   : slug별 rating/insights 통합 SSOT

Image SSOT:
- manifests/images-manifest.json        : OG/hero 추출 SSOT
- manifests/images-body-manifest.json   : 본문 1장 주입 SSOT

Ledgers/Logs:
- logs/seed-ledger.jsonl                : seed/pageId/publish 장부(SSOT)
- logs/publish-blogger-YYYY-MM-DD.log   : 상세 로그
- logs/publish-summary-YYYY-MM-DD.log   : 요약 로그
- logs/qa-*.json (또는 qa-report-*.json) : qa-check 리포트(정책에 맞춰 1개로 고정 권장)

────────────────────────────────────────────────────────────
6) Debug Playbook (진단 루트)
────────────────────────────────────────────────────────────
Case-1) “대량 발행/429”
- Check: blogger.cjs scope(today.expanded publishable) + MAX_POSTS + POST_SLEEP_MS
- Map: I(Publish) ← Queue Execution SSOT

Case-2) “pageId 누락”
- Check: ids.cjs가 Execution SSOT 대상만 발급하는지
- Check: render가 신규 발급 금지 지키는지
- Map: D(IDs) ← B(Posts) ← Queue

Case-3) “DRY_RUN인데 실제 발행/업로드”
- Check: parseDryRun 규칙(false/0만 live)
- Check: blogger/r2-upload gate
- Map: H(Upload) + I(Publish)

Case-4) “리뷰 섹션 비어있음/CRIT”
- Check: review-pipeline-map.md의 SSOT(bySlug) 존재 + injector 실행 여부
- Map: Review Bundle → Render/Inject

────────────────────────────────────────────────────────────
End of Map (SSOT)
────────────────────────────────────────────────────────────
