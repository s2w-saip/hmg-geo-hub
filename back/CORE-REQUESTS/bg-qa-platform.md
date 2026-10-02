# core·DB 요청: 값 갭 보강 bg-qa-platform(BG-45·BG-46·D2·views.json)

작성 2026-09-28(검증 수정 라운드 갱신: R3 추가, D-01 해소) · 요청자: bg-qa-platform 빌더(feat/bg-qa-platform) · 기준: stg 8890406, DB-v2.7

프론트 어댑터 설계(front-adapter-plan.md 3.6 (가))의 값 갭 중 이 그룹 몫을 백엔드가 주게 했다. DDL 이 필요한 부분만 아래에 요청한다.
요청이 반영되기 전 API 는 해당 필드를 내지 않는다(추가형 필드로 붙일 예정, 기존 응답 필드·의미는 그대로).

## R1. 검수 상세 답변 머리의 run_id·region (DB 뷰 확장, 중간, BG-46)

- **무엇**: `rd.v_answer_body` 끝에 열 3개를 덧붙인다(CREATE OR REPLACE VIEW 는 끝에 열 추가만 허용하므로 기존 열 순서 유지).
  ```sql
  CREATE OR REPLACE VIEW rd.v_answer_body WITH (security_barrier) AS
    SELECT j.answer_key, j.job_id, j.surface, j.project_key, j.geo_key, j.bgrp, a.answer_text, a.model_slug, a.measured_at, a.analysis_status, a.status,
           a.run_id, a.region, a.prompt_run_id
      FROM rd.job j JOIN ing.answer_key_map m ON m.job_id = j.job_id JOIN ing.answer a ON a.run_month = m.run_month AND a.job_id = m.job_id;
  ALTER VIEW rd.v_answer_body OWNER TO loader_ro;
  GRANT SELECT ON rd.v_answer_body TO api_ro, admin_long, qa_gate;
  ```
- **왜**: 현행 검수 상세 메타(front granule-tables.tsx:451 runId, :454 region)가 쓰는 값이 `ing.answer.run_id`·`ing.answer.region` 에만 있다.
  qa_gate 는 ing 권한이 없고(DB-v2.7 P16), `rd.job` 에는 `run_key`(정수)만 있으며 `rd.job.load_id → ing.load.run_id` 는 재투영(rebuild) 적재가
  load_id 를 그 적재 id 로 다시 쓰고(ingest/project/apply/queries.py rd.job INSERT 의 $1) 그 적재의 kind 는 run 이 아닐 수 있어(judgment·rebuild 등, run_id NULL 가능) run 을 보장하지 않는다. region 은 웹사이트 표면에서 `country`(사이트 가상 지역·사이트 국가 우선)와 다르다
  (ingest/project/apply/queries.py FACT_SRC 의 geo_key CASE). 그래서 country 로 대체할 수 없다.
- **막힌 기능**: `GET /v1/qa/answers/{job_id}` 의 `answer.run_id`·`answer.region`(추가형 선택 필드로 붙일 예정).

## R2. ACR 셀의 Scope prompt_run_id (DB 뷰 신설, 중간, BG-46)

- **무엇**: ACR 셀 키 ↔ Scope prompt_run_id 대응 뷰.
  ```sql
  CREATE VIEW rd.v_acr_cell_run WITH (security_barrier) AS
    SELECT p.acr_cell_key, p.prompt_run_id, p.run_id FROM ing.acr_prompt_run p;
  ALTER VIEW rd.v_acr_cell_run OWNER TO loader_ro;
  GRANT SELECT ON rd.v_acr_cell_run TO api_ro, admin_long, qa_gate;
  ```
  (P16 의 qa_gate `rd.v_%` 일괄 부여는 그 시점 뷰에만 적용됐으므로 새 뷰는 명시 부여가 필요하다.)
- **왜**: 현행 ACR 노트 키는 `${promptRunId}:${entityId}`(front granule-tables.tsx:316·372-378)다. 이번 라운드에 셀 식별자
  `acr[].acr_cell_key`(rd.acr_cell)는 붙였지만, 기존에 쌓인 ACR 노트의 target_key 와 잇으려면 Scope prompt_run_id 가 필요하다.
  `ing.acr_prompt_run.acr_cell_key` 는 `rd.acr_cell.acr_cell_key` 의 발급처라(개발 DB 확인: 501 ↔ 501) 뷰 한 번 조인으로 풀린다.
- **막힌 기능**: `GET /v1/qa/answers/{job_id}` 의 `acr[].prompt_run_id`(추가형 선택 필드로 붙일 예정).

## R3. core.urls.normalize_url_for_match 의 trim 과 적재기 cit_norm 정합 (core 결정, 낮음, 검증 D-01 후속)

