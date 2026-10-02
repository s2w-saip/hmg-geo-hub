# qa.review.lock · 검수 콘솔 / 판정 / 답변 락

설계 단위: QA-2 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| POST | `/v1/qa/answers/{job_id}/lock` | low |
| PATCH | `/v1/qa/answers/{job_id}/lock` | low |
| DELETE | `/v1/qa/answers/{job_id}/lock` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/raw-data-qa/answers/[jobId]`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모
- 인증: 검수 게이트(Q17). 락 소유자 = 쿠키 세션. TTL 180초, heartbeat 30초. 실패 409 lock_held(details.held_by).
- 동시 획득 경합: 단일 upsert(테스트 test_concurrent_acquire_exactly_one_wins·test_upsert_blocks_and_loses_while_first_uncommitted).
