# aoia-flow-map.md (SSOT, offline)
# AOIA Cell-Level Audit Log

> 목적: AOIA 1단계의 파일별 기능(세포급)과 파이프라인 연결을 “오프라인에서 바로 검증”할 수 있게 기록한다.  
> 원칙: 추정/의심/리스크/검토는 배제하고, 사실 기반(입력·출력·역할·계약·연결)만 기술한다.  
> 루트(SSOT): `System_files/`

---

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
  표시용 단일 진실(Single Truth)

[전수조사 결론]
- 설계 의도 명확
- AOIA SSOT 구조의 기준점 파일


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
- “의도적으로 미니멀”한 유틸


---

## Part 2 — Page ID Ledger (slug→pageId SSOT)

────────────────────────────────────────
FILE: System_files/scripts/build/lib/page-ids.cjs
────────────────────────────────────────

[라벨/역할]
- “slug → pageId” 매핑을 SSOT로 유지하는 Ledger 관리자.
- pageId는 게시물 식별(페이지 배지/정합성/OG 이미지 파일명/manifest/발행 로그)에서
  연쇄적으로 참조되는 불변 키이므로,
  여기서의 정책이 AOIA 전체 무결성을 좌우함.

[SSOT 저장소 (READ/WRITE)]
(1) Active ledger (실번호)
- manifests/page-ids.json

(2) Local ledger (테스트/드라이런)
- manifests/page-ids.local.json

(3) Journal (WAL, append-only)
- manifests/pageid-journal.jsonl

[가드 정책 — 핵심 불변 조건]
■ “active 실번호 소모 허용 조건”
- BODY_WRITE_MODE === "active"
- AND PUBLISH_MODE === "enable"
- AND DRY_RUN !== true

→ 조건 미충족 시 신규 발급(next 증가) 금지

[전수조사 결론]
- dual ledger + 강한 가드로 실번호 소모를 구조적으로 방지
- 멱등성(idempotency) 보장


---

## Part 3 — Issue Sequence SSOT (날짜×라벨 인덱스)

────────────────────────────────────────
FILE: System_files/manifests/issue-seq.json
────────────────────────────────────────

[생성일]
- 2026-02-05

[역할]
- 날짜×라벨 단위로 “발급 인덱스(001,002…)”를 영속 관리하는 번호 SSOT.
- 빌드 재실행/재배포에서도 “001 되감김” 사고를 방지한다.

[책임 범위]
- ✅ 번호 증가(인덱스)만 담당
- ❌ 콘텐츠 중복 판단/차단과 분리 (fingerprint/seed-ledger 책임)

[저장 구조]
{
  "version": 1,
  "updatedAt": null,
  "byDate": {}
}

[필드 의미]
- version: 스키마 버전
- updatedAt: 마지막 갱신 시각(ISO)
- byDate:
  - 키: "YYYY-MM-DD"
  - 값: 라벨별 발급 카운터 맵
    예) { "app-reviews": 12, "how-to-playbooks": 7, ... }

[연결]
- scripts/build/queue-to-posts.cjs
  - issue-seq.json을 읽고/증가/저장하며,
    slug 생성에 필요한 index를 안정적으로 제공한다.

[전수조사 결론]
- 번호 SSOT는 issue-seq 단일 책임으로 확정


---

## Part 4 — Slug/Prefix/Label Policy SSOT

────────────────────────────────────────
FILE: System_files/scripts/build/lib/slug-policy.cjs
────────────────────────────────────────

[생성일]
- 2026-02-08

[역할]
- slug/prefix/label 정규화 정책의 단일 진실(SSOT).
- build/publish/patch 스크립트들이 들고 있던 매핑을 단일 파일로 수렴해
  불일치/오타를 차단한다.

[제공(모듈 export)]
- ALLOWED_LABELS / ALLOWED_LABEL_SET
- LABEL_TO_PREFIX
- PREFIX_TO_LABEL_STRICT
- PREFIX_ALIASES
- assertAllowedLabel(label)
- getCanonicalPrefixByLabel(label)
- normalizePrefix(prefix)
- inferLabelFromSlugOrFilename(input)
- buildSlug({label,date,index,...})

[책임 범위]
- ✅ 라벨/접두어/슬러그 정규화(표준화)
- ❌ 번호 발급(= issue-seq)
- ❌ 콘텐츠 중복 차단(= fingerprint + seed-ledger)

[연결]
- scripts/build/queue-to-posts.cjs
  - label→prefix 정규화, buildSlug로 slug 생성/검증
- scripts/build/patch-missing-labels.cjs
  - prefix 기반 label 보정 시 정책 준수
- scripts/publish/blogger.cjs
  - 파일명/slug에서 prefix 정규화 및 labelCode 추론 시 정책 사용

[전수조사 결론]
- “접두어/라벨 불일치” 문제를 정책 SSOT로 구조적으로 봉쇄


---

## Part 5 — Fingerprint Utility (내용 중복 지문)

────────────────────────────────────────
FILE: System_files/scripts/build/lib/fingerprint.cjs
────────────────────────────────────────

[생성일]
- 2026-02-10

[역할]
- 내용 중복 판정의 핵심 지문 생성 유틸.
- normalizedTitle + angle + audience + intent 조합을 normalize 후 해시로 고정한다.

[입력]
- normalizedTitle
- angle
- audience
- intent

