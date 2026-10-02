# core·DB 요청: 검수 콘솔(qa)

작성 2026-09-28 · 요청자: qa 기능 빌더(feat/qa) · 기준: stg 0092400, DB-v2.4 · 갱신 2026-09-28(검증 결함 D1~D7 반영: R6~R9 추가, 재검증 N1·N2 반영: R4·R6 위험 명시, R7 격하)

qa 7개 기능은 Q17 결정대로 core.auth 의 검수 게이트(`require_qa_reviewer`·`QaConn`, qa_gate 풀) 하나로만 읽고 쓴다.
아래 요청이 반영될 때까지 막힌 부분은 값을 비우고 `meta.suppressed` 로 드러낸다(조용히 무시하지 않는다).

## R1. qa_gate 에 참조 표 SELECT 부여 (DB, 우선순위 높음)

- **무엇**: DB-v2.4 P16 의 qa_gate 권한에 다음을 더한다.
  ```sql
  GRANT SELECT ON app.brand, app.citation_category, app.citation_domain_override TO qa_gate;
  GRANT SELECT (prompt_id, project_id, scope_prompt_id, deleted_at, created_at, brand_code, brand_presence, list_type,
                depth1, depth2, depth3, depth4, funnel_stage, kind, prompt_type, category) ON app.prompt TO qa_gate;
  ```
- **왜**: P16 은 rd.job·rd.dim_*·rd.acr_*·rd.v_*·rd.answer·rd.answer_brand·rd.citation 과 app.qa_* 4표만 준다. 그런데 설계(모듈-검수-콘솔 §3·§4)가 요구하는
  - 브랜드 코드↔비트(Q11 정본 app.brand): 목록·상세·노트 행의 brand 좌표, brand[] 필터, 필터 옵션 brand
  - 상세 prompt.catalog(depth4·prompt_type·category 는 app.prompt 에만 있음)
  - 상세 인용 오버라이드 분류(app.citation_domain_override ⋈ app.citation_category)
  를 qa_gate 로는 읽을 수 없다. 모두 비민감 참조 데이터이고 app.prompt 는 열 권한으로 좁힌다.
- **현재 동작(막힘)**: `has_table_privilege` 로 권한을 확인해, 없으면 해당 값 null + `meta.suppressed` = `{"brand"|"prompt.catalog"|"citations.override_category": "qa_gate_grant_missing"}`,
  brand[] 필터는 `meta.ignored_filters` 에 넣는다. 부여되면 코드 변경 없이 바로 채워진다(테스트 `qa_gate_grants()` 문맥이 부여 후 동작을 검증).
- **막힌 기능**: qa.answers.list(brand 좌표·필터·옵션), qa.answers.detail(catalog·override·brand), qa.notes.notes(행 brand 좌표).
- 대안으로 rd.catalog_entry 권한은 필요 없다: 브랜드 좌표·필터는 rd.job.bgrp(카탈로그·사이트·프로젝트 브랜드 비트 묶음)로 푼다.

## R2. 검수 게이트용 접근 감사 경로 (core.write, 중간)

- **무엇**: `core.write.access_audit` 가 Principal(계정)만 받는다. 계정 없는 검수자(QaReviewer)의 원문 열람(`GET /v1/qa/answers/{job_id}`, kind data_access)과
  CSV 다운로드(`GET /v1/qa/notes/export`, kind download)를 기록할 경로가 없다. app.access_audit_log.actor_id 는 NOT NULL uuid, actor_role 은 app.user_role 이다.
- **제안 시그니처**: `access_audit_qa(reviewer: QaReviewer, kind: Literal["data_access","download"], action: str, *, target: str | None = None,
  detail: dict | None = None)` → actor_id = 검수 세션 id(app.qa_review_session.session_id), actor_role = 새 값 'qa_reviewer'(또는 'vendor' 재사용 결정),
  detail 에 reviewer_name. 같은 배치 라이터(api_rw) 사용.
- **막힌 기능**: qa.answers.detail·qa.notes.notes(export) 의 Q4 민감 조회 감사. 현재는 기록하지 않는다(기능 동작은 정상).

## R3. 검수 대상 범위 설정 키 이관 (core.config, 낮음)

- **무엇**: Q17 "검수 대상 범위는 서버 설정으로 고정" 을 기능 설정 `QaScopeSettings`(app/features/qa/answers/list/scope.py)로 두었다.
  환경 변수 `HGH_QA_SURFACES`(쉼표 목록 global|website|project, 기본 셋 다)·`HGH_QA_SINCE`(YYYY-MM-DD, round_date 하한, 기본 없음).
