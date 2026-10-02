# analytics.answers.detail · 분석 조회 / 답변 드릴다운 / 답변 상세

설계 단위: AN-2 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/answers/{job_id}` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]/analysis/citation`
- `/projects/[id]/analysis/mention`
- `/standard/answer-analysis/citation`
- `/standard/answer-analysis/citation/prompts`
- `/standard/answer-analysis/mention`
- `/website/answer-analysis/citation`
- `/website/answer-analysis/mention`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모
- 당사(own) 판정 = 표면별 관점: project = 프로젝트 브랜드(core), global·website = 요청 관점(계정 스코프 ∩ brand[], 없으면 스코프 전체, core `ReadContext.own_bits`). 목록(analytics.answers.list)과 같은 규칙, 현행 front `scope-aggregates.ts` getMirrorAnswerBody(`trackedEntityIdsFor(contextBrand ?? brand)`)·`server.ts` withWebsite(contextBrand = 스코프 ∩ brand[]).
- brand[] 는 관점 입력일 뿐 접근 게이트(헤더 스코프)를 바꾸지 않는다. 그 밖의 공통 축은 `meta.ignored_filters`(core `ignored_axes`).
