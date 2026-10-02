# admin.interest.sources · 운영 관리 / 고객 관심 원천 / 표준 출처

설계 단위: AD-1b · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/admin/interest/sources` | low |
| POST | `/v1/admin/interest/sources` | low |
| PATCH | `/v1/admin/interest/sources/{source_id}` | low |
| DELETE | `/v1/admin/interest/sources/{source_id}` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/admin/standards/customer-interest`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모(2026-09-28, ad-content)
- app.standard_source CRUD(keywords 와 같은 규칙). 목록 필터 channel·brand[]·enabled·q(url ILIKE), 정렬 channel·created_at DESC.
- 무시 축은 `core.envelope.crud_meta(support=('brand',))`. 자유 문자열은 한 줄 값 `PgLine`·메모 `PgText`(core.filters, 제어 문자·NUL 422).
  브랜드 FK 는 사전 검증(`unknown_brand`), 검증 뒤 브랜드가 사라지는 경쟁은 core 전역 처리기가 422 `constraint_violation` 으로 낸다.
