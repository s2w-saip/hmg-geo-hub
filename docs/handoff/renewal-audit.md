# 리뉴얼 점검 후속 (한 세션, 순서대로)

2026-10-31 중간점검에서 나온 문제를 고친다. 점검은 Global · Website 전 화면을 원본과 대조하고, 지표 · 데이터 원칙 · 화면 원칙을 확인했다. 진행 세션 하나가 1단계부터 순서대로 하되, 단계마다 새 하위 에이전트에게 맡긴다('진행 방식' 절). 단계를 마칠 때마다 이 파일을 고쳐 커밋 · 푸시한다. 컨텍스트를 비운(/clear) 뒤에도 이 파일만 보고 이어 갈 수 있게 썼다.

사용자 결정(2026-10-31):
- 병렬 세션으로 나누지 않고 한 세션이 순서대로 한다.
- 단계마다 새 하위 에이전트가 깨끗한 컨텍스트로 맡는다(B 방식).

**현재 위치:** 13단계(Prompts 귀속 · 계정 범위 · 선택지) 시작 전. 12단계 끝(단계 메모 '12단계'). 마지막 커밋: 12단계를 올린 커밋.

## 진행 방식 (단계마다 새 하위 에이전트)

진행 세션은 사용자가 '다음 작업'이라고 하면 시작한다. 진행 세션은 코드를 직접 고치지 않고, 단계를 맡기고 검증만 한다.

1. **시작.** '이어 가는 법' 1~3을 한다. 첫 답변에 '지금 할 일' 줄, '현재 위치' 줄, 이번에 맡길 단계를 적는다.
2. **맡기기.** '현재 위치'의 단계를 새 하위 에이전트(general-purpose) 하나에 맡긴다.
   - 한 번에 하나만 맡긴다. 앞 단계를 검증한 뒤에 다음 단계를 맡긴다.
   - 지시문은 아래 틀을 쓴다.
   - e2e가 있는 단계(2 · 6 · 7 · 10)는 진행 세션 메모리의 'Browser e2e on the Mac' 내용을 지시문에 붙인다. 로컬 실행 방법은 '공통 규칙'에 있다.
3. **검증.** 에이전트가 돌아오면 확인한다.
   - `git log` · `git show --stat`으로 커밋을 확인한다. 바뀐 파일이 그 단계 범위 안인지 본다.
   - 이 파일의 체크 · '현재 위치' · 단계 메모 · 진행 기록이 고쳐졌는지 본다.
   - 그 단계의 핵심 시험 한두 개(BFF 모듈, vitest 파일)를 직접 다시 돌린다.
   - 빠졌거나 틀린 것이 있으면 같은 에이전트에게 고치게 한다(SendMessage). 끝까지 맞지 않으면 사용자에게 말한다.
4. **보고.** 단계마다 사용자에게 짧게 보고한다: 한 일, 커밋, 재현 안 된 항목, 다음 단계. 그리고 바로 다음 단계를 맡긴다.
5. **멈춤.** 다음 경우에는 다음 단계로 가지 않는다.
   - 에이전트가 새 원칙이 필요한 질문을 들고 왔다 → 먼저 사용자 결정의 추이(admin-todo 결정 기록 · 세션 메모)로 정한다. 정해지면 결정 기록에 적고 같은 에이전트에게 이어 가게 한다(admin-todo 규칙 2, 2026-10-31). 추이로도 정할 수 없을 때만 사용자에게 묻는다.
   - 푸시 충돌이 났거나, 다른 세션 파일 때문에 시험이 막혔다 → 사용자에게 말한다.
   - 사용자가 멈추라고 했다.
   - ⛔ 결정이 없는 단계는 멈추지 않고 건너뛴다('이어 가는 법' 끝 문단).
6. **끝.** 16단계를 검증하면 사용자 확인을 받는다.

**에이전트 지시문 틀** (`<N>`만 바꾼다)

> 저장소 `/Users/s2w/Desktop/dev/hmg-geo-hub`에서 리뉴얼 점검 후속 `<N>`단계만 한다.
> 1. `docs/handoff/renewal-audit.md`의 '이어 가는 법' 3~6, '공통 규칙', '약칭', '`<N>`단계' 절과 '확인 결과' 표, '단계 메모'를 읽는다. 다른 단계 절은 읽지 않는다.
> 2. 규칙은 `CLAUDE.md` 작업 규칙과 `docs/handoff/admin-todo.md` 규칙 5 · 6 · 7을 따른다. 그 단계의 '읽을 파일'만 읽는다.
> 3. '할 일'을 위에서부터 한다. 각 항목은 재현 시험이 고치기 전에 실패하는지 먼저 본다. 재현되지 않으면 고치지 않고 단계 메모에 적는다.
> 4. 시험을 통과하면 커밋 · 푸시한다(작성자 환경변수, fetch 먼저, 자기 파일만 스테이징). 같은 커밋에서 계획서의 체크, '현재 위치', 단계 메모, 진행 기록을 고친다.
> 5. 다음 경우에는 그 자리에서 멈추고 보고한다: 새 원칙이 필요하다, ⛔ 결정이 없다, 푸시가 충돌한다, 다른 세션 파일 때문에 시험이 막힌다. 사용자에게 직접 묻지 않는다.
> 6. 보고에 넣을 것: 한 일(항목별), 커밋 해시, 시험 명령과 결과, 재현 안 된 항목과 이유, 원본 대조 결과, 남은 것.

## 이어 가는 법 (세션 시작 · /clear 뒤)

1~3은 진행 세션이, 4~6은 단계 에이전트가 한다.

1. CLAUDE.md가 `admin-todo.md`를 불러오고, 그 파일의 '지금 할 일'이 이 파일을 가리킨다. 첫 답변은 admin-todo 규칙대로 '지금 할 일' 줄로 시작하고, 이어서 이 파일의 '현재 위치' 줄을 적는다.
2. 이 파일에서는 '현재 위치', '진행 방식', '공통 규칙', '단계' 표를 읽는다. 단계 절은 그 단계 에이전트만 읽는다.
3. `git fetch` → `git status --short` → `git log --oneline -5`를 실행한다.
   - '현재 위치'에 적힌 마지막 커밋이 log에 있는지 본다. 다르면 진행 기록과 log로 맞춘 뒤 '현재 위치'부터 고친다.
   - 그 단계 파일에 미커밋 변경이 있으면 이어서 쓴다. 다른 세션 파일이면 건드리지 않는다.
4. 그 단계의 '읽을 파일'만 읽는다. 줄 번호는 2026-10-31 점검 때 값이다. 밀렸으면 함수 · 키 이름으로 찾는다.
5. '할 일'을 위에서부터 한다. 하위 항목 하나가 시험을 통과하면 바로 커밋 · 푸시해도 된다. 작게 자주 올린다.
6. 단계를 마치면 다음을 같은 커밋에 넣는다: 체크, '현재 위치', 단계 메모(다음 단계가 알아야 할 것), 진행 기록 한 줄. 그다음에는 사용자가 /clear 해도 된다.

단계 중간에 멈추면 '현재 위치'에 하위 항목까지 적는다. 예: "5단계 5-2 진행 중. 5-1 커밋 `abc1234`. 미커밋: `BS/mention_renewal.py`".

⛔ 단계에 닿았는데 결정이 아직이면 그 단계를 건너뛰고 다음 단계로 간다. '현재 위치'에 건너뛴 단계를 적고, 결정이 나면 돌아온다. 결정은 admin-todo '결정 대기' 표의 J · K · L 행에서 본다. 2026-10-31에 셋 다 추천안으로 정했다(admin-todo 결정 기록 'J · K · L'). 그래서 2 · 14 · 15단계는 건너뛰지 않는다.

## 공통 규칙

- **원칙.** admin-todo 규칙 5(데이터)와 규칙 7(화면)을 따른다. 원칙으로 정해지는 일은 묻지 않고 진행한다. 고른 안은 그 단계 메모와 admin-todo 결정 기록에 적는다. 원칙으로 정할 수 없으면 사용자 결정의 추이를 따른다(admin-todo 규칙 2). 에이전트는 묻지 않고 보고하고, 진행 세션이 정한다.
- **확인 먼저.** 점검은 코드를 읽어서만 했고, 실행이나 화면 대조는 하지 않았다. 버그 수정 규칙대로 재현 시험이 고치기 전에 실패하는지 먼저 본다. 재현되지 않으면 고치지 않고, 단계 메모에 '재현 안 됨'과 이유를 적는다.
- **원본 대조.** 원본 화면과 같은 BFF 화면을 읽으면 숫자가 같아야 한다. 숫자가 바뀌는 단계는 끝에 원본(`/ko/…`)과 같은 조건으로 한 번 대조한다. 공용 리더나 화면을 고쳐 원본 숫자도 같이 바뀌면 단계 메모에 적는다.
- **golden.** 화면 출력이 바뀌면 `bff.tests.test_golden`이 실패한다.
  - 의도한 변경이면 `back/bff/tests/golden/README.md` 'Deliberate changes'에 날짜 · 이유 · case 수를 적고, 그 case의 output만 새 값으로 바꾼다(2026-10-30 W6 방식).
  - 의도하지 않은 차이는 코드를 고친다.
- **시험**
  - BFF 모듈 하나: `cd back && ~/micromamba/envs/hgh-bff/bin/python -X utf8 -m unittest bff.tests.<모듈>`
  - BFF 전체(BFF를 고쳤으면 커밋 전에): `cd back && for f in bff/tests/test_*.py; do m=$(echo ${f%.py} | tr / .); ~/micromamba/envs/hgh-bff/bin/python -X utf8 -m unittest -q $m 2>&1 | tail -1 | grep -q '^OK' || echo "FAIL $m"; done`. `test_live_reads`는 `HGH_GOLD_TEST_BASE_URL=http://127.0.0.1:5555`가 있어야 한다.
  - 프런트: `cd front && npx vitest run <바꾼 파일의 시험>`, `npm run typecheck`, `npm run lint`. 전체 vitest는 부하 때문에 실패가 많이 나므로 관련 파일만 돌린다. prettier는 쓰지 않는다.
  - 로컬 실행: `HGH_PYTHON=~/micromamba/envs/hgh-bff/bin/python bash scripts/start-local.sh`(front 3333 · API 5555). BFF를 고쳤으면 다시 실행한다. 다시 실행하면 API만 재시작된다.
  - e2e: 새 흐름이 생긴 단계(2 · 6 · 7 · 10)만 돌린다. 표시만 바뀌면 render 시험으로 끝낸다.
- **커밋 · 푸시.** admin-todo 규칙 6과 CLAUDE.md 작업 규칙을 따른다: 작성자 환경변수, `main`에 직접, fetch 먼저, 자기 파일만 스테이징.
- **아키텍처 문서.** 구조 · 권한 · BFF 화면 수 · 프록시가 바뀌면 같은 커밋에서 `docs/architecture/hmg-geo-hub-architecture.html`을 고친다. 2단계는 반드시 확인한다.
- **문구.** 새 문구는 그 화면의 기존 네임스페이스(`renewal.<화면>`, website는 `renewal.website.<화면>`)에 ko · en 함께 둔다. 문구 키는 `messages/{ko,en}.json`과 `messages/units/*.json`이 요청 때 합쳐진다. 키를 더하거나 고치기 전에 units에도 같은 키가 있는지 보고, 문구를 바꾼 단계는 `npx vitest run i18n/request.test.ts`를 돌린다.

**약칭**

- `RN/` = `front/app/[locale]/(renewal)/renewal/`
- `LG/` = `front/app/[locale]/(dash)/`
- `AA/` = `front/app/[locale]/(dash)/standard/answer-analysis/_components/` (원본 언급 · 인용 부품)
- `BS/` = `back/bff/screens/`
- `GR/` = `back/bff/gold_reader/`
- `HS/` = `back/bff/hub_stores/`
- `KO` = `front/messages/ko.json` (`en.json`도 같은 키)

## 단계

| 단계 | 내용 | 먼저 필요한 것 | 상태 |
|---|---|---|---|
| 1 | Gold 확인(읽기 전용)과 업스트림 질문 보강 | — | [x] |
| 2 | Website 범위 계정 접근 | ⛔J | [x] |
| 3 | 공통 스파크라인 회차 값 · Overview 표시 | — | [x] |
| 4 | 경쟁사 브랜드 접기(공용 모듈) · Overview 데이터 | 1 | [x] |
| 5 | Mention ① KPI 탭: 회차별 분자 · 분모, 답변당 언급 수 Δ, 당사 평균 위치 | 1 | [x] |
| 6 | Mention ② 브랜드 순위 표 전체 · 열 정의 | — | [x] |
| 7 | Mention ③ 서랍 · 드릴다운 | — | [x] |
| 8 | Mention ④ 귀속 · 트리맵 · bump | 1 | [x] |
| 9 | Citation ① 결함 · 문구 · 귀속 | 1 | [x] |
| 10 | Citation ② 구성 추이 수치 · Website 도메인 표 전체 | 3 | [x] |
| 11 | ACR 발견 · 귀속 · 정렬 | 1 | [x] |
| 12 | AI Conversion 부분합 · 문구 | — | [x] |
| 13 | Prompts 귀속 · 계정 범위 · 선택지 | 1 | [ ] |
| 14 | 기간 비교 억제 | ⛔K | [ ] |
| 15 | HUB가 만든 평균 기준선 · 분해 | ⛔L | [ ] |
| 16 | 마무리: 원본 대조, 전체 시험, 문서, 다음 일 | 1~15 | [ ] |

순서를 이렇게 잡은 이유:
- 1단계 결과가 여러 단계의 고칠 방향을 정한다.
- 2단계는 가장 큰 결함이다. 지금 Website는 관리자만 읽을 수 있다.
- 3단계 부품을 10단계가 쓴다.
- 공용 모듈(4단계)을 Mention · Citation보다 먼저 고쳐야 각 화면 단계의 golden 차이가 섞이지 않는다.
- 결정이 필요한 14 · 15단계는 뒤에 둔다.

---

### 1단계 — Gold 확인(읽기 전용)과 업스트림 질문 보강

**목표.** 코드만으로 판단할 수 없던 것을 Gold에서 확인한다. 코드는 고치지 않는다.

**읽을 파일**
- `.env.gold.local`(접속 정보). Gold 읽기 전용 계정으로 SQL을 직접 돌린다. 쓰기는 하지 않는다.
- `docs/handoff/upstream-questions-2026-10-30.md`: 머리와 목차만.
- 아래 표의 근거 파일: 필요한 함수만.
- Gold 표 · 열 설명(`obj_description` · `col_description`)도 근거로 쓴다.

**할 일.** 아래 항목을 확인해 '확인 결과' 표를 채운다.

| ID | 질문 | 근거 | 쓰는 단계 |
|---|---|---|---|
| U1 | 'HMG 계열' 이름 목록(Hyundai · Kia · Genesis)과 Gold `own_bit` / `is_hmg_own`이 같은 브랜드를 고르는가 | `BS/mention_renewal.py` ~36 · 116-118, `BS/acr.py` ~365 · 531-533, `GR/metrics.py` ~181-205 | 8 · 11 |
| U2 | Gold 추이에서 그 회차에 점이 없는 브랜드 · 도메인은 0회인가, 측정되지 않은 것인가 | bump `BS/_trend.py` ~578, `BS/mention_renewal.py` ~598-599, 인용 추이 `BS/citation_model.py` ~249-251 | 8 · 9 |
| U3 | 인용 답변 톤(당사 관점 브랜드 긍정 신호 합 > 부정 합, 같으면 뺌)이 Gold `citation_cell.cit_pos` · `cit_neg` 정의와 같은가 | `GR/citations.py` ~165-171, `GR/drilldown.py` ~167-169 | 9 |
| U4 | Global 공식(HMG) 타일 Δ가 쓰는 `cit_m05` 추이가 Official(HMG) 카테고리 비중과 같은 값인가 | `BS/citation_model.py` ~794-798 · 817-818 · 857, `citation-body.tsx` ~646 | 9 |
| U5 | 당사 우호도 분모 `kpi_cell.sent_all`과 경쟁사 분모 `brand_cell`(s_pos + s_neu + s_mix + s_neg)가 같은 정의인가 | `BS/_competitors.py` ~50-55, `GR/advanced.py` ~26, `GR/metrics.py` ~44 | 4 |
| U6 | 출처 '당사' 태그(그 도메인 인용 중 하나라도 자사면 붙음)가 `dim_source.owned_brand_bit`과 같은 도메인을 고르는가 | `GR/citations.py` ~54-59 · 97 | 9 |
| U7 | HUB 권역 표 `RHQ_REGION_COUNTRIES`(`BS/_query.py`)의 권역 id가 Gold `dim_region.code`와 맞는가 | Overview 지도 권역 칠하기 · 측정 예정 권역 | 4 |
| U8 | global 프롬프트 목록에서 다음 수: `catalog_entry.kind`가 빈 행, 브랜드 포함 여부(presence)가 빈 행과 값 종류, `brand_bit`이 {1,2,4,8} 밖인 행 | `BS/standard_prompts.py` ~67-88, `GR/catalog.py` ~33-55 | 13 |
| U9 | 멘션 유형 total = 0인 열이 실제 필터에서 생기는가(엔진 · 국가 조합) | 9단계 재현 자료 | 9 |
| U10 | Gold `kpi/compare`가 `mentionsPerAnswer`를 돌려주는가 | `BS/mention_data.py` ~173, `BS/_period.py` ~457 | 5 |
| U11 | 당사 평균 위치: 당사 브랜드별 위치의 가중평균과 Gold 관점 회차 값(`overviewSlots.avgPosition`)이 얼마나 다른가 | `BS/mention_view.py` ~639-662, `BS/_trend.py` ~347 | 5 |
| U12 | Global 프롬프트 목록에 계정 국가를 걸 Gold 값(`dim_prompt.regions` 등)이 있는가 | `GR/catalog.py` ~33-49 | 13 |

**끝 조건**
- '확인 결과' 표의 모든 행을 '같음', '다름(수치)', 'Gold로 알 수 없음 → 업스트림' 가운데 하나로 채운다.
- 업스트림으로 넘긴 것은 `upstream-questions-2026-10-30.md`에 새 절 'D. 2026-10-31 점검'으로 더한다.
- 다음 질문이 그 묶음에 아직 없으면 함께 넣는다: Hyundai N bit 16(W4 · W6), 비완성차 경쟁사, 등록됐지만 측정되지 않은 website 프롬프트 2,563개(W6), URL 카드 모집단 4 · 10, Kona 귀속(W2), `loc_owned`와 `cit_m05` 차이(W3).
- 사용자가 보낸다.

---

### 2단계 — Website 범위 계정 접근 ⛔J

**문제.** hq · region · country 계정은 Website 메뉴가 보이지만, 데이터 읽기는 모두 403이다.
- `back/bff/access.py` ~68-71: `clamp`는 surface가 global이 아니면 403을 낸다. docstring ~12-13에는 '리뉴얼 페이지가 아직 없어서'라고 적혀 있는데, 이제는 맞지 않는다.
- `HS/hub_auth.py` ~64-68: 범위가 '전체'(`all`)인 계정은 관리자뿐이다.
- `front/lib/auth/route-policy.ts` `WEBSITE_VIEWERS`: 내부 4역할과 website 역할이 Website 메뉴를 본다.

**추천안(⛔J).** website surface에도 global과 같은 clamp를 건다.
- 브랜드는 계정 브랜드 안, 국가는 계정 국가 또는 권역 국가 안이다. website의 국가 축은 사이트 국가다.
- 원본 규칙과 같다(route-policy 주석): country = 자국 공식 사이트, region · hq = 권역 안 국가 종합, 브랜드 통합 보기는 관리자만.
- project surface는 그대로 막는다.

**읽을 파일**
- `back/bff/access.py` 전체, `HS/hub_auth.py`의 `scope()`
- `front/lib/auth/route-policy.ts`의 website 주석과 항목
- 원본 API의 website 범위 처리: `back/app/core/auth.py`의 DataScope
- `BS/_filters.py`의 브랜드 축(관리자만) 부분
- Website 화면이 ctx.admin을 보내는 곳: `RN/website/page.tsx` ~60, `RN/website/prompts/page.tsx` ~56, `front/app/api/website/prompts/[view]/route.ts` ~38
- W0 패널의 브랜드 축 기준: `RN/_components/overview-filter-model.ts` ~125-146(scope.all)