[처리]
- normalize(공백/대소문자/특수문자 정리 등)
- hash(SHA1)

[출력]
- fingerprint (string)

[책임 범위]
- ✅ 중복 판정의 유일 기준(내용 레벨)
- ❌ 사용 기록 저장(= seed-ledger)
- ❌ 재고 채움 계산(= seed-refill)
- ❌ 번호 증가(= issue-seq)

[전수조사 결론]
- 10만 페이지 규모에서도 실질적 충돌 위험이 낮은 방식으로 확정


---

## Part 6 — Seed Ledger (Append-Only SSOT + Index)

────────────────────────────────────────
FILE: System_files/scripts/build/lib/seed-ledger.cjs
────────────────────────────────────────

[역할]
- 시드 “사용 이력” SSOT (회계 장부).
- append-only(JSONL) + 인덱스(offset) 구조로 대용량에서도 최신 상태 접근을 빠르게 유지.

[SSOT 파일]
- System_files/logs/seed-ledger.jsonl (append-only)
- System_files/logs/seed-ledger.index.json (recordKey → byteOffset, alias)

[저장 핵심 항목(최소)]
- seedId
- label
- mode (trend | evergreen | firstgate)
- fingerprint
- usedAt(또는 createdAt/updatedAt 체계 내 기록)

[핵심 기능]
- 동일 fingerprint 재사용 차단(중복 방지의 근거 저장)
- seedId 사용 여부 추적(감사/통계/복구용)

[정리(분리 원칙)]
- 번호 SSOT: issue-seq.json
- 내용 지문: fingerprint.cjs
- 사용 이력 SSOT: seed-ledger.cjs


---

## Part 7 — Seedpool & Warehouse (아이디어 풀 + 재고 창고)

────────────────────────────────────────
PATH: System_files/seedpool/*.json
────────────────────────────────────────

[역할]
- 라벨별 “기획/개요” 후보 풀(연습장 성격).
- 오늘 소비 대상(큐)은 여기서 직접 뽑지 않고,
  warehouse(실재고) 또는 스케줄러 규칙을 통해 최종 조립된다.

[스키마(정규화 확정)]
- 기존: trendLimit / evergreenLimit
- 변경: limits 객체로 통일

예)
{
  "label": "<label>",
  "limits": { "trend": <n>, "evergreen": <n> },
  "trend": [ ... ],
  "evergreen": [ ... ]
}

[의미]
- limits: 라벨별 목표량/규모(전략별로 다를 수 있음)
- trend/evergreen: 기획 항목(개요) 배열


────────────────────────────────────────
PATH: System_files/seedpool/warehouse/trend/*-trend.json
PATH: System_files/seedpool/warehouse/evergreen/*-evergreen.json
PATH: System_files/seedpool/warehouse/first-gate/*-first-gate.json
────────────────────────────────────────

[역할]
- 실제 발행 후보를 담는 “재고 창고(warehouse)”.
- refill이 채우고, scheduler가 소비한다.

[스키마(정규화 확정)]
1) trend 창고
{
  "label": "<label>",
  "limits": { "trend": <n> },
  "trend": [ ... ]
}

2) evergreen 창고
{
  "label": "<label>",
  "limits": { "evergreen": <n> },
  "evergreen": [ ... ]
}

3) first-gate 창고
{
  "label": "<label>",
  "limits": { "firstGate": <n> },
  "firstGate": [ ... ]
}

[정리]
- seedpool 라벨 파일: 기획 후보(개요)
- warehouse 전략 파일: 실제 소비할 재고(실전)


---

## Part 8 — Seed Refill (재고 보충 전용)

────────────────────────────────────────
FILE: System_files/scripts/build/seed-refill.cjs
────────────────────────────────────────

[생성일]
- 2026-02-12

[역할]
- warehouse(trend/evergreen/first-gate) 대상 “채움 전용” 스크립트.
- 발급(번호)과 소비(큐 생성)에서 완전히 분리된 보충 레이어.

[대상]
- warehouse/trend
- warehouse/evergreen
- warehouse/first-gate

[계산 규칙]
- 최근 45일 사용량 × 2
- 최소 100
- 최대 1000

[중복 차단 조건]
- seed-ledger 기준 fingerprint 재사용 금지

[출력]
- warehouse 파일 갱신(재고 보충)

[전수조사 결론]
- refill은 “보충만”
- scheduler는 “소비만”
- issue-seq는 “번호만”
- fingerprint/seed-ledger는 “중복/사용이력만”


---

## Part 9 — Pipeline Map (Seed 관점 핵심 연결)

────────────────────────────────────────
[Seed Lifecycle — SSOT 분리 원칙 기반]
────────────────────────────────────────

LLM 생성(외부/내부 생성 단계)
   ↓
seed-refill.cjs  (보충: 계산 + 중복차단 + warehouse 저장)
   ↓
warehouse (trend / evergreen / first-gate)  (재고 SSOT)
   ↓
seed-scheduler.cjs (소비: 오늘 큐 구성)
   ↓
dist/queue/today.json
   ↓
queue-to-posts.cjs
   - slug-policy.cjs (prefix/label/slug 정책)
   - issue-seq.json (날짜×라벨 인덱스 증가)
   ↓
render-posts.cjs
   ↓
publish/blogger.cjs
   ↓
seed-ledger.cjs (사용 이력 기록, fingerprint 기반 재사용 차단 근거 축적)
