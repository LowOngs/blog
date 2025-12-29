# tools/

이 폴더는 **자동 발행 파이프라인에 포함되지 않는 수동 도구(manual tools)** 전용입니다.

- 목적: 시스템 누락·오작동 발생 시 **사후 복구 / 보정 / 검증**
- 특징:
  - 스케줄러, GitHub Actions, 자동 빌드 단계에서 **절대 호출되지 않음**
  - 실행은 항상 사람이 직접 수행
  - BODY_WRITE_MODE / PUBLISH_MODE 규칙은 scripts/와 동일하게 유지
- 원칙:
  - 자동화 안정성을 해치지 않기 위해 scripts/와 물리적으로 분리
  - 필요 시에만 실행하며, 일상 발행 루프에는 영향 없음
 
- 사용법:
  - 파워쉘애서 아래 명령 수행.
  - BODY_WRITE_MODE=local node System_files/tools/fill-updated-from-queuedate.cjs