**할 일**
- [x] 2-1 재현 시험을 쓴다. region 계정 범위로 website를 읽으면 403이 나는 것을 확인한다.
- [x] 2-2 clamp를 website에 연다. website 필터 패널(W0)에서도 계정 브랜드 잠금과 국가 좁히기가 원본처럼 보이는지 확인한다.
- [x] 2-3 전용 사이트 계정(Hyundai N 등)의 국가 잠금(admin-todo 세션 메모 W0)과 겹치는지 확인한다.
- [x] 2-4 docstring과 아키텍처 문서의 계정 · 권한 설명을 고친다.

**시험**
- BFF 전체와 관련 프런트 시험.
- e2e 한 번: region 계정으로 Website 5화면을 연다. 값이 계정 범위 안에 있고, 범위 밖 국가는 고를 수 없어야 한다.
- 시험 계정은 Admin › 사용자 관리에서 만들고, 끝나면 중지한다.

---

### 3단계 — 공통 스파크라인 회차 값 · Overview 표시

**읽을 파일**
- `front/components/renewal-ui/sparkline.tsx`와 그 시험
- `RN/dashboard/_components/overview-body.tsx`
- `LG/dashboard/_components/overview-kpi-cards.tsx` 271-286
- `BS/overview.py`의 card-trend · website_tiles 부분, `BS/_summary.py` 222-252
- `RN/website/_overview/`의 해당 파일

**할 일**
- [x] 3-1 `RnSparkline`은 aria-hidden SVG라 회차 값을 읽을 수 없다. 선택 prop을 더해 점마다 날짜 · 값 · 직전 회차 Δ를 hover로 보인다.
  - prop이 없으면 지금과 같다. 다른 사용처(Mention · Citation · ACR · Conversion · Visibility · website 주별 언급)의 render 시험은 그대로 통과해야 한다.
- [x] 3-2 Global Overview KPI 카드 스파크라인(`overview-body.tsx` ~296-307)에 회차별 값과 직전 회차 Δ를 붙인다.
  - 원본은 점마다 '값 · WoW'를 툴팁으로 보였다.
  - BFF `overview/card-trend` spark points에 값이 이미 있다. Δ는 두 Gold 값의 차이다.
- [x] 3-3 Website '경쟁사 대비 SOV'에서 당사 SOV가 비면 당사 언급을 0으로 넣어 '0.0배'가 될 수 있다(`BS/overview.py` ~281-283 → `BS/_summary.py` ~236). 값이 없으면 '—'로 보인다. 재현 시험부터 한다.
- [x] 3-4 Global 기간 비교 라벨은 `compare[0]` 하나로 모든 카드를 대신한다(`BS/overview.py` ~387-390). 카드마다 자기 비교 라벨을 보인다.
- [x] 3-5 Website 기간 hint `comparePeriod`('바로 앞 같은 길이의 기간')는 달력 월 비교(직전 달)에 맞지 않는다. 비교 종류에 맞는 문구로 고친다.
- [x] 3-6 정리한다.
  - 경쟁사 Δ가 없으면 칸이 빈다(`overview-body.tsx` ~344-345). '—'로 보인다.
  - 상위 컨테이너가 없어 효과가 없는 컨테이너 쿼리를 지운다(`RN/website/_overview/website-markets.tsx` ~98, `website-trend.tsx` ~100).
  - 쓰지 않는 문구 `renewal.overview.heatLegend · marketsKey · cellPlace · cellRival · sort* · vsRival`을 지운다. 지우기 전에 grep으로 다시 확인한다.

**시험.** sparkline · Overview render와 page 시험, `test_screens_overview`, `test_golden`(overview · ov), typecheck · lint. `_summary.py`는 citation · mention도 쓰므로 golden 전체를 돌린다.

---

### 4단계 — 경쟁사 브랜드 접기(공용 모듈) · Overview 데이터 [U5 · U7]

**읽을 파일**
- `BS/_competitors.py` 전체
- `BS/overview.py` ~690-745
- `GR/advanced.py` ~20-70
- `BS/_query.py`의 `RHQ_REGION_COUNTRIES`

**할 일**
- [x] 4-1 브랜드 이름을 trim하고 소문자로 맞춰 접으면서 한쪽 행을 버린다(`_competitors.py` ~36-38 · 118-126, `overview.py` ~727-741). Gold `brand_key`가 다르면 두 행을 모두 남긴다(규칙 5: 귀속을 합치지 않는다).
  - `_competitors`는 Overview · Mention · Citation이 같이 쓰므로 golden 전체를 돌린다.
  - 원본 화면도 바뀐다.
- [x] 4-2 U5가 '다름'이면 경쟁사 우호도 분모(`_competitors.py` ~50-55)를 당사와 같은 정의로 맞춘다. Gold가 비율을 주면 그 값을 쓴다.
- [x] 4-3 U7이 '다름'이면 권역 id를 Gold에 맞춘다.
- [x] 4-4 'Official (Competitor)' 카테고리를 이름 문자열로 맞추는 곳(`_competitors.py` ~25 · 275)을 slug(`dim_category.slug`)로 바꾼다.

**시험.** `test_screens_overview` · `mention` · `citation`, golden 전체, 원본 `/ko/dashboard` 대조.

---

### 5단계 — Mention ① KPI 탭 [U10 · U11]

Global과 Website가 같은 본문을 쓴다. Website는 `mention/rn-*`를 ctx.surface=website로 읽는다.

**읽을 파일**
- `BS/mention_renewal.py`: `rate_hero` ~ `rank_hero`(263-340), `hero_trend_series`(384), `resolve_delta`(230), payload 함수(1028-1180)
- `BS/mention_view.py` 636-680, `BS/_trend.py` ~340-350
- `RN/standard/answer-analysis/mention/_components/mention-rate.tsx` · `mention-rank.tsx` · `mention-favor.tsx`
- `RN/website/answer-analysis/mention/_components/site-cards.tsx`
- 원본: `AA/kpi/kpi-trend-chart.tsx` 62-90, `AA/kpi/favorability-trend-chart.tsx` 69-70, `AA/kpi/type-kpi-section.tsx` 351

**할 일**
- [x] 5-1 회차별 분자 · 분모를 되살린다(노출률 · 우호도 추이 툴팁, 유형 차트의 회차별 답변 수).
  - BFF points에는 분자 · 분모가 있지만 응답에서 뺀다(`mention_renewal.py` ~267 · ~305 · ~1075).
  - 추이 툴팁 · 표 보기 · CSV(`mention-rate.tsx` ~194 · 207, 지금은 %만)에 수를 더한다.
  - 원본의 WoW%는 HUB가 만든 값이라 옮기지 않는다.
- [x] 5-2 답변당 언급 수 Δ(달력 월 모드)를 되살린다.
  - `resolve_delta`와 `COMPARE_KEY`(~62)가 지표 4개만 고른다. BFF는 이 값을 요청하고 있다.
  - U10이 '돌려줌'이면 기간 칩 줄에 더한다. 아니면 업스트림 질문으로 둔다.
- [x] 5-3 당사 평균 위치 추이를 Gold 관점 회차 값(`_trend.py` ~347 `overviewSlots.avgPosition`)으로 바꾼다.
  - 지금은 당사 브랜드별 위치를 HUB가 가중평균한다(`mention_view.py` `_own_weighted_position` · `own_position_series`, `mention_renewal.py` ~332 · ~551). 히어로 값은 Gold 관점 값이라 마지막 점과 어긋날 수 있다.
  - 원본 Global 위치 추이도 같은 함수를 쓰는지 보고 단계 메모에 적는다.
- [x] 5-4 Website KPI 세부 지표의 '전체 언급 수' 증가를 좋아짐(초록)으로 칠한다(`BS/mention_surfaces.py` ~65, `site-cards.tsx` ~213-216). 당사 지표가 아닌 셈(전체 언급 · 언급 브랜드 수 등)은 방향 색 없이 중립으로 칠한다.

**시험.** `test_screens_mention_renewal`, `test_screens_mention`, golden(mention), Mention render 시험, 원본 `/ko/standard/answer-analysis/mention` 대조(위치 추이).

---

### 6단계 — Mention ② 브랜드 순위 표 전체 · 열 정의

**읽을 파일**
- `BS/mention_renewal.py`: `BRANDS_TOP`(57), `shell_payload`(924-945), `ranking_payload`(1218-1250)
- `mention-brands.tsx`의 순위 표 부분(~520-630)
- 원본: `AA/brand-rank-table.tsx` 90-110
- 원본 열 정의 문구(grep: `colDefinition` · `colFormula`)

**할 일**
- [x] 6-1 101위 이후 브랜드를 볼 수 있게 한다(Global · Website).
  - 지금은 BFF가 먼저 100행으로 자르고, 검색도 그 100행 안에서만 된다(`mention-brands.tsx` ~537).
  - 원본 Global은 전체를 검색한 뒤 100행을 보였고, 원본 website는 전체 표(436행)였다.
  - 고친 뒤: 처음 100행, 전체 대상 검색, '더 보기'. 잘림 각주는 실제 전체 수로 쓴다.
  - 리더에 상한이 있는지 먼저 본다. 행이 수백 개 수준이면 전체를 보내고 화면에서 자르는 쪽이 단순하다.
- [x] 6-2 열 정의 · 산식 툴팁을 되살린다. 원본 브랜드 표와 서랍의 colDefinition · colFormula(평균 위치의 노이즈 제외, 언급률 · 점유율 산식 등)를 리뉴얼 표 머리 ⓘ로 옮긴다.

**시험.** render(전체 검색 · 더 보기), `test_screens_mention_renewal`, golden, e2e 한 번(101위 밖 브랜드 검색 → 행 → 서랍).

---

### 7단계 — Mention ③ 서랍 · 드릴다운

**읽을 파일**
- `BS/mention_drilldown.py` 전체
- `GR/drilldown.py` 1-60과 인용 도메인 읽기
- `mention-brands.tsx`의 서랍 부분(~700-900)
- 원본: `AA/citation-domain-table.tsx`(DomainRow)
- 원본 유형 드릴다운: website `view.typeAbs`가 부르는 BFF 화면(grep)

**할 일**
- [x] 7-1 서랍 › 인용 출처를 원본처럼 되살린다.
  - 지금은 URL 열이 늘 '—'다(`mention_drilldown.py` ~275-284 `to_citation_domain`이 `urls: []`, `mention-brands.tsx` ~845-853). 점유율 · 커버리지 · 당사 표시도 그리지 않는다.
  - 원본처럼 행을 펼치면 `&skey=` 상세를 읽는다: URL 제목 · 인용 수 · 엔진 · 프롬프트 · 국가, 프롬프트 목록.
  - URL 열은 상세를 읽은 뒤의 수로 채우거나, 빼거나 한다.
- [x] 7-2 서랍 목록 결함을 고친다(admin-todo 세션 메모 W2).
  - 증상: 어느 브랜드를 열어도 프롬프트 · 인용 출처 탭에 당사 목록이 나온다.
  - 원인: BFF는 `mention_brand=<이름>`을 보내는데, Gold 리더(`mention_prompts`, 인용 도메인 읽기)는 `brand_key`만 받는다.
  - 재현 시험부터 쓴다. 고치는 방법은 BFF가 `brand_key`를 보내거나 리더가 이름을 받는 것이다. 이름으로 `dim_brand.brand_key`를 찾는 것은 귀속을 바꾸지 않는다.
  - 원본 · 리뉴얼, Global · Website가 모두 고쳐진다.
- [x] 7-3 유형 → 프롬프트 드릴다운을 되살린다.
  - 원본은 유형 조각(website 당사 유형별 건수, Global 유형 차트)을 누르면 그 유형의 프롬프트로 내려갔다. 리뉴얼에는 Global 포함 없다(W2 메모 '그대로 남은 차이').
  - 원본이 부르던 BFF 드릴다운 화면을 재사용해 유형 카드 건수에 붙인다.

**시험**
- `test_screens_mention_drilldown`, Gold 리더 시험, render.
- e2e 한 번: 다른 브랜드로 서랍 열기 → 목록이 바뀜 → 인용 출처 행 펼침 → URL. 유형 → 프롬프트 → 답변 원문.
- 새 BFF 화면이나 프록시를 더하면 아키텍처 문서를 고친다.

---

### 8단계 — Mention ④ 귀속 · 트리맵 · bump [U1 · U2]

**읽을 파일**
- `BS/mention_renewal.py`: 36 · 116-200 · 579-690
- `GR/metrics.py` 175-210
- `mention-brands.tsx`의 트리맵 부분(~300-340)

**할 일**
- [x] 8-1 'HMG 계열' 배지를 이름 목록 `HMG_BRANDS` 대신 Gold `is_hmg_own`(`?include=`)으로 정한다(`mention_renewal.py` ~370 · 558 · 913 · 1229).
  - W6가 'golden 영향이 크다'며 남긴 항목이다.
  - U1이 '같음'이면 golden 출력은 그대로이고 tape만 바뀐다.
- [x] 8-2 `NON_AUTO` 이름 목록(~123-173 · 681)은 Google · Apple 등을 '자동차 외'로 묶고 트리맵에서 늘 접는다. 다른 그룹처럼 점유율 · 순서 규칙(`FOLD_SHARE` 1.5 · `FOLD_AFTER` 14)만 따르게 한다.
  - 원칙 판단: 표시 묶음은 사용자가 허용했지만, 늘 접어 숨기는 것은 숨김이다. 그래서 묶음 이름은 두고 늘 접는 것만 뺀다.
  - 비완성차 분류는 업스트림 질문 '비완성차 경쟁사'의 답을 따른다.
  - 점유율 · 순서 접기 자체는 표시 묶음이라 둔다.
- [x] 8-3 트리맵 Δ 색 구간(~318-330, `KO renewal.mention.treemap.steps`)은 |Δ| < 0.2pp를 '변화 없음' 색으로 칠한다. W6 기준(반올림해 0일 때만 '변화 없음')으로 바꾸고, 색 세기는 판정이 아닌 크기 눈금으로 둔다.
- [x] 8-4 U2가 '측정되지 않음'이면 bump의 빈 점을 0 대신 비워 둔다(`_trend.py` ~578, `mention_renewal.py` ~598-599).

**시험.** `test_screens_mention_renewal`, golden mention, render.

---

### 9단계 — Citation ① 결함 · 문구 · 귀속 [U2 · U3 · U4 · U6 · U9]

**읽을 파일**
- `BS/citation_model.py`: 110-260 · 380-400 · 500-560 · 760-1060
- `GR/citations.py` 40-180
- `BS/citation.py` 170-200
- `RN/standard/answer-analysis/citation/_components/citation-body.tsx` · `citation-domains.tsx` · `citation-subpages.tsx`
- 원본: `AA/type-category-chart.tsx`

**할 일**
- [x] 9-1 표본이 0인 유형 열을 고친다(Global · Website).
  - 지금: `to_type_category_rows`(~178-192)가 유형 5개를 0으로 채운다 → `type_matrix`(~901-908)에 total 0인 열이 들어간다 → `matrix`(~880-892)가 그 열의 비중을 0으로 둔다. typeGap 발견(~1019-1027)은 '추천 답변 0.0% — 40pp 낮음'까지 만든다. 프런트(`citation-body.tsx` ~798-809)도 n = 0을 막지 않는다. 원본은 '—'였다.
  - 고친 뒤: n = 0 열의 비중은 null('—')이고, live · 발견 · cap 계산에서 뺀다.
  - 재현 시험(모의 입력)부터 쓴다. U9의 실제 필터도 확인 자료로 쓴다.
- [x] 9-2 처방 문구를 사실만 말하는 문구로 바꾼다(ko · en 같은 키).
  - `renewal.citation.sub.positiveSub`: '유지·확산할 출처'
  - `renewal.citation.sub.negativeSub`: '대응 콘텐츠가 필요한 출처'
  - `renewal.citation.tone.subtitle`: '대응할 콘텐츠가 보입니다'
- [x] 9-3 Website 범프 범례 · 설명이 당사 도메인을 '공식(HMG) 도메인'이라 부른다(`renewal.citation.bump.legendOwn` · `bump.info`, `citation-domains.tsx` ~137). website에서는 W6 표 태그와 같게 '당사 도메인'으로 쓴다. Global은 그대로 둔다.
- [x] 9-4 U2가 '측정되지 않음'이면 인용 추이의 빈 점을 0 대신 비워 둔다(`citation_model.py` ~249-251).
- [x] 9-5 U3(답변 톤) · U4(`cit_m05`) · U6('당사' 태그)가 '다름'이면 Gold 정의로 맞춘다. 'Gold로 알 수 없음'이면 업스트림에 두고 고치지 않는다. U6는 Website Overview 출처 구성비의 '당사' 태그에도 쓰인다.
- [x] 9-6 출처 카테고리가 null인 행을 'Other'로 보인다(`citation_model.py` ~518, 긍정/부정 URL 행). Gold의 Other와 구분해 '—'로 보인다.
- [x] 9-7 도메인 표 · 서랍은 `route_context`가 website 계정 규칙을 'standard'로 읽고, 본문은 'website'로 읽는다(`citation.py` ~178-196). 전용 사이트 계정(2단계 뒤)에서 본문과 표 · 서랍의 국가 잠금이 같은지 확인하고, 다르면 website로 맞춘다.
- [x] 9-8 카테고리를 이름으로 찾는 곳을 slug(`dim_category.slug`)로 바꾼다(4단계 4-4와 같은 이유: 이름은 HUB 코드표 값이라 관리자가 고칠 수 있다). 대상은 `BS/citation_model.py`의 `OFFICIAL_COMPETITOR_CATEGORY`(경쟁사 고르기 · 카테고리 숨김 등, 단계 메모 '4단계'). 결과가 같으면 golden은 함수 case 입력만 바뀐다.
- [x] 9-9 **재현 안 됨.** 키는 처음부터 `messages/units/u7.{ko,en}.json`에 있었고 요청 때 `ko.json` · `en.json`과 합쳐진다. 진행 세션이 7단계 뒤 `ko.json`만 보고 '키 없음'으로 판단한 착오다. 9단계에서 `ko.json` · `en.json`에 넣은 중복 두 키는 9-9 후속 커밋에서 뺐다. 처음 적은 할 일: 리뉴얼 Citation 도메인 서랍이 쓰는 문구 키 `answerAnalysis.citations.drilldown.loading` · `loadFailed`가 ko · en에 없다(단계 메모 '7단계', 2026-10-31 진행 세션 확인: 그 아래 키는 noUrls · noUrlsOfficial · noPrompts · promptsTopOnly · cites · placeholder뿐). 읽는 중 · 실패 때 키 이름이 보이는지 render 시험으로 재현한 뒤 문구를 더한다.

**시험.** `test_screens_citation`, `test_gold_citations`, golden citation, 인용 render 시험, 원본 대조(Global · Website 인용).

---

### 10단계 — Citation ② 구성 추이 수치 · Website 도메인 표 전체 [3단계 부품]

**읽을 파일**
- `citation-body.tsx`: 출처 구성 카드 ~540-700
- `citation-domains.tsx` 220-260
- `BS/citation_model.py` 380-400
- 원본: `AA/citations-standard-view.tsx` 380-400, `AA/citations-view.tsx` 360-380 · 660-690 · 870-890 · 1030-1050

**할 일**
- [x] 10-1 출처 구성 추이의 회차별 수치를 되살린다(Global · Website).
  - 지금은 줄마다 스파크라인만 있고(~683-688), 카드 CSV(~566-569)에도 회차 값이 없다.
  - 원본은 회차 축, 툴팁(회차별 인용 수), 공백 음영을 보였고, 출처를 하나 고르면 절대 인용 수로 그렸다.
  - 고친 뒤: 3단계 스파크라인 툴팁(회차 · 비중 · 인용 수)을 쓴다. 표 보기 · CSV에 회차별 인용 수와 비중을 넣는다. 출처를 하나 고르면 선을 절대 인용 수로 그린다.
- [x] 10-2 Website 도메인 표 101위 이하를 볼 수 있게 한다.
  - 지금은 `LIMIT = 100`(`citation-domains.tsx` ~229 · 248-249)이다. BFF는 website 첫 쪽으로 200행을 보낸다(~393-396).
  - 원본 website는 200행씩 '더 보기'(`LoadMoreRow`)였다.
  - website에만 '더 보기'를 둔다. 서버 읽기는 원본과 같은 화면을 쓰고, 검색도 전체가 대상이다.
  - Global 원본은 상위 100이라 그대로 둔다.

**시험.** render, `test_screens_citation`, e2e 한 번(website 도메인 표 '더 보기' → 150위 행 서랍).

---

