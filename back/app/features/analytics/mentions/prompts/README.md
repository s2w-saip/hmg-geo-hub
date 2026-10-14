# analytics.mentions.prompts · 분석 조회 / 언급 / 프롬프트별 언급

설계 단위: M-3 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/mentions/prompts` | medium |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]/analysis/mention`
- `/standard/answer-analysis/mention`
- `/website/answer-analysis/mention`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현(2026-09-28)
- 파라미터: 공통 필터 + `mode`(brand|signal, 필수) · `brand_key`(mode=brand 필수, 1~2^31-1(int4), 넘으면 422, 없으면 404 brand_not_found) ·
  `signal`(positive·neutral·negative·mixed·mention·recommendation·comparison·definition·final_choice) · `limit`(1~200, 50) · `cursor` · `answers_limit`(1~50, 6).
- 응답 `data`: `mode` · `target` · `total`(share 분모) · `items[]{prompt_id, prompt_text, funnel_code, count, share, providers, answers[]}`,
  `answers[]{job_id, engine, region, value, position|null, measured_at, runs}`. `meta.page{next_cursor, limit, total(프롬프트 수)}`.
- 키셋 = (count DESC, prompt_key DESC), 커서 = core.pagination(필터 해시·세대, 세대 변경 409 cursor_stale). 문장 둘(페이지 + 답변 배치).
  BG 라운드 타깃 인자(mention_brand·own·own_brand_code)는 값이 있을 때만 해시에 들어간다: 배포 전 커서가 그대로 이어진다(검증 D5).
- 셀 대표(R05): (프롬프트, 엔진, 국가) 안 is_rep 우선 → 최신 측정 → answer_key, runs = 셀의 타깃 답변 수.

## 값 갭 보강(BG 라운드, 2026-09-28). 전부 선택 인자: 주지 않으면 응답 모양·값이 위와 같다
- mode=brand 타깃은 셋 중 정확히 하나(아니면 422): `brand_key` · `mention_brand`(BG-17: 표시명, name 일치 우선·없으면 bare 소문자,
  없으면 404 brand_not_found, `/v1/answers` 와 같은 해석) · `own=true`(BG-17: 당사 행 = own_bit ∈ 관점 비트 ∧ competitive).
  `own_brand_code`(own=true 전용): D13 split_own 행 키(`common.own_splits`: 관점 비트가 둘 이상일 때 비트별 부모 브랜드 코드)만 그 비트 하나로 받는다.
  브랜드 코드가 아니면 422, 행 키가 아닌 코드(관점 밖·관점 안 하위 브랜드 코드 예 ADMIN 의 `Hyundai N`·단일 관점)는 빈 목록.
  mode=signal 에 `brand_key`·`own`·`mention_brand` 가 오면 422(`own_brand_code` 와 같은 규칙, 조용히 무시하지 않는다).
  `data.target` 에 `own: true`·`own_brand_code` 가 붙는다(그 밖 타깃은 종전 모양).
- `terms=true`(BG-18): `answers[].terms{brand[], model[]}` = 모달 하이라이트 표기(현행 highlightTermsForBrand 이식). 원천 = rd.v_answer_mention_raw
  (answer_key 배치 1문장, surface·project_key 재단언) + 엔티티 정본 브랜드(키·비트·이름). brand 타깃은 그 브랜드, own·signal 은 관점 비트.
  own·signal 씨앗(관점 브랜드 코드)은 그 답변의 타깃 Brand 행 정본 이름에 있는 것만 넣는다(없는 표기가 상한을 먹지 않게).
  모델 표기는 현행과 같이 롤업으로만 잇는다(롤업 id 가 타깃 Brand 행이거나 롤업 엔티티 정본 브랜드가 타깃. 엔티티 자기 정본 브랜드로는 잇지 않는다:
  Hyundai 타깃의 `Hyundai Creta`(롤업 = Tata)는 칠하지 않는다, 검증 D3). mode=signal 의 terms 는 현행 신호 드릴다운(하이라이트 없음)에 없는
  확장이라 화면을 그대로 두는 어댑터는 signal 에 terms 를 요청하지 않는다.
  상한: 표기 brand 8·model 24. 언급 원본 뷰는 answer_key 1000개(TERMS_MAX_REFS)씩 나눠 읽는다 — 요청 크기는 limit ≤ 200 ×
  answers_limit ≤ 50 필드 상한으로만 묶는다(종전 limit × answers_limit ≤ 1000 의 422 는 어댑터 브랜드 드릴다운 200 × 50 을 항상 거부해 뺐다).
