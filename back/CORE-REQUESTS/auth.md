# core 요청: auth(platform.auth.session, AU-1)

막힌 기능 없음. 아래는 비차단 제안 3건이다(R1 경량 참조 로더, R2 ERROR_RESPONSES 503, R3 오류 응답 no-store).

## R1. 세션 조회용 경량 스코프 참조 로더(비차단, 우선순위 낮음)

- 무엇: `GET /v1/auth/me` 는 `DataScope.of(principal, refs)` 에 넣을 참조로 `core.codes.load_refs` 전체(브랜드·owned_base·엔진·국가·언어·권역·출처 카테고리·dim_project surface 1·2)를 읽는다. 스코프 계산에 실제로 쓰는 것은 `brands`(엄브렐러 판정)와 `rhq`(권역 → 국가)뿐이다.
- 왜: 로컬 합성 DB EXPLAIN ANALYZE 실행 0.9ms(dim_country 188·rhq_region_country 334·dim_project 3행)라 지금은 문제가 없다. 다만 이 엔드포인트는 프론트가 화면 진입마다 부르는 경로라, 웹사이트 사이트 수(dim_project surface 2)가 커지면 불필요한 스캔이 요청마다 붙는다.
- 제안 시그니처: `async def load_scope_refs(conn) -> Refs` (brands·rhq 만 채우고 나머지는 빈 값) 또는 `DataScope.of` 가 `Refs` 대신 `(umbrella_codes, rhq)` 최소 프로토콜을 받게 하기. 결과 캐시가 아니라 요청 안 한 문장 조회(D8 준수).
- 막힌 기능: 없음(현재 `load_refs` 로 정상 동작).

## R2. `errors.ERROR_RESPONSES` 에 503 키 추가(비차단, 검증 D3c)

- 무엇: `core.auth.JwtVerifier._key_for` 는 JWKS 엔드포인트 장애를 503 `auth_unavailable` 로 올린다(core/auth.py `errors.unavailable(..., code="auth_unavailable")`). 그런데 `ERROR_RESPONSES` 에는 401·403·404·422 만 있어 `ERROR_RESPONSES[503]` 이 KeyError 다.
- 왜: `CurrentUser` 를 받는 모든 /v1 라우터가 같은 503 을 낼 수 있는데 OpenAPI 에 문서화할 공통 항목이 없다. 기능마다 모양을 따로 만들면 설명 문구가 갈린다.
- 제안: `ERROR_RESPONSES[503] = {"model": ErrorBody, "description": "unavailable(auth_unavailable 포함)"}`. 가능하면 `CurrentUser` 의존 라우터에 401·503 을 공통으로 붙이는 헬퍼.
- 기능 쪽 방어(적용함): `router.py` 에서 같은 모양(`ErrorBody`)으로 503 을 직접 선언. core 반영 후 `ERROR_RESPONSES[503]` 으로 교체한다.
- 막힌 기능: 없음.

## R3. 인증 실패 응답에도 `Cache-Control: no-store`(비차단, 제안)

- 무엇: 401·503 은 core 의존성(`get_principal`)에서 나가 기능 라우터가 헤더를 붙일 수 없다. 현재 오류 응답에는 Cache-Control 이 없다.
- 왜: 세션 엔드포인트의 성공 응답은 `private, no-store` 인데 오류 응답은 중간 캐시 정책에 맡겨진다. 해가 되는 내용은 없지만 하드닝 차원에서 `install_error_handlers` 가 401·403 에 `no-store` 를 붙이면 일관된다.
- 기능 쪽 조치: 테스트가 헤더 부재를 강제하던 단언을 지웠다(검증 D3a). 추가돼도 테스트는 깨지지 않는다.
- 막힌 기능: 없음.
