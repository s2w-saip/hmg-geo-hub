# core·DB 요청: ad-content (admin.catalog.prompts·bulk·reference, admin.interest.keywords·sources, admin.entities.registry)

작성 2026-09-28 · 빌더 ad-content · 기준 stg 0092400. 각 항목은 무엇·왜·제안 시그니처·막힌 기능 순이다.

## R1. SQL 경계 가드가 SAVEPOINT 를 막는다 (core.sqlguard)

- **무엇**: `app.core.sqlguard.fact_guard` 가 SELECT·INSERT·UPDATE·DELETE·EXPLAIN 밖 문장을 전부 G5 위반으로 본다. SQLAlchemy
  `AsyncConnection.begin_nested()` 가 내는 `SAVEPOINT sa_savepoint_1` 도 막힌다(실측: `SqlGuardError G5 허용되지 않은 문장: TransactionStmt`).
- **왜**: 모듈-관리자 §2.1·taxonomy 요약이 bulk/regions·bulk/apply 를 "행마다 SAVEPOINT, 부분 성공"으로 정했다. 한 행의 DB 오류가
  나머지 199행을 되돌리지 않게 하려면 행 단위 SAVEPOINT 가 필요하다.
- **제안**: fact_guard 에서 `ast.TransactionStmt` 중 kind ∈ {TRANS_STMT_SAVEPOINT, TRANS_STMT_RELEASE, TRANS_STMT_ROLLBACK_TO} 만 허용
  (BEGIN·COMMIT·SET TRANSACTION 등은 계속 금지). fragment_guard 는 영향 없음.
- **막힌 기능**: admin.catalog.bulk 부분(partial). 지금은 DB 제약에 걸릴 값(brand_code FK·brand_presence CHECK·lang·regions 형식)을
  전부 사전 검증해 행 단위 실패로 돌려주고, 예기치 않은 DB 오류가 나면 요청 전체가 롤백된다. R1 이 풀리면
  `bulk/service.py` 의 행 루프를 `async with rw.begin_nested():` 로 감싸기만 하면 된다.

## R2. admin_long 롤에 rd.today_kst() 실행 권한이 없다 (DB)

- **무엇**: `has_function_privilege('admin_long', 'rd.today_kst()', 'execute')` = false(DB-v2.4, 로컬 dev-db 실측). api_ro 에만
  `GRANT EXECUTE ON FUNCTION rd.today_kst() TO api_ro`(DB-v2.4.sql:832)가 있다. 그래서 admin_long 커넥션에서
  `core.cycles.resolve_window(today=None)` 가 `permission denied for function today_kst` 로 실패한다(실측).
- **왜**: Q16·G-18 로 관리 조회(AD-2·AD-3)는 admin_long 이다. 창 해석까지 같은 커넥션(같은 스냅샷)에서 하는 것이 자연스럽다.
- **제안**: DB-v2.5 패치 `GRANT EXECUTE ON FUNCTION rd.today_kst() TO admin_long;`
- **막힌 기능**: 없음(우회). admin.entities.registry 는 창을 api_ro 에서 해석하고, 회차 1개를 넘는 집계만 admin_long 에서 돈다.
  두 트랜잭션의 스냅샷이 다를 수 있으나 커서 세대(generation) 검사로 페이지 간 불일치는 409 로 드러난다.

## R3. 표면 없는 admin 엔드포인트용 공통 필터 선언·입력 도우미 (core.filters 또는 core.admin)

- **무엇**: `CommonFilters` 는 surface 필수라 관리 화면(원천 편집 API)이 받을 수 없다. 그래도 "지원하지 않는 공통 필터는 meta 에 드러낸다"
  규칙을 지키려면 요청 쿼리에서 공통 축을 읽어 ignored 로 적어야 한다. 쓰기 전 FK 사전 검증(app.brand)·트림 규칙도 admin 기능마다 같다.
- **제안 시그니처**: `def ignored_axes(request: Request, supported: Iterable[str]) -> list[str]`(from·to → period, cf.* → custom, surface·project_id 포함),
  `async def brand_codes(conn) -> dict[str, bool]`, `def clean_text(v, *, field, max_len, required=False) -> str | None`.
