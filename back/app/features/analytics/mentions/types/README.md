# analytics.mentions.types · 분석 조회 / 언급 / 언급 유형·태도

설계 단위: M-2 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/mentions/types` | medium (1년 high) |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]/analysis/mention`
- `/standard/answer-analysis/mention`
- `/website/answer-analysis/mention`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현(2026-09-28)
- 파라미터: 공통 필터(`brands/common.py MENTIONS_SUPPORT`) + 선택 `split_own`(아래).
- 응답 `data`: `answers_total` · `by_type[5]` · `sentiment_matrix[10]`(유형 × own|all, 근사: 유형 간 합산 금지) · `stance`.
- stance(A3): rd.answer_stance ⋈ rd.answer, 두 사실 표 모두 창 3술어(DB-v2.5 rd.answer_stance.cyc_key, an-mentions R1 해소).
  손 계산: 현대 관점 {positive 1, pairs 1}, 전사 관점 {positive 1, mixed 1, pairs 2}(대표 턴 0 만).

## 값 갭 보강(BG 라운드, 2026-09-28). 선택 인자: 주지 않으면 응답 모양·값이 위와 같다
- `split_own`(D13, bool): 관점 비트가 둘 이상이면 `data.by_own_brand[]{own_brand_code, by_type[5], sentiment_matrix[10], stance}` 를 더한다.
  판정·행 키는 mentions/brands·trend 와 같다(`core.measure.split_own_scopes(ms)`, `common.own_splits`, 키 = 비트의 부모 브랜드 코드, 비트 오름차순).
  블록 = 그 비트만 당사로 둔 스코프로 `types_sql`·`stance_sql` 을 한 번씩 더 돈 값: own_* = 그 브랜드, other_* = 그 밖 경쟁 행 전부(형제 관점 브랜드 포함),
  분모 `answers_total` 은 합친 관점과 같다. 당사 언급·당사 매트릭스·스탠스는 블록 합 = 합친 값(행 가산), own_answers 는 가산 아님.
  관점 비트가 하나면 `by_own_brand = []`(가르지 않음). 합친 필드는 split_own 과 무관하게 같다. 쿼리 = 비트 수(≤ 3) × 2 문장 추가.
  손 계산(admin, 스냅샷 11): Hyundai 당사 5·답변 2·비교 6, Kia 2·1·9, Genesis 0·0·11, 스탠스 Hyundai {positive 1}, Kia {mixed 1}.

## 선택 파라미터(백로그 P1~P12, 2026-10-14). 전부 선택 인자: 주지 않으면 응답 모양·값·문장이 종전과 같다
- `include_stance`(B093): false = 당사 스탠스(A3) 문장을 돌리지 않고 `stance`·`by_own_brand[].stance` = null(OwnTypes.stance nullable).
  유형·매트릭스·answers_total·meta 는 같다.
