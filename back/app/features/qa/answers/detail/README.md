# qa.answers.detail · 검수 콘솔 / 검수 대상 / 검수 상세

설계 단위: QA-3 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/qa/answers/{job_id}` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/raw-data-qa/answers/[jobId]`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모
- 인증: 검수 게이트(Q17). 서버 검수 범위 밖·없는 job 은 404 job_not_found.
- prompt.catalog(app.prompt 16열)·citations.override_category(app.citation_domain_override ⋈ app.citation_category)·brand(app.brand)는
  qa_gate SELECT(DB-v2.6 P47)로 채운다. catalog 는 표준 루트 카탈로그 행이 없을 때만 null.
- 접근 감사(Q4): 성공 응답마다 core.write.access_audit_qa(kind data_access, action qa.answers.detail, target job_id).
  actor_id = 검수 세션 id, actor_role = 'vendor'(외부 검수자), detail.actor_kind = 'qa_reviewer'·reviewer_name. 404·401 은 기록하지 않는다.
- ACR 비율은 Ratio 정수 쌍(appearance/valid_turn1, choice/valid_acr). 연결은 rd.acr_cell_job 정확 연결(현행 4축 근사와 값이 다를 수 있음).
- BG-46: citations[].url_norm·url_base_norm = rd.citation(서빙 답변만 행이 있다) ⋈ rd.dim_url 을 ord 로 붙인다. 사실 표 3술어는 이 job 의
  surface·round_date·cyc_key(rd.job) 라 파티션 가지치기로 리프 1개만 읽는다(EXPLAIN 에서 확인하는 것은 리프 1개까지다. 그 리프 안의 접근 경로는
  플래너가 통계로 고른다: 픽스처에서는 Seq Scan 또는 url_key 인덱스 + Filter, PK 인덱스로 고정되지 않는다).
  rd.citation 행이 없는 인용(비서빙 = 비완료·드롭 job)은 1순위로 원문 url 이 rd.dim_url 에 있으면(url_hash = sha256(url UTF-8), 적재기 키
  규칙) 그 저장값을 싣고(검증 BG46-NONSERVED: 적재기 값 그대로), dim_url 에 없는 URL 만 원문 url 에 적재기와 같은 식
  (core.urls.normalize_url_for_match = pg_temp.cit_norm, normalize_url_base_for_match = pg_temp.cit_base_norm)을 적용해 채운다(검증 D-01:
  현행 미러 scope_citations(qa-review.ts:701)는 전 job 에 값이 있어 드롭 답변도 값이 보였다). URL 없음은 null. acr[].acr_cell_key = rd.acr_cell 식별자(셀 단위 노트 키·재조회용).
- run_id·region·prompt_run_id·acr[].prompt_run_id(core 8라운드, DB-v2.9 P63): answer 머리 3값 = rd.v_answer_body 끝 열(ing.answer 원값,
  region 은 웹사이트에서 country 와 다를 수 있다), ACR 셀 prompt_run_id = rd.v_acr_cell_run(ing.acr_prompt_run, 현행 ACR 노트 키
  `${promptRunId}:${entityId}` 연결용). 대응 행이 없으면 null. 회귀 tests/test_bg46.py.
