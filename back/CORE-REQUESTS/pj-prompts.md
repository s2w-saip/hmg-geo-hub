# core·DB 요청: pj-prompts (PJ-3 프로젝트 프롬프트)

기준: stg 0092400(검증 수정 라운드 반영: §4·§6 보강, §7·§8 신규). 6기능 23 엔드포인트는 전부 구현했고 아래 항목 때문에 막힌 기능은 없다(우회는 기능 안에 두고 여기 이관 요청을 적는다).
술어(사실 표 3술어·권한·스코프)는 기능 안에서 재구현하지 않았다: 영향 미리보기는 `core.cycles.build_window` + `Window.where`, 권한은 `core.auth.resolve_project`·`require_operator`, 쓰기는 `core.write`(RwConn·enqueue_scope·access_audit).

## 1. 의존성: python-multipart·openpyxl (막힌 기능 없음, io 가 기능 안 대체 구현 중)

- 무엇: `pyproject.toml` dependencies 에 `python-multipart`(FastAPI `UploadFile`·`Form`), 선택으로 `openpyxl`(xlsx 읽기·쓰기) 추가.
- 왜: 공유 venv 에 둘 다 없어 `projects.prompts.io` 가 표준 라이브러리로 대체했다. multipart 는 `email.parser`(`io/service.py read_upload`).
- xlsx 읽기는 공용화했다(검증 D3-R, 2026-09-28): `app.core.xlsx`(XlsxReader·XlsxBudget·XlsxError·Warnings) 스트리밍 파서를
  projects.prompts.io 와 admin.catalog.bulk 가 함께 쓰고, 기능에는 예산 값·행 모양 규칙만 남겼다(`io/xlsx.py budget`).
  openpyxl 을 들이더라도 읽기는 이 파서를 유지하길 권한다: openpyxl 은 공유 문자열 개수·총 문자·원소 수 예산을 걸 수 없고
  읽기 전용 모드도 공유 문자열 표를 통째로 메모리에 올린다. 쓰기(`write_workbook`)만 core 로 옮기는 것은 남은 제안이다.
  별도로 `projects.settings.tracked_urls/xlsx.py`(pj-core) 에 세 번째 파서가 남아 있다(ET.fromstring 전체 DOM, 이번 범위 밖).
- 제안: python-multipart 추가 후 io 는 `file: UploadFile` 로 바꾼다. xlsx 쓰기 유틸도 `app.core.xlsx` 로 옮겨 공용화.
- 막힌 기능: 없음(projects.prompts.io 동작·테스트 통과).

## 2. core.filters: 공통 필터를 받지 않는 엔드포인트의 무시 축 계산 헬퍼

- 무엇: `CommonFilters` 를 파라미터로 받지 않는(= surface 필수가 아닌) CRUD 목록에서, 쿼리에 들어온 공통 필터 축을 `meta.ignored_filters` 로 돌려주는 헬퍼.
- 왜: `CommonFilters` 는 `surface` 가 필수라 PJ-3 같은 프로젝트 소속 CRUD 목록에 그대로 붙이면 기존 화면 호출이 422 가 된다.
  "조용히 무시 금지" 를 지키려고 기능 안(`crud/common.py ignored_filters`)에서 `CommonFilters.model_fields` 로 키를 뽑아 계산 중이다.
- 제안 시그니처: `def ignored_axes(query_params: Mapping[str, Any], support: FilterSupport, surface: Surface, *, extra: Iterable[str] = ()) -> list[str]`
  (from·to → period, `cf.*` → custom). 다른 CRUD 기능(PJ-1·PJ-2·PJ-4·관리자)도 쓸 수 있다.
- 막힌 기능: 없음.

## 3. core.auth.ProjectAccess 에 scope_project_id

- 무엇: `resolve_project` 가 이미 읽는 `app.project` 행의 `scope_project_id` 를 `ProjectAccess` 에 싣기.
- 왜: outbox payload(워커가 Scope 프로젝트를 알아야 함)에 필요해 기능이 `app.project` 를 한 번 더 읽는다(`crud/common.py scope_project_of`).
- 막힌 기능: 없음.

## 4. 결정 필요: 비멤버 스코프 열람과 PJ-3 읽기 게이트