- **제안**: core.config.Settings 에 `qa_surfaces: tuple[int, ...]`·`qa_since: date | None` 로 옮기고 load_settings 에서 검증(잘못된 값이면 기동 실패).
  이관 뒤 기능은 `get_settings().qa_surfaces` 를 읽도록 한 줄 바꾼다.

## R4. 입장 시도 상한의 다중 인스턴스 공유 (core, 낮음)

- **무엇**: `POST /v1/qa/sessions` 의 비밀번호 시도 상한(클라이언트 IP 당 분당 10회 + 전역 분당 60회)은 프로세스 메모리 버킷이다(현행 lib/qa/rate-limit.ts 와 같은 범위).
  인스턴스가 N 개면 상한이 N 배가 된다. 공용 rate limit 구성요소가 core 에 생기면 교체한다. 막힌 기능 없음.
- **전역 상한의 입장 봉쇄 위험(재검증 N1, 남은 위험)**: 전역 60회/분 버킷은 모든 뷰어가 공유한다. 공격자가 IP 여섯 개(IPv4 6개 또는
  IPv6 /64 6개)로 IP 당 10회씩 채우면 그 1분 동안 정상 검수자의 **신규 입장도 429** 다(이미 받은 세션 쿠키는 영향 없음). 대입 속도는
  인스턴스당 60회/분으로 묶이지만 가용성을 공유 자원 하나에 건 셈이다. 기능 쪽 완화: IP 당 버킷 키를 IPv6 /64 접두로 정규화했다
  (예전에는 /64 하나에서 주소를 돌리면 IP 당 상한이 한 번도 걸리지 않고 전역만 소진됐다). 근본 해결은 core 몫: 공유 저장소 기반 상한,
  실패 누적 IP·접두 차단(fail2ban 류) 또는 CloudFront/WAF 속도 규칙, 필요하면 입장 CAPTCHA.

## R5. qa_note_cursor_idx 방향 (DB, 낮음)

- **무엇**: DDL `qa_note_cursor_idx ON app.qa_review_note (created_at DESC, note_id)` 는 note_id 가 ASC 라, 설계 정렬 `created_at DESC, note_id DESC`
  (core.pagination.keyset_predicate 는 전 열 같은 방향만 허용)에서 Incremental Sort 가 붙는다(EXPLAIN 확인). `(created_at DESC, note_id DESC)` 로 교정 제안.
  노트는 사람이 만든 소량 데이터라 성능 위험은 낮다. 막힌 기능 없음.

## R6. 신뢰 프록시 기준 클라이언트 IP (core.config·배포, 높음, 검증 D1)

- **무엇**: 검수 입장 시도 상한과 세션 ip_hash 가 X-Forwarded-For 의 **첫 원소**를 믿어, 뷰어가 XFF 를 돌리면 상한이 무력화됐다
  (CloudFront 오리진 정책 Managed-AllViewerExceptHostHeader 는 뷰어 XFF 를 그대로 넘기고 CloudFront·ALB 는 오른쪽에 덧붙인다).
- **기능 쪽 방어(반영)**: `HGH_QA_TRUSTED_PROXY_HOPS`(기본 0) 만큼 **오른쪽에서** 센 XFF 원소만 쓰고, 0 이거나 원소가 모자라면 소켓 주소.
  이름과 무관한 **전역 분당 60회** 상한을 더했고, 키 표가 넘쳐도 표를 통째로 비우지 않는다(창 지난 키 → 가장 오래 쉰 키 순으로 1개씩, 전역 버킷 유지).
- **요청**:
  1. core.config.Settings 에 `trusted_proxy_hops: int`(0~5) 를 두고 공용 `client_ip(request)` 를 core 로 옮긴다(다른 IP 기반 기능이 같은 규칙을 쓰게).
  2. 배포 환경 변수 `HGH_QA_TRUSTED_PROXY_HOPS=2`(CloudFront → ALB → 앱). 설정하지 않으면 전원이 ALB IP 한 버킷을 공유한다(대입은 막히지만 정상 입장도 분당 10회로 묶임).
  3. uvicorn 을 `--forwarded-allow-ips='*'` 로 띄우지 않는다(소켓 주소 폴백이 뷰어 XFF 로 바뀐다). 대안으로 CloudFront-Viewer-Address 헤더를
     오리진 요청 정책에 명시 포함하고 그 값을 쓰는 방식도 가능(정책 변경 필요, 기능은 홉 방식으로 구현).
  4. 공용 `client_ip` 를 core 로 옮길 때 버킷 키 정규화(IPv6 /64, IPv4 사상 주소는 IPv4, 기능 `rate_key_ip`)도 함께 옮긴다.
     CloudFront 는 IPv6 를 켜 두었다(infra/60-cloudfront.sh IsIPV6Enabled). 전역 상한 봉쇄 위험은 R4.

