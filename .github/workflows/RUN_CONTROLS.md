# Ongs Blog Pipeline — Run Controls (PUBLISH_MODE / BODY_WRITE_MODE / DRY_RUN)

이 문서는 GitHub Actions + 로컬 실행에서 “실번호 발급/외부 업로드/실발행”을 안전하게 통제하기 위한 3개 스위치의 역할을 정리합니다.

---

## 0) 요약 (한 줄 정의)

- **PUBLISH_MODE**: “active 실번호(+1) 발급을 허용/차단”하는 2차 안전장치 (특히 ids 단계)
- **BODY_WRITE_MODE**: “어떤 문서에 pageId를 발급할지(전체 vs today publishable)”를 결정
- **DRY_RUN**: “외부로 나가는 행동(R2 업로드, Blogger 발행, live 강제 검증)을 실제로 수행할지”를 결정

---

## 1) PUBLISH_MODE (enable | disable)

### 목적
- 실운영 상태에서만 **실번호(pageId) 발급(+1)**을 허용하고,
- 운영 불허 상태에서는 **active 발급을 0회로 ‘일시정지’**합니다.

### 적용 파일 (확인된 사용처)
- `System_files/scripts/build/ids.cjs`

### 핵심 동작 (ids.cjs)
- 조건:
  - `PUBLISH_MODE != enable` AND `BODY_WRITE_MODE == active`
- 결과:
  - **실번호 발급 루프(ensurePageId)를 타지 않고 즉시 종료**
  - 즉, “이번 실행에서 발급 0회” (번호 리셋이 아니라 발급 일시정지)

> NOTE:
> “리셋(0으로 회귀)”은 page-ids 저장 파일을 초기값으로 덮어쓰는 코드가 있어야 가능한데,
> 현재 ids.cjs의 가드는 return(조기 종료)로 보이며, 이는 일반적으로 “발급 중단” 의미입니다.

---

## 2) BODY_WRITE_MODE (local | active)

### 목적
- 로컬 검증(대량 산출)과 실운영(발행 대상 엄격 제한)을 분리합니다.

### 적용 파일 (확인된 사용처)
- `System_files/scripts/build/ids.cjs`

### 동작 정의
#### (1) local
- 대상 제한 없음: `content/posts/*.json` 전반을 대상으로 pageId가 없으면 발급 가능
- 테스트 산출물 확대에 유리

#### (2) active
- **발급 대상이 “dist/queue/today.json publishable slug”로 제한**
- today.json이 비어있으면 **발급 0회 즉시 종료** (번호 폭주 방지)
- 실발행 대상만 “정밀 발급”하는 구조

---

## 3) DRY_RUN (true | false)

### 목적
- 외부 시스템(R2, Blogger)로 실제 요청을 보낼지/말지를 제어하는 1차 안전장치입니다.
- 또한 일부 “live 강제 검증”의 기준으로도 사용됩니다.

### 적용 파일 (확인된 사용처)
- `System_files/scripts/publish/blogger.cjs`
- `System_files/scripts/build/r2-upload.cjs`
- `System_files/scripts/build/inject-sources-from-ssot.cjs`
- (참고) `System_files/scripts/build/ids.cjs` 에서는 DRY_RUN을 로깅 및 ledger 기록에 포함

### 동작 정의
#### (1) blogger.cjs
- `DRY_RUN=true`:
  - Blogger API 호출 없음 (토큰 발급도 스킵)
  - 로그만 남기고 “발행 안 함”
- `DRY_RUN=false`:
  - 실제 Blogger 발행 수행

#### (2) r2-upload.cjs
- `DRY_RUN=true`: 업로드 대신 로그만 출력
- `DRY_RUN=false`: 실제 R2 업로드 수행

#### (3) inject-sources-from-ssot.cjs
- 내부 규칙: `DRY_RUN=false`면 live 취급
- live일 때:
  - 리뷰 라벨(3종 등)에서 sources가 2개 미만이면 `process.exitCode=1`로 실패 처리 가능
- test(no_live)일 때:
  - 강제 실패 대신, HTML 정리/치환 수준으로만 수행

---

## 4) 권장 운용 조합 (안전 패턴)

### A) 로컬 전체 점검 (외부로 아무것도 안 나감)
- `BODY_WRITE_MODE=local`
- `PUBLISH_MODE=disable` (또는 enable이어도 DRY_RUN=true면 외부동작 없음)
- `DRY_RUN=true`

### B) 깃허브에서 “빌드만 하고 커밋” (외부 업로드/발행은 안 함)
- `DRY_RUN=true`
- 필요 시 `BODY_WRITE_MODE=local` (대량 산출) 또는 `active`(today만)
- `PUBLISH_MODE`는 보수적으로 `disable` 권장 (active 발급 억제)

### C) 실운영(실발행)
- `PUBLISH_MODE=enable`
- `BODY_WRITE_MODE=active` (today publishable만 발급)
- `DRY_RUN=false` (R2 업로드 + Blogger 발행 + live 검증 가능)

---

## 5) 주의사항

- `PUBLISH_MODE=disable`은 “리셋”이 아니라 “active 발급을 중단(0회)”시키는 용도로 사용해야 안전합니다.
- `DRY_RUN=true`는 외부 API 호출 자체를 막는 가장 강력한 스위치입니다.
- 실운영에서는 `BODY_WRITE_MODE=active` + today publishable 제한을 유지해야 번호 폭주를 막을 수 있습니다.