### 11단계 — ACR 발견 · 귀속 · 정렬 [U1]

**읽을 파일**
- `BS/acr.py`: 360-420 · 452-575 · 700-800
- `GR/acr.py` 30-110
- `RN/standard/ai-funnel/acr/_components/acr-body.tsx`(Hero ~340-380, 정렬, 지도 ~620-680)
- `KO renewal.acr.summary` · `find.*`

**할 일**
- [x] 11-1 발견(~452-520)을 W6가 Mention · Citation · Conversion에 쓴 방식으로 바꾼다. 고정 순서로 두고, 색은 방향만 나타내고, 문턱은 없앤다.
  - 지금 있는 문턱: 6pp(leak의 '비슷함'), −0.5pp(leak), 3개(engine), 3개(sweep), 0.5pp(mover), 3개(dist). `pri` 중요도로 상위 4개를 고른다.
  - leak: '후보군이 비슷한' 경쟁사를 고르는 것 자체가 문턱이다. '후보군 포함율이 가장 가까운 경쟁사와의 Top1 차'라는 사실로 바꾼다. 차가 반올림해 0이면 '같음'이다.
  - engine · sweep · dist: 값이 있으면 사실로 쓴다(엔진 2개 이상, sweep 1개 이상, 0 선택 프롬프트 1개 이상).
  - mover: |Δ|가 반올림해 0이 아니면 쓴다. 제목 '가장 큰 변화'는 최댓값이라는 사실이라 둔다(Mention · Citation과 같다).
  - 문구: `summary.how`('중요도를 매겨 4개'), `find.leak.title`('비슷하지만'), `find.sweep.detail`('콘텐츠 보강 후보')를 고친다.
  - golden `acr/*`가 바뀐다. README의 2026-10-30 'no HUB threshold' 항목에 ACR을 더한다.
- [x] 11-2 'HMG 계열' 배지를 이름 목록(~365 · 531-533) 대신 Gold `own_bit`으로 정한다. 리더가 브랜드마다 준다(`GR/acr.py` ~38 · 101). HMG 계열 = own_bit ≠ 0이고 관점 밖인 브랜드다. U1 결과를 확인한다.
- [x] 11-3 차종 당사 판정(~567)은 Gold `isOurs` 또는 부모 브랜드 이름 일치다. Gold `isOurs`만 쓴다.
- [x] 11-4 원본 정렬 5종 가운데 리뉴얼에 없는 이름 · 선택 수 · 언급 수 정렬을 브랜드 표에 되살린다.
- [x] 11-5 촘촘 모드에서 Hero의 '당사 = … 합산' 칩이 숨는다(`acr-body.tsx` ~363-366). 정보이므로 숨기지 않는다.
- [x] 11-6 필터 무시 · 제외 안내(`filter_notices`, ~161)는 계산되지만 어느 화면에도 보이지 않는다(원본도 같다). 무시된 필터를 알리지 않으면 사용자는 그 필터가 걸린 줄 안다. 그래서 보이게 한다.

**시험.** `test_screens_acr`, `test_gold_acr`, golden acr, ACR render, 원본 `/ko/standard/ai-funnel/acr` 대조(브랜드 표).

---

### 12단계 — AI Conversion 부분합 · 문구

**읽을 파일**
- `HS/analytics_reader.py` 180-260
- `BS/conversion.py` 70-320
- `RN/standard/ai-funnel/conversion/_components/conv-body.tsx` · `conv-insights.tsx`
- `back/analytics/ga4_collect.py` 20-30 · 440-450
- `KO renewal.conversion.status` · `states` · `findings`

**할 일**
- [x] 12-1 부분합을 없앤다.
  - 빠진 날이 있으면 합계 · 일별은 '모름'으로 나온다(W6).
  - 그런데 다음 값은 부분합이 나가고, 비중 · 순위도 그 부분합으로 계산된다(`conversion.py` ~93-114 · 174-196): 엔진(`analytics_reader.py` ~211-213), 채널(~216-218), 세그먼트 전환(~223-224), 입구 페이지(~227-233), 이벤트 수(~234), 시장 전환(~245 · 248).
  - 같은 규칙으로 맞춘다: 창 안에 빠진 날이 있으면 '모름'이다.
  - 원본 표도 같은 리더라 같이 바뀐다.
- [x] 12-2 '사이트 전체'라는 이름이 두 정의에 쓰인다. Hero는 report 5 합계(`conversion.py` ~81, `conv-body.tsx` ~278-284)이고, 채널 카드는 채널 행 합(~104-109, `conv-insights.tsx` ~69-79)이다. 이름을 나누거나 한 정의로 맞춘다.
- [x] 12-3 '시장 미연결'(`status.unmapped`, `states.pendingDesc`, `findings.coverage.detail`)을 '수집 중지'로 바꾼다. 수집기에서 `unmapped`는 관리자 중지다. 속성 칩의 total(~213)과 coverage의 total(중지 제외, ~253)도 같게 맞춘다.
- [x] 12-4 결과 없음 문구 `states.nomatchDesc`의 '국가 선택지는 답변 측정 국가'는 W0 변경 뒤로 맞지 않는다(지금은 GA4 속성 국가). 고친다. `renewal.visibility.states.nomatchDesc`는 숨긴 화면이라 그 화면 사실에 맞는지만 본다.

**시험.** `test_screens_conversion`, `test_analytics`, Conversion render. GA4 수집 전이라 실제 화면 대조는 없고 fixture로 본다.

---

### 13단계 — Prompts 귀속 · 계정 범위 · 선택지 [U8 · U12]

**읽을 파일**
- `BS/standard_prompts.py` 60-180
- `GR/catalog.py` 1-60
- `RN/standard/prompts/_components/prompts-view.tsx` 280-400
- 원본: `LG/standard/prompts/_components/prompt-list-readonly.tsx` 420-501
- 원본 API의 프롬프트 목록 범위(`back/app`, grep `prompts`)
- `docs/design/api/모듈-프롬프트.md` ~95

**할 일**
- [ ] 13-1 브랜드 포함 여부 유추를 없앤다.
  - 지금은 Gold 값이 비면 BFF가 브랜드로 정한다(`presence_of` ~67-73: HMG → 미포함, 그 외 → 포함). 이 값이 열 · 필터(~149) · 정렬 · 엑셀에 쓰인다.
  - 고친 뒤: Gold 값만 쓴다. 빈 값은 '—'이고, 필터 선택지에는 '값 없음'으로 둔다.
  - 원본 API 설계(`presence_effective`)에서 온 규칙이라 원본 화면도 바뀐다. U8로 빈 값이 몇 개인지 먼저 본다.
