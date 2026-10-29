# hmg-geo-hub — Claude 작업 메모

## 다음 세션 최우선 작업

- [x] **P4 ACR 차종 전환율 분모 중복 확인** — 2026-10-28 완료. Gold 기준 영향 없음, 수정 없음. 결과는 `docs/handoff/p4-acr-model-denominator.html` 머리 배너.
- [ ] **ACR 후속** — `docs/handoff/acr-next-session.html` 2절 순서대로: P1 측정 단절(10-05 회차 경계, 지금 화면의 Δ·추이가 틀림; 처리 방식은 사용자 결정) → P2 업스트림 질문 → P3 새 카드(후보→선택 전환, 결선 맞대결) → P5 성능. 2026-10-29 작업분(분포 시트 분리 로딩·시트 선택 UI·분포 카드 개편)은 미커밋.

## 작업 규칙

- 커밋·푸시는 사용자가 명시적으로 요청할 때만. 브랜치 없이 `main` 에 직접, 푸시 전 `git fetch`.
- 커밋 작성자는 환경변수로 지정한다(git config 변경 금지): `GIT_AUTHOR_NAME=taeho-s2w GIT_AUTHOR_EMAIL=taeho_kr@s2w.inc`, COMMITTER 도 같게.
- 버그 수정은 재현 시험(수정 전 실패 확인) → 수정 → 전후 시험 비교 순서.
- 시험 환경 세부(Windows 주의점 포함)는 인계 문서 5절.
- 서비스 구조와 HUB DB ERD의 정본(SSOT)은 `docs/architecture/hmg-geo-hub-architecture.html` 하나다. 구조·스키마·DB 권한을 바꾸는 변경은 같은 커밋에서 이 문서를 고친다(ERD는 `docs/architecture/render_erd.py` 의 표 정의를 고친 뒤 실행). 별도 그림 문서나 외부(claude.ai) 링크로 두지 않는다.
