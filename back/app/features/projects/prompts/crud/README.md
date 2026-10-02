# projects.prompts.crud · 프로젝트 / 프로젝트 프롬프트 / 프롬프트 CRUD

설계 단위: PJ-3 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/projects/{project_id}/prompts` | low |
| POST | `/v1/projects/{project_id}/prompts` | low |
| PATCH | `/v1/projects/{project_id}/prompts/{prompt_id}` | low |
| DELETE | `/v1/projects/{project_id}/prompts/{prompt_id}` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]`
- `/projects/[id]/prompt`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모
- 공용 모듈 `common.py`(6기능 공유): 라우터 게이트, 프로젝트 접근(resolve_project), meta, 무시 필터, 프롬프트 잠금·태그 조립.
- 목록: status[]·kind·q(strpos lower, 패턴 문자 무해)·`cf.<field_id>=값`(core.filters.parse_custom_fields), 키셋(created_at DESC, prompt_id DESC, 기본 50), meta.page.total.
  다른 프로젝트 필드는 meta.dropped_filters.custom + 빈 결과. 은퇴 축(list_type·depth·funnel·brand_presence) 비노출.
- PATCH: text·lang·regions 는 draft 만(409 prompt_not_draft), brand_code·category·prompt_type·kind 는 상태 무관. 값 오류(FK·CHECK)는 422 invalid_value(트랜잭션 롤백).
- 제어 문자: 본문(POST·PATCH text)은 탭·줄바꿈만 허용, 분류 메타·q 는 C0·DEL 전부 금지 → 422 unprocessable(NUL 이 DB 까지 가 500 이던 결함, 검증 D2·D5).
  짝 없는 서로게이트(JSON `"\ud800"`)도 본문·분류 메타·regions 항목에서 같은 방어선(본문 check_body, 한 줄 값 core.filters.PgLine·single_line)으로 422(asyncpg 인코딩 오류 500 이던 결함, 검증 D2-R). 본문 규칙은 core PgText 보다 좁아(탭·줄바꿈 밖 C0·DEL 도 거부) 기능에 둔다(요청 §8 처분).
- DELETE: draft ∧ scope_prompt_id NULL 만(그 외 409 prompt_not_deletable). 감사·judgment_change 는 app.prompt 트리거(Q3).