- [ ] 13-2 측정 종류 기본값(~84 `kind or "single"`)을 없앤다. 빈 값은 '—'로 보인다.
- [ ] 13-3 계정 국가 범위를 맞춘다.
  - 화면 안내(`prompts-view.tsx` ~392, 원본 489-501)는 '대상 시장이 내 국가를 포함하거나 미지정인 프롬프트만 보인다'고 한다. 그런데 Gold 리더 global 분기(`GR/catalog.py` ~33-49)는 국가를 쓰지 않는다(gold-metric-review #3).
  - 먼저 원본 API가 국가를 걸었는지 본다. 걸었으면 같게 건다(U12). 아니면 문구를 사실대로 고친다.
  - 열람 범위 pill에서 국가 목록 전체를 볼 수 있게 한다(원본 드롭다운 420-481, 리뉴얼 ~294-301).
- [ ] 13-4 Website 프롬프트의 브랜드 선택지를 화면 값으로 바꾼다.
  - 지금은 화면이 준 `brandOptions` 대신 고정 목록 `DIMENSIONS.brand`(`front/components/dash/dimension-filter-panel.tsx` ~196)를 쓴다.
  - W0 공통 `OverviewPanelInput`(`RN/_components/overview-filter-model.ts`)에 선택지를 넘기는 길을 둔다.
  - 지금 값은 같다(Genesis · Hyundai · Kia).

**시험.** `test_screens_standard_prompts`, `test_screens_website_prompts`, 필터 parity 시험, 프롬프트 render.

---

### 14단계 — 기간 비교 억제 ⛔K

**문제.** 아래 경우 Δ를 숨기고 경고한다(`GR/compare_logic.py` ~25-36 · 183-228, 화면 쪽 사본 `BS/_period.py` ~156-160 · 256-281).
- 수집분이 계획의 70%에 못 미칠 때(`MISSING_SHARE_MAX = 0.3`)
- 시작 유예 기간일 때(`grace_days = ceil(days/4)`, 달력 월은 첫 측정이 7일 뒤)
- 적용일(`PERIOD_COMPARE_EPOCH` 2026-09-08) 전일 때

Website 인용 도달 Δ도 값 출처(발행 / 실시간)가 다르면 숨긴다(`BS/citation.py` ~465-473). 모두 규칙 5('범위가 달라도 숨기거나 경고하지 않는다')와 맞지 않는다. 원본 API 명세(`docs/design/api/모듈-KPI.md` 115-118)에 있는 규칙이다.

**추천안(⛔K)**
- 비교할 값이 없는 경우(`unsupported` · `no_prev` · `no_data`)의 억제만 남긴다. `missing_share` · `start_window` · `start_month`와 적용일 게이트는 뺀다.
- 도달 Δ는 출처가 달라도 보이고, 값 출처 각주는 둔다.

**읽을 파일**
- `GR/compare_logic.py`, `BS/_period.py`
- 쓰는 곳: `grep -rn "suppression_of\|compare_suppress\|missing_share" back/bff`
- `BS/overview.py` ~949-951, `BS/citation.py` ~455-500
- 화면의 억제 문구(grep `suppression`)
- `docs/design/api/모듈-KPI.md` 해당 절

**할 일**
- [ ] 14-1 억제 사유를 뺀다. 쓰지 않게 된 억제 문구와 키를 정리한다.
- [ ] 14-2 명세 문서에 '2026-10-31 HUB 규칙 5로 뺌'을 적는다. golden(ov · overview · mention · citation 기간 case)을 README에 기록한다.
- [ ] 14-3 원본 화면도 같은 로직을 쓴다. Global · Website Overview와 Mention의 기간 모드를 한 번씩 확인한다.

**시험.** `test_period_basis`, `test_exact_deltas`, `test_screens_ov` · `overview` · `mention` · `citation` · `conversion`, golden 전체.

---

### 15단계 — HUB가 만든 평균 기준선 · 분해 ⛔L

**대상**
- Mention 히어로의 '경쟁사 평균' 추이선. 회차마다 상위 10 경쟁사 값을 평균하고, 값이 없는 브랜드는 빠지므로 회차마다 평균하는 집합이 바뀐다(`BS/mention_renewal.py` ~384-406 `hero_trend_series`).
- Mention 유형별 경쟁사 평균(상위 5, `TYPE_AVG_TOP`, ~438-486)과 그 값을 기준으로 삼는 typeTrail · typeLead 발견(~716-731).
- ACR '브랜드 평균선'(k = ΣTop1 ÷ Σ포함율)과 '평균선 대비' 편차(`BS/acr.py` ~414-416 · 722, `acr-body.tsx` ~627-677, `KO renewal.acr.map.*`).
- Conversion 전환 변화 분해. 직전 기간의 세션당 전환을 기준으로 유입 몫과 효율 몫을 나눈다(`BS/conversion.py` ~128-144).

**남기는 것.** 원본에 있던 엔진별 '당사 vs 경쟁사 평균'(레거시 KPI, `BS/mention_view.py` ~399-424).

**추천안(⛔L).** 리뉴얼에서 새로 만든 기준선과 분해는 뺀다. 대신 다음을 보인다.
- 비교 브랜드 선(이미 있다)
- ACR 산점도의 점(선 없이)
- 두 요인(세션 수 · 세션당 전환)의 값과 Δ를 나란히

발견 문장은 비교 브랜드 기준으로 다시 쓴다.

**함께 할 일(진행 세션이 11단계 뒤 더함).** 당사 순위(standing) 발견은 격차 변화가 반올림해 0.0이어도 '좁혀졌습니다'로 읽힌다(Mention · ACR, 단계 메모 '11단계'). W6 기준대로 반올림해 0이면 '변화 없음'으로 쓴다. 발견 문장을 다시 쓰는 이 단계에서 같이 고친다.

**시험.** 해당 모듈 시험 · golden · render. 원본에 없던 것이라 원본 대조는 없다.

---

### 16단계 — 마무리

- [ ] 바뀐 화면을 원본과 같은 조건으로 한 번씩 대조한다(Global · Website의 Overview · Mention · Citation · ACR · Prompts). 다른 값이 단계 메모에 적은 의도한 변경인지 본다.
- [ ] BFF 전체, 프런트 관련 시험 · typecheck · lint를 돌린다.
- [ ] 아키텍처 문서의 '마지막 갱신' 줄을 고친다.
- [ ] 1단계에서 보강한 업스트림 질문 묶음을 사용자에게 알린다. 사용자가 보낸다.
- [ ] 보류한 것을 admin-todo에 남긴다.
  - AI 가시성: 메뉴에서 숨겼다. HUB 기준선 · 문턱이 많고 `rule_ver` · 원자료가 빠져 있다. 메뉴를 다시 열 때 다룬다.
  - Website ACR: ⛔H.
- [ ] admin-todo의 '지금 할 일'을 다음 일(Admin 3단계 범위 확인)로 바꾸고, 진행 기록과 CLAUDE.md 최우선 작업 줄을 고친다.
- [ ] 사용자 확인을 받는다.

---

## 고치지 않는 것 (점검에서 보고 판단을 마침)

다시 점검하지 않는다.

- **레거시 KPI라 남긴다(규칙 7).** 엔진 간 일관성(최저 ÷ 최고), 경쟁사 대비 SOV, 엔진별 경쟁사 평균.
- **표시 눈금이라 판정이 아니다.**
  - 인용: Δ 축 최소 ±0.5pp, 스파크라인 세로 범위 최소 2pp, 매트릭스 색 포화 최소 3pp
  - Prompts: 시장 표의 ¼ 단위 색, TOP 8 보기
  - Conversion: 막대 안 라벨(10% 이상일 때)
- **표시 묶음이다.** 브랜드 → 모그룹 `GROUPS`, 트리맵 점유율 · 순서 접기('그 외').
- **Gold가 준 공백 사유로 숨기는 것.** collection_error · hidden, Prompts 렌즈의 servable 회차.
- **W6가 남긴 것.** `pct1_or_zero`(원본 계약), 카테고리 추이의 빌드 시점 category_key.
- **의도한 변경이고 정보는 남아 있다.**
  - Mention: 당사 브랜드별 행 · 선을 당사 합산 1행 · 1선으로(브랜드별 값은 순위 표 · 필터에 있음), 비교 브랜드는 최대 3개를 페이지 전체가 같이 씀, 유형 카드의 '기타' · '전체' 행 없앰(값은 계산하면 나오거나 히어로와 같음).
  - Citation: 도넛 → 구성 줄, 엔진 · 유형 차트 → 매트릭스, Website 프롬프트 상위 5에서 답변 원문 · 퍼널 배지를 하위 화면으로 옮김.
  - ACR: 시트 범례를 당사 · 비교 · 그 외로 바꿈(이름은 툴팁 · CSV에 있음), 추이를 당사 + 비교 3선으로 줄임(브랜드별은 Board 스파크라인).
- **이상 없음.**
  - 측정 방식 변화로 값을 숨기는 코드(`metric_version` 등)는 0건이다.
  - W6가 뺀 문턱은 Mention · Citation · Conversion에 남아 있지 않다.
  - Prompts에는 원칙 위반이 없다.
  - 모바일 브레이크포인트 · 밀도 토글은 없다. 좁은 폭 대비용 컨테이너 쿼리만 있다.
  - Website Conversion은 Global과 같은 본문 · 숫자다.

## 확인 결과 (1단계가 채운다)

2026-10-31에 Gold 읽기 전용 계정으로 SELECT만 해서 확인했다.
- **기준.** live global = release 603, live website = release 3647이다. 빌드는 `release_item`(state ready) ⋈ `build`(status validated)이고, 회차 하나는 `dim_cycle`의 slice_key `cyc:<cyc_key>`로 찾는다. release 번호는 Gold가 다시 발행하면 바뀐다. 다시 돌릴 때는 `active_release`(scope, read_mode live)에서 읽는다.
- **조건.** 리더와 같다. global은 `bgrp & (관점 비트 | 8) <> 0`이다. 언급은 population 1, 인용은 population 2, 관점은 `dim_perspective.own_bits`로 고른다. HMG = 7, Hyundai 1 · Kia 2 · Genesis 4다.
- **접속.** psql에 `.env.gold.local`의 URL을 쓰고 `PGOPTIONS='-c default_transaction_read_only=on'`을 건다. U10은 리더 함수 `bff.gold_reader.compare.read`를 읽기 전용 asyncpg 세션에서 직접 불렀다. 로컬 API는 로그인이 필요하다.

| ID | 결과 | 근거(쿼리 · 수치) | 다음 |
|---|---|---|---|
| U1 | **다름(ACR만)** · 업스트림 D1 | **Mention · Overview는 같다.** `dim_brand`에서 own_bit ≠ 0인 브랜드는 Hyundai(1) · Kia(2) · Genesis(4) 셋뿐이다. 이름은 유일하고, 나머지 5,270개는 own_bit 0이다. 그래서 이름 목록과 Gold `is_hmg_own`(= `bool(dim_brand.own_bit)`)이 같은 브랜드를 고른다. **ACR은 다르다.** `acr_entity_fact`(level 1 · keep) ⋈ `dim_brand`를 release 603 acr 빌드로 좁혀 `x.own_bit<>0 OR b.own_bit<>0`로 묶었다. 그 행의 own_bit('명부')가 0이 아닌데 dim_brand.own_bit = 0(kind 2)인 이름이 둘이다. '제네시스 마그마'는 own_bit 4, 5행 · appearance 5 · choice 0(08-24 · 09-07 · 09-14)이다. 'Hyundai Canada'는 own_bit 1, 2행 · appearance 2 · choice 0(09-14)이다. 리더는 이 둘을 `x.own_bit & 관점`으로 당사로 세지만, 이름 목록에는 없다. | 8 · 11 |
| U2 | **같음(0회)** | 두 셀 표 모두 0인 행을 두지 않는다. `brand_cell`(release 603 cell) 3,843,121행의 mention_count 최솟값은 1이고, `citation_cell` 14,553,380행의 citations 최솟값도 1이다. release 603 · 3647의 cell · fact · acr 빌드는 모두 `build.ecat_ver` 01a173a4 하나다. 엔티티 카탈로그가 회차마다 같다는 뜻이다. 그래서 범위 안에 답변이 있는 회차(kpi_cell 행 있음. kpi_cell은 '언급 · 인용이 0이어도 분모 셀을 남김')에 행이 없는 브랜드 · 도메인은 0회다. 측정 안 됨은 답변이 없는 회차 · 범위뿐이다(리더 gap). 예외가 하나 있다. smart · Cruise(kind 3)는 같은 release 안에서 `competitive`가 행마다 다르다. smart는 경쟁 행 179 · 비경쟁 행 740 언급, Cruise는 8 · 15다. 그 회차에 비경쟁 행만 있으면 경쟁 추이에서 0으로 보인다(D3). | 8 · 9 |
| U3 | **같음** | 10-05 global HMG를 보았다. `citation_cell` Σcit_pos는 561,946, Σcit_neg는 16,284다. `citation_fact` ⋈ `answer_fact`(전체 키)를 cit_in으로 좁히고, p = Σsent_pos_{h,k,g}, n = Σsent_neg로 셌다. p > n은 561,946, n > p는 16,284로 정확히 같다. p = n(0 포함)은 빠지고, 0이 아닌 동점은 7,739건이다. Kia 관점(sent_*_k만)도 203,225 · 5,228로 같다. | 9 |
| U4 | **같음** | Gold 설명은 'global cit_m05 = Σcit_off(카테고리 Official (HMG))'이다. kpi_cell(pop 1)의 Σcit_m05 · Σcit_total과 citation_cell(pop 2)의 category_key 1 인용 · source_key ≠ 0 인용을 비교했다. 회차 × 국가 × 엔진이 HMG 659칸, Kia 483칸, Hyundai 471칸 모두 같다. 10-05 HMG는 233,628 / 935,276 = 24.98%다. 빌드 시점 `citation_cell.category_key`와 지금 `dim_source.category_key`로 센 Official(HMG) 수도 지금은 같다. | 9 |
| U5 | **같음** | kpi_cell(pop 1, 관점)의 sent_pos · sent_all과 brand_cell(pop 1, own_bit & 관점, 모두 competitive)의 s_pos · (s_pos + s_neu + s_mix + s_neg)를 비교했다. 회차 × 국가 × 엔진이 HMG 659칸, Kia 483칸 모두 같다. website(release 3647) HMG도 14회차 모두 같다(Σ 2,745,087). sent_all = 감정 4종 합 = 당사 언급 수다(10-05 HMG 325,173). | 4 |
| U6 | **다름(작음)** · 업스트림 D2 | 당사 태그는 그 출처 인용 중 하나라도 표면별 자사인 경우다(global owner_key ∈ owned_base(brand_bit & 관점), website loc_owned ∨ tgt_hit). 이것과 `dim_source.owned_brand_bit`를 비교했다. **global HMG 14회차:** 태그 39 · 비트 40. 비트에만 있는 것은 kia.pt 하나다(09-28 1건, URL owner_key 없음). 태그에만 있는 것은 0이다. **10-05:** 33 · 34. 비트에만 있는 것은 hyundai.lt다(9건이 모두 cars.hyundai.lt URL이라 base `hyundai.lt`에 맞지 않음). Kia 10-05는 12 = 12다. **website 전 회차:** 태그 54 · 비트 42. 태그에만 12개가 있다. hyundai.pe(13,361/13,478) · hyundaipr.com · beijing-hyundai.com.cn · kia.cn · hyundaiksa.com · kiavietnam.com.vn · kiaphilippines.com · hyundaicolombia.co · hyundai-me.com · kia.uz · hyundai-n.com.cn · kia.am이다. 8개는 dealerMarketplace, 4개는 officialHmg이고, 모두 category_src 5다. 태그는 Gold 표면별 자사 정의(`citation_cell` 설명)를 따르고, 비트는 도메인 단위 '당사 공식 도메인'이다. | 9 |
| U7 | **다름(전부)** | Gold `dim_region.code`는 대륙(Africa · Asia · Europe · Latin America · Middle East · North America · Oceania · 빈 코드)이다. 표 설명도 '계정 권역(RHQ)과는 다른 개념'이라고 한다. HUB `RHQ_REGION_COUNTRIES`의 id 19개(hyundai-* · kia-* · genesis-*)와 겹치는 id는 0개다. geo 리더는 `region_id` = 대륙 코드를 보내고 `pending`은 늘 []다. 그래서 `countries_for_rhq(m["region"])`는 늘 비고, 지도는 market 자기 국가로 칠한다. '측정 예정'은 행이 없을 때(`empty_geo`)만 RHQ id로 나온다. 측정 국가(release 603 global kpi_cell)의 대륙은 Europe 25 · Asia 9 · Middle East 7 · Latin America 4 · North America 3 · Africa 1 · Oceania 1 · 빈 코드 2(CO · VN, B5)다. 소속도 다르다. MX는 Gold North America이고 kia-central-south-america에 든다. AU는 Oceania이고 *-asia-pacific에 든다. KZ는 Europe이고 genesis-asia-pacific에 든다. | 4 |
| U8 | **같음(빈 값 0)** | release 603 fact 빌드의 `catalog_entry`를 catalog_row_id마다 최신 빌드 한 행으로 셌다. 12,164행, 프롬프트 11,903개다. kind 빈 행은 0이다(single 11,184 · acr 980). presence 빈 행도 0이다(`dim_taxon` branded 6,376 · unbranded 5,788). brand_bit이 {1, 2, 4, 8} 밖인 행도 0이다(1 5,548 · 2 5,408 · 4 1,208, 엄브렐러 8 · 0 · NULL 행 없음). 그래서 `presence_of`의 대체 규칙과 `kind or "single"`은 쓰이지 않는다. `common`(brand 없음 · HMG)도 지금은 한 행도 참이 아니다. | 13 |
| U9 | **다름(생김)** | citation_cell(pop 2, 관점)의 cit_t_{5종}을 회차 × (엔진 × 국가 · 엔진 · 국가 · 언어)로 합했다. release 603 14회차에서 한 열 이상이 0인 조합은 다음과 같다. HMG는 엔진 × 국가 77/656(8회차), 국가 35/331, 엔진 7/28, 언어 17/197이다. Hyundai는 엔진 × 국가 103/467, 다섯 열 모두 0인 것 13이다. Kia는 76/480 · 9, Genesis는 107/314 · 29다. 필터 없는 HMG에서도 definition이 07-06 · 07-13 · 07-20에 0이고, final_choice가 07-06에 0이다. 10-05 HMG 엔진 × 국가는 0건이다. 같은 날 Genesis AT는 다섯 열 모두 0이다(인용 181). Hyundai CH도 다섯 열 모두 0이다(인용 111). | 9 |
| U10 | **같음(요청하면 줌)** | 리더 `compare.read`(`kpi/compare`)는 metrics[]에 `mentions_per_answer`가 있을 때만 돌려준다. 기본 5개(visibility · share_of_voice · sentiment · position · citation_share)에는 없다. BFF는 `MENTION_COMPARE_METRICS` → `COMPARE_METRIC_TO_API`로 요청한다. 값은 num = own_mentions, den = answers다. global cycle 09-28 → 10-05는 315,562/45,500 → 325,173/44,979, Δ +4.2%(단위 pct, 억제 없음)다. website 10-02 → 10-09는 169,602/19,859 → 270,247/20,219, Δ +56.5%다. | 5 |
| U11 | **다름(수치)** | Gold 관점 값은 kpi_cell Σrank_sum / Σranked다. 복수 관점은 답변 단위 '0을 뺀 최솟값'이다(`dim_perspective` 규칙). 당사 브랜드 가중평균은 brand_cell(own_bit & 관점, competitive)의 Σrank_sum / Σranked다. **global HMG:** 10-05에 Gold 2.353(81,064/34,452), 가중 3.283(164,635/50,154), +0.93이다. 14회차 차이는 +0.69(08-03) ~ +0.98(08-24)이다. **website HMG:** 10-09에 1.070 · 1.188, +0.12다. 14회차는 +0.10 ~ +0.20이다. 단일 브랜드 관점(Hyundai)은 14회차 모두 같다(차 0). | 5 |
| U12 | **같음(있음)** | `dim_prompt.regions`(text[] 'Scope 시장 태그')를 global 카탈로그 프롬프트 11,903개에서 보았다. 모두 1개 이상의 값이 있다(1개 9,520 · 여러 개 2,383, 최대 22). 값은 ISO alpha-2 52종이고 가상 코드(x:)는 없다. 측정된 11,401개는 답변 국가(answer_fact std_in의 geo)가 모두 태그 안에 있고, 11,109개는 정확히 같다. 리더 `GR/catalog.py` prompts가 이미 `p.regions`를 읽어 행 `regions` · `markets`로 보낸다. | 13 |

## 단계 메모 (다음 단계가 알아야 할 것, 단계마다)

- **1단계(2026-10-31).** 코드는 고치지 않았다. 재현 시험 대신 Gold SQL로 확인했고, 근거는 '확인 결과' 표에 있다. 업스트림 질문은 `upstream-questions-2026-10-30.md`의 'D. 2026-10-31 점검'(D1~D7)으로 더했고 사용자가 보낸다. 다음 단계의 할 일에 걸리는 것은 아래와 같다(단계 절 본문은 고치지 않았다).
  - **4단계.** U5가 같으므로 당사와 경쟁사의 우호도 분모는 같은 정의다(감정 4종 합 = 언급 수). U7은 Gold 대륙 코드와 HUB RHQ id가 하나도 맞지 않는다. 권역을 칠하거나 측정 예정을 Gold 값으로 맞추려면 Gold에는 RHQ 표가 없다는 것을 전제로 한다. HUB 계정 권역 표와 대륙은 다른 개념이다.
  - **5단계.** U10: 답변당 언급 수 Δ는 Gold 리더가 이미 준다(요청할 때만). U11: 당사 평균 위치를 브랜드 행 가중평균으로 내면 HMG에서 Gold 관점 값보다 0.7~1.0(global), 0.1~0.2(website) 크다. 단일 브랜드에서만 같다. Gold 관점 값(kpi_cell)을 쓰는 쪽이 Gold 정의다.
  - **8단계.** U1: Mention에서는 이름 목록과 Gold 플래그(`dim_brand.own_bit`)의 결과가 같다. 바꿔도 출력이 같다. U2: 회차에 브랜드가 없으면 0으로 두는 지금 처리가 Gold 뜻과 같다. 공백은 답변이 없는 회차뿐이다.
  - **9단계.** U2: 인용 도메인 추이의 0도 맞다. U3 · U4는 같아서 고칠 방향이 없다. U6: 당사 태그는 Gold 표면별 자사 정의를 따른다. `owned_brand_bit`로 바꾸면 global 10-05에서 hyundai.lt가 더해지고, website에서는 자사 사이트 12개(hyundai.pe 등)가 빠진다. U9: 유형 열 합이 0인 경우가 실제로 생긴다. 10-05 HMG에서는 없고, 단일 브랜드 · 7월 회차 · 엔진 × 국가에서 생긴다(예: Genesis AT, Hyundai CH는 다섯 열 모두 0).
  - **11단계.** U1이 ACR에서 다르다. 이름 목록 대신 Gold 플래그(`acr_entity_fact.own_bit`)를 쓰면 '제네시스 마그마' · 'Hyundai Canada'가 당사(HMG)로 바뀐다. 영향은 live release에서 7행 · appearance 7 · choice 0이다. 명부(`acr_entity_fact.own_bit`)는 ACR 리더가 이미 당사 판정(`is_ours` · `own_cells`)에 쓰는 값이다. `dim_brand.own_bit`로 고르면 지금 이름 목록과 결과가 같다. 두 Gold 값이 서로 다른 것은 D1로 물었고, HUB는 어느 쪽도 고쳐 쓰지 않는다(규칙 5).
  - **13단계.** U8: 빈 값 대체 규칙이 쓰이는 행이 지금 없다. 엄브렐러(brand_bit 8) 행도 없어 '공통' 배지는 0행이다. U12: 계정 국가를 걸 Gold 값 `dim_prompt.regions`가 모든 행에 있고 리더가 이미 보낸다. 측정 국가와도 맞는다. Hyundai N(bit 16, D4)은 website 프롬프트 이야기다.
  - **2단계.** U와 관계없다(⛔J는 admin-todo에서 결정됨, `34a3980`).
- **2단계(2026-10-31).** ⛔J 추천안대로 website를 범위 계정에게 열었다. project는 그대로 403이다.
  - **2-1 재현.** 고치기 전에 실패했다. BFF 시험은 clamp website 2개 · 경로 1개였다(`test_hub_accounts`). 실제 API에서도 권역 계정(Genesis · genesis-middle-east)의 `overview/filters`(website) · `website/prompts-options`가 403 `out_of_scope`였다.
  - **2-2 clamp.** `access.clamp`가 website도 global과 같은 브랜드 · 국가 범위로 바꾼다. 국가는 사이트 국가다. 원본 website 규칙(`back/app/core/auth.py` `website_scope_countries`, 프런트 `withPseudoCountries`)처럼 SA가 범위에 있으면 도시 사이트 SA-Dammam · SA-Jeddah · SA-Riyadh도 읽는다(`access.surface_countries`, `_query.with_pseudo_countries`). 권역 허브 사이트(worldwide · EU · MIDDLEEAST · CPO · CN-BJ)는 국가가 없는 HQ 계정만 읽는다. 패널에서 도시 사이트를 고르면 그대로 걸린다(`read_standard_filters`의 website 허용 목록).
  - **2-2에서 같이 고친 것(원본 규칙, 재현 시험이 고치기 전에 실패).**
    - 패널 선택지가 계정 범위로 좁혀지지 않았다. global도 같았다. Gold 선택지 읽기(`metrics.options`)는 국가 축으로 좁히지 않는다. 그래서 권역 계정 Global 패널에 Genesis 국가 28개가 보였다(범위 6개). 읽기는 clamp가 막아 값이 새지는 않았다. `_filters.fetch_filter_options`가 범위 밖 국가의 매트릭스 · 국가 · 언어 행을 뺀다(`options_in_countries`). 원본 API의 선택지 규칙(범위 교집합)과 같다. 관리자 · HQ는 그대로다.
    - Website Overview 시장별 현황(`website/geo`)이 브랜드 하나인 범위 계정에게 비었다. `active_brand_of`에 원본 `activeBrandFor`의 '범위 브랜드가 하나면 그 브랜드'가 빠져 있었다.
    - Website Overview(`/renewal/website`)가 관리자를 포함한 모든 계정에서 오류 화면이었다(`f28395f`부터). 서버 페이지가 `"use client"` 모듈(`website-format.tsx`)의 `engineLabel`을 불렀다. 엔진 이름표를 일반 모듈(`components/dash/engine-label.ts`, 패널이 다시 내보냄)과 `_overview/engine-label.ts`로 옮겼다. 시험은 `engine-label.test.ts`다. 따로 커밋했다(`ae8da9d`).
  - **2-3 재현 안 됨(해당 없음).** HUB 계정은 전용 사이트 코드(worldwide · CPO · HYUNDAI-N)를 가질 수 없다. 계정 관리가 계정 RHQ 권역의 ISO 국가만 받는다(`accounts.scope_of`). 시험 `test_no_account_holds_a_dedicated_site_code`로 확인했다. admin-todo 세션 메모 W0의 차이('전용 사이트 계정의 국가 잠금')는 HUB에서 생기지 않는다. 화면 쪽 전용 사이트 규칙(`website_dedicated_codes`)은 쓰이지 않는 채로 둔다.
  - **2-4.** `access.py` docstring과 아키텍처 문서 '읽기는 계정 범위 안에서만 한다' 항목 · '마지막 갱신'을 고쳤다. 화면 빌더 수는 그대로다.
  - **원본 대조.** 권역 계정의 기본 화면과 관리자가 같은 범위(brand=Genesis, 국가 = 범위 + 도시 사이트)를 직접 고른 화면을 BFF로 비교했다. `website/summary` · `summary-deferred` · `trend` · `composition` · `geo`, `mention/rn-summary` · `rn-ranking` · `rn-page` · `view-cards` · `view-weekly`, `citation/as-of`, `website/prompts-page` · `prompts-insights`가 같다. `citation/website`는 값이 같고 URL 쿼리 메아리만 다르다. 다른 것은 의도한 차이다. `citation/filter-bar` 선택지는 관리자에게 좁히지 않는다. `conversion/renewal`은 계정이 읽는 GA4 속성이 없어 noprop이다(관리자는 nomatch). 원본 `/ko/website`도 같은 계정으로 열리고 KPI 숫자 22개가 리뉴얼과 같다(예: 노출률 99.7% = 1,189/1,192, 당사 언급 16,430/17,865). 관리자 숫자는 바뀌지 않는다(golden 그대로).
  - **e2e(24항목 통과).** 권역 계정으로 Website 5화면을 열었다. 국가 선택지는 AE · BH · KW · OM · QA · SA-Dammam · SA-Jeddah · SA-Riyadh(AI Conversion은 없음)이고 브랜드 축은 없다. 실패 요청은 없다. 아랍에미리트를 고르면 걸린다. `?geography=DE`는 범위 기본값으로 읽고 DE는 선택지에 없다. 원본 `/ko/website` 숫자도 같다. Global 4화면의 국가 선택지도 범위 6개다. 시험 계정 `audit2-region` · `audit2-country` · `audit2-hq@local`은 관리자 API(사용자 관리 화면과 같은 경로)로 만들었고 끝나고 중지했다.
  - **다음 단계가 알 것.** 범위 계정의 패널 선택지는 이제 global · website 모두 계정 국가 안이다. 범위 계정의 website 읽기 쿼리에는 SA가 있으면 도시 사이트 코드가 붙는다. Website Overview는 2단계에서 처음 실제로 열렸다(관리자 포함). 3단계 이후 Overview 화면을 고치면 실제 화면으로 한 번 연다.
- **3단계(2026-10-31).** 여섯 항목 모두 재현 시험이 고치기 전에 실패했고, 고친 뒤 통과했다.
  - **3-1.** `RnSparkline`에 선택 prop `tips`(값마다 글 하나, null = 그 점 없음)를 더했다. 있으면 점마다 hover · 초점 영역(`spark-tips.tsx`, 이웃 점과의 중간까지)이 생기고, 공용 `useRnTruncTip` 툴팁과 접근 이름(aria-label)으로 글을 보인다. 올리거나 초점을 둔 점에는 고리가 생긴다. 없으면 svg가 예전과 바이트까지 같다(새 시험 `sparkline.render.test.tsx`가 고치기 전 출력을 고정). 영역은 카드 전체 링크 위에 있다(카드의 ⓘ와 같은 `z-[1]`). 그래서 스파크라인 띠를 누르면 페이지가 열리지 않고, 카드의 나머지 곳은 그대로 연다(실제 화면에서 확인).
  - **3-2.** Global Overview 카드 스파크라인 점마다 '날짜 · 값'과 '직전 회차 대비 ▲/▼Δ'를 보인다. Δ는 `overview/card-trend` 점의 `wow`(두 Gold 값의 차, 한 번 반올림)이고 0이면 '변화 없음'이다. 그리는 첫 회차와 값 없는 회차 바로 뒤는 Δ 줄이 없다(원본과 같음). 같은 날 두 회차는 앵커 시각을 붙인다. 원본 `/ko/dashboard` 툴팁과 대조했다: 노출률 9/7 73.8% · 9/21 76.3% −0.3pp · 10/5 76.6% −0.2pp, 우선 노출도 2.2 · 2.2 −0.1 · 2.3 +0.1로 같다.
  - **3-3.** 당사 SOV 분자가 없으면(`share_of_voice` 없음 · num null) 경쟁사 대비 SOV 값이 null이다(`_summary.apply_competitor_sov_from_brands`, `overview.to_dashboard_kpis`). 화면은 '—'다. 당사 언급이 0이면 0.0배 그대로다. 공용 리더라 원본 `/ko/website` 타일도 그 경우 '0.0%' 대신 '측정 대기'가 된다. 실데이터에는 이런 경우가 없다(live golden 그대로, 지금 Website 화면 410.7배 그대로).
  - **3-4.** `overview/cards`의 `compareTitle`은 기간 블록이 있는 카드들이 같이 가진 라벨이고, 다르면 null이다. 화면은 머리에 '증감 = 카드마다 적은 기간 비교'를 쓰고 카드마다 칩 옆에 자기 라벨을 보인다. 같으면 지금처럼 머리에 한 번만 쓴다(W6 반복 줄이기). 다를 수 있는 것은 window 라벨(지표마다 회차 수)뿐이다. 실데이터 네 조건(7/1~8/20, 8/1~9/10 US, Website 두 조건)은 모두 한 라벨이었다. 기간 블록이 하나도 없으면 예전처럼 첫 결과 라벨을 둔다(브랜드 표가 기간 문구를 고르는 데 씀).
  - **3-5.** Website 타일도 같은 규칙이다. BFF가 기간 칩이 있는 타일에 `periodLabel`, 타일 묶음에 `compareTitle`을 붙인다(기간 비교가 없으면 둘 다 없음). 머리는 그 라벨을 쓴다: 2026-09 → '전전월 대비', 사용자 지정 기간 → '현재 N회차 / 직전 M회차 수집 기준'. 문구 `renewal.website.overview.comparePeriod`는 지웠다.
  - **3-6.** 브랜드 표에서 비교한 값의 Δ가 없으면 카드 · Website 브랜드 표와 같은 증감 없음 표시 '−'(`NO_DELTA`, 툴팁 '증감 미제공')를 둔다. 계획의 '—'는 이 표에서 '그 지표의 비교 경쟁사가 아님'(칸 전체, 각주)이라 겹치지 않게 했다. Website 시장별 현황 · KPI 추이의 `/rnpage` 컨테이너 쿼리를 지웠다(그 이름의 컨테이너는 핵심 요약에만 있다). 쓰지 않는 `renewal.overview` 문구는 계획의 9개에 같은 grep으로 찾은 9개(`collapseRegion` · `expandRegion` · `noMarkets` · `answersMeta` · `periodMeta` · `roundMeta` · `heatLegendFront` · `heatLegendTitle` · `cellNoRival`)를 더해 18개를 ko · en에서 지웠다.
  - **golden.** 26건이 바뀌었다(README 'Deliberate changes' 2026-10-31): 3-3 함수 case 12호출 + website fixture 4건, 3-4 `fix-g-cards-02` · `-03` · `-10`, 3-5 website fixture 20건(키 추가). live case는 그대로다.
  - **확인.** Global · Website Overview를 로컬 서버에서 열었다(관리자, 1920×915). 오류 화면 · 5xx 없음, 툴팁 · 초점 · 카드 링크가 동작한다. 원본 `/ko/dashboard` 라벨 · 숫자와 같다.
  - **다음 단계가 알 것.** 10단계는 `RnSparkline`의 `tips`를 쓰면 된다(글은 호출하는 쪽이 만든다). 레거시 `period-delta-off-parity.render.test.tsx`(overviewKpiCards ko · en 2건)는 HEAD에서도 실패한다(이 단계와 관계없음).
- **4단계(2026-10-31).** 4-4만 고쳤다. 4-1 · 4-3은 재현되지 않았고, 4-2는 U5가 같아 할 일이 없다.
  - **4-1 재현 안 됨.** BFF가 행을 접는 키(`brand_key`: trim + 소문자)는 Gold `dim_brand.bare`('정본명 키 (기본 소문자·트림)')와 같다. Gold의 5,273개 브랜드를 이 함수로 접으면 서로 다른 브랜드가 같은 키가 되는 경우가 0이고, 키는 brand_key 0('(이름 없음)', bare 빈 값)을 빼면 모두 bare와 같다. Gold는 `name`과 `bare`에 UNIQUE를 건다. 그래서 이름으로 접어도 Gold 브랜드 둘이 한 행이 되지 않는다. 접는 행의 이름은 모두 `dim_brand.name`이다(언급 브랜드 행, 인용 경쟁사는 `competitor_brand_key` → name). 당사 행 이름(HMG · Hyundai · Kia · Genesis)도 경쟁사 행과 겹치지 않는다(Gold에 'HMG' 브랜드가 없고, 관점 브랜드 행은 리더가 뺀다).
    - 이름이 같고 brandKey가 다른 행은 golden의 합성 입력에만 있다(TS 때 기록한 무작위 입력: `ov/fn-dedupe-brand-rows` · `fn-competitor-candidates` 등 함수 case 9개와 Mention fixture 일부). brand_key로 바꾸면 그 입력에서만 출력이 바뀐다. 추이 · 우선 노출도 Δ는 키가 없는 읽기라 이름으로 짝을 지으므로, 바꾸면 반쪽만 키 기준이 된다.
    - 코드는 그대로 두고 `brand_key` docstring에 Gold bare와 같다는 것을 적었다. admin-todo 결정 기록 '점검 후속'의 '경쟁사 접기는 이름 대신 `brand_key` 기준'은 이 확인으로 할 일이 없다(진행 세션이 정리한다).
  - **4-2 해당 없음.** U5 같음. 경쟁사 우호도(`competitor_value_of` sentiment = 긍정 ÷ 감정 4종 합)와 당사 우호도는 분모 정의가 같다.
  - **4-3 재현 안 됨(틀리게 보이는 것이 없다).** 실제 화면에서 확인했다.
    - 지도: 리뉴얼 · 원본 Global Overview와 리뉴얼 Website Overview는 국가 단위 지도(`level="country"`)라 권역 칠하기를 쓰지 않는다. 권역 단위 지도는 원본 `/ko/website`뿐이다. 거기서 `geo_view`의 `countries_for_rhq(m["region"])`는 Gold 대륙 코드라 늘 비고, 그 권역에 Gold가 넣은 측정 국가만 칠한다(Kia: 측정 국가만 칠하고 나머지는 회색). Gold 귀속 그대로이고, 측정하지 않은 나라에 권역 값을 칠하지 않는다(규칙 5). HUB RHQ 국가로 칠하면 귀속을 다시 정하게 된다.
    - 측정 예정: Gold 리더의 `pending`은 늘 []다. RHQ id를 넣는 곳은 `empty_geo(active)` 하나이고 website 읽기가 일시 실패할 때뿐이다. 그때 두 화면(원본 `/ko/website`, 리뉴얼 Website)은 실패 안내를 보이고 측정 예정 줄을 그리지 않는다. 화면에 RHQ id가 나오는 경로는 없다.
    - 그래서 고치지 않았다. 두 RHQ 경로는 Gold 행에서는 동작하지 않는 레거시 경로로 남는다.
    - 관찰: 권역 행 이름에 Gold 코드가 그대로 보인다(Asia · Europe · Latin America · Middle East · North America · Oceania 등, 빈 코드는 '권역 미분류'). 한국어 화면에서도 영어다. `rhqLabel`이 RHQ id만 번역해서이고, 원본 · 리뉴얼이 같다. 한국어 이름을 붙이는 것은 표시 문구 일이라 이 단계 범위 밖이다(16단계 '다음 일' 후보).
  - **4-4.** 인용 점유율 카드의 경쟁사 줄(`competitor_citation_shares`)이 카테고리 이름 'Official (Competitor)'를 비교했다. 이름은 HUB 코드표 값이라 관리자가 고칠 수 있다(Gold `dim_category.name`은 그 투영). 이제 slug `officialCompetitor`를 비교하고, `to_competitor_citation_domains`가 행에 `categorySlug`를 싣는다. 재현 시험 `test_the_category_is_known_by_its_slug_not_its_name`(이름을 바꾼 공식 경쟁사 + 이름만 같은 딜러)은 고치기 전에 실패했다(9.0 ≠ 3.0).
  - **golden.** 함수 case 3개(README 'Deliberate changes' 2026-10-31 4-4): 변환 case 출력에 `categorySlug`, 두 case 입력에 `categorySlug`를 더했다. 화면 출력은 바뀌지 않는다(screen · live case 그대로).
  - **원본 대조.** 원본 `/ko/dashboard` 인용 점유율 카드의 경쟁사 줄(Mercedes-Benz 2.2% · Toyota 1.7% · Tesla 1.3% · Volvo 1.1%)이 리뉴얼 브랜드 비교 표의 인용 점유율 열과 같다. 권역 행도 두 화면이 같다. 리뉴얼 · 원본 Global · Website Overview 4화면이 오류 화면 · 5xx 없이 열린다.
  - **다음 단계가 알 것.** 카테고리를 이름으로 비교하는 곳이 `BS/citation_model.py`에 남아 있다(`OFFICIAL_COMPETITOR_CATEGORY`, 경쟁사 고르기 · 카테고리 숨김 등). 같은 이유로 slug로 바꿀 후보다(9 · 10단계). `competitor_value_index`와 경쟁사 Δ 찾기는 이름(= Gold bare)으로 짝을 짓는다.
- **5단계(2026-10-31).** 5-1 · 5-2 · 5-4를 고쳤다. 재현 시험은 고치기 전에 실패했다(BFF 6개 · render 6개). 5-3은 재현되지 않았다. Global과 Website는 같은 본문이라 둘 다 바뀐다.
  - **5-1.** BFF가 회차별 수를 보낸다. 노출률 · 점유율 추이는 `rn-rate-hero` `trend.ownNum` · `ownDen`, 우호도 추이는 `rn-favor-hero` `points[].positiveCount` · `total`이다. 유형 선(당사 노출률 추이 보기)은 `rn-rate-types` `own.exposure.x` · `answers`(회차 답변 수)와 `rows[].counts`(그 유형 답변 수)다. 값이 없는 회차는 수도 null이다(히어로와 같은 규칙).
    - 화면: 추이 툴팁 아래에 당사의 분자 · 분모 두 줄을 둔다(공용 `RnLineChart`에 선택 prop `tooltipNote`를 더함, 없으면 예전과 같음). 표 보기 · CSV에 두 행을 더한다. 유형 선은 점마다 툴팁 '회차 · 비율 / 당사 {유형} 답변 n개 / 전체 답변 N개'(3단계 `RnSparkline` `tips`)를 보이고, CSV에 회차 열과 '회차 답변 수' 행을 더한다. 문구 `renewal.mention.type.sparkTip` · `sparkTipCounts` · `colRoundAnswers`(ko · en).
    - 원본의 WoW %(분자 · 분모의 직전 회차 대비 %)는 HUB가 만든 값이라 옮기지 않았다.
    - 점유율 추이에도 같은 두 줄(당사 브랜드 언급 수 · 전체 브랜드 언급 수)을 둔다. 원본 점유율 탭은 보통 브랜드 선 차트(수 없음)이고, 브랜드 선이 없을 때만 수가 있는 당사 선을 그렸다. 같은 Gold 값을 보일 뿐이다.
  - **5-2.** U10대로 리더는 요청한 `mentions_per_answer`를 돌려준다. 리뉴얼 Mention에는 '기간 칩 줄'이 없어서, 원본 KPI 본문의 달력 월 줄(`kpi-period` monthLine)을 요약 카드 바로 아래에 되살렸다. 줄에는 탭 · 히어로에 없는 지표 하나, 답변당 언급 수만 둔다. 리뉴얼 Citation이 답변당 인용 수 줄을 둔 방식과 같다(`load_period_view`). 다른 네 지표의 기간 Δ는 탭과 히어로에 이미 있다.
    - BFF `mention/rn-summary`에 `monthLine`(`per_answer_line`, 달력 월만, 그 밖에는 null)을 더했다. `ctx.today`가 월 라벨의 오늘을 고정한다(시험). 화면은 공용 `PeriodDeltaLine`(`PerAnswerLine`, `mention-body.tsx`)이다. 새 BFF 화면이 아니라서 아키텍처 문서는 그대로다.
  - **5-3 재현 안 됨.** U11의 차이(당사 브랜드 가중평균 > Gold 관점 값)는 Gold 표 두 개(brand_cell · kpi_cell)를 견준 것이다. BFF 위치 추이(`mention_view.own_position_series`)는 브랜드 추이 읽기의 당사 행을 가중평균한다. 그런데 리더는 2026-10-29 지표 점검 R1부터 당사 행을 관점마다 하나만 보낸다. 그 값은 관점의 날짜 합계, 곧 kpi_cell 관점 값이다(`gold_reader/metrics.py` `brand_series`). 그래서 가중평균은 그 한 행 그대로이고 Gold 관점 값과 같다.
    - live API로 확인했다. 브랜드 추이 당사 position과 관점 추이(dimension=none) position이 global HMG 14회차(2.747 … 2.353), website HMG 14회차(1.032 … 1.070) 모두 소수 셋째 자리까지 같다. 리뉴얼 선의 마지막 점 2.4 = 히어로 2.4다.
    - golden의 3.4(히어로 2.4)는 R1 이전(10-26) 녹음 테이프가 당사 행을 브랜드별로 나눠 보냈기 때문이다. live에서는 생기지 않는다. 코드는 그대로 두고 `rank_hero`에 주석을 달았다.
    - 원본 Global 위치 추이: 원본 우선 노출도 차트(`rank_trend_chart`)는 같은 브랜드 추이 읽기의 당사 행('HMG')을 그대로 그린다. `own_position_series`는 원본 히어로가 Overview 카드 값이 없을 때만 쓰는 대체 경로다. live 원본 HMG 선은 리뉴얼 선과 14회차 모두 같다(2.7 … 2.4).
  - **5-4.** `mention_surfaces.summary_deltas`의 전체 언급 수 Δ를 `neutral`로 바꿨다(전 브랜드 언급 합이라 당사 지표가 아님). 측정 프롬프트 수는 이미 중립이다. 언급 브랜드 수는 Δ가 없다. 당사 지표(미언급 프롬프트 · 복수 언급 답변 · Top 3)는 방향 색을 그대로 둔다. 공용 함수라 원본 website · project Mention 요약 카드의 색도 같이 바뀐다(값은 그대로).
  - **golden.** 24건(README 'Deliberate changes' 2026-10-31 step 5). 5-1 · 5-2는 키만 더했다: 함수 case 3개(`rn-fn-rate-hero` · `rn-fn-favor-hero` · `rn-fn-rate-types`)와 번들 18개. 달력 월 번들 `rn-live-month`는 args에 `ctx.today` 2026-10-31을 넣었다. 5-4는 원본 website fixture 3개의 tone이다. 다른 값은 바뀌지 않는다.
  - **원본 대조(live, 관리자).** 필터 없음 · 미국 · gemini · 2026-09 네 조건에서 견줬다.
    - 노출률 회차별 분자 · 분모가 원본 `mention/kpi-hero-trend`와 14회차 모두 같다(10-05 34,452 / 44,979).
    - 우호도 긍정 · 전체 신호 수가 원본 `mention/favor-trend`와 같다(10-05 175,995 / 325,173).
    - 유형 선의 회차 답변 수가 원본 유형 차트 막대(`mention/kpi-engines` combo `answers`)와 같다.
    - 2026-09 답변당 언급 수 칩이 원본 달력 월 줄과 같다(▼10.9%, 전전월 대비, 현재 4회차 / 직전 5회차). Website 2026-09는 ▼17.6%다.
    - Website 요약 카드 전체 언급 수 Δ는 이제 neutral이다.
  - **화면 확인.** 리뉴얼 Global · Website Mention(기본 · 2026-09 · 우호도 탭 · 유형 당사 보기)을 1920×915로 열었다. 오류 화면과 5xx가 없었다. 툴팁 아래 줄, 기간 줄, 유형 점 툴팁이 보였다.
    - 관찰(이 단계 밖): Next 개발 오버레이에 hydration 불일치 1건이 뜬다. 위치는 `_shell/rn-sidebar.tsx` NavGroup(226행) `id`다. 이 단계 파일이 아니다. 첫 방문의 404 1건은 페이지 요청이 아니다(Playwright 응답에 잡히지 않음).
  - **다음 단계가 알 것.** 공용 `RnLineChart`에 `tooltipNote`(점 index → 줄 목록)가 생겼다. 6단계 이후 추이 차트에 회차별 수를 보일 때 쓴다. `TrendTooltip`은 시험을 위해 `charts.tsx`에서 내보낸다(index에는 없음). `Types`는 `initialView` prop으로 내보낸다(render 시험).
- **6단계(2026-10-31).** 6-1 · 6-2를 고쳤다. 재현 시험은 고치기 전에 실패했다(BFF 2개 · render 5개, 검색 개수 문구 결함 포함). Global과 Website는 같은 본문이라 둘 다 바뀐다.
  - **6-1 리더.** 상한이 없다. BFF는 `full`로 읽어 리더가 브랜드 전부를 보내고(`truncated`는 늘 false), `rn-ranking`이 `BRANDS_TOP`(100)에서 잘랐다. 그래서 BFF가 행 전부를 보내고 화면이 자른다. 행 수는 global 752 · website 436(최근 회차), 기간 전체(06-01~10-31)는 global 1,642 · website 1,177이다.
  - **6-1 BFF.** `ranking_payload`가 모든 본문 브랜드의 행을 보내고 `orders`도 모든 행을 센다. 트리맵은 그대로 상위 100이다(8단계 범위). 셸의 서랍 행은 그대로 처음 100개다(본문 전체가 셸을 기다린다). 100위 밖 행은 셸과 같은 모양의 `drawer` 행(`_drawer_row`)을 싣는다. 그래서 그 브랜드의 서랍도 언급 수 · 점유율 · 평균 위치 · 언급률 · 순위 · 감정 분포 · 멘션 유형을 보인다.
    - 크기: `rn-ranking` global이 60 KB에서 597 KB(gzip 44 KB)가 됐다. 행 237 · 서랍 행 242 · 순서 93 KB다. 기간 전체 global은 1.36 MB다. 읽기 시간은 그대로다(1.7초, Gold 읽기가 대부분). 서랍 행을 필요할 때 따로 읽는 안(새 화면 + 프록시)도 있었다. 그 안은 서랍 수치가 늦게 뜨고 실패 상태가 생긴다. 압축 뒤 차이가 작아 같이 싣는 쪽을 골랐다(규칙 7).
  - **6-1 화면.** 순위표는 처음 100행을 보이고 '{n}개 더 보기'로 100행씩 늘린다. 검색과 트리맵 그룹 필터는 모든 행에 걸리고, 검색이나 그룹이 바뀌면 다시 100행부터다. 잘림 각주는 실제 전체 수다('752개 중 100개 표시', 검색 중이면 일치 수). 검색 개수 줄은 문구 인자가 틀려(`count`, 문구는 `matched` · `total`) 키 이름이 그대로 보였다. 이제 '752개 중 1개 일치'로 보인다. 카드 제목은 '(상위 100)'을 뺀 '브랜드 언급 순위'다. 트리맵은 머리에 '언급 상위 {n}개 브랜드'를 적는다. CSV는 모든 행을 내보낸다.
    - 원본과 하나 다르다. 원본 website 표는 436행을 한 번에 보였고, 리뉴얼은 100행 + 더 보기다(계획대로, Global과 같음).
  - **6-2.** 순위표 머리 ⓘ(정의 · 계산식)를 원본 브랜드 표 문구로 붙였다. 순번 · 언급 수 · 점유율(+산식) · 평균 위치(비경쟁 · 노이즈 제외) · 프롬프트 · 언급률(+산식)이다. 증감 열은 카드 머리 '읽는 법'과 같은 문구다. 복수 언급을 켜면 그 기준 문구로 바뀐다. 언급 수 · 언급률은 원본 multiMentions · multiRate 정의를 쓰고, 점유율 · 프롬프트 · 언급률 산식은 BFF 계산(`brand_row_values`)을 그대로 적은 새 문구다(`renewal.mention.brands.multi*`). 서랍 프롬프트 목록 머리(순위 · 언급 수 · 점유율 + 산식)에도 원본 드릴다운 문구로 ⓘ를 붙였다. 서랍 점유율은 '이 브랜드 안의 프롬프트별 비중'이라 분모가 다르다는 설명이 원본에 있었다.
    - 순위표의 가로 넘침 상자를 뺐다. 그 상자 안에서는 짧은 검색 결과에서 ⓘ가 잘렸다. 그리고 행 영역에 최소 높이(168px)를 뒀다. 이게 없으면 페이지 끝의 짧은 목록에서 ⓘ가 본문 스크롤을 12px 늘리고 커서에서 벗어나 깜박였다(e2e에서 찾음). 1920 폭에서 표는 넘치지 않는다(최소 700px).
  - **golden.** 9건(README 'Deliberate changes' 2026-10-31 step 6-1): `rn-live-*` 번들의 `rn-ranking`에 행 · 순서가 늘었다. 처음 100행, `count`, 트리맵, 다른 화면은 그대로다(스크립트로 확인).
  - **원본 대조(live, 관리자).** 100위 밖 브랜드의 행 값이 원본 표 검색 결과와 같다. Global Czinger(150위)는 언급 29 · 점유율 0.0% · 평균 위치 7.6 · 프롬프트 4 · 언급률 0.0%, Website Payback(150위)은 6 · 0.0% · 1.3 · 4 · 0.0%다. 행 수는 원본 `count`와 같다(752 · 436).
  - **e2e(Global · Website 각 9항목 통과).** 처음 100행 · 각주 → 더 보기 200행 → 점유율 ⓘ → 100위 밖 브랜드 검색(1개 일치) → 짧은 목록의 ⓘ(카드 안에 열림) → 행 → 서랍(150위 · 수치 4개 · 감정 · 유형) → 서랍 점유율 ⓘ. 5xx는 없다. 페이지 오류 1건은 원본 `/ko/standard/...` 페이지의 hydration 불일치(DashLayout)다.
  - **관찰(이 단계 밖, 7단계).** 서랍 프롬프트 목록은 어느 브랜드를 열어도 당사 목록(1,000개)이다. admin-todo 세션 메모 W2의 기존 결함(리더가 `mention_brand` 이름을 무시)과 같다. 100위 밖 브랜드도 같다.
  - **다음 단계가 알 것.** `DrawerTarget`(brand)에 선택 `row`가 생겼다. 서랍은 셸 행이 없으면 그 행을 쓴다. `BrandRanking`(`initialView` · `initialQuery`)과 `PromptList`는 render 시험을 위해 내보낸다. 순위표 머리 ⓘ 문구는 `renewal.mention.brands.defLabel` · `formulaLabel`이다.

- **7단계(2026-10-31).** 세 항목 모두 고쳤다. 재현 시험은 고치기 전에 실패했다(Gold 리더 6개 · BFF 1개 · render 6개). 원본 · 리뉴얼, Global · Website가 같은 BFF 화면을 읽어 모두 바뀐다.
  - **7-2 리더(먼저 했다).** live로 재현했다. `mentions/prompts`에 `mention_brand=Toyota`를 보내도 target이 HMG, total 325,173(당사)이었다. 리더가 `brand_key`만 읽고 이름을 버려서 own 기본값(true)으로 떨어졌다. `citations/domains` · 상세는 이름을 아예 읽지 않아 필터의 모든 인용이었다.
    - 리더가 계약의 `mention_brand`(표시 이름)를 원본 API 규칙으로 `dim_brand.brand_key`로 찾는다(`context.brand_key_of`: 이름 일치 먼저, 없으면 bare 소문자, brand_key 0 제외). 귀속은 바꾸지 않는다. 모르는 이름은 원본처럼 프롬프트 404 `brand_not_found`(BFF가 빈 목록으로 바꿈), 인용 출처 · 상세는 빈 결과 + `meta.dropped_filters`다.
    - 인용 출처 · 상세는 그 브랜드가 언급된 답변의 인용만 센다(`citations.mention_target` · `mentioned`). 같은 빌드 · 회차 · 답변의 `answer_brand_fact` 행이 프롬프트 탭과 같은 조건(std_in ∧ competitive ∧ mention_count > 0)이어야 한다. 커버리지 분모(답변 수)도 그 답변으로 좁힌다(원본 `answers_den_sql`). 원본 API는 std_in만 봤다. live global에는 std_in인데 competitive가 아닌 행이 51개 브랜드 50,025행 있고, 순위 행(brand_cell competitive) · 프롬프트 탭과 같은 모수를 골랐다(admin-todo 결정 기록 '점검 7단계').
    - 당사 행(이름 HMG, HMG 관점에서는 Gold 브랜드가 아님)은 인용 출처도 own으로 읽는다. BFF가 `own=1`이면 `mention_own=true`를 보내고, 리더는 관점의 자사 브랜드(`dim_brand.own_bit & 관점`)가 언급된 답변으로 좁힌다. 리뉴얼 서랍과 원본 `MentionsDrilldown`(`BrandCitationsTab`)이 인용 출처에도 own을 보낸다. 고치지 않았으면 원본 당사 행 인용 출처가 빈 목록이 됐을 것이다(이전에는 필터의 모든 인용).
    - `own_brand_code`(분할 당사 행)는 리더가 여전히 읽지 않는다. 지금 Gold 리더 `mentions/brands`는 그 키를 보내지 않아 그런 행이 없다(재현 안 됨, 해당 없음).
    - 확인(live): 프롬프트 total이 순위 행 값과 같다. Toyota 61,535 언급 · 4,248 프롬프트, Czinger(150위) 4개, Website Tata 245 · Toyota 185 · Payback(150위) 4. 인용 출처 첫 행은 Toyota hyundai.com 16,146 · 5.0% · 13.7%, BMW hyundai.com 13,580, 당사 kia.com 76,848 · 10.4% · 16.8%, Website Tata hyundai.com 2,359 · 34.7% · 60.2%, 당사 kia.com 73,086이다. 읽기 시간: 스냅샷 Toyota 1.5초 · 당사 2.3초(브랜드 없을 때 1.8초), Website 5개월 기간 당사 7.6초(브랜드 없을 때 5.2초, 15초 제한 안). 늘어난 시간은 같은 답변의 행 확인(merge semi join)이고 정렬 비용은 원래 크다.
  - **7-1 서랍 › 인용 출처.** URL 열('—' 고정)을 빼고, 원본 표처럼 도메인(+ 당사 표시 · 분류) · 인용 수 · 점유율 · 프롬프트 · 커버리지를 보인다. 당사 표시는 Citation 서랍과 같은 규칙이다(Website '당사', Global 'HMG', Gold 표면별 자사 인용). 점유율 · 커버리지 머리 ⓘ는 이 탭 분모(그 브랜드가 언급된 답변)로 쓴 새 문구다(`renewal.mention.brands.cite*`, ko · en). 행을 누르면 그 아래에서 `&skey=` 상세를 한 번 읽고 '인용 URL n | 프롬프트 n'을 고른다. 목록은 Citation 서랍의 부품(`citation-domains.tsx` `UrlList` · `PromptList`, 내보내기만 함)을 쓴다. 이 서랍 상세에는 프롬프트 점유율이 없어(원본에도 없음) `share={false}`로 그 열을 뺐다. 프롬프트를 누르면 답변 원문 창(인용 변형)이 열리고, 닫으면 서랍이 돌아온다. 읽는 중 · 실패 문구는 원본 행 문구(`citationsLoading` · `citationsError`)다.
  - **7-3 유형 → 프롬프트.** 원본은 website · project `MentionsView`의 '당사 유형 구성(절대 건수)'을 누르면 신호 대화창(`/api/scope/signal-prompts`, signal = 유형)을 열었다. 원본 Global KPI 유형 차트(`type-kpi-section.tsx`)에는 드릴다운이 없었다. 리뉴얼은 유형 카드의 '당사 노출률 추이' · '당사 유형 구성' 보기의 유형 행(유형 · 막대 · 값)을 누르면 같은 신호 서랍이 그 유형으로 열린다. 신호 수가 0인 유형은 누를 수 없다. 서랍 제목은 '‘추천’ 신호가 발생한 프롬프트'이고, 꼬리말에 원본 안내(`breakdown.drilldownHint`)를 붙였다. BFF는 그대로다(`mention/drill-signal-prompts`가 이미 유형을 받음).
  - **golden 변경 없음.** BFF 출력이 바뀌는 case가 없다(인용 출처 own case 없음). 새 BFF 화면 · 프록시가 없어 아키텍처 문서는 그대로다.
  - **원본 대조(live, 관리자).** 원본 `/ko/standard/answer-analysis/mention`의 Toyota 서랍 첫 프롬프트('Can you compare hybrid car brands…' 769 · 1.2%)와 인용 출처 첫 행(hyundai.com 16,146 · 5.0% · 918 · 13.7%), HMG 인용 출처(kia.com 76,848 · 10.4% · 2,477 · 16.8%)가 리뉴얼과 같다. 원본 `/ko/website/answer-analysis/mention` Tata(첫 프롬프트 TUCSON Hybrid 42 · 6.4%, hyundai.com 2,359 · 34.7% · 143 · 60.2%), HMG(kia.com 73,086 · 19.8% · 3,260 · 31.9%)도 같다. 원본 HMG 인용 출처 요청에 `own=1`이 실린다.
  - **e2e(Global · Website 각 9항목, 원본 2화면 각 2항목 통과).** 당사 · 두 경쟁사 서랍의 프롬프트가 서로 다름 → 인용 출처 행(점유율 · 커버리지, URL 열 없음) → 행 펼침 URL 목록 → 프롬프트 → 답변 원문(인용 N건) → 닫으면 서랍 복귀 → 당사 행 인용 출처 → 100위 밖(Czinger · Payback) 서랍 프롬프트가 그 브랜드 목록(4개) → 유형 '추천' 행 → 신호 서랍(50개) → 답변 원문. 5xx는 없다. 원본 페이지의 hydration 불일치(DashLayout, 6단계와 같음)가 한 번 났다.
  - **관찰(이 단계 밖).** 리뉴얼 Citation 도메인 서랍의 읽는 중 · 실패 문구 키 `answerAnalysis.citations.drilldown.loading` · `loadFailed`가 ko · en에 없다(9단계 후보). Website Tata 서랍 프롬프트에 Hyundai TUCSON · KONA 질문이 나오는 것은 Gold 귀속(업스트림 D5 Kona 귀속과 같은 종류)이다.
  - **다음 단계가 알 것.** Gold 리더 인용 읽기에 `ctx.mention`(브랜드 · 당사 대상)이 생겼다. `citations.predicate`가 걸므로, 다른 인용 읽기도 `mention_target(ctx)`를 먼저 부르면 같은 대상으로 좁혀진다. `DrawerTarget` signal은 감정 4종과 유형 5종(`DrawerSignal`)이다. `CitationList` · `CitationRow` · `CitationDetail` · `brandDrillPaths`는 render 시험을 위해 내보낸다.

- **8단계(2026-10-31).** 8-1 · 8-2 · 8-3을 고쳤다. 재현 시험은 고치기 전에 실패했다(BFF 4개 · render 3개). 8-4는 재현되지 않았다. Global과 Website는 같은 본문이라 둘 다 바뀐다.
  - **8-1.** 'HMG 계열' 배지(`sibling`)를 HUB 이름 목록(`HMG_BRANDS`, 지웠다) 대신 Gold 플래그로 정한다. 리뉴얼 화면의 본문 브랜드 읽기(`mentions/brands`)가 `include=hmg`를 더해 `is_hmg_own`(= `dim_brand.own_bit ≠ 0`, 당사 행은 true)을 받고, `to_mentions_brand_live`가 `hmgOwn`으로 싣는다. `_begin`이 ctx `hmg`를 켜서 모든 rn 화면의 본문 브랜드 읽기가 같은 요청 하나다(읽기 수 그대로). 원본 화면 요청은 그대로다.
    - 순위 행 · 서랍 행은 자기 행의 `hmgOwn`, 경쟁 구도 board는 본문 행에서 이름으로 찾는다(`hmg_flags`). 우선 노출도 표(`rank_board`)는 새 인자 `brands`(본문 행)에서 찾는다. 그 표 행은 같은 브랜드 읽기에서 온다(`to_first_position_latest`). 이름은 Gold `dim_brand.name`(UNIQUE)이다.
    - U1대로 live에서는 결과가 같다. Kia 화면(brand=Kia)에서 Hyundai · Genesis가 Global · Website 모두 'HMG 계열'이다(실제 화면 확인). Gold가 다른 이름에 HMG를 주면 그 브랜드가 배지를 받고, 목록에만 있는 이름은 받지 않는다(재현 시험).
    - ACR(`BS/acr.py`의 `HMG_BRANDS`)은 11단계 범위라 그대로다.
  - **8-2.** 트리맵이 '자동차 외' 묶음을 점유율과 관계없이 늘 '그 외'로 접었다. 이제 다른 묶음처럼 점유율 1.5% 미만이거나 15번째부터만 접는다. 묶음 이름과 `NON_AUTO` 명단은 그대로 둔다(업스트림 D3 '비완성차 경쟁사'의 답이 아직 없음). 화면에서는 브랜드 하나인 '자동차 외' 타일의 키를 다른 묶음처럼 그 브랜드로 했다(`groupTile`, 원래는 늘 접혀 쓰이지 않던 갈래). live에서 '자동차 외' 브랜드는 언급의 0.2%(Global 상위 100 중 8개 · Website 2개)라 규칙대로 접혀, 지금 트리맵은 그대로다.
  - **8-3.** 트리맵 Δ 색은 타일이 읽는 값(`deltaTxt`, 0.05 미만은 '0.0pp', 그 밖은 소수 한 자리)이 0.0일 때만 '변화 없음' 색이다. 색 세기는 크기 눈금 0.1 · 0.5 · 1.0pp다(방향 초록 · 빨강은 그대로). 범례 문구 `renewal.mention.treemap.steps`를 '−1.0pp 이하, −0.5, −0.1, 변화 없음, +0.1, +0.5, +1.0pp 이상'(en도)으로 바꿨다.
  - **8-4 재현 안 됨.** bump는 답변이 있는 회차(`trend_axis` measured = 버킷 있음, `to_brand_trend_result`가 답변 0인 회차를 뺀다)에서만 행 없는 브랜드를 0으로 두고, 답변이 없는 회차는 빈칸이다. U2대로 셀 표에 0인 행이 없으므로 그 0이 Gold 뜻(0회)이다. 고치지 않고 시험 `BumpZeroIsGold`로 지금 동작을 고정했다.
  - **golden.** README 'Deliberate changes' 2026-10-31 step 8. 8-1은 tape · args에 플래그만 더했다(bundle 18개 · 함수 case 7개, 출력 그대로). 출력이 바뀐 것은 셋이다. `rn-fn-rank` 4호출은 무작위 입력의 표 행이 그 호출의 본문 행에 없는 HMG 브랜드라 배지가 빠졌다(live에서는 생기지 않음). `conv-to-mentions-live` 25호출은 녹음된 리더 항목의 `is_hmg_own`이 `hmgOwn` 키로 실렸다. 8-2는 무작위 입력의 큰 '자동차 외'(Alexa)로 `rn-fn-treemap-groups` 10호출 · `rn-fn-ranking` 트리맵 12호출이 바뀌었다. live case는 그대로다.
  - **원본 대조.** 숫자가 바뀌지 않는다(배지 · 트리맵 묶음 · 색만). 원본에는 이 배지 · 트리맵이 없다.
  - **화면 확인.** 리뉴얼 Global · Website Mention(브랜드 상세, 기본 · brand=Kia, KPI 화면)을 1920×915로 열었다. 오류 화면 · 5xx가 없었고, 범례가 새 문구로 보였다.
  - **다음 단계가 알 것.** 리뉴얼 Mention 본문 브랜드 행에 `hmgOwn`(Gold `is_hmg_own`)이 있다. ctx `hmg`를 켠 읽기만 받는다. 11단계(ACR)는 다른 Gold 값(`acr_entity_fact.own_bit`)이라 이 경로와 관계없다.

- **9단계(2026-10-31).** 9-1 · 9-2 · 9-3 · 9-6 · 9-7 · 9-9를 고쳤다. 재현 시험은 고치기 전에 실패했다(BFF 6개 · render 5개). 9-4 · 9-8은 재현되지 않았고 지금 동작을 시험으로 고정했다. 9-5는 고칠 것이 없다. Global과 Website는 같은 본문 · BFF 화면이라 둘 다 바뀐다.
  - **9-1.** 출처 선호 매트릭스(`citation_model.matrix`)에서 인용이 0인 열(n = 0)은 비중이 null('—')이다. `live`는 인용이 있는 열이 둘 이상일 때 그 열들만이다. 그래서 칠하기 · cap · 발견(typeGap · skew · engineGap)이 그 열을 읽지 않는다. 화면 뷰의 `gaps`도 null이고 CSV는 그 칸을 비운다.
    - 유형 다섯 열이 모두 0이면 `rn.typeMatrix`가 `{status: "empty", m: null}`이다. 화면은 원본 유형 차트의 빈 안내(`answerAnalysis.citations.v2.typeCategory.empty` '유형별 출처 데이터가 없습니다')를 보인다.
    - 인용이 있는 열이 하나뿐이면 '비교할 대상이 없다' 안내가 나온다. 조건을 열 수에서 `live` 수로 바꿨고, 문구 `renewal.citation.matrix.single`을 '인용이 있는 열이 하나뿐이라…'로 고쳤다(ko · en).
    - 실데이터(U9, 관리자): 필터 없는 2026-07-06 하루는 최종 선택 · 정의 열이 0이라 '—'다. 나머지 열의 공식(HMG) 비중(추천 20.6 · 비교 21.4 · 단순 언급 22.7)은 원본 유형 차트와 같다. Genesis AT · Hyundai CH(10-05)는 다섯 열이 모두 0이라 빈 안내이고, 원본 `/ko/standard/…/citation`도 빈 안내다. 필터 없는 10-05 HMG는 0인 열이 없어 그대로다.
  - **9-2.** 처방 문구 셋을 사실 문구로 바꿨다(ko · en). `sub.positiveSub`는 '당사 언급이 긍정으로 기운 답변이 근거로 쓴 URL입니다.'이고 `negativeSub`도 같은 꼴이다. `tone.subtitle`은 '당사 언급이 긍정 · 부정으로 기운 답변이 근거로 쓴 URL을 톤별로 셉니다.'다.
  - **9-3.** Website 범프 범례와 읽는 법은 새 문구 `bump.legendOwnWebsite`('당사 도메인')와 `bump.infoWebsite`를 쓴다. 고르는 기준은 `input.website`이고, 도메인 표 태그(`OwnTag`)와 같은 규칙이다. Global은 그대로 '공식(HMG) 도메인'이다.
  - **9-4 재현 안 됨.** U2대로 셀 표에는 0인 행이 없다. 그래서 인용이 있는 회차에 행이 없는 도메인 · 카테고리는 0회이고, 값이 없는 회차는 이미 공백(gap)이다. 시험 `CitationTrendZero`로 고정했다.
  - **9-5 고칠 것 없음.** U3 · U4는 같다. U6에서 지금 '당사' 태그(리더 `is_own` = `citations.own_citation`)는 Gold 정의를 따른다. Website Overview 출처 구성비의 '당사' 태그도 같은 값이다. 두 Gold 값의 차이는 업스트림 D2로 물었다. 근거는 Gold 표 설명이다.
    - `citation_cell`: '자사 판정은 표면별입니다: global = owner_key = ANY(허용 배열), website = loc_owned ∨ tgt_hit'.
    - `dim_owned_base`: '쓰임: Global 자사 인용 판정(도메인 순위 · 인용 프롬프트 · 답변 모달 · 도메인 상세의 자사 표시와 수)', 'Website 자사 판정은 이 표가 아니라 web_unit 의 base · sibs 를 씁니다'.
    - `dim_source.owned_brand_bit`('당사 공식 도메인 비트')는 출처 분류(category_src 3 '당사 도메인')와 Admin 분류 경고가 쓰는 값이다. 도메인 표의 자사 표시는 그 표 쓰임에 없다.
  - **9-6.** 긍정/부정 URL 행의 출처에 카테고리가 없으면 `category`가 null이고 화면은 '—'다. 원본 `citation-tone-urls-page.tsx`도 같은 BFF 화면이라 함께 고쳤다(색 점 없이 '—'). Gold의 Other(카테고리 13)는 그대로 '기타'다. Gold `dim_source.category_key`는 null을 허용하지만 2026-10-31에 null 행은 0개라, 실데이터 화면은 바뀌지 않는다.
  - **9-7.** 재현했다. 범위 계정(Genesis · genesis-middle-east)이 SA-Dammam(SA의 도시 사이트)을 고르면 본문은 SA-Dammam을 읽었다. 도메인 표 · 서랍 · 내보내기(`route_context`, global 계정 규칙)는 그 코드를 버려 국가 조건 없이 읽었고, clamp가 범위 사이트 전부를 붙였다. 이제 `route_context`가 website에서 본문과 같은 `website_context`(website 규칙)를 쓴다(`surface_rule` 인자는 지웠다).
    - 원본 `/ko/website/answer-analysis/citation`의 표 · 서랍도 같은 BFF 화면이라 같이 맞춰진다. 관리자 · HQ 계정은 국가 범위가 없어 결과가 그대로다.
    - live 확인: 그 계정의 SA-Dammam 본문은 인용 2,908 · 도메인 210이고, 표도 210행이다. 상위 5행(genesis.com 1,904 …)이 같고, 관리자가 brand=Genesis · SA-Dammam으로 읽은 본문과도 같다. 서랍(genesis.com)도 열린다. AE도 같다(2,797 · 227). 시험 계정 `audit2-region@local`은 관리자 API로 다시 켜서 쓰고 끝나고 중지했다.
  - **9-8 재현 안 됨.** citation_model이 비교하는 카테고리 이름은 모두 `category_label_of`(Gold slug → 택소노미 라벨 `LABEL_BY_SLUG`)에서 온다. Gold 이름(HUB 코드표 값)은 택소노미에 없는 slug일 때만 쓴다. 그래서 공식(경쟁사)의 이름을 바꿔도 경쟁사 고르기와 행 숨김은 slug로 찾고, 다른 카테고리에 같은 이름을 붙여도 섞이지 않는다. 시험 `CategoryBySlug`로 고정했다. 4-4(Overview 경쟁사 줄)는 Gold 이름을 직접 비교해서 달랐다.
  - **9-9(아래 '9-9 후속'으로 철회).** render 시험으로 재현했다(읽는 중 · 실패 때 키 이름이 보였다). `answerAnalysis.citations.drilldown.loading`('도메인 상세를 불러오는 중…') · `loadFailed`('도메인 상세를 불러오지 못했습니다')를 ko · en에 더했다. 원본 `citations-view.tsx` 도메인 펼침도 같은 키를 써서 같이 고쳐진다.
  - **9-9 후속(재현 안 됨, 2026-10-31).** 위 재현은 render 시험이 `ko.json`만 읽어서 생긴 것이다. 화면이 받는 메시지는 `ko.json`에 `messages/units/*.json`을 합친 것이고, 두 키는 처음부터 u7에 있었다('상세를 불러오는 중입니다' · '상세를 불러오지 못했습니다. 행을 닫았다가 다시 열어 주세요.'). 9단계가 `ko.json` · `en.json`에 다른 문구로 더한 두 키 때문에 `i18n/request.test.ts` 2건(ko · en, 합친 뒤 기존 문구가 바뀜)이 `cdcb3c1`부터 실패했다. 두 키를 `ko.json` · `en.json`에서 지웠고(units 문구가 정본), 서랍 render 시험은 합친 메시지(`loadMessages`)로 키 이름이 보이지 않는지 본다.
  - **golden.** 7건이다(README 'Deliberate changes' 2026-10-31 step 9). 9-1은 `fn-rn-type-matrix`(120호출 중 21) · `rn-fix-all-owned` · `-degraded` · `-picks-source` · `-rounds`다. 정의 열이 null이 되고 live에서 빠지며, 그 픽스처의 cap · 발견은 그대로다. 9-6은 `sub-tone-fix-counts` · `-reuse`(카테고리 없는 픽스처 행)다. live case는 그대로다.
  - **원본 대조.** 숫자는 바뀌지 않는다. 바뀐 것은 0인 열의 표시 · 빈 안내 · 문구, 그리고 범위 계정이 도시 사이트를 고른 표 · 서랍이다(위 9-1 · 9-7). 리뉴얼 Global · Website 인용과 하위 화면(prompts · tone-urls), 원본 `/ko/standard/…/citation` · `/ko/website/…/citation`을 1920×915로 열었다. 오류 화면 · 5xx는 없다.
    - 관찰: 로컬 front(next dev, 10-29부터 실행 중)가 `/ko/renewal/website/answer-analysis/citation` 한 경로에만 고치기 전 ko 문구를 보냈다. 그래서 새 키 `bump.legendOwnWebsite`가 키 이름으로 보였다. 같은 경로의 en('Our domains')과 다른 경로의 ko는 새 문구다. 파일 touch로도 풀리지 않았다. 개발 서버 캐시이므로 front를 다시 띄우면 풀린다(render 시험은 새 문구로 통과).
  - **다음 단계가 알 것.** 매트릭스 열의 `shares` · `gaps`는 null일 수 있다(`MatrixCol`, `RnMatrixView`). `rn.typeMatrix.status`에 `empty`가 생겼다. 긍정/부정 URL 행의 `category`는 null일 수 있다(`CitationToneUrlRow`). 범위 계정의 website 인용 읽기는 모두 website 규칙(`website_context`)이다.

- **10단계(2026-10-31).** 10-1 · 10-2를 고쳤다. 재현 시험은 고치기 전에 실패했다(BFF 2개 · 훅 2개 · render 7개). 10-1은 Global · Website가 같은 본문이라 둘 다 바뀌고, 10-2는 Website만 바뀐다.
  - **10-1 회차 툴팁.** 출처 구성 줄의 회차 선은 점마다 '회차 · 비중 · 인용 수'를 보인다(3단계 `RnSparkline` `tips`). 인용 수는 같은 화면이 이미 보내는 `live.categoryTrend`에서 읽는다. 원본 구성 추이 차트가 그리던 값이고, 원본 툴팁의 수도 이 값이다. 그래서 BFF는 그대로다(`compositionRounds`, 비중은 화면의 `rows[].trend`).
    - 값이 없는 회차(공백)는 점을 그리지 않고 '{회차} · 인용 공백'이라고 쓴다.
    - 열 머리에 회차 범위(예: 7/3 – 10/9)를 둔다.
  - **10-1 표 보기 · CSV.** 카드에 표 보기를 더했다. 목록 값(비중 · 인용 수, 직전 회차 대비) 뒤에 회차마다 비중과 그 아래 인용 수를 둔다(`CompositionTable`, 목록의 '비중 · 인용 수' 칸과 같은 모양). CSV에는 회차마다 인용 수 · 비중 열을 더했다(`compositionCsvRows`).
  - **10-1 출처 하나.** 출처를 하나 고르면(`oneSource`) 비중이 늘 100%라 선은 회차별 인용 수다(원본 absolute 모드, 세로 범위 최소값 없음). 열 머리는 '회차별 인용 수'이고, 축 각주도 그 뜻으로 바뀐다.
  - **10-1 줄 구조.** 필터 토글 버튼은 값 다섯 칸만 감싼다(subgrid). 회차 선은 버튼 밖에 둔다. 버튼 안에 초점 가능한 점을 두면 키보드로 닿지 않고, 버튼 title 툴팁과도 겹치기 때문이다. 그래서 회차 선 칸을 눌러도 필터가 걸리지 않는다(7-3 유형 행과 같은 방식). 나머지 칸은 그대로 필터를 건다(실제 화면에서 확인).
    - 문구(ko · en): `renewal.citation.comp`의 `col.trendCount` · `col.trendRange` · `tipPoint` · `tipGap` · `axisNoteCount`, `info` 문장 추가.
  - **10-2 결정.** 원본처럼 서버 쪽 '더 보기'를 골랐다. 같은 route `citation/domains`를 200행씩 읽는다. 다른 안은 6단계 방식(모든 행을 보내고 화면에서 자르기)이었다. 그러나 website 출처는 14,687개(2026-10-31)라 첫 화면 응답이 약 3.6 MB가 된다(1,000행 = 244 KB). 다음 쪽은 1.2초 · 50 KB다. 검색 · 정렬은 이미 서버가 전체 출처에서 한다(규칙 7, admin-todo 결정 기록 '점검 10단계').
  - **10-2 BFF.** `table_views(rows, limit)`이 생겼다. Website renewal 화면(`renewal_vm(..., website=True)`)과 route 쪽은 모든 행의 views를 보낸다. 표준 화면은 상위 100 그대로다. 재현: Website 첫 쪽 200행 중 views는 100행뿐이었다(BFF 시험 2개).
  - **10-2 프런트.** `useServerDomainTable`이 '더 보기'로 붙인 쪽의 views를 앞 행 수만큼 밀어 붙인다(`appendDomainTableViews`, `_data/citation-view.ts`). 원본 화면들은 views를 읽지 않아 동작이 같다(원본 인용 시험 9개 파일 통과).
  - **10-2 화면.** Website 표는 불러온 행을 모두 보인다. 처음 20행 → '200개 모두 보기' → '200개 더 보기'(다음 쪽) 순서다.
    - 칩은 '인용 수 순 · 전체 14,687개'이고, 아래 줄은 '14,687개 중 400개 표시'다.
    - 카테고리 선택은 불러온 행 안에서 고른다. 더 받을 쪽이 있으면 '불러온 400개 중 일치 101개'라고 쓴다.
    - 검색은 서버가 전체에서 한다('일치 1,200개 · 상위 200개 표시', 그 뒤로도 더 보기).
    - 다음 쪽 읽기가 실패하면 '다음 도메인을 불러오지 못했습니다…'라고 쓴다. 훅은 다시 시도하지 않는다(원본 `LoadMoreRow`와 같음).
    - 원본 Global은 상위 100이라 Global 표는 그대로다.
  - **golden.** 1건이다(README 'Deliberate changes' 2026-10-31 step 10-2): `citation/route-domains-live-more`의 views(200행 전부). live 화면 case는 그대로다.
  - **원본 대조(live, 관리자).** 숫자는 바뀌지 않는다.
    - Website 150위 kiachambly.ca(180 · 0.0% · 48 · 0.3%)는 원본 `/ko/website/answer-analysis/citation` 표와 같다. 두 화면에서 '더 보기'를 누른 뒤의 201위 kia.cz(141 · 0.0% · 46 · 0.3%)도 같다.
    - 회차 툴팁의 인용 수는 원본 화면(`citation/standard` · `citation/website`)의 구성 추이 값과 같다. Global 공식(HMG)은 9/21 96,467 · 9/28 219,995 · 10/5 233,628(= U4), Website는 10/2 278,718 · 10/9 256,034다. 딜러 하나를 고르면 10/2 37,327 · 10/9 44,504(비중 100.0%)다.
  - **e2e(26항목 통과, ko).** Website 표: 칩 → '200개 모두 보기' 200행 → 150위 행 → 서랍(도메인 상세 200) → '200개 더 보기'(route `cursor=200&limit=200`) 400행 → 201위 = route 첫 행 → 카테고리(불러온 행 안) → 검색(서버 1,200개). 구성 카드: 회차 툴팁 14개 → 표 보기 → 출처 하나(인용 수 선). Global 표: 상위 100 · 더 보기 없음, 구성 툴팁, 줄 클릭 필터. 원본 Website 표 150위 · 201위. 오류 화면 · 5xx는 없다.
  - **관찰(이 단계 밖).** en 화면 필터 패널의 회차 달력(`components/renewal-ui/round-calendar.tsx`)이 요일 머리 키 'T' · 'S'가 겹친다는 React 경고를 낸다(요일 첫 글자를 key로 씀). 공용 부품이라 16단계 '다음 일' 후보다. 첫 방문의 404 1건은 6 · 7단계와 같다(Playwright 응답에 잡히지 않음).
    - `i18n/request.test.ts`의 '기존 문구가 병합 뒤에도 같다' 2건(ko · en)이 HEAD(`cdcb3c1`)부터 실패한다. 9-9가 `ko.json` · `en.json`에 더한 `answerAnalysis.citations.drilldown.loading` · `loadFailed`를 `messages/units/u7.*.json`이 다른 문구로 덮는다. 실제 화면은 u7 문구('상세를 불러오는 중입니다')다. render 시험은 `ko.json`만 읽어 9-9 문구를 본다. 이 단계 문구는 단위 파일과 겹치지 않는다(겹치는 키는 그 둘뿐). 어느 문구를 남길지는 9-9 후속으로 정한다.
  - **다음 단계가 알 것.** `DomainTableCard`는 `initialAll` prop(render 시험용)을 받는다. `CompositionTable` · `compositionRounds` · `compositionCsvRows`를 내보낸다. route `citation/domains`의 views는 쪽 전체다. 출처 구성 줄은 이제 `div` 안의 버튼이다(`data-rn-b`는 줄, `data-rn-src` · `aria-pressed`는 버튼, 회차 칸은 `data-rn-trend`).

- **11단계(2026-10-31).** 11-1 · 11-2 · 11-3 · 11-4 · 11-5를 고쳤다. 재현 시험은 고치기 전에 실패했다(BFF 12개 · Gold 리더 3개 · render 5개). 11-6은 재현되지 않았다. 리뉴얼 ACR(Global)만 바뀐다.
  - **11-1 발견.** W6 방식(Mention · Citation)으로 바꿨다. 순서는 하나로 고정했다(`acr.FINDING_ORDER`). 당사 순위와 격차 → 후보군 포함율이 가장 가까운 경쟁사와의 Top1 ACR 차(leak) → 엔진별 당사 1위 프롬프트(engine) → 모든 엔진에서 1위인 경쟁사(sweep) → 당사 차종 전환율(model) → 당사가 한 번도 선택되지 않은 프롬프트(dist) → 가장 크게 움직인 브랜드(mover) 순서로, 값이 있는 앞의 4개를 보인다. 순서는 원본 '만드는 방법' 문구의 순서이고, Mention · Citation처럼 움직인 브랜드를 끝에 두었다.
    - 문턱을 모두 뺐다: leak 6pp · −0.5pp, engine 3개, sweep 3개, mover 0.5pp, dist 3개. engine은 엔진 2개 이상이면 쓴다. 차가 0이면 '엔진마다 당사 1위 프롬프트 n/N로 같음'이다. sweep · dist는 1개 이상이면 쓴다. mover는 반올림해 0.0이 아니면 쓴다('가장 큰 변화' 제목은 그대로).
    - leak: 당사 브랜드 행마다 후보군 포함율이 가장 가까운 경쟁사를 고른다. 거리는 정확값으로 재고, 같으면 표 순서가 앞선 쪽이다. 그 둘의 Top1 ACR 차(`delta1`)가 가장 작은(가장 뒤진, 없으면 가장 덜 앞선) 당사 브랜드를 보인다. Mention 유형 발견과 같은 규칙이다. `params.dir`은 less · more · same(반올림해 0)이고, 문구는 '{own}, 후보군 포함율이 가장 가까운 {rival}보다 Top1 ACR {gap}pp 낮음 / 높음', 같으면 '…{rival}와 Top1 ACR 같음'이다. 다른 안은 당사 합계로 비교하기였다. 원본 발견은 당사 브랜드별이었고, 합계 포함율은 브랜드들의 합집합이라 어느 브랜드의 후보 → 선택 차인지 흐려진다.
    - 색은 당사 기준 방향만이다. standing은 앞섬 good · 뒤짐 warn, leak은 낮음 warn · 높음 good · 같음 info, mover는 당사면 방향대로 · 경쟁사면 info(오르면 warn이었다)다. engine · sweep · dist · model은 info다(Citation engineGap · opportunity와 같다).
    - 문구(ko · en): `summary.how`(정해진 순서, 기준값 · 중요도 없음, 색은 방향만), `find.leak.title` → `titleLess` · `titleMore` · `titleSame`, `find.engine.titleSame`(새 키), `find.sweep.detail`('콘텐츠 보강 후보' → '이 프롬프트에서 당사는 어느 엔진에서도 1위가 아닙니다 · …기준'). units에는 `renewal.acr` 키가 없다.
  - **11-2 배지.** 'HMG 계열'은 이름 목록(`HMG_BRANDS`, 지웠다)이 아니라 리더가 행마다 주는 Gold 플래그(`is_hmg`)로 정한다. 그 값은 그 행의 당사 판정에 리더가 이미 쓰는 Gold 값을 따른다. 그래야 한 카드 안에서 당사 · HMG 계열 · 그 외가 한 Gold 값으로 갈린다.
    - 브랜드 행: 명부 `acr_entity_fact.own_bit ≠ 0`. `is_ours` · `own_cells` · `own.brands`가 읽는 값이다. Gold 설명은 열 '당사 비트: 명부', 표 쓰임 'Global ACR 브랜드별 ACR 표 …'다.
    - 차종 행: 부모 `dim_brand.own_bit ≠ 0`. 차종 `is_ours`가 읽는 값이다(리더 `model_rows`의 `parent.own_bit`).
    - 맞대결 행: `dim_brand.own_bit ≠ 0`. 후보군의 당사 판정이 읽는 값이다(`head_to_head`의 `sl`).
    - BFF `to_standard_acr`는 리더가 보낼 때 `isHmg`로 싣는다. 배지 = `isHmg` ∧ 당사 아님. 맞대결 행은 리더 규칙상 늘 당사가 아니다.
    - live에서 결과는 이름 목록과 같다(U1). '제네시스 마그마'(명부 4) · 'Hyundai Canada'(명부 1)는 HMG 관점에서 이미 당사이고, 단일 브랜드 관점에서는 HMG 계열이 된다. 둘은 choice 0 · appearance 7이라 상위 12 표에 들지 않는다.
    - 다른 안은 모두 `dim_brand.own_bit`로 고르기였다. 그러면 브랜드 표 안에서 당사(명부)와 계열(dim_brand)이 서로 다른 Gold 값을 읽는다. 두 Gold 값의 차이는 D1로 물었다. HUB는 합치거나 고치지 않는다(규칙 5).
  - **11-3.** 차종 당사는 Gold `isOurs`만이다(부모 이름이 당사 브랜드 목록에 있으면 당사로 보던 것을 뺐다). 배지도 `isHmg` ∧ ¬당사라, 당사와 HMG 계열이 함께 켜지지 않는다.
  - **11-4.** 브랜드 표 정렬에 원본의 최종 선택 · 언급 수(내림차순, 같으면 순위) · 브랜드(이름 오름차순, ko 정렬)를 더했다. `boardOrders`의 `choiceCount` · `appearanceCount` · `brand`이고, 문구는 `board.sortChoices` · `sortMentions` · `sortBrand`다. 정렬 버튼은 Top1 ACR · 후보군 포함율 · 증감 · 최종 선택 · 언급 수 · 브랜드 순서다. 1920 폭에서 카드 머리에 한 줄로 들어간다.
  - **11-5.** Hero의 '당사 = … 합산' 칩에서 `[.rn-dense_&]:hidden`을 뺐다. 리뉴얼은 늘 촘촘이라 그동안 이 칩이 보이지 않았다.
  - **11-6 재현 안 됨.** 리더 `funnel/acr`는 ACR 패널의 모든 축을 셀 조건에 건다(국가 · 언어 · 엔진 · 브랜드 유무 · 목록 유형 · depth1~3 · 브랜드(bgrp) · 기간). meta의 `ignored_filters` · `dropped_filters`는 늘 비어 있다(`context.meta`). 이 값을 채우는 곳은 인용 리더의 brand_not_found 하나다. BFF도 패널 축을 모두 리더 쿼리로 넘긴다(`read_standard_filters` → `analysis_query`). 그래서 무시되는 필터가 없고, 보일 안내도 없다. 시험 `EveryFilterApplies`(`test_gold_acr`)로 고정했다. 리더가 안내를 보내게 되면 그때 화면 표시를 더한다.
  - **golden.** `acr/renewal` 40개 파일이다(출력 35 · 녹음만 5, README 'Deliberate changes' 2026-10-31 step 11). 2026-10-30 'no HUB threshold' 항목에도 ACR을 이었다.
    - 발견은 33건이다.
    - 녹음(`funnel/acr`)에 `is_hmg`를 더했다. live Gold가 그 이름에 주는 규칙(U1)을 따랐다: `is_ours`이거나 이름이 Hyundai · Kia · Genesis.
    - 출력에는 `isHmg` 키(브랜드 행 · leader · 차종 행)와 `boardOrders` 세 키가 더해졌다.
    - 11-3으로 무작위 녹음의 차종 8행이 당사 → HMG 계열로 바뀌었다. 당사 차종 23행은 화면에 그리지 않던 `sibling`이 빠졌다.
    - `acr/standard` · `acr/gold`는 그대로다. 녹음에 플래그가 없고, live에서는 `isHmg`가 실리지만 원본 화면은 쓰지 않는다.
  - **원본 대조(live, 관리자).** 원본 `/ko/standard/ai-funnel/acr` 브랜드 표 12행의 Top1 ACR · 후보군 포함율 · 최종 선택 · 언급 수가 리뉴얼 브랜드 표 행과 같다(예: Toyota 17.7% · 64.5% · 6,374 · 16,029, Hyundai 6.8% · 88.9% · 2,451 · 22,230). 원본 정렬 셋(최종 선택 · 언급 수 · 브랜드)의 행 순서도 리뉴얼 새 정렬과 같다. 숫자는 바뀌지 않는다.
  - **화면 확인(1920×915, 관리자).** 리뉴얼 ACR 기본(HMG)과 `?brand=Kia`가 오류 화면 · 5xx 없이 열린다.
    - HMG 요약: 'Top1 ACR Toyota에 5.4pp 뒤짐', 'Kia, 후보군 포함율이 가장 가까운 BMW보다 Top1 ACR 0.1pp 낮음', 'Gemini에서 당사 1위 프롬프트 115/908 — ChatGPT보다 37개 적음', 'Toyota가 모든 엔진에서 1위인 프롬프트 156개'.
    - '당사 = Hyundai+Kia+Genesis 합산' 칩이 보인다.
    - Kia: 브랜드 표 Hyundai에 'HMG 계열'이 붙고, 페이지 전체에서는 5곳(표 · 차종 · 맞대결)이다.
    - 리더의 바뀐 SQL은 읽기 전용 세션에서 live Gold로 돌렸다(HMG 1.3초 · Kia 0.7초).
  - **그대로 둔 것.** standing의 격차 변화가 반올림해 0.0이면 '좁혀졌습니다'로 읽힌다. Mention standing도 같은 규칙이다. 리더 안에서 카드마다 당사 판정 Gold 값이 다르다(브랜드 표 = 명부, 차종 · 맞대결 · 추이 당사 합 = dim_brand). 두 이름(choice 0)에서만 갈리고, D1의 답을 기다린다.
  - **다음 단계가 알 것.** ACR 리더의 브랜드 · 차종 · 맞대결 행에 `is_hmg`가 있다. `StandardAcr` 행에는 리더가 보낼 때만 `isHmg`가 있다. `RnAcrView.boardOrders`는 키가 여섯이다. ACR 발견의 `params.dir`(leak)과 `diff` 0(engine)은 화면 문구를 고른다.

- **12단계(2026-10-31).** 네 항목 모두 고쳤다. 재현 시험은 고치기 전에 실패했다(리더 1개 · 화면 2개 · render 3개, 아래). Global · Website 리뉴얼 AI Conversion은 같은 본문 · BFF 화면이라 둘 다 바뀐다. GA4 수집 전이라 실제 숫자 대조는 없고 fixture로 봤다.
  - **12-1 리더.** 수집기 창(일별 `total` users 창)이 있는데 활성 속성 하나가 기간 중 하루라도 빠졌으면, W6의 합계처럼 그 합계의 조각도 모름(null)이다(`analytics_reader.whole_only`). 엔진(세션 · 조회 · 전환), 채널(세션 · 주요 이벤트 · 조회), 세그먼트 전환, 입구 페이지(여섯 값 모두), 이벤트 발생 수다. 시장(속성별) 전환은 그 속성이 빠졌을 때만 모름이다(세션은 W6부터 그랬다). 창이 하나도 없던 때의 행(확인할 수 없음)은 그대로다. 수집된 날에 행이 없는 조각은 목록에 없으므로 0을 채울 일이 없다.
    - 재현: DE가 10-25를 빠뜨리면 합계는 이미 모름인데 엔진 세션 12/16 · 전환 3/4, 채널 270/360, 입구 페이지 3/6, 이벤트 900/1,200, DE 시장 전환 1이 부분합으로 나갔다(`test_a_property_missing_days_leaves_the_slices_unknown`).
    - 리더가 `missing`(빠진 활성 속성의 property_id와 빠진 날)을 보낸다. 원본 `/ko/standard/ai-funnel/conversion` 표(엔진 · 페이지 · 국가 · 이벤트)도 같은 리더라 빠진 날이 있으면 값이 빈칸이 된다(원본 화면은 `missing`을 읽지 않음).
  - **12-1 화면.** 리더가 비운 값 위의 비중 · 순위는 저절로 비고, 화면에서 따로 부분합을 만들던 둘을 막았다(`test_a_missed_day_leaves_the_shares_and_blocks_unknown`, 고치기 전 실패).
    - 시장 비중: 활성 속성이 빠지면 속성 합계가 없다(전에는 Kia IT가 부분 합계의 100.0%였다).
    - 7일 합(Hero 전환 · 세션 작은 선): 빠진 날이 든 블록은 모름이다(전에는 그날을 뺀 합 186). 계획 목록에는 없던 것으로, 같은 규칙이라 같이 고쳤다. 수집됐는데 행이 없는 날은 지금처럼 0으로 더한다.
    - `view.missing`(id · 국가 · 브랜드 · 빠진 날)으로 Hero에 한 줄 안내를 둔다: 'GA4 속성 n개에 이 기간 수집되지 않은 날이 있습니다(독일 · Hyundai 1일). 기간 합계와 그 합계로 낸 비중 · 순위 · 7일 합은 … 계산하지 않습니다(‘—’)…'(`summary.missing` · `missingItem`). 필터가 없으면 이때 '기간 사용자 수가 없어' 안내는 띄우지 않는다(이유가 다름). 카드마다 같은 안내를 되풀이하지 않았다(W6 반복 줄이기).
    - 채널 카드: AI 행은 있는데 세션이 모름이면 엔진 필터 문구('AI Assistant 행이 없습니다')를 띄우지 않는다.
  - **15단계가 알 것(분해).** 분해 입력(두 기간의 AI 세션 · 전환 합계)은 W6부터 이 규칙을 따른다. 빠진 날이 있으면 합계가 모름이라 `decomp`가 null이다(시험에서 확인). 이번에 엔진별 세션 몫의 입력도 같은 규칙이 됐지만, 그때는 합계도 모름이라 따로 갈리는 경우가 없다. 분해를 두 요인의 값 · Δ로 바꿀 때도 입력은 같은 합계다.
  - **12-2.** 이름을 나눴다. Hero의 '사이트 전체'는 report 5(GA4 전체 트래픽 보고서) 합계 그대로 두고, 채널 카드의 합계 행은 '채널 합계'(채널 행을 더한 값)로 바꿨다. BFF 키도 `channels.site` → `channels.total`, 채널 발견의 `site` → `total`이다. 채널 카드 ⓘ에 두 값이 다른 보고서라 다를 수 있다고 적었다. 문구: `channels.total` · `info` · `take` · `note`, `findings.channel.detail`(ko · en). 다른 안은 한 정의로 맞추기였다. 채널 합계 행을 report 5로 바꾸면 행의 합이 아래 합계 행과 달라지고, 채널 비중의 분모로 report 5를 쓰면 보고서를 섞게 된다('보고서는 서로 더하지 않음').
  - **12-3.** `status.unmapped`는 '수집 중지'(en 'Collection stopped', Admin › GA4 연동의 '수집 중지'와 같은 말)다. `states.pendingTitle`은 'GA4 속성 {n}개가 아직 측정 중이 아닙니다'(중지 속성은 연결을 기다리지 않음), `pendingDesc`는 권한 대기 · 수집 중지 각각 언제 채워지는지, `findings.coverage.detail`은 카드 이름을 지금 제목('시장(GA4 속성)별 AI · 일반 전환')으로 고쳤다.
    - total: 중지 속성은 측정 범위 밖이라(W6, Admin 문구 '다음 수집부터 AI Conversion 화면에서 빠집니다') 시장 카드 목록에서 빼고 칩 total에서도 뺀다. 그래서 칩 '측정 중 a / t'와 발견 'GA4 속성 t개 중 a개'가 같은 t다(`coverage.total` = 목록 속성 수, `coverage.unmapped` = 중지 수). 상태 카드(권한 대기 등)의 속성 목록은 중지 속성도 '수집 중지' 표시로 보인다(왜 비었는지 알림). 다른 안은 목록에 남기고 total만 빼기였다. 그러면 칩 수와 행 수가 달라진다. `props.info`에 '수집을 중지한 속성은 이 표에 넣지 않습니다'를 더했다.
  - **12-4.** `states.nomatchDesc`: '국가 선택지는 계정이 읽을 수 있는 GA4 속성의 시장입니다(수집 중지 속성 제외)'(W0의 `property_options`와 같음). `renewal.visibility.states.nomatchDesc`('국가 선택지는 답변 측정 국가…')는 그 화면이 Gold 패널 선택지(`load_panel_options`, surface global)를 쓰므로 맞다. 고치지 않았다.
  - **문구.** `renewal.conversion` · `renewal.visibility` 키는 `messages/units`에 없다(확인). en 두 문장은 ICU 복수형이다. `i18n/request.test.ts` 통과.
  - **golden 없음.** Conversion은 golden case가 없다. 프런트 fixture(`conv-body.fixture.json`, 이 화면의 출력)를 다시 만들었다: `channels.site` → `total`, `missing: []`. 새 BFF 화면 · 프록시 · 권한이 없어 아키텍처 문서는 그대로다.
  - **화면 확인(1920×915, 관리자).** 리뉴얼 Global · Website AI Conversion과 원본 `/ko/standard/ai-funnel/conversion`이 오류 화면 · 5xx 없이 열린다. 지금 로컬 DB에 GA4 속성이 없어 리뉴얼 둘은 '연결된 GA4 속성이 없습니다'다.
  - **다음 단계가 알 것.** 리더 `analytics/conversion` 응답에 `missing`이 생겼다. `ConvView`에 `missing`이 있고, `ConvChannels.site`는 `total`이다. 직전 기간에만 빠진 날이 있으면 증감 칩이 '−'인데 이유 안내는 없다(합계 Δ는 W6부터 같았음, 16단계 '다음 일' 후보).

## 진행 기록

- 2026-10-31 — 계획을 작성했다. 근거는 같은 날 중간점검이다(코드 읽기 다섯 갈래: Overview · Mention · Citation · Prompts · AI Funnel, 큰 지적은 코드로 다시 확인). 처음에는 병렬 세션으로 나누려 했으나 사용자가 한 세션이 순서대로 하는 방식으로 바꿨다. 다음은 1단계다.
- 2026-10-31 — 1단계: Gold를 읽기 전용(SELECT, release 603 · 3647)으로 U1~U12를 확인해 '확인 결과' 표를 채웠다. 같음 7(U2 · U3 · U4 · U5 · U8 · U10 · U12), 다름 5(U1 ACR만 · U6 · U7 · U9 · U11)다. 업스트림 묶음에 'D. 2026-10-31 점검' 7개를 더했다. U1 · U6에서 나온 2개와 넘겨받은 5개(Hyundai N bit 16, 비완성차 경쟁사, 미측정 website 프롬프트 2,563개, URL 카드 모집단 4 · 10, Kona 귀속)다. `loc_owned` · `cit_m05` 차이는 W6 수정 뒤 같아져(US 19.90 = 19.90) 묻지 않는다. 코드는 고치지 않았다. 다음은 2단계다.
- 2026-10-31 — 2단계: ⛔J 추천안대로 website를 범위 계정(hq · region · country)에게 열었다(`access.clamp`, 사이트 국가 + SA 도시 사이트, project는 403). 원본 규칙대로 같이 고쳤다: 패널 국가 · 언어 선택지를 계정 범위로 좁힘(global · website), 브랜드 하나인 계정의 Website 시장별 현황, 모든 계정에서 오류였던 Website Overview(`engineLabel` 서버 · 클라이언트 경계, `ae8da9d`). 재현 시험은 고치기 전에 실패했다. 2-3(전용 사이트 계정)은 HUB에 그런 계정이 없어 해당 없음이다. 시험: BFF 34개 모듈 전부(+live 8개), 프런트 관련 시험 · typecheck · lint, e2e 24항목 + Global 4화면. 다음은 3단계다.
- 2026-10-31 — 3단계: 스파크라인 점마다 회차 · 값 · 직전 회차 Δ 툴팁(`RnSparkline` `tips`, Global Overview 카드), 당사 SOV 분자가 없을 때 경쟁사 대비 SOV '—', 비교 라벨을 카드들이 같이 가질 때만 머리에 두고 다르면 카드마다(Global `compareTitle`, Website `periodLabel` · `compareTitle`, Website '같은 길이' 문구 제거), 브랜드 표 Δ 없음 표시, 효과 없는 컨테이너 쿼리 · 쓰지 않는 문구 18개 정리. 재현 시험은 모두 고치기 전에 실패했다. golden 26건 의도 변경. 시험: BFF 34개 모듈 전부(+live 8개), 프런트 관련 23개 파일 181개 · typecheck · lint, 두 Overview 실제 화면 확인 · 원본 툴팁 대조. 다음은 4단계다.
- 2026-10-31 — 4단계: 인용 점유율 카드 경쟁사 줄이 카테고리를 이름 대신 Gold slug(`officialCompetitor`)로 고른다(4-4, 재현 시험은 고치기 전에 실패). 4-1은 BFF의 이름 접기 키가 Gold `dim_brand.bare`(UNIQUE)와 같아 재현되지 않았다(5,273개 브랜드 충돌 0). 4-2는 U5가 같아 할 일이 없다. 4-3은 화면에 RHQ id가 쓰이는 곳이 없어 재현되지 않았다. golden 함수 case 3개(slug 키 추가, 화면 출력 그대로). 시험: BFF 34개 모듈 전부(+live 8개), Overview 4화면 실제 확인 · 원본 대조. 다음은 5단계다.
- 2026-10-31 — 5단계: Mention KPI 탭에 회차별 분자 · 분모를 되살렸다(노출률 · 점유율 · 우호도 추이 툴팁 · 표 · CSV, 유형 선 점 툴팁 · CSV의 회차 답변 수, 5-1). 달력 월에는 요약 아래 답변당 언급 수 기간 줄을 되살렸다(5-2, Citation 방식). Website 요약 카드의 전체 언급 수 Δ는 중립이다(5-4, 원본 website · project도 같이). 재현 시험은 고치기 전에 실패했다. 5-3은 재현되지 않았다. 리더가 R1부터 당사 행을 관점 값 하나로 보내 위치 추이가 이미 Gold 관점 값이다(live 14회차 일치). golden 24건 의도 변경. 시험: BFF 34개 모듈 571개(+live 8개), 프런트 관련 12개 파일 78개 · typecheck · lint, 원본 대조 4조건, Global · Website 실제 화면. 다음은 6단계다.
- 2026-10-31 — 6단계: Mention 순위표가 모든 브랜드를 갖는다(6-1). BFF `rn-ranking`이 행 전부를 보내고(리더 상한 없음, global 752 · website 436), 화면은 처음 100행 · 전체 검색 · '더 보기' · 실제 전체 수 각주다. 100위 밖 행은 서랍 행을 같이 실어 서랍이 수치 · 감정 · 유형을 보인다. 검색 개수 문구 결함도 고쳤다. 순위표 머리와 서랍 프롬프트 목록 머리에 원본 열 정의 · 계산식 ⓘ를 되살렸다(6-2, 복수 언급 기준 포함). 재현 시험은 고치기 전에 실패했다. golden 9건 의도 변경. 시험: BFF 34개 모듈 574개(+live 8개), 프런트 관련 9개 파일 58개 · typecheck · lint, 원본 대조(100위 밖 행 값), e2e Global · Website 각 9항목. 다음은 7단계다.
- 2026-10-31 — 7단계: Mention 서랍이 그 브랜드를 읽는다(7-2). Gold 리더가 계약의 `mention_brand`를 원본 규칙으로 `dim_brand.brand_key`로 찾고, 인용 출처 · 상세 · 커버리지 분모를 그 브랜드가 언급된 답변으로 좁힌다. 당사 행은 두 탭 모두 own(`mention_own`)으로 읽는다(원본 `MentionsDrilldown`도). 인용 출처 탭을 원본처럼 되살렸다(7-1: 점유율 · 커버리지 · 당사 표시, URL 열 제거, 행 펼침 URL · 프롬프트 → 답변 원문). 유형 행 → 그 유형 프롬프트 → 답변 원문(7-3, 신호 서랍 재사용). 재현 시험은 고치기 전에 실패했다. golden 변경 없음. 시험: BFF 34개 모듈 584개(live 8개 포함), 프런트 관련 14개 파일 110개 · typecheck · lint, 원본 대조(Global · Website 첫 행 값), e2e Global · Website 각 9항목 + 원본 2화면. 다음은 8단계다.
- 2026-10-31 — 8단계: Mention 'HMG 계열' 배지를 HUB 이름 목록 대신 Gold `is_hmg_own`(본문 브랜드 읽기 `include=hmg`, 리뉴얼만)으로 정한다(8-1, live 결과 같음). 트리맵 '자동차 외' 묶음을 늘 접지 않고 다른 묶음과 같은 점유율 · 순서 규칙으로 접는다(8-2, 묶음 이름은 그대로). 트리맵 Δ 색은 반올림해 0.0일 때만 '변화 없음', 세기는 0.1 · 0.5 · 1.0pp 눈금(8-3, 범례 문구). 재현 시험은 고치기 전에 실패했다. 8-4는 재현되지 않았다(U2: 답변 있는 회차의 0은 Gold 뜻, 시험으로 고정). golden: tape · args에 플래그, 출력은 무작위 입력 case 3개만. 시험: BFF 34개 모듈(+live 8개), 프런트 Mention 7개 파일 · typecheck · lint, Global · Website 실제 화면. 다음은 9단계다.
- 2026-10-31 — 9단계: Citation 출처 선호 매트릭스에서 인용이 0인 열은 비중 '—'이고 칠하기 · cap · 발견에서 빠진다. 유형이 모두 0이면 원본 빈 안내를 보인다(9-1, U9 실데이터 07-06 · Genesis AT · Hyundai CH). 처방 문구 셋을 사실 문구로 바꿨다(9-2). Website 범프 범례는 '당사 도메인'이다(9-3). 카테고리 없는 긍정/부정 URL 행은 'Other' 대신 '—'다(9-6, 원본도). 범위 계정의 Website 도메인 표 · 서랍 · 내보내기가 본문과 같은 website 계정 규칙을 쓴다(9-7, 도시 사이트). 도메인 서랍의 읽는 중 · 실패 문구를 더했다(9-9, 원본도). 재현 시험은 고치기 전에 실패했다. 9-4(U2) · 9-8(이름이 이미 slug 라벨)은 재현되지 않았고, 9-5는 고칠 것이 없다(U3 · U4 같음, U6 태그는 Gold 설명의 도메인 순위 자사 표시 정의). golden 7건 의도 변경. 시험: BFF 34개 모듈 598개(live 8개 포함), 프런트 관련 13개 파일 103개 · typecheck · lint, 범위 계정 live 대조, Global · Website 인용 · 하위 화면 · 원본 실제 화면. 다음은 10단계다.
- 2026-10-31 — 10단계: Citation 출처 구성 줄의 회차 선이 점마다 회차 · 비중 · 인용 수를 보이고(3단계 `tips`, 인용 수는 같은 화면의 `live.categoryTrend`), 표 보기와 CSV에 회차별 인용 수 · 비중이 생겼다. 출처를 하나 고르면 선은 인용 수다(10-1, Global · Website). Website 도메인 표는 불러온 행을 모두 보이고 원본처럼 route `citation/domains`의 다음 200행을 '더 보기'로 붙인다. 카테고리는 불러온 행 안, 검색은 서버 전체다(10-2, 6단계식 전체 전송은 14,687행이라 고르지 않음). 재현 시험은 고치기 전에 실패했다. golden 1건 의도 변경. 시험: BFF 34개 모듈 589개(live 8개 포함), 프런트 관련 16개 파일 121개(건너뜀 1) · typecheck · lint, 원본 대조(150위 · 201위 · 회차 인용 수), e2e 26항목. 다음은 11단계다.
- 2026-10-31 — 9-9 후속: 9-9는 재현되지 않았다. `answerAnalysis.citations.drilldown.loading` · `loadFailed`는 처음부터 `messages/units/u7`에 있었고 요청 때 합쳐진다(진행 세션 판단 착오). 9단계가 `ko.json` · `en.json`에 더한 중복 두 키를 지워 `i18n/request.test.ts` 2건 실패를 고쳤다. 서랍 render 시험은 합친 메시지로 본다. '공통 규칙'의 문구 줄에 units 확인과 `i18n/request.test.ts` 실행을 더했다. 시험: `i18n/request.test.ts`, 리뉴얼 표준 · website 인용 · 원본 citations-view render 시험, typecheck · lint.
- 2026-10-31 — 11단계: ACR 요약 발견을 W6 방식으로 바꿨다. 순서는 고정했고, 문턱을 뺐고, 색은 당사 방향만 나타낸다. '후보군이 비슷한'은 '후보군 포함율이 가장 가까운 경쟁사와의 Top1 차'가 됐다(11-1). 'HMG 계열' 배지는 이름 목록 대신 리더가 행마다 주는 Gold 플래그로 정한다. 그 행의 당사 판정 값을 따르므로 브랜드 행은 명부, 차종 · 맞대결은 dim_brand다(11-2). 차종 당사는 Gold isOurs만이다(11-3). 브랜드 표에 원본 정렬 셋(최종 선택 · 언급 수 · 브랜드)을 되살렸다(11-4). 촘촘 화면에서도 '당사 = … 합산' 칩이 보인다(11-5). 재현 시험은 고치기 전에 실패했다. 11-6은 재현되지 않았다. 리더가 모든 ACR 축을 걸고 무시 · 제외 필터를 보내지 않으며, 시험으로 고정했다. golden은 40개 파일이다(출력 35 · 녹음만 5). 시험: BFF 34개 모듈 606개(live 8개 포함, 건너뜀 5), 프런트 ACR 2개 파일 23개 · i18n · typecheck · lint, 원본 브랜드 표 대조(12행 값 · 정렬 3종), 리뉴얼 ACR 실제 화면(HMG · Kia). 다음은 12단계다.
- 2026-10-31 — 12단계: AI Conversion에서 수집기가 활성 속성의 하루를 빠뜨리면 합계뿐 아니라 그 조각(엔진 · 채널 · 세그먼트 전환 · 입구 페이지 · 이벤트 수, 그 속성의 시장 전환)도 모름이다. 화면의 시장 비중 · 7일 합도 부분합을 내지 않고, Hero가 빠진 속성 · 날 수를 안내한다(12-1, 리더 `missing`, 원본 표도 같은 리더). 채널 카드 합계 행은 '채널 합계'로 이름을 나눴다(Hero '사이트 전체' = report 5, 12-2). '시장 미연결'은 '수집 중지'이고, 중지 속성은 시장 카드 목록 · 칩 total에서 빠져 측정 범위 발견과 같은 total이다(12-3). 결과 없음 안내의 국가 선택지 설명을 GA4 속성 시장으로 고쳤다(12-4, visibility 문구는 맞아 그대로). 재현 시험은 고치기 전에 실패했다. golden 없음, 프런트 fixture 재생성. 시험: BFF 34개 모듈 609개(live 8개 포함), 프런트 Conversion · Website Conversion · i18n 3개 파일 20개 · typecheck · lint, 리뉴얼 두 화면 · 원본 실제 화면. 다음은 13단계다.