- **무엇**: `core.urls.normalize_url_for_match` 는 `str.strip()`(현행 JS `trim` 과 같은 유니코드 공백)으로 자르고, 적재기 정본
  `pg_temp.cit_norm`(seed-3x-common.sql §1, 미러 0052 citation_url_norm)은 `regexp_replace($1, '^\s+|\s+$', '')`(POSIX `\s`) 로 자른다.
  개발 DB 실측: 앞뒤에 NBSP(U+00A0)가 붙은 URL 에서 둘이 갈린다(`'\u00a0https://h.com/'` → 파이썬 `h.com`, SQL `'\u00a0https://h.com'`).
  ASCII 공백·대소문자·추적 파라미터·조각·끝 슬래시는 같다(back/app/features/qa/answers/detail/tests/test_bg46.py 골든 11건).
- **왜**: 검수 상세는 rd.citation 행이 없는 인용(비서빙 = 비완료·드롭 job)의 url_norm 을 이 함수로 채운다(검증 D-01 수정, 이번 라운드).
  서빙 답변 값(rd.dim_url)과 글자 단위로 같아야 하는데, 비ASCII 공백이 붙은 원문 URL 에서만 한 글자 차이가 날 수 있다. 같은 함수가
  프로젝트 추적 URL ↔ 인용 url_norm 대조(projects.settings.tracked_urls 등)에도 쓰이므로 feature 쪽에서 따로 고치지 않았다.
- **선택지**: (a) 파이썬을 SQL 에 맞춘다(trim 문자 집합을 POSIX `[[:space:]]` 로 좁힘, 추적 URL 등록 값의 정규화가 바뀔 수 있어 기존 행 재계산
  필요 여부 확인), (b) 적재기 식을 JS trim 에 맞춘다(rd.dim_url 재계산), (c) 현행 유지(차이를 문서화). url_base_norm 은 새 함수
  `normalize_url_base_for_match`(btrim 6문자 집합) 가 SQL 과 같아 해당 없다.
- **막힌 기능**: 없음(드문 입력에서 비서빙 인용 url_norm 한 글자 차이 가능성).

## 해소: 비서빙 job 인용의 url_norm·url_base_norm (검증 D-01)

- 이전 라운드는 rd.citation(서빙 답변만 행이 있음) 조인만 해서 비서빙 job 인용이 null(화면 빈 값 표시)이었다. 현행 화면은 미러 scope_citations 의
  url_norm·url_base_norm 을 전 job 에 대해 보여 줬다. 이제 rd.citation 행이 없는 인용은 원문 url 에 적재기와 같은 식(core.urls 의
  `normalize_url_for_match` = cit_norm, 새 `normalize_url_base_for_match` = cit_base_norm)을 적용해 채운다. DB 변경 요청은 필요 없다(R1 확장 불요).
- 검증 BG46-NONSERVED 보강: 원문 url 이 rd.dim_url 에 이미 있으면(url_hash = sha256(convert_to(url,'UTF8')), qa_gate SELECT 기존 권한)
  그 저장값이 1순위다. 적재기가 만든 값 그대로라 R3 차이도 이 경우에는 생기지 않는다. R3 의 비ASCII 공백 차이는 dim_url 에 없는 URL 을
  파이썬 식으로 계산하는 2순위 경로에만 남는다.

## 참고(요청 아님): D2 신뢰 중계 IP 배포 조건

- core.auth.client_ip 는 `HGH_RELAY_SECRET` 이 설정될 때만 `X-HGH-Client-IP` 를 받는다(`X-HGH-Relay-Secret` 상수 시간 비교). 미설정이면 기존 규칙
  (XFF 오른쪽에서 trusted_proxy_hops 번째, 기본 소켓 주소) 그대로라 배포 전후 동작이 같다.
- 켜는 순서: Secrets Manager 에 비밀 생성(16자 이상, 권장 32바이트 난수) → 백엔드 환경 변수 `HGH_RELAY_SECRET` 과 프론트(Vercel 서버 환경 변수,
  NEXT_PUBLIC_ 접두 금지) 양쪽 주입 → BFF route 가 뷰어가 보낸 `X-HGH-Relay-Secret`·`X-HGH-Client-IP` 를 지우고 실제 뷰어 IP(Vercel 이 넣은
  XFF 첫 원소, 현행 front/lib/qa/route-helpers.ts:45)와 비밀을 붙인다. 비밀 교체 시 두 쪽을 같이 바꾼다(불일치 기간에는 기존 규칙으로 폴백,
  검수자들이 Vercel 출구 IP 버킷을 나눠 쓰는 결정 D2 (a) 상태가 될 뿐 입장은 막히지 않는다).
