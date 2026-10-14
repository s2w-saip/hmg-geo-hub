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

## 선택 파라미터(백로그 P1~P12, 2026-10-14). 전부 선택 인자: 주지 않으면 응답 모양·값·문장이 종전과 같다
- `project_id`(B002): project 표면 선택 게이트 = 화면(BFF)이 게이트한 프로젝트. 답변의 프로젝트(LOCATE)와 다르면 404(현행 `fetchProjectAnswerBody`
  의 run 소속 게이트, 스코프·멤버십 조회 전). global·website 에 주면 `meta.ignored_filters`.
- `gate_country[]`(B003, project 는 P13d): 화면 URL 국가.
  - global = 계정 스코프 ∩ 이 목록(스코프 밖 값은 버림) 밖 답변은 404(현행 `region IN f.region`).
  - project = 계정 스코프와 교차하지 않고 그대로 건다(현행 라우트가 프로젝트 URL 을 프로필 스코프 없이 읽는다). 모르는·가상 브랜드 코드는 버리고,
    다 버려지면 404(현행 IN 이 맞는 행 없음). 프로젝트 재조회 없이 `refs` 로 푼다(문장 수 그대로).
  - website 는 쓰지 않는다(사이트 국가 리맵: worldwide 같은 가상 사이트 국가는 답변 국가가 아니다).
- `gate_brand[]`(B003): global = 그 브랜드 카탈로그 행이 있는 프롬프트(현행 prompts.brand), website = 그 브랜드 사이트(현행 narrowScopeBrands).
  계정 스코프 ∩, 밖이면 404. project 는 쓰지 않는다(run 소속 게이트가 brand 게이트를 대신한다).
- `lite`(B004): 답변 모달이 쓰지 않는 값을 계산하지 않고 null — `header.catalog`·`cycle_id`·`anchor_date`·`model_slug`·`is_rep`·`acr_iter_rank`,
  `citations[].owned`·`target_hit`. 게이트 술어·나머지 값은 같다.
- 보내는 곳: 답변 모달 BFF(front `lib/hgh/adapters/answers.ts`)가 `lite=true` 와 표면별 게이트를 보낸다(project = `project_id` + URL 국가,
  global = URL 국가·브랜드, website = URL 브랜드).
