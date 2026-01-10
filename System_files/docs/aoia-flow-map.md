# AOIA Flow Map (SSOT)
- Path: System_files/docs/aoia-flow-map.md
- Last Updated: 2026-01-10 (+0900)

본 문서는 AOIA 파이프라인의 최상위 지도(SSOT)입니다.
지도에 없는 구조/변경은 사전 합의 없이 제안/반영하지 않습니다.

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
- dist/queue/                 : 스케줄/발행 스코프 SSOT(today.json 등)
- dist/ai/                    : AI/크롤러 외부 노출 산출물(feed/authority)

────────────────────────────────────────────────────────────
3) AI Output Path Policy (중요: ai 폴더 2개 분리 선언)
────────────────────────────────────────────────────────────
여기서부터는 “혼선 방지”를 위해 강제 규칙으로 고정합니다.

[A) System_files/ai/  (소스/정의/로직 영역)]
- 목적: AI 관련 로직/정의/참조 데이터를 “만드는 곳”
- 원칙: 외부에 직접 노출되는 파일을 두지 않는다.
- 예: 내부 규칙, 생성 로직의 원천, 실험용 자료(노출 금지)

[B) dist/ai/  (산출물/노출/배포 영역)]
- 목적: AI/크롤러가 실제로 “읽는 결과물”을 두는 곳
- 원칙: 외부 노출 파일은 무조건 dist/ai 에만 생성한다.
- 예:
  - dist/ai/feed.ndjson
  - dist/ai/authority.json

[결론]
- authority.json은 “정의 문서”가 아니라 “AI가 읽는 최종 선언 산출물”이므로
  → 반드시 dist/ai/authority.json 이다.
- System_files/ai/authority.json 은 금지(혼선 유발).

────────────────────────────────────────────────────────────
4) Review Pipeline Map (리뷰 파이프라인 지도)
────────────────────────────────────────────────────────────
[SSOT]
- content/reviews/review-ratings.json

[갱신기]
- scripts/build/review-rating.cjs
  - app-ratings 스냅샷 → review-ratings(SSOT) bySlug 갱신
  - 기존 histogram/insights 보존 정책 유지

[리졸버]
- scripts/build/review-resolver.cjs
  - SSOT 읽기 전용
  - 렌더러가 필요한 형태로 normalize
  - insights 정책: 긍정/부정 분리 + 각각 최대 6개(총 최대 12개)
    - 한쪽만 12개로 채워지는 형태 금지(불합리 방지)
    - 부정이 부족하면: 긍정 6 + 부정 있는대로(최대 6)
    - 긍정이 부족하면: 부정 6 + 긍정 있는대로(최대 6)

[렌더]
- scripts/build/render-posts.cjs
  - review-resolver 결과를 blocks로 출력
  - 리뷰 라벨(app/device/subscription)만 리뷰 블록 출력

────────────────────────────────────────────────────────────
5) Publish Scope SSOT (발행 스코프 SSOT)
────────────────────────────────────────────────────────────
[SSOT]
- dist/queue/today.json
  - publishable 기준 스코프
  - 기본값: today.json에 포함된 slug만 발행 대상
  - 수동 위험 옵션(all)은 제한적/명시적 설정에서만 허용

[최종 발행]
- scripts/publish/blogger.cjs
  - 외부 API 호출 단일 책임
  - canPublish 게이트 준수(위 1절)
  - Seed Ledger publish 단계 업서트

────────────────────────────────────────────────────────────
6) Images Pipeline (OG + Body)
────────────────────────────────────────────────────────────
[SSOT]
- manifests/images-manifest.json

[생성]
- scripts/build/images-build-og.cjs (Sharp 기반 OG 생성)
- (body 이미지 정책은 중제목 출력 검증 이후 확정)

[업로드]
- scripts/build/r2-upload.cjs
  - DRY_RUN 파서 단일화 적용
  - dist/images/og, dist/images/body → R2 images/og/*, images/body/*

[치환]
- scripts/build/rewrite-images.js
  - 본문/메타 이미지 경로를 CDN_BASE 기준으로 치환

────────────────────────────────────────────────────────────
7) Ledger (Seed Ledger SSOT)
────────────────────────────────────────────────────────────
[SSOT]
- logs/seed-ledger.jsonl

[업서트 포인트]
- ids 단계: assigned 기록
- publish 단계: published(url/postId/status) 기록
- 동일 recordKey(pageId/slug) 기준 멱등 업데이트

────────────────────────────────────────────────────────────
8) QA / Validate (검증 단계)
────────────────────────────────────────────────────────────
- validate는 “교정/검증” 단계이며 신규 발급/외부 호출 금지 원칙 유지
- 필수 블록/슬롯 확인(TL;DR, Key Facts, FAQ, Sources, Updated 배지 등)
- og:image 200 OK 등 핵심 점검은 qa-check에 포함(필요 시)

────────────────────────────────────────────────────────────
9) Change Control (지도 변경 트리거)
────────────────────────────────────────────────────────────
다음 중 하나라도 해당하면 지도 갱신이 필요합니다.
- 경로/폴더 역할 변경
- SSOT 파일 위치/스키마 변경
- DRY_RUN / PUBLISH_MODE 게이트 변경
- 리뷰/피드/authority 산출 경로 변경

항상 먼저 질문:
“지도 맵도 함께 변경할까요?”
