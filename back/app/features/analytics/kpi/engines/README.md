# analytics.kpi.engines · 분석 조회 / KPI / 엔진별 서브 지표

설계 단위: K-3 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/kpi/engines` | medium |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]`
- `/projects/[id]/analysis/mention`
- `/standard/answer-analysis/mention`
- `/website`
- `/website/answer-analysis/mention`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현(2026-09-28, an-kpi)
- 파라미터: 공통 필터 + `cycle_offset`(0|1) + `part`(all|exposure|sov|favorability|position|citation). part 로 계산하지 않은 필드는 0 이 아니라 null.
- 응답: `rows[]`(engine 코드별 정수), `total`(행 합), `engine_consistency`(round1(100 × min ÷ max), 유효 엔진 2개 미만 null).
- 계산: `core.measure.fetch_counts(group_by=("engine",))` 한 번 스캔. 행 합 = K-1 카드(D6, 테스트로 고정).

## 값 갭 보강(2026-09-28, bg-kpi-filters)
- BG-01·BG-03: core KPI_SUPPORT 로 글로벌 `lang[]`, 글로벌·프로젝트 `depth4[]` 를 적용한다(행 합 = K-1 카드 불변).

## 선택 파라미터(백로그 P1~P12, 2026-10-14). 전부 선택 인자: 주지 않으면 응답 모양·값·문장이 종전과 같다
- `parts[]`(B090, all|exposure|sov|favorability|position|citation): core part 들의 합집합으로 열을 좁힌다. 주면 `part` 대신 쓰고, 비우면 `[part]`(종전).
  계산하지 않은 필드는 null(`part` 와 같은 규칙).
- 보내는 화면: 엔진 일관성 배지 = `parts=sov&parts=citation`(rank_detail 없음), 언급 서브 KPI = `parts=sov`.
