# hmg-geo-hub — Claude 작업 메모

## 다음 세션 최우선 작업

- [x] **P4 ACR 차종 전환율 분모 중복 확인** — 2026-10-28 완료. Gold 기준 영향 없음, 수정 없음. 결과는 `docs/handoff/p4-acr-model-denominator.html` 머리 배너.
- [ ] **ACR 후속** — `docs/handoff/acr-next-session.html` 2절. 2026-10-29 두 번째 세션에서 P1(회차 간 비교 막기)·P3(후보→선택 전환, 결선 맞대결)·P5(리더 SQL 집계)를 끝내 푸시했다(첫 세션 `341a09e`, 두 번째 세션 `2dfb8ef`). 같은 날 사용자 최종 결정으로 회차 간 비교를 다시 열고 숨김 코드도 지웠다. 추이·Δ·기간 합산을 리뉴얼·기존 화면 모두 보인다. 측정 방식·범위가 매주 달라질 수 있어도 그건 화면 사용자가 감수할 일이다. 숨기거나 경고하지 않는다. P2 업스트림 질문은 사용자가 보낸다. 미결: cell·fact family의 metric_version 혼재(Mention·Citation 추이).
- [ ] **GA4 수집 시작** — 2026-10-29 리뉴얼 AI Conversion 화면과 GA4 수집기(`back/analytics/ga4_collect.py`)를 만들었다. 수집기는 GA4 Data API를 직접 읽어 HUB 데이터 DB `analytics.ga4_*`에 쌓고, 화면은 그 DB만 읽는다. GA4 계정 인계 뒤 VM에서 돌린다(사용자 결정: production·dev build가 HUB DB 하나를 같이 씀, production은 cron `vm.sh ga4-cron`, dev는 수동 `vm.sh ga4 …`). 순서와 남은 일은 `docs/handoff/p4-acr-model-denominator.html` 7-3절 13~18번.

## 작업 규칙

- 커밋·푸시는 사용자가 명시적으로 요청할 때만. 브랜치 없이 `main` 에 직접, 푸시 전 `git fetch`.
- 커밋 작성자는 환경변수로 지정한다(git config 변경 금지): `GIT_AUTHOR_NAME=taeho-s2w GIT_AUTHOR_EMAIL=taeho_kr@s2w.inc`, COMMITTER 도 같게.
- 버그 수정은 재현 시험(수정 전 실패 확인) → 수정 → 전후 시험 비교 순서.
- 시험 환경 세부(Windows 주의점 포함)는 인계 문서 5절.
- 서비스 구조와 HUB DB ERD의 정본(SSOT)은 `docs/architecture/hmg-geo-hub-architecture.html` 하나다. 구조·스키마·DB 권한을 바꾸는 변경은 같은 커밋에서 이 문서를 고친다(ERD는 `docs/architecture/render_erd.py` 의 표 정의를 고친 뒤 실행). 별도 그림 문서나 외부(claude.ai) 링크로 두지 않는다.
