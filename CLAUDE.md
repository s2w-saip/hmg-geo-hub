# hmg-geo-hub — Claude 작업 메모

## 다음 세션 최우선 작업

- [ ] **P4 ACR 차종 전환율 분모 중복 확인** — 다른 일보다 먼저 `docs/handoff/p4-acr-model-denominator.html` 을 끝까지 읽고 그 절차(단계 0 → 4)대로 진행한다.
  - 인계 문서의 "stg"는 이전 재설계 저장소(첫 커밋 `b18d7e1` 스냅샷) 문서가 가리키는 AWS 환경이다. 이 저장소에서는 그 환경에 접근하거나 존재를 확인한 기록이 없다. 그러니 진행하기 전에 어떤 데이터로 확인할지 사용자에게 묻는다.
  - 참고: 인계 문서의 쿼리는 이전 재설계의 `rd.*` 스키마를 기준으로 한다. 지금 서비스의 ACR은 Gold(`acr_entity_fact`, `dim_entity.rep_name`)를 읽는다(`back/bff/gold_reader/acr.py`). Gold는 이 Mac에서 읽기 전용으로 접속할 수 있다.
  - 쿼리는 읽기 전용만. 수정은 단계 3 결과를 사용자에게 보고하고 승인받은 뒤에만 한다.
  - 끝나면 이 체크박스를 완료로 바꾸고, 인계 문서 상태(머리 배너)를 갱신한다.

## 작업 규칙

- 커밋·푸시는 사용자가 명시적으로 요청할 때만. 브랜치 없이 `main` 에 직접, 푸시 전 `git fetch`.
- 커밋 작성자는 환경변수로 지정한다(git config 변경 금지): `GIT_AUTHOR_NAME=taeho-s2w GIT_AUTHOR_EMAIL=taeho_kr@s2w.inc`, COMMITTER 도 같게.
- 버그 수정은 재현 시험(수정 전 실패 확인) → 수정 → 전후 시험 비교 순서.
- 시험 환경 세부(Windows 주의점 포함)는 인계 문서 5절.
- 서비스 구조와 HUB DB ERD의 정본(SSOT)은 `docs/architecture/hmg-geo-hub-architecture.html` 하나다. 구조·스키마·DB 권한을 바꾸는 변경은 같은 커밋에서 이 문서를 고친다(ERD는 `docs/architecture/render_erd.py` 의 표 정의를 고친 뒤 실행). 별도 그림 문서나 외부(claude.ai) 링크로 두지 않는다.
