# admin.integrations.keyword_tools · 운영 관리 / 외부 연동 / 키워드 도구

설계 단위: AD-7 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| POST | `/v1/admin/keyword-tools/volume` | medium |
| POST | `/v1/admin/keyword-tools/to-prompt` | medium |
| POST | `/v1/admin/keyword-tools/prompt-to-volume` | medium |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/admin/keyword-tools`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`
- LLM 은 core.llm(`LlmDep`, 테스트는 `app.dependency_overrides[core.llm.get_llm]`, 설정 `HGH_OPENROUTER_*`), term_norm·지역 프리셋 29개는 core.kw

## 구현 메모(2026-09-28, 단위 설계 없음: 현행 /api/keyword/* 이식)
- 검색량: 수집된 rd.kw_volume_monthly(최신 월 + 12개월)를 즉시 돌려주고, 없거나 7일 넘었거나 force 인 term 은 `judgment_change('dfs_fetch')`
  (core.contracts 계약: subject = 정렬된 term_norm, payload `{fetch: volume, terms(원문), location_code, language_code, requested_via}`, Q13)로
  수집 요청(202). term 단위 dedupe: 같은 지역·언어의 대기·진행 중 검색량 수집(volume·insight, 고객 관심 IN-1 요청 포함)이 가진 term 은 빼고
  나머지만 요청(`fetch.pending_terms`·`pending_change_ids`), 전부 겹치면 새 요청 없이 `fetch.status pending`. 반영 확인은 /v1/admin/changes.
- language_code 는 프리셋 언어 집합만(대소문자 무시, 정본 표기로 저장). 그 밖은 422 `unknown_language`.
- 키워드 → 프롬프트·프롬프트 → 키워드: 현행 프롬프트 문구 그대로 LLM 호출(상한 180초, 25개 초과면 10개 배치, 실패 배치 제외,
  전부 실패 502 `llm_failed`, 키 미설정 503 `llm_unavailable`). `CurrentUserDetached`(LLM 대기 중 요청 커넥션 없음).
- 지역: `country`(프리셋 id) 또는 프리셋에 있는 `location_code`, 기본 kr(2410·ko).
- BG-40(core 8라운드, DB-v2.9 P62): `VolumeItem.competition` = 최신 월 행의 DataForSEO competition 라벨(LOW·MEDIUM·HIGH, rd.kw_volume_monthly.competition).
  적재 전 행·세 값 밖은 null(현행 keyword-tools 경쟁도 배지·CSV 열).
