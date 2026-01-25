# AOIA Cell-Level Audit Log
## Part 1 — Runtime Environment & Core Utilities

────────────────────────────────────────
FILE: System_files/scripts/build/lib/env.cjs
────────────────────────────────────────

[역할]
- AOIA 전체 빌드/렌더/검증/발행 파이프라인에서
  단일 환경 로더(Single Env Loader) 역할을 수행.
- 모든 .cjs 스크립트는 env.cjs를 통해서만
  환경 변수를 해석하도록 설계됨.

[경로 기준]
- __dirname = System_files/scripts/build/lib
- ROOT = 상위 3단계 → System_files
- 이 ROOT 기준은 AOIA 전역 SSOT 경로 기준점 역할.

[env 로딩 우선순위]
1) System_files/.env
2) repo root/.env
3) dotenv 기본 동작

→ 의미:
- 로컬/CI/GitHub Actions/Worker 간
  환경 변수 충돌을 최소화하기 위한 설계.
- System_files 기준을 최우선으로 고정함으로써
  “어디서 실행하든 동일한 해석”을 보장.

[DRY_RUN 파서 — parseDryRun()]
- 규칙:
  - 'false', '0' 만 live
  - 그 외 모든 값은 dry-run
- 문자열 기반 파싱으로,
  GitHub Secrets / Actions / 로컬 환경 불일치 방지 목적.

[PATHS 객체]
- POSTS_DIR: content/posts (기본)
- TEMPLATE_PATH: templates/post.html
- OUTPUT_DIR: dist/posts
→ 모든 렌더·검증 스크립트가 이 PATHS를 신뢰.

[SITE / CDN 정규화]
- SITE_BASE:
  - SITE_BASE → CANONICAL_BASE → fallback 순
  - trailing slash 제거
- CDN_BASE:
  - SITE_BASE/images 기본값
  - trailing slash 제거

→ canonical / og:url / 이미지 경로의
  “슬래시 중복·불일치” 문제를 원천 차단.

[ENV 객체]
- SITE_NAME / ARTICLE_AUTHOR / PUBLISHER_NAME
- 메타·스키마·피드 전반에서 참조되는
  **표시용 단일 진실(Single Truth)**

[전수조사 결론]
- 설계 의도 명확
- AOIA SSOT 구조의 기준점 파일
- 수정 필요 없음
- DRY_RUN 규칙은 이후 page-ids.cjs와
  완전히 통일되지 않았다는 점만 “의심군”으로 기록

────────────────────────────────────────
FILE: System_files/scripts/build/lib/escape.js
────────────────────────────────────────

[역할]
- 렌더 파이프라인에서 사용되는
  최소 HTML/JSON 안전 유틸 묶음.

[esc()]
- &, <, >, " 문자만 escape
- 의도:
  - 과도한 sanitize로 마크다운/HTML 구조를
    깨지 않기 위한 최소 방어선.

[toJsonLd()]
- JSON.stringify wrapper
- try/catch로 감싸져 있으며,
  실패 시 "{}" 반환.
- 렌더 중 JSON-LD 직렬화 실패로
  전체 빌드가 중단되는 것을 방지.