- 현상: `resolve_project(level="member")` 는 활성 멤버가 아니어도 프로젝트 브랜드×국가가 계정 스코프 안이면(vendor 제외) 보이게 한다(2026-07-02 결정 계승, 테스트 계정 HQ_HYUNDAI).
  PJ-3 단위 명세 auth 와 현행 page.tsx 는 프롬프트 탭 열람을 "활성 멤버 또는 admin" 으로 제한한다.
- 구현: core 를 따랐다(목록·후보·태그 목록·내보내기 = resolve_project member). 쓰기는 owner, 실행·재개는 require_operator('run').
- 요청: 프롬프트 탭 열람을 멤버 한정으로 좁힐지 결정. 좁힌다면 `ProjectLevel` 에 `"active_member"`(admin ∨ 활성 멤버) 추가를 제안(기능은 인자만 바꾼다).
- 독립 검증(a606685, D6 minor)도 같은 불일치를 확인했다: HQ_HYUNDAI(비멤버·스코프 안)가 멤버 없는 Hyundai/US 프로젝트의 GET /prompts·/prompts/export 를 200 으로 읽는다
  (모듈-프로젝트.md §7 "상세·export = 활성 멤버 또는 admin", §2 "비멤버 404"). 스코프 밖 누출은 아니다. 결정 전까지 명세 불일치로 추적한다.
  바꿀 곳(결정 후): `crud/common.py project_gate(…, "member")` 를 쓰는 목록·후보 목록·태그 목록·export 4곳의 인자.

## 5. 테스트 수집: 네임스페이스 중간 디렉터리와 기능 leaf 이름 충돌

- 현상: `app/features/projects/`·`projects/prompts/` 에 `__init__.py` 가 없어 pytest(prepend 모드)가 `io/tests/*` 를 `io.tests.*` 로 import 하려다
  표준 라이브러리 `io` 와 충돌했다(`ModuleNotFoundError: No module named 'io.tests'`). 같은 이유로 leaf 이름이 겹치는 기능
  (예: analytics.mentions.prompts·analytics.citations.prompts·intent.social.prompts 의 `prompts.tests`)은 한 세션에서 서로 부딪힐 수 있다.
- 우회: `projects/prompts/io/tests/` 는 패키지로 두지 않고(`__init__.py`·conftest 없음) 테스트 파일 이름을 `test_prompts_io.py` 로 유일하게 했다.
- 제안: `[tool.pytest.ini_options] addopts = "--import-mode=importlib"` 또는 중간 디렉터리 `__init__.py` 일괄 추가(스텁 생성기).

## 6. 교차 모듈 계약(ingest outbox 워커): aggregate='prompt' op·payload

core 변경이 아니라 적재 모듈(outbox 드레인) 요청이다. PJ-3 이 적재하는 행:

| op | 언제 | payload |
| --- | --- | --- |
| create | 실행(execute): draft ∪ (queued ∧ scope_prompt_id NULL ∧ 미완료 create 없음) | prompt_id, project_id, scope_project_id(없으면 null), scope_prompt_id(null), text, kind, brand_code, category, lang, regions |
| disable | 중지(pause) | prompt_id, project_id, scope_project_id, scope_prompt_id(발행 전이면 null) |
| enable | 재개(resume) | 위와 같음 |
| delete | 완전 삭제(공유 0 ∧ 발행 이력) | 위 + was_paused(bool: false 면 Scope 중단을 먼저) |

- 워커 규약 요청: ① outbox_id 순서 처리(같은 프롬프트의 create 뒤 disable·delete) ② scope_prompt_id 가 null 인 disable·enable·delete 는 같은 prompt 의 create 완료 뒤 app.prompt 에서 다시 읽어 처리
  ③ scope_project_id 가 null 이면 프로젝트 링크(project:create) 완료까지 prompt:create 지연(모듈-프로젝트.md 열린 질문 1 "워커 계약").
