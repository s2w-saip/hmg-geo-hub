# catalog.prompts.history · 프롬프트 카탈로그 / 프롬프트 / 변경 이력

설계 단위: P-2 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/prompts/history` | low |
| GET | `/v1/admin/catalog/prompts/{prompt_id}/history` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/admin/standards/prompts`
- `/standard/prompts`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 요약(2026-09-28)
- 라우트 게이트: hq·region·country·admin ∧ 메뉴 standard(vendor·website 역할 403). surface 는 생략 또는 global(그 밖 422).
- 스코프: 카탈로그(P-1)와 같은 술어 한 벌(core.filters catalog_brand_scope·catalog_market_scope·catalog_market_filter). 스코프가 전체가 아니거나 brand·country 를 요청하면 app.prompt 행이 없는 감사 행(하드 삭제)은 뺀다(fail-closed).
- prompt_id 타임라인도 같은 스코프: 스코프 밖이면 빈 목록 + `meta.dropped_filters.prompt_id`. limit 기본 500(prompt_id 지정 시 100), 상한 500.
- from/to = created_at 의 KST 달력일(둘 다 주거나 둘 다 생략, CommonFilters 규칙), 운영 범위 2000-01-01~2100-12-31(core CommonFilters DATE_MIN~DATE_MAX, 밖이면 422: 검증 D2, 이전엔 극단값이 500). 기본 from = 오늘(KST) - 90일. event_type[] 은 CHECK 어휘(밖이면 422).
- 키셋 (created_at DESC, audit_id DESC), `meta.mode = audit`. format=csv 상한 5,000(core.export, X-Export-Truncated), 다운로드 접근 감사.
- project_id 는 값을 바꾸지 않는다(감사 원장은 표준 루트 고정): core 가 `meta.ignored_filters` 에 적는다.
- 관리 카탈로그 타임라인(U8-7, 2026-09-30) `GET /v1/admin/catalog/prompts/{prompt_id}/history`: require_admin ∧ 메뉴 그룹 admin(현행 admin 자리
  /admin/standards/prompts 게이트), 표준 메뉴 그룹 게이트 면제(resolve_read_context surface_gate=False). 현행 listForPrompt 처럼 기간 없음(운영 범위 전체),
  기본 100(상한 500), 삭제된 프롬프트 이력 포함, 키셋. 값 = 같은 admin 의 /v1/prompts/history?prompt_id&from=2000-01-01&to=2100-12-31. 비 admin 403 admin_only.
