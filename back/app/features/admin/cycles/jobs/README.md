# admin.cycles.jobs · 운영 관리 / 회차 운영 / 측정 앵커 고정·드롭

설계 단위: AD-4 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/admin/jobs/{job_id}/registry` | low |
| POST | `/v1/admin/jobs/{job_id}/anchor-pin` | low |
| POST | `/v1/admin/jobs/{job_id}/drop` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- (화면 없음: 운영·워커)

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모(2026-09-28)
- 조회: rd.job(job_id 유니크) → rd.v_answer_registry(answer_key 등치). answer_key·cyc_key 는 응답에 싣지 않는다.
- 앵커 고정: `judgment_change('anchor_pin', subject_uuids=[job_id], payload{job_id, op: set, anchor, reason, old})`, anchor ≤ 오늘(KST), 같은 앵커 409.
- 드롭: `judgment_change('answer_drop', payload{job_id, op: drop, reason})`, `confirm=true` 필수(dry_run 제외), 이미 드롭 409. 반영은 적재기.