## R7. 검수 세션 폐기의 정식화: revoked_at 열 (DB, 낮음, 제안, 검증 D2·재검증 N2)

- **현재 동작(막힌 기능 없음)**: 로그아웃(`PATCH /v1/qa/sessions/{session_id}` 본문 `{"logout": true}`)은 한 트랜잭션에서 세션 행을 잠그고
  (FOR UPDATE) 락을 풀고, `app.qa_answer_review.session_id`·`app.qa_review_note.session_id` 를 NULL 로 끊은 뒤 세션 행을 지운다
  (문장 분리, G5·G6 준수). 두 열은 NULL 을 허용하고 qa_gate 는 두 표에 UPDATE 권한이 있어(DB-v2.4.sql GRANT … TO qa_gate) DDL 없이 된다.
  판정·노트를 남긴 세션도 로그아웃 즉시 복사해 둔 쿠키가 401 이다(재검증 N2 의 12시간 잔존 해소). 작성자는 reviewer_name 스냅샷으로 남고
  노트 수정·삭제 권한도 이름 기준이라 달라지지 않는다. 쓰기 경로의 세션 확인은 FOR KEY SHARE 로 로그아웃과 직렬화된다(겹치면 401, FK 500 없음).
- **잃는 것**: 판정·노트 행에서 '어느 탭(세션)이 썼는가' 연결이 로그아웃 시점에 사라진다(이름·시각은 남는다).
- **제안(정식화)**: 연결을 남기고 싶으면 `ALTER TABLE app.qa_review_session ADD COLUMN revoked_at timestamptz` 로 폐기를 표시하고
  `revoked_at IS NULL` 을 세션 확인 조건으로 삼는다(assert_session·get_qa_conn, R9). 반영되면 기능은 끊기·삭제 대신 revoked_at 설정으로 바꾼다.

## R8. taxonomy 에 로그아웃 엔드포인트 추가 (설계·core 테스트, 낮음, 검증 D2)

- **무엇**: Q17 이식 범위(현행 `DELETE /api/qa/session`, qa-header.tsx 나가기 버튼)의 로그아웃이 taxonomy 에 없다. 쿠키가 HttpOnly 라 프론트가 스스로 지울 수 없다.
- **현재 동작(우회)**: 전용 엔드포인트를 열면 `tests/core/test_app.py::test_openapi_keeps_feature_stubs`(연산 171·경로 136 고정)가 깨져,
  기존 `PATCH /v1/qa/sessions/{session_id}` 에 선택 본문 `{"logout": true}` 를 더해 로그아웃을 실었다(본문 없으면 종전대로 활동 갱신).
- **요청**: 모듈-검수-콘솔.md §3 와 taxonomy 에 `DELETE /v1/qa/sessions/{session_id}`(또는 `/current`)를 등재하고 core 테스트 수치를 172 로 올린다.
  반영되면 기능은 같은 service.logout 을 새 경로에 연결하고 PATCH 의 logout 분기는 폐기 예고 후 제거한다.

## R9. get_qa_conn 에서 세션 행 존재 확인 (core.auth, 중간, 검증 D3)

- **무엇**: core.auth.get_qa_conn 은 쿠키 서명·만료만 보고 세션 행을 보지 않아, 행을 지운(폐기) 세션도 읽기(원문 상세·CSV)가 계속됐다.
- **기능 쪽 방어(반영)**: qa 전 라우터가 `QaLiveConn`(app/features/qa/review/sessions/service.py: QaConn + `SELECT … FROM app.qa_review_session WHERE session_id = :sid
  FOR KEY SHARE` PK 등치 1회, 로그아웃과 직렬화)을 쓴다. 로그아웃만 QaConn(이미 폐기된 세션도 쿠키를 지울 수 있게).
- **요청**: 같은 확인을 get_qa_conn 안으로 옮겨(또는 `get_live_qa_conn` 을 core 에 두어) 새 QA 경로가 빠뜨리지 않게 한다. R7 반영 시 `revoked_at IS NULL` 조건 포함.