- **막힌 기능**: 없음. 지금은 `app/features/admin/catalog/prompts/admin_common.py` 에 두고 ad-content 6기능이 import 한다.
  core 에 들어오면 이 파일을 지운다.

## R4. 의존성: xlsx 읽기·쓰기(openpyxl), multipart 업로드(python-multipart) (pyproject)

- **무엇**: 공유 venv 에 openpyxl·python-multipart 가 없다.
- **왜**: 카탈로그 export·import(현행 ExcelJS)와 파일 업로드(현행 FormData).
- **제안**: `dependencies` 에 `openpyxl>=3.1`, `python-multipart>=0.0.9` 추가(보안: openpyxl 은 defusedxml 과 함께).
- **막힌 기능**: 없음(우회). 쓰기는 `app/features/admin/catalog/bulk/xlsx.py build`(표준 라이브러리 최소 구현). 읽기는 검증 D2-R 로
  공용 스트리밍 파서 `app.core.xlsx` 로 옮겼다(projects.prompts.io 와 공용, 기능에는 `xlsx.BUDGET` 예산 값과 격자 모양만 남김).
  import/preview 는 multipart 대신 요청 본문 = xlsx 원본 바이트로 받는다. openpyxl 이 들어와도 읽기는 core 파서를 유지하길 권한다
  (openpyxl 은 공유 문자열·원소 수 예산을 걸 수 없다). 프론트가 FormData 를 유지하려면 preview 를 `UploadFile` 로 바꾼다.

## R5. DB 무결성 오류의 HTTP 매핑 (core.errors)

- **무엇**: 23503(FK)·23514(CHECK)·23505(UNIQUE) 가 기능 밖으로 새면 500 internal 이 된다.
- **왜**: 사전 검증을 빠뜨린 경로·경쟁 상태에서 4xx 가 맞다(현행 ActionResult 는 사용자 오류로 냈다).
- **제안**: `install_error_handlers` 에 `sqlalchemy.exc.IntegrityError` 처리기: sqlstate 23503·23514 → 422 `constraint_violation`
  (details = 제약명만), 23505 → 409 `conflict`.
- **막힌 기능**: 없음. 지금은 기능이 쓰기 전에 전부 검증한다.

## R6. pytest 모듈 이름 충돌 (pyproject 또는 기능 트리 __init__.py)

- **무엇**: 기능 디렉토리 이름이 겹친다(prompts 4곳·sources 2곳). `tests/__init__.py` 가 있으면 pytest 기본 prepend 모드에서
  `prompts.tests.test_x` 가 충돌할 수 있다(an-answers R4 와 같은 문제).
- **제안**: pyproject `addopts = "--import-mode=importlib"` 또는 중간 디렉토리 `__init__.py`.
- **이 기능의 조치**: 담당 6기능의 `tests/__init__.py` 를 지우고 파일명을 고유하게 했다(`test_ad_catalog_prompts.py` 등).

## R7. AD-2 엔티티 수치 게이트 확인과 known_diff 등록 (기술 리드·mig)

- **무엇**: 검증 D3(2026-09-28). `/v1/admin/entities` 의 brand_answers·brand_mentions 에 계약 §3 모수 게이트 `std_in AND dflt` 를 걸었다
  (`entities/registry/service.py` COUNT_GATES). 모듈-관리자 §2.3 SQL 초안과 현행 listDiscoveredBrands 에는 게이트가 없다.
- **왜**: 계약 §3 술어 규약(언급 계열 모수 = std_in, 기본 엔진 = dflt)이 단위 SQL 초안보다 우선한다고 판단했다. 로컬 합성 DB 실측
  global 09-14: 게이트 없음 Kia 2/3·Tata 1/1 → 게이트 Kia 1/2·Tata 0/0(answer_key 3, elig=false).
- **요청**: (1) 기술 리드가 이 판단을 확인한다. 게이트 없음으로 결정되면 COUNT_GATES 를 비우고 meta.source.gate 를 'none' 으로 바꾸면
  된다(회귀 테스트 test_counts_gate_std_in_and_dflt 기대값도 함께). (2) mig.known_diff 에 AD-2 수치 정의 변경(게이트 추가 + 표시 브랜드
  단위 + 기간 필수, 모듈-관리자 §4)을 등록한다.
- **막힌 기능**: 없음.