[clean()]
- 백틱(`) 및 내부 특수 마커() 제거
- 과거 AI 출력 잔여물 제거 목적
- trim()으로 전후 공백 제거

[전수조사 결론]
- 단순하지만 AOIA 렌더 안정성에 핵심
- 과도한 기능 없음
- “의도적으로 미니멀”한 유틸
- 수정 불필요

## Part 2 — Page ID Ledger (slug→pageId SSOT)

────────────────────────────────────────
FILE: System_files/scripts/build/lib/page-ids.cjs
────────────────────────────────────────

[라벨/역할]
- “slug → pageId” 매핑을 SSOT로 유지하는 Ledger 관리자.
- pageId는 게시물 식별(페이지 배지/정합성/OG 이미지 파일명/manifest/발행 로그)에서
  **연쇄적으로 참조되는 불변 키**이므로,
  여기서의 정책이 AOIA 전체 무결성을 좌우함.

[핵심 목표]
1) slug당 pageId는 **멱등(idempotent)** 이어야 한다.
2) “실발행 번호(active)”는 절대 잘못 소모되면 안 된다.
3) 로컬 테스트/드라이런은 “local ledger”를 사용해 실번호를 보호한다.
4) ledger는 append-only journal을 병행해 “감사/복구” 근거를 남긴다.

────────────────────────────────────────
[SSOT 저장소 (READ/WRITE)]
────────────────────────────────────────

(1) Active ledger (실번호)
- manifests/page-ids.json
- 목적: 실제 발행에 사용되는 pageId 번호를 계속 증가시키며 보관.

(2) Local ledger (테스트/드라이런)
- manifests/page-ids.local.json
- 목적: 로컬 실험/CI/DRY_RUN에서 pageId를 할당해도
        active 번호가 절대 소모되지 않게 격리.

(3) Journal (WAL, append-only)
- manifests/pageid-journal.jsonl
- 목적: ledger 변경 이력을 1줄 1기록으로 남김.
- “비치명(non-fatal)” 정책: journal append 실패해도 ledger가 SSOT이므로 계속 진행 가능.

────────────────────────────────────────
[환경 변수 & 모드 개념]
────────────────────────────────────────

- BODY_WRITE_MODE: "local" | "active"
  - local  : page-ids.local.json 대상
  - active : page-ids.json 대상 (실번호)

- PUBLISH_MODE: "enable" | "disable"
  - enable  : 발행 허용 상태
  - disable : 발행 금지 상태

- DRY_RUN: true | false (문자열로 들어오는 경우가 많음)
  - true  : 절대 실번호 소모 금지
  - false : 실발행 가능 상태(단 PUBLISH_MODE=enable 필요)

────────────────────────────────────────
[가드 정책 — 핵심 불변 조건]
────────────────────────────────────────

■ “active 실번호 소모 허용 조건(둘 다 만족해야 함)”
- BODY_WRITE_MODE === "active"
- AND PUBLISH_MODE === "enable"
- AND DRY_RUN !== true

→ 위 조건을 하나라도 만족 못 하면:
  - pageId 신규 발급(=next 증가)을 **즉시 금지**
  - throw로 차단하며, 코드로 원인 분기

[throw 코드]
- code = "PAUSE_ACTIVE"
  - 의미: active 모드인데 publishMode가 enable이 아님 → 실번호 소모 위험
- code = "PAUSE_DRYRUN"
  - 의미: active 모드인데 DRY_RUN=true → 실번호 소모 위험

※ 설계 의도:
- “active ledger”는 실번호이므로,
  발행이 실제로 일어나는 순간에만 소모되어야 함.
- 실수로 active로 두고 로컬 테스트를 돌려도
  실번호가 늘어나 버리는 사고를 원천 차단.

────────────────────────────────────────
[데이터 구조(ledger 파일 형태)]
────────────────────────────────────────

ledger shape(개념):
{
  "mode": "active" | "local",
  "next": 1,
  "map": {
    "<slug>": "page000001",
    ...
  },
  "updatedAt": "<iso>"
}

- next: 다음 발급될 번호(정수)
- map: slug→pageId 매핑
- updatedAt: ledger 최종 갱신 시각

[중요 불변]
- “0 리셋 금지”
  - next가 비정상/손상되어도 0으로 내려가면 안 됨.
  - 복구 시 최소 1부터만 유지(실제로는 더 큰 값이어야 안전).

────────────────────────────────────────
[핵심 함수 흐름]
────────────────────────────────────────

1) loadLedger()
- 대상 파일(page-ids.json 또는 page-ids.local.json)을 로드.
- 파일이 없으면 최초 생성:
  - next=1
  - map={}
  - mode 기록
- JSON 파싱 실패나 손상 시:
  - 안전 복구 로직 존재(단, “0 리셋 금지” 정책 적용)

2) ensurePageId(slug)
- slug가 없으면 즉시 throw (정상 정책)
- map[slug]가 이미 존재하면 그대로 반환 (멱등)
- 없으면 신규 발급:
  - pageId = "page" + pad6(next)
  - next += 1
  - ledger 저장
  - journal append 시도(실패해도 비치명)

3) pad6(n)
- page000001 형태를 만들기 위한 6자리 제로 패딩

────────────────────────────────────────
[설계가 AOIA 파이프라인에 미치는 영향]
────────────────────────────────────────

- render-posts.cjs
  - page badge(id="pageId", data-page-id)에 pageId 주입
  - canonical 링크와 함께 pageId가 “글 고유키”로 노출됨

- images-build-body.cjs / images-build-og.cjs
  - 파일명 규칙에 pageId가 포함됨 (예: {pageId}_{slug}_...webp)
  - pageId가 바뀌면 이미지 매핑/manifest가 전부 깨짐

- manifests/images-manifest.json
  - og:image와 pageId 매핑 유지
  - pageId 불안정은 manifest 재생성 시 추적 불가

- seed ledger / publish guard
  - 발행 로그/중복 방지에서 pageId는 핵심 키로 사용 가능
  - pageId가 흔들리면 중복 감지/회계 추적 불가

────────────────────────────────────────
[전수조사로 기록된 리스크/의심군(중요)]
────────────────────────────────────────

(1) DRY_RUN 판정 규칙 불일치 가능성
- page-ids.cjs 쪽은 “String(v)==='true'” 같은 단순 판정일 가능성이 있었음.
- 반면 env.cjs는 parseDryRun()에서
  'false','0'만 live 처리하고 나머지는 dry 처리하는 정책.

→ 결과 위험:
- 어떤 실행 환경에서는 DRY_RUN='1' 또는 DRY_RUN='TRUE' 같은 값이 들어오면
  env.cjs 기준: dry
  page-ids.cjs 기준: dry로 인식 못 할 수 있음
  → active ledger 소모 사고 가능성(최악)

[대책 후보(기록)]
- page-ids.cjs가 DRY_RUN을 자체 해석하지 말고
  env.cjs parseDryRun() 결과를 단일 진실로 쓰는 방향이 안전.

(2) active 모드에서 throw가 상위 호출부 정책과 충돌 가능
- page-ids.cjs는 “실번호 소모 위험”이면 throw로 강하게 막음.
- 상위 파이프라인(예: ids 단계)이
  이 throw를 “치명 실패”로 처리하면,
  빌드 자체가 중단될 수 있음.

→ 의도상 “중단”이 맞지만,
  운영 모드에서 “스킵하고 local로 폴백” 같은 정책이 필요할 수도 있음.
  (현재는 정책 확정 전, 의심군으로만 기록)

(3) slug 미존재 시 즉시 throw
- 정상이며 SSOT 규칙에 맞음.
- 다만 “slug 생성 강제”가 파이프라인 상 확실히 보장되어야 함.
  (seed-scheduler/slug-builder/queue-to-posts 단계에서 slug 필수)

────────────────────────────────────────
[전수조사 결론]
────────────────────────────────────────

- 구조적으로 안전장치(dual ledger + throw gate)가 강력함.
- 실번호 소모 방지라는 목표에 매우 충실.
- 단, DRY_RUN 판정 로직은 env.cjs와 완전 통일이 필요할 가능성이 있어
  “크리티컬 의심군”으로 기록됨.
- 멱등성(idempotency)은 잘 보장됨:
  같은 slug는 항상 동일 pageId 반환.


## Part 3 — Seed Ledger (Append-Only SSOT + Index)

────────────────────────────────────────
FILE: System_files/scripts/build/lib/seed-ledger.cjs
────────────────────────────────────────

[라벨/역할]
- AOIA 파이프라인 전반에서 발생하는 “시드 상태 변화”를
  **단일 진실원(Source of Truth)** 으로 기록하는 Ledger.
- 단순 JSON overwrite가 아닌,
  **append-only(JSONL) + 인덱스(offset)** 구조를 채택.
- 대규모 기록에서도 조회·업데이트를 O(1)에 가깝게 유지하는 것이 목적.

이 파일은 “이력이 사라지지 않는 기억 장치”이며,
AOIA에서 말하는 **전두엽급 기억(불가역 로그)** 의 핵심 구현체이다.

────────────────────────────────────────
[SSOT 파일 구성]
────────────────────────────────────────

1) Ledger (append-only)
- 경로: System_files/logs/seed-ledger.jsonl
- 형식: JSON Lines (1줄 = 1 record)
- 정책: 절대 overwrite 금지, 항상 append

2) Index (경량 JSON)
- 경로: System_files/logs/seed-ledger.index.json
- 역할:
  - recordKey → byteOffset 매핑
  - slugKey → pidKey alias 관리
- 크기: 작게 유지 (메모리 로드 가능 수준)

3) Temp Index
- 경로: System_files/logs/seed-ledger.index.tmp.json
- 역할: index 저장 시 atomic-ish replace용 임시 파일

────────────────────────────────────────
[recordKey 규칙 — 불변 계약]
────────────────────────────────────────

recordKey는 **항상 하나의 문자열 키**로 기록되며,
형식은 아래 둘 중 하나만 허용된다.

- pid 기반(확정 키)
  - "pid:page000123"

- slug 기반(임시 키)
  - "slug:howto-20251207-001"

우선순위:
- pageId가 존재하면 pid 기반 recordKey 사용
- pageId가 없으면 slug 기반 recordKey 사용
- 둘 다 없으면 즉시 오류(정상 정책)

이 규칙 덕분에:
- 초기에는 slug로 기록 → 이후 pageId 확정 시 pid로 승격 가능
- 과거 기록은 삭제되지 않고 alias로 연결됨

────────────────────────────────────────
[Index 구조 (개념)]
────────────────────────────────────────

index.json shape:
{
  "version": 2,
  "updatedAt": "<iso>",
  "offsetByKey": {
    "pid:page000123": 1048576,
    "slug:abc": 102400
  },
  "alias": {
    "slug:abc": "pid:page000123"
  }
}

- offsetByKey:
  - recordKey → ledger 파일 내 바이트 시작 위치
- alias:
  - slugKey → pidKey 연결 정보
  - slug로 조회해도 최신 pid 레코드를 찾을 수 있게 함

────────────────────────────────────────
[핵심 동작 개념]
────────────────────────────────────────

■ append-only 전략
- 기존 레코드를 “수정”하지 않음
- 항상 병합된 최신 상태를 새 줄로 append
- 과거 기록은 감사/추적/복구 용도로 그대로 보존

■ index 기반 즉시 조회
- 최신 상태는 index를 통해 바로 offset 점프
- ledger 전체 스캔 없이 최신 레코드 접근 가능

■ alias 승격 모델
- slug → pid 승격 시:
  - slugKey는 pidKey의 alias로 연결
  - slug 조회 = pid 최신 상태 조회

────────────────────────────────────────
[주요 함수 설명]
────────────────────────────────────────

1) makeRecordKey({ pageId, slug })
- recordKey 생성기
- pageId 유효 → pid 기반
- 아니면 slug 기반
- 둘 다 없으면 throw

2) loadIndex()
- index.json 로드
- 파일이 없거나 파손 시:
  - rebuildIndex() 호출
- 항상 version=2 구조 보장

3) saveIndex(index)
- tmp 파일에 먼저 저장
- rename으로 index.json 교체
- 부분 기록/깨짐 방지 목적

4) appendRecord(obj)
- ledger.jsonl 끝에 1줄 append
- 반환값: 해당 레코드의 byte offset
- offset은 index 갱신에 사용됨

5) readLineAtOffset(file, offset)
- 주어진 offset부터 한 줄(JSON)만 읽기
- 대용량 파일에서도 전체 로드 없이 동작
- 안전장치:
  - 64KB 단위 chunk
  - 2MB 이상 비정상 라인 방어

6) getLatestByKey(recordKey, index)
- alias 처리 포함
- slugKey가 pidKey로 연결되어 있으면 pidKey 우선
- index → offset → readLineAtOffset

7) rebuildIndex()
- ledger.jsonl 전체를 순차 스캔
- 각 recordKey의 “마지막 offset”만 유지
- alias 정보도 함께 흡수
- 최후 수단이지만 SSOT 복구 가능

8) upsert(patch)
- 이 모듈의 핵심 API
- 동작 흐름:
  1) recordKey 결정
  2) index 로드
  3) 기존 최신 레코드(pid/slug 모두 고려) 조회
  4) base + patch 병합
  5) merged record를 append
  6) index.offsetByKey / alias 갱신
  7) index 저장

────────────────────────────────────────
[record 병합 규칙 (요약)]
────────────────────────────────────────

병합 결과에는 다음 정보가 포함된다:

- 식별
  - recordKey
  - slug
  - pageId

- 시드/출처
  - label
  - seedId
  - source

- 상태
  - status
  - stage
  - dryRun

- 발행 결과
  - postId
  - url

- 시간
  - createdAt (최초 기록 시각 유지)
  - updatedAt (항상 now)

- 기타
  - notes
  - alias (참고 정보)

이 구조 덕분에:
- 한 seed의 “생애 전체 상태 변화”가
  시간 순서대로 ledger에 축적된다.

────────────────────────────────────────
[AOIA 파이프라인 내 위치]
────────────────────────────────────────

- ids.cjs
  → pageId 확정 후 seed-ledger upsert

- seed-scheduler / queue-to-posts
  → stage/status 변경 시 upsert

- publish 단계
  → postId, url 기록

- 운영/회계/감사
  → ledger.jsonl + index.json으로
    언제든 전체 이력 재구성 가능

────────────────────────────────────────
[전수조사 결론]
────────────────────────────────────────

- seed-ledger.cjs는 AOIA에서
  “기억이 지워지지 않는 장부” 역할을 수행한다.
- append-only + index + alias 구조로
  확장성, 추적성, 복구성을 동시에 만족한다.
- slug → pid 승격 모델이 명확하며,
  과거 기록을 훼손하지 않는다.
- 본 파일은 AOIA 전두엽(장기 기억) 레이어의
  핵심 구성 요소로 확정 기록한다.


## Part 4 — Seedpool (주제·아이디어 SSOT 저장소 계층)

────────────────────────────────────────
개요
────────────────────────────────────────

Seedpool은 AOIA 파이프라인에서 **“아직 글이 아닌 모든 것”**을
사전에 구조화해 보관하는 **아이디어·주제·의도 SSOT 계층**이다.

- 아직 content/posts/*.json 으로 승격되지 않은 상태
- 그러나 “즉시 글이 될 수 있는 수준”까지 정규화된 데이터
- 사람이 떠올린 기획을 잃지 않기 위한 **전두엽 전 단계 기억 저장소**

Seedpool은 아래 3단계로 명확히 분리된다.

1) profiles        : 글의 구조/규칙(형식 SSOT)
2) origin           : 사이트 정체성·신뢰 관련 원천 시드
3) warehouse        : 실제 발행 후보 주제 창고(evergreen / first-gate / trend)

────────────────────────────────────────
[1] seedpool/profiles
────────────────────────────────────────

FILE: seedpool/profiles/label-profiles.json

[역할]
- 라벨별 글 “형식 계약서”
- AI가 글을 생성할 때 **넘지 말아야 할 구조·톤·금지선**을 정의
- 리뷰 계열의 경우, SSOT 리뷰 체인과 직접 연결됨

[구조 핵심]
- profiles는 “콘텐츠가 아니라 규칙”
- 글을 어떻게 써야 하는지에 대한 **메타 정의**

주요 필드 의미:

■ appliesTo
- 이 프로파일이 적용되는 labels 목록
- 예: app-reviews / device-reviews / subscription-services

■ structure.fixedHeadings
- 반드시 존재해야 하는 h2 섹션 목록
- 누락 시 QA 또는 생성 단계에서 실패/보정 대상

■ structure.optionalHeadingsPool
- 선택적으로 허용되는 섹션 풀
- optionalRules(min/max)로 개수 제약

■ contentRules
- tone: 글의 기본 어조
- comparisonBias: 비교 시 기준
- avoid: 절대 사용 금지 표현군

■ reviewSignals
- ratings / insights 활성 여부
- source: ssot:review-ratings.json
→ 리뷰 체인과의 **직접 결합 지점**

■ aiPromptDirectives
- headingPolicy: 헤딩 강제 여부
- contentFreedom: 헤딩 내부 자유도
- variation: 도입부/예시 다양화 규칙

[전수조사 결론]
- profiles는 **AI 통제 레이어**다.
- 글의 품질을 “결과 검증”이 아니라
  **생성 단계에서부터 강제**하기 위한 구조.
- AOIA에서 “AI가 멋대로 쓰지 못하게 하는 전두엽 억제장치”로 기록한다.

────────────────────────────────────────
[2] seedpool/origin
────────────────────────────────────────

FILE: seedpool/origin/origin-pool.json

[역할]
- 사이트의 “정체성·신뢰·선언문”에 해당하는 시드 모음
- 회전하지 않는(non-rotating) SSOT
- firstgate 전략의 최상위 근간

[meta]
- version / updatedAt
- note: 이 풀의 성격을 명시
  → “실제 발행 전제, 실험용 아님”

[item 단위 의미]

■ seedId
- origin 전용 고유 ID
- 일반 seed와 분리됨

■ title / slug
- 실제 발행 가능한 제목/슬러그

■ labelHint
- 어떤 라벨로 내려갈지에 대한 힌트
- 확정이 아닌 “방향성”

■ intent
- trust / about 등
- 검색 유입보다는 **신뢰 신호** 목적

■ tldrHints
- TL;DR 자동 생성 시 사용되는 힌트

■ trustClaims
- 사이트가 주장하는 검증 가능 사실
- 이후 authority.json / proofLinks로 연결

■ proofLinks
- 외부 또는 내부 증빙 URL
- 비어 있어도 무방(추후 추가 가능)

[전수조사 결론]
- origin-pool은 **AOIA의 헌법 초안**이다.
- 트래픽용 콘텐츠와 분리된,
  “왜 이 사이트를 믿어야 하는가”에 대한 기억 저장소.
- 삭제·회전 대상이 아니므로
  seedpool 중에서도 최상위 고정 레이어로 기록한다.

────────────────────────────────────────
[3] seedpool/warehouse — 개요
────────────────────────────────────────

warehouse는 **실제 발행 후보 주제 저장소**다.
모든 항목은 “이미 충분히 구체화된 상태”이며,
content/posts 로 승격만 남은 시드들이다.

구조는 3중 분기:

- evergreen   : 시효 없음, 장기 자산
- first-gate  : 초기 유입·검증용 핵심 관문
- trend       : 시의성 기반, 회전 가능

각 폴더는 동일한 라벨 세트를 공유한다.

────────────────────────────────────────
[4] warehouse/evergreen
────────────────────────────────────────

PATH:
seedpool/warehouse/evergreen/
- app-reviews-evergreen.json
- device-reviews-evergreen.json
- how-to-playbooks-evergreen.json
- smart-savings-evergreen.json
- subscription-services-evergreen.json
- templates-checklists-evergreen.json

[역할]
- “언제 써도 되는 글”
- 검색 수요가 안정적인 주제
- 사이트의 **장기 체력** 담당

[item 공통 필드 의미]

■ id
- evergreen 전용 ID
- eg: ar-eg-001 ~ 100

■ title
- 발행 시 제목 초안
- 검색 친화적이지만 과장 없음

■ angle
- 글의 핵심 접근 방식
- 동일 주제를 중복 생산하지 않기 위한 장치

■ audience
- 명확한 독자층 정의
- AI가 톤을 흔들지 않게 함

■ intent
- review/* / principles / methodology 등
- SEO intent와 1:1 매핑 가능

■ environment / timing / goal
- 실제 사용 맥락 정의
- 추상적 리뷰 방지용

[전수조사 결론]
- evergreen은 “지식 자산 창고”다.
- 양이 많아도 중복이 생기지 않도록
  angle/goal 필드가 세포 단위로 설계되어 있음.
- AOIA 장기 성장 레이어로 확정 기록.

────────────────────────────────────────
[5] warehouse/first-gate
────────────────────────────────────────

PATH:
seedpool/warehouse/first-gate/
- app-reviews-firstgate.json
- device-reviews-firstgate.json
- how-to-playbooks-firstgate.json
- smart-savings-firstgate.json
- subscription-services-firstgate.json
- templates-checklists-firstgate.json

[역할]
- “첫 방문자가 만나는 관문 콘텐츠”
- 깊지 않지만 **판별력은 높은 글**

[firstGateLimit]
- 라벨별 최대 개수 제한
- 품질 관리 목적

[item 특징]
- 문제 제기형 제목
- 빠른 판단 가능 구조
- 실제 비교/검증을 유도하는 질문 중심

[전수조사 결론]
- first-gate는 AOIA의 **면접관**이다.
- 독자와 사이트가 서로 맞는지 빠르게 판단.
- evergreen보다 먼저 쓰이되,
  수명은 더 짧을 수 있음.

────────────────────────────────────────
[6] warehouse/trend
────────────────────────────────────────

PATH:
seedpool/warehouse/trend/
- app-reviews-trend.json
- device-reviews-trend.json
- how-to-playbooks-trend.json
- smart-savings-trend.json
- subscription-services-trend.json
- templates-checklists-trend.json

[역할]
- 시의성·유행·업데이트 기반 콘텐츠
- 회전 가능, 폐기 가능

[trendLimit]
- 최대 보관 개수
- 초과 시 오래된 항목 정리 전제

[item 특징]
- “지금 이 시점” 질문
- 업데이트/출시/유행 키워드 반영
- evergreen과 명확히 구분되는 목적성

[전수조사 결론]
- trend는 AOIA의 **레이더**다.
- 장기 기억이 아닌,
  단기 상황 인식용 기억 저장소.
- SSOT이지만 “영구 보존 대상은 아님”으로 명확히 구분.

────────────────────────────────────────
[Part 4 종합 결론]
────────────────────────────────────────

- seedpool은 AOIA에서
  “글이 되기 전 모든 사고의 보관소”다.
- profiles → origin → warehouse 구조는
  규칙 → 정체성 → 실행 아이디어로 이어지는
  **사고 흐름 자체를 문서화**한다.
- 이 계층 덕분에,
  사람의 기억이 사라져도
  AOIA는 같은 사고 경로로 다시 글을 만들 수 있다.

다음 Part에서는
**templates / tools / workers 계열(운영·회복·외부 제어 레이어)** 로 이어
갈 수 있다.


## Part 5 — Templates · Tools · Workers  
(운영·회복·외부제어 레이어 — “행동하는 전두엽”)

────────────────────────────────────────
개요
────────────────────────────────────────

Part 5는 AOIA 시스템에서 **콘텐츠를 ‘만드는 영역’이 아니라,
이미 만들어진 사고·콘텐츠를 “유지·회복·통제”하는 레이어**다.

이 레이어의 공통 성격은 다음과 같다.

- 트래픽 목적 ❌
- 콘텐츠 생산 ❌
- 대신,
  - 무결성 유지
  - 인간 개입 최소화
  - 사고 복구 경로 확보
  - 외부 시스템과의 안전한 접점

즉, **AOIA의 실행 전두엽 + 자율신경계**에 해당한다.

────────────────────────────────────────
[1] templates/
────────────────────────────────────────

### 1-1. templates/post.html

[역할]
- AOIA 모든 포스트의 **최종 HTML 계약서**
- Blogger 테마 위에 “덧씌우는 구조”
- 렌더·주입·QA·광고·리뷰 체인이 전부 이 파일을 기준으로 작동

[핵심 원칙]
- html / body 절대 오염 금지
- .ongs-post 단일 래퍼로만 스타일 적용
- Blogger 테마를 “침범하지 않고 공존”

[구조적 계약 요소]

■ Page Badge
- id="pageId" / data-page-id 필수
- pageId ↔ canonical ↔ ledger 연결 고리
- 삭제·변경 불가 (파이프라인 계약)

■ Updated Badge
- updated 필드는 freshness/90days 체인과 연결
- 단순 UI가 아닌 **신뢰 신호**

■ Hero Image
- heroImage / heroAlt 필수
- LCP / OG / 이미지 매니페스트와 연결

■ TL;DR / KeyFacts
- 요약 정보의 1차 진입점
- AI 요약, 사용자 스캔 모두 고려

■ Review Blocks
- 템플릿은 “빈 뼈대”만 제공
- 실제 내용은 inject-reviews-from-ssot.cjs가 replaceSection으로 치환
- .review-block--empty → 기본 숨김
- 주입 시 클래스 제거로 자동 노출

■ FAQ / Sources
- **실물 섹션 뼈대는 템플릿이 책임**
- id="faq", id="sources" 절대 제거 금지
- 내용 없을 경우 :empty로 자동 숨김
- qa-check.cjs의 핵심 무결성 검사 대상

■ Ad Slots
- MID / BOTTOM 위치 고정
- 광고 삽입으로 레이아웃 붕괴 방지

[전수조사 결론]
- post.html은 “디자인 파일”이 아니다.
- AOIA 전체 파이프라인이 의존하는 **최상위 계약 문서**다.
- 변경은 항상 전체 영향 분석 후에만 허용.

────────────────────────────────────────
[2] tools/
────────────────────────────────────────

### 2-1. tools/fill-updated-from-queuedate.cjs

[역할]
- 수동 복구용 유틸리티
- content/posts/*.json 중 updated 누락 항목을 복구

[존재 이유]
- 정상 루트: updated는 render/validate 체인에서 자동 관리
- 예외 상황:
  - 초기 데이터 이관
  - 큐 손상
  - 테스트 데이터 병합
→ 이 경우를 위한 **수술용 도구**

[입력/출력]

READ:
- content/posts/*.json
- seedMeta.queueDate

WRITE:
- content/posts/*.json (updated, updatedFill)

[중요 제어 규칙]

■ BODY_WRITE_MODE
- local  : 로컬에서만 쓰기 허용
- active : PUBLISH_MODE=enable일 때만 쓰기 허용

■ DRY 보호
- 조건 불만족 시 로그만 출력
- 실데이터 오염 방지

[updatedFill 메타]
- source: 어떤 기준으로 채웠는지
- filledAt: 복구 시각
- mode / publishMode 기록

[전수조사 결론]
- 이 파일은 자동화가 아니라 **복구 책임 도구**
- 평소엔 쓰이지 않는 것이 정상
- 그러나 “사고 발생 시 기억을 되살리는 신경 재접합 장치”로 보존

────────────────────────────────────────
[3] workers/
────────────────────────────────────────

### 3-1. workers/rewrite-post.js

[역할]
- Cloudflare Worker 기반 **외부 제어 인터페이스**
- GitHub API를 통해 포스트 JSON을 직접 수정

[이 파일의 위치적 의미]
- AOIA 내부 스크립트 ❌
- 외부에서 AOIA를 “조심스럽게 건드리는 손”

[엔드포인트]

■ GET /
- 헬스 체크
- 배포 상태 확인용

■ POST /rewrite-post
- 실제 기능 엔드포인트

[보안 모델]

■ X-Rewrite-Secret
- 공유 시크릿 기반 인증
- 공개 API 아님

■ GitHub Token
- 최소 권한으로 content 수정

[요청 바디]

{
  slug: string,
  mode: "repair" | "rewrite",
  instructions?: string
}

[동작 흐름]

1) GitHub에서 대상 post JSON 조회
2) 기존 body 확보
3) mode에 따라 body 수정
   - 현재는 테스트용 주석 추가
   - 추후 OpenAI 호출로 교체 예정
4) updated 필드 갱신
5) GitHub에 커밋 업로드

[에러 처리]
- JSON 파싱 오류
- 인증 실패
- GitHub GET/PUT 실패
- 모두 구조화된 JSON 에러 응답

[전수조사 결론]
- rewrite-post worker는
  “사람이 AOIA 전두엽에 직접 신호를 보내는 통로”
- CI/CD나 수동 편집 없이도
  **원격 사고 개입**이 가능
- 향후 자동 수정·AI 재작성의 핵심 관문으로 확장 가능

────────────────────────────────────────
[Part 5 종합 결론]
────────────────────────────────────────

- Templates는 **형태와 무결성**
- Tools는 **회복과 응급 수술**
- Workers는 **외부에서의 안전한 개입**

이 3종은 모두 공통적으로
> “평소엔 보이지 않지만, 없으면 시스템이 붕괴되는 요소”

AOIA는
콘텐츠를 잘 만드는 시스템이 아니라,
**사고를 잃지 않는 시스템**이기 때문에
이 레이어가 반드시 필요하다.

다음 Part에서는
- render / build / validate 계열
- 실제 “사고 → 글 → 배포”를 수행하는  
**중앙 신경계 파이프라인**으로 이어갈 수 있다.


  ## Part 6 — Build · Render · Validate  
(사고 → 구조 → 결과물로 변환되는 **중앙 신경계**)

────────────────────────────────────────
개요
────────────────────────────────────────

Part 6는 AOIA의 **실제 사고 처리 영역**이다.  
앞선 Part 5가 “유지·회복·외부 개입”이라면,  
Part 6는 **사고가 실제로 ‘글’이 되는 과정 전체**를 담당한다.

이 구간의 특징은 명확하다.

- 모든 데이터는 SSOT에서 시작한다
- 중간 단계는 항상 가역적이다
- 결과물(dist)은 언제든 재생성 가능해야 한다
- 발행은 마지막 1초에만 허용된다

즉, **AOIA의 대뇌 피질 + 해석기**에 해당한다.

────────────────────────────────────────
[1] content/posts/*.json — 사고의 원본
────────────────────────────────────────

### 역할
- 모든 포스트의 **유일한 진실(SSOT)**
- render, review, image, feed, publish의 출발점

### 구조적 성격
- 사람이 읽기 쉬운 JSON
- 기계가 오해하지 않도록 엄격한 키 계약 유지

### 핵심 필드 계층

■ 식별 계층
- slug
- pageId  
→ ledger / feed / canonical / review 체인의 기준

■ 메타 계층
- title
- description
- labels  
→ 분류·파이프라인 분기 기준

■ 코어 블록 계층 (계약)
- tldr
- keyfacts
- faq
- sources  
→ templates/post.html의 고정 슬롯과 1:1 대응  
→ 제거·이름 변경 금지

■ 본문 계층
- bodyPrompt (생성 규칙)
- body (HTML)  
→ generate → normalize → markdown → sanitize 흐름을 통과

■ 리뷰 연계 계층 (라벨 기반)
- reviewTarget
- reviewData  
→ review-resolver / inject-reviews-from-ssot와 연결

■ 이미지 연계 계층
- pageId / slug 기반 파일명 규칙
- body/og 이미지 파이프라인의 입력값

■ 발행·신뢰 계층
- updated
- seedMeta.queueDate  
→ freshness / 90days / Updated 배지의 근거

[전수조사 결론]
- posts JSON은 “원고”가 아니라 **사고 세포**
- 사람이 직접 편집할 수 있지만,
  기계 계약을 어기면 즉시 파이프라인에서 배제된다

────────────────────────────────────────
[2] scripts/build/render-posts.cjs
────────────────────────────────────────

### 역할
- posts JSON → dist/posts/*.html 변환의 **중심 축**
- 템플릿(post.html)에 실제 내용을 결합

### 주요 책임

1) post.html 로드
2) {{title}}, {{description}}, {{canonical}} 치환
3) blocks.cjs를 통해:
   - TLDR
   - KeyFacts
   - Body
   - Review placeholder
   - FAQ / Sources
   HTML 블록 생성
4) 결과 HTML 저장

### 중요한 불변 규칙

- render 단계는 “추가 생성”을 하지 않는다
- FAQ / Sources / Review 섹션을 새로 만들지 않는다
- **템플릿에 있는 것만 채운다**

[전수조사 결론]
- render-posts.cjs는 “글을 쓰는 코드”가 아니다
- **사고를 배치하는 코드**다

────────────────────────────────────────
[3] scripts/build/lib/blocks.cjs
────────────────────────────────────────

### 역할
- posts JSON의 구조 데이터를
  **HTML 블록으로 해석·조립**

### 생성 대상

- TLDR 블록
- KeyFacts 리스트
- FAQ 리스트
- Sources 리스트
- Review Rating 블록
- Review Insights 블록
- Body sanitize

### 핵심 특징

■ 방어적 설계
- 데이터가 없으면 조용히 스킵
- 예외 throw 최소화
- 빈 데이터 → 빈 블록

■ 계약 중심
- blocks는 항상 “있을 수도, 없을 수도”를 전제로 동작
- 무조건 렌더하지 않는다

[전수조사 결론]
- blocks.cjs는 AOIA의 **언어 해석기**
- 데이터 → 표현 변환의 마지막 관문

────────────────────────────────────────
[4] normalize / validate 계열
────────────────────────────────────────

### 4-1. normalize-body.cjs
- 헤딩 구조 정렬
- 리스트/문단 정규화
- 불필요한 태그 제거

### 4-2. markdown-list.cjs
- Markdown 스타일 리스트를 HTML로 정규 변환
- 리스트 중첩 안정화

### 4-3. validate-body-images.cjs
- 본문 이미지 최소 조건 검사
- 누락 시 경고 또는 차단

### 4-4. validate-repair.cjs
- canonical / og / updated 동기화
- 누락 메타 자동 보정

[전수조사 결론]
- 이 단계들은 “글을 고치는 것”이 아니라
- **사고의 형태를 바로잡는 과정**

────────────────────────────────────────
[5] qa-check.cjs — 최종 판단기
────────────────────────────────────────

### 역할
- dist/posts/*.html을 대상으로 한 **최종 QA**

### 검사 항목

■ 구조 계약
- pageId 존재 여부
- faq / sources 섹션 존재 여부

■ SEO / AIO
- Article / Breadcrumb schema
- og:image / CDN 경로

■ 리뷰 무결성
- 리뷰 라벨 글에서 SSOT 누락 시 CRIT

### 판정 레벨
- PASS
- WARN
- FAIL
- CRIT (자동 발행 차단)

[전수조사 결론]
- qa-check는 단순 검사기가 아니다
- **“이 사고를 세상에 내보내도 되는가”를 판단하는 뇌간**

────────────────────────────────────────
[Part 6 종합 결론]
────────────────────────────────────────

- posts JSON = 사고 세포
- render = 배치
- blocks = 해석
- normalize/validate = 형태 교정
- qa-check = 생존 판정

AOIA는
글을 빠르게 찍어내는 시스템이 아니라,
**사고를 단계별로 검증하며 성장시키는 시스템**이다.

이 Part 6이 존재하기 때문에
앞단의 Seed / Review / Image,
뒷단의 Publish / Feed / Authority가
모두 안정적으로 연결될 수 있다.

다음 Part에서는  
**발행 · 피드 · AI 신뢰 신호**  
즉, AOIA가 외부 세계와 연결되는 마지막 레이어로 넘어갈 수 있다.
