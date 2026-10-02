# platform.auth.session · 플랫폼 / 인증 / 세션·스코프

설계 단위: AU-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/auth/me` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/`
- 전 화면 공통: DashLayout 의 GNB·SNB 분기(역할·메뉴 그룹·operator·스코프). 현행 `getSession` 을 대체한다.

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모(AU-1)
- 응답 `data`: `user_id·email·display_name·role·operator·scope{all,brands,regions,countries,account_countries}·menu_groups·is_qa_reviewer`.
  `account_countries`(core 8라운드, fe-u2 요청 1) = 계정 원값 국가(저장 표기 그대로, 가상 지오 코드 포함, 권역 전개 없음, 전체 스코프·원값 없음은 null).
  `menu_groups` 는 빈 배열을 내지 않는다(null, fe-u2 요청 5). 스코프는 `core.auth.DataScope` 계산값(Q10 유효 국가, Q16 admin 전체, vendor 빈 브랜드 무제한). `null` = 제한 없음, `[]` = 거부(글로벌·웹사이트 읽기 403).
- `meta.mode = "session"`, surface·cycles·generation 없음. 공통 필터는 지원하지 않아 들어오면 `meta.ignored_filters` 에 축 이름으로 적는다(`core.envelope.crud_meta` = `core.filters.ignored_axes`).
- 자체 SQL 없음: 사용자 = `core.auth.get_principal`(app.user_account PK 단건), 참조 = `core.codes.load_refs`. 응답 헤더 `Cache-Control: private, no-store`.
- 오류: 토큰 없음·형식 오류·서명·aud 불일치 401 `unauthenticated`, 만료 401 `token_expired`, 계정 없음·정지 401 `no_account`, JWKS 엔드포인트 장애 503 `auth_unavailable`(core.auth, 500 아님). OpenAPI 는 core `ERROR_RESPONSES[401]`·`[503]`. 401·403 오류 응답은 core 오류 처리기가 `Cache-Control: no-store` 를 붙인다.
- 역할·운영자·메뉴 그룹 타입은 `core.auth` 의 `Role`·`Operator`·`MenuGroup` 을 그대로 쓴다(재정의 금지, 값 집합 정본 = DB enum).

## auth 요청(R1~R3) 처분
- R2(ERROR_RESPONSES 503): 반영. 라우터 자체 503 선언을 `ERROR_RESPONSES[503]` 로 교체.
- R3(오류 응답 no-store): 반영(core). 테스트가 401 응답의 `Cache-Control: no-store` 를 단언한다.
- R1(경량 스코프 참조 로더): 보류 처분. `load_refs` 전체 조회가 로컬 EXPLAIN ANALYZE 0.9ms 이고 결과 캐시를 두지 않는 원칙(D8)상 지금 분리할 이유가 없다. 사이트 수가 커져 비용이 드러나면 다시 연다.