- 로컬 상태: execute 는 draft→queued, pause 는 paused, resume 은 done(미발행 행은 queued), hard-delete 는 deleted_at(soft). 감사·judgment_change 는 app.prompt 트리거.
- superseded 행(검증 D1 수정): 토글(disable·enable) 적재 전 같은 프롬프트의 미완료 토글을 `done_at = now(), last_error = 'superseded'` 로 닫는다.
  워커는 done_at 이 있는 행을 집지 않으므로 추가 처리가 필요 없다. 다만 ④ 워커가 행을 잠그고(FOR UPDATE SKIP LOCKED 등) 처리한다면
  처리 완료 표시는 `WHERE outbox_id = ? AND done_at IS NULL` 로 해서 superseded 를 덮어쓰지 않게 해 달라(덮어써도 뒤따르는 새 토글이
  최종 상태를 맞추므로 정합성은 유지된다. 이력 표시만 달라진다).

## 7. core.write.enqueue_scope: 순서가 의미 있는 op 의 병합 금지 옵션 (검증 D1, 기능 안 우회 중)

- 현상: `enqueue_scope` 는 같은 (aggregate, id, op) 미완료 행에 payload 를 병합하고 그 옛 outbox_id 를 돌려준다.
  토글 op 에 쓰면 pause→resume→pause 가 미완료 [(16,disable),(17,enable)] 로 남아, §6 ① outbox_id 순서 처리 시 Scope 최종 = enable
  (화면은 중지, 측정·과금 계속). 반대로 resume→pause→resume 은 Scope 최종 = disable(측정이 조용히 멈춤).
- 우회(기능 안): `execute/publisher.py OutboxPublisher` 가 disable·enable 적재 전 같은 프롬프트의 미완료 토글을 superseded 로 닫는다
  (§6 참고). 회귀 테스트: `lifecycle/tests/test_lifecycle.py test_toggle_*` 3건.
- 제안: `enqueue_scope(…, supersede: Iterable[str] = ())` 옵션(같은 aggregate·id 의 미완료 행 중 op ∈ supersede 를 superseded 로 닫고
  항상 INSERT). schedule(일시정지·재개) 등 다른 토글 적재자도 같은 함정이 있다. 옵션이 생기면 기능은 publisher 의 UPDATE 를 지우고 인자만 넘긴다.
- 막힌 기능: 없음.

## 8. core.errors: DB 입력 값 오류(SQLSTATE 22xxx)를 500 대신 422 로 (검증 D2, 기능 안 방어 중)

- 현상: 본문에 NUL(\u0000)이 들어간 POST·PATCH 가 asyncpg `invalid byte sequence for encoding "UTF8": 0x00`(22021) 미처리 예외 →
  `errors._internal` 500. 키셋 조회는 `pagination.fetch_keyset` 이 22xxx 를 cursor_invalid 로 바꾸지만(원인과 다른 코드: q=%00 이
  "커서 값이 정렬 열과 맞지 않음" 으로 보고됨) 그 밖의 쓰기·읽기 경로에는 최후 방어가 없다.
- 우회(기능 안): 입력 단계에서 제어 문자를 422 로 거부(`crud/schemas.py check_body·check_line·Q_PATTERN`, io 가져오기 경고 후 건너뜀).
- 제안: 전역 예외 처리기에서 `DBAPIError` 의 원인이 DataError(22xxx)면 422 `invalid_value` 로 매핑(메시지에 값 원문을 싣지 않는다).
  pagination 의 cursor_invalid 변환은 커서가 실제로 있을 때만 적용하는 편이 원인 보고가 정확하다.
- 추가(검증 D2-R, 2026-09-28): JSON 의 짝 없는 서로게이트(`"\ud800"`)는 FastAPI 가 파이썬 str 로 받아들이고, asyncpg 가 인자를
  UTF-8 로 인코딩하는 단계(서버 왕복 전)에서 `asyncpg.exceptions.DataError('invalid input for query argument $1 …')` 를 낸다
  (실측: 클래스 기본 sqlstate '22000', `__cause__` = UnicodeEncodeError, SQLAlchemy 는 DBAPIError 로 감싼다). 서버가 보낸 오류
  필드만 보는 매핑이면 빠지므로, 매핑 조건을 'orig.sqlstate 가 22xxx 이거나 원인이 UnicodeEncodeError' 로 두길 권한다.
  기능 안 우회: `crud/schemas.py` CTRL_IN_BODY·CTRL_IN_LINE 에 U+D800~DFFF 를 넣어 check_body·check_line·PromptPatch._regions 가 422.
- 막힌 기능: 없음.
