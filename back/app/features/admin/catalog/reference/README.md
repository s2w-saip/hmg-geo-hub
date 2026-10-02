# admin.catalog.reference · 운영 관리 / 표준 카탈로그 / 택소노미·시장

설계 단위: AD-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/admin/catalog/taxonomy` | low |
| GET | `/v1/admin/catalog/markets` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/admin/standards/prompts`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모(2026-09-28, ad-content)
- taxonomy: 루트 활성 행 라벨 DISTINCT(brand·brand_presence·list_type·depth1~4) + funnel_stages(정렬). 공통 필터 축은 전부 무시
  (`core.envelope.crud_meta` 가 `meta.ignored_filters` 로 적는다).
- markets: rd.dim_project.regions(루트) 정규화·정렬. `bounded=false` 면 어휘 없음(편집은 형식만 검사). Scope 호출 없음.
