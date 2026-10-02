# qa.review.verdict · 검수 콘솔 / 판정 / 판정 저장

설계 단위: QA-2 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/qa/answers/{job_id}/review` | low |
| PUT | `/v1/qa/answers/{job_id}/review` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/raw-data-qa/answers/[jobId]`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모
- 인증: 검수 게이트(Q17). PUT 은 한 트랜잭션에서 락 재확인 후 저장, 락을 잃으면 409 lock_lost(미저장).
- body = {section_flags: {answer|prompt|mentions|citations|acr|meta: ok|issue}}. 세션 id·검수자 이름은 쿠키에서 온다(본문에 받지 않는다).
