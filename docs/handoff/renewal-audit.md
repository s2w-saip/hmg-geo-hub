# 리뉴얼 점검 후속 (한 세션, 순서대로)

2026-10-31 중간점검에서 나온 문제를 고친다. 점검은 Global · Website 전 화면을 원본과 대조하고, 지표 · 데이터 원칙 · 화면 원칙을 확인했다. 진행 세션 하나가 1단계부터 순서대로 하되, 단계마다 새 하위 에이전트에게 맡긴다('진행 방식' 절). 단계를 마칠 때마다 이 파일을 고쳐 커밋 · 푸시한다. 컨텍스트를 비운(/clear) 뒤에도 이 파일만 보고 이어 갈 수 있게 썼다.

사용자 결정(2026-10-31):
- 병렬 세션으로 나누지 않고 한 세션이 순서대로 한다.
- 단계마다 새 하위 에이전트가 깨끗한 컨텍스트로 맡는다(B 방식).

**현재 위치:** 2단계(Website 범위 계정 접근) 시작 전. 1단계 끝(결과는 '확인 결과' 표 · 단계 메모). 마지막 커밋: 1단계 결과를 올린 커밋.

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
- **문구.** 새 문구는 그 화면의 기존 네임스페이스(`renewal.<화면>`, website는 `renewal.website.<화면>`)에 ko · en 함께 둔다.

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
| 2 | Website 범위 계정 접근 | ⛔J | [ ] |
| 3 | 공통 스파크라인 회차 값 · Overview 표시 | — | [ ] |
| 4 | 경쟁사 브랜드 접기(공용 모듈) · Overview 데이터 | 1 | [ ] |
| 5 | Mention ① KPI 탭: 회차별 분자 · 분모, 답변당 언급 수 Δ, 당사 평균 위치 | 1 | [ ] |
| 6 | Mention ② 브랜드 순위 표 전체 · 열 정의 | — | [ ] |
| 7 | Mention ③ 서랍 · 드릴다운 | — | [ ] |
| 8 | Mention ④ 귀속 · 트리맵 · bump | 1 | [ ] |
| 9 | Citation ① 결함 · 문구 · 귀속 | 1 | [ ] |
| 10 | Citation ② 구성 추이 수치 · Website 도메인 표 전체 | 3 | [ ] |
| 11 | ACR 발견 · 귀속 · 정렬 | 1 | [ ] |
| 12 | AI Conversion 부분합 · 문구 | — | [ ] |
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
- [ ] 2-1 재현 시험을 쓴다. region 계정 범위로 website를 읽으면 403이 나는 것을 확인한다.
- [ ] 2-2 clamp를 website에 연다. website 필터 패널(W0)에서도 계정 브랜드 잠금과 국가 좁히기가 원본처럼 보이는지 확인한다.
- [ ] 2-3 전용 사이트 계정(Hyundai N 등)의 국가 잠금(admin-todo 세션 메모 W0)과 겹치는지 확인한다.
- [ ] 2-4 docstring과 아키텍처 문서의 계정 · 권한 설명을 고친다.

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
- [ ] 3-1 `RnSparkline`은 aria-hidden SVG라 회차 값을 읽을 수 없다. 선택 prop을 더해 점마다 날짜 · 값 · 직전 회차 Δ를 hover로 보인다.
  - prop이 없으면 지금과 같다. 다른 사용처(Mention · Citation · ACR · Conversion · Visibility · website 주별 언급)의 render 시험은 그대로 통과해야 한다.
- [ ] 3-2 Global Overview KPI 카드 스파크라인(`overview-body.tsx` ~296-307)에 회차별 값과 직전 회차 Δ를 붙인다.
  - 원본은 점마다 '값 · WoW'를 툴팁으로 보였다.
  - BFF `overview/card-trend` spark points에 값이 이미 있다. Δ는 두 Gold 값의 차이다.
- [ ] 3-3 Website '경쟁사 대비 SOV'에서 당사 SOV가 비면 당사 언급을 0으로 넣어 '0.0배'가 될 수 있다(`BS/overview.py` ~281-283 → `BS/_summary.py` ~236). 값이 없으면 '—'로 보인다. 재현 시험부터 한다.
- [ ] 3-4 Global 기간 비교 라벨은 `compare[0]` 하나로 모든 카드를 대신한다(`BS/overview.py` ~387-390). 카드마다 자기 비교 라벨을 보인다.
- [ ] 3-5 Website 기간 hint `comparePeriod`('바로 앞 같은 길이의 기간')는 달력 월 비교(직전 달)에 맞지 않는다. 비교 종류에 맞는 문구로 고친다.
- [ ] 3-6 정리한다.
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
- [ ] 4-1 브랜드 이름을 trim하고 소문자로 맞춰 접으면서 한쪽 행을 버린다(`_competitors.py` ~36-38 · 118-126, `overview.py` ~727-741). Gold `brand_key`가 다르면 두 행을 모두 남긴다(규칙 5: 귀속을 합치지 않는다).
  - `_competitors`는 Overview · Mention · Citation이 같이 쓰므로 golden 전체를 돌린다.
  - 원본 화면도 바뀐다.
- [ ] 4-2 U5가 '다름'이면 경쟁사 우호도 분모(`_competitors.py` ~50-55)를 당사와 같은 정의로 맞춘다. Gold가 비율을 주면 그 값을 쓴다.
- [ ] 4-3 U7이 '다름'이면 권역 id를 Gold에 맞춘다.
- [ ] 4-4 'Official (Competitor)' 카테고리를 이름 문자열로 맞추는 곳(`_competitors.py` ~25 · 275)을 slug(`dim_category.slug`)로 바꾼다.

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
- [ ] 5-1 회차별 분자 · 분모를 되살린다(노출률 · 우호도 추이 툴팁, 유형 차트의 회차별 답변 수).
  - BFF points에는 분자 · 분모가 있지만 응답에서 뺀다(`mention_renewal.py` ~267 · ~305 · ~1075).
  - 추이 툴팁 · 표 보기 · CSV(`mention-rate.tsx` ~194 · 207, 지금은 %만)에 수를 더한다.
  - 원본의 WoW%는 HUB가 만든 값이라 옮기지 않는다.
- [ ] 5-2 답변당 언급 수 Δ(달력 월 모드)를 되살린다.
  - `resolve_delta`와 `COMPARE_KEY`(~62)가 지표 4개만 고른다. BFF는 이 값을 요청하고 있다.
  - U10이 '돌려줌'이면 기간 칩 줄에 더한다. 아니면 업스트림 질문으로 둔다.
- [ ] 5-3 당사 평균 위치 추이를 Gold 관점 회차 값(`_trend.py` ~347 `overviewSlots.avgPosition`)으로 바꾼다.
  - 지금은 당사 브랜드별 위치를 HUB가 가중평균한다(`mention_view.py` `_own_weighted_position` · `own_position_series`, `mention_renewal.py` ~332 · ~551). 히어로 값은 Gold 관점 값이라 마지막 점과 어긋날 수 있다.
  - 원본 Global 위치 추이도 같은 함수를 쓰는지 보고 단계 메모에 적는다.
- [ ] 5-4 Website KPI 세부 지표의 '전체 언급 수' 증가를 좋아짐(초록)으로 칠한다(`BS/mention_surfaces.py` ~65, `site-cards.tsx` ~213-216). 당사 지표가 아닌 셈(전체 언급 · 언급 브랜드 수 등)은 방향 색 없이 중립으로 칠한다.

**시험.** `test_screens_mention_renewal`, `test_screens_mention`, golden(mention), Mention render 시험, 원본 `/ko/standard/answer-analysis/mention` 대조(위치 추이).

---

### 6단계 — Mention ② 브랜드 순위 표 전체 · 열 정의

**읽을 파일**
- `BS/mention_renewal.py`: `BRANDS_TOP`(57), `shell_payload`(924-945), `ranking_payload`(1218-1250)
- `mention-brands.tsx`의 순위 표 부분(~520-630)
- 원본: `AA/brand-rank-table.tsx` 90-110
- 원본 열 정의 문구(grep: `colDefinition` · `colFormula`)

**할 일**
- [ ] 6-1 101위 이후 브랜드를 볼 수 있게 한다(Global · Website).
  - 지금은 BFF가 먼저 100행으로 자르고, 검색도 그 100행 안에서만 된다(`mention-brands.tsx` ~537).
  - 원본 Global은 전체를 검색한 뒤 100행을 보였고, 원본 website는 전체 표(436행)였다.
  - 고친 뒤: 처음 100행, 전체 대상 검색, '더 보기'. 잘림 각주는 실제 전체 수로 쓴다.
  - 리더에 상한이 있는지 먼저 본다. 행이 수백 개 수준이면 전체를 보내고 화면에서 자르는 쪽이 단순하다.
- [ ] 6-2 열 정의 · 산식 툴팁을 되살린다. 원본 브랜드 표와 서랍의 colDefinition · colFormula(평균 위치의 노이즈 제외, 언급률 · 점유율 산식 등)를 리뉴얼 표 머리 ⓘ로 옮긴다.

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
- [ ] 7-1 서랍 › 인용 출처를 원본처럼 되살린다.
  - 지금은 URL 열이 늘 '—'다(`mention_drilldown.py` ~275-284 `to_citation_domain`이 `urls: []`, `mention-brands.tsx` ~845-853). 점유율 · 커버리지 · 당사 표시도 그리지 않는다.
  - 원본처럼 행을 펼치면 `&skey=` 상세를 읽는다: URL 제목 · 인용 수 · 엔진 · 프롬프트 · 국가, 프롬프트 목록.
  - URL 열은 상세를 읽은 뒤의 수로 채우거나, 빼거나 한다.
- [ ] 7-2 서랍 목록 결함을 고친다(admin-todo 세션 메모 W2).
  - 증상: 어느 브랜드를 열어도 프롬프트 · 인용 출처 탭에 당사 목록이 나온다.
  - 원인: BFF는 `mention_brand=<이름>`을 보내는데, Gold 리더(`mention_prompts`, 인용 도메인 읽기)는 `brand_key`만 받는다.
  - 재현 시험부터 쓴다. 고치는 방법은 BFF가 `brand_key`를 보내거나 리더가 이름을 받는 것이다. 이름으로 `dim_brand.brand_key`를 찾는 것은 귀속을 바꾸지 않는다.
  - 원본 · 리뉴얼, Global · Website가 모두 고쳐진다.
- [ ] 7-3 유형 → 프롬프트 드릴다운을 되살린다.
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
- [ ] 8-1 'HMG 계열' 배지를 이름 목록 `HMG_BRANDS` 대신 Gold `is_hmg_own`(`?include=`)으로 정한다(`mention_renewal.py` ~370 · 558 · 913 · 1229).
  - W6가 'golden 영향이 크다'며 남긴 항목이다.
  - U1이 '같음'이면 golden 출력은 그대로이고 tape만 바뀐다.
- [ ] 8-2 `NON_AUTO` 이름 목록(~123-173 · 681)은 Google · Apple 등을 '자동차 외'로 묶고 트리맵에서 늘 접는다. 다른 그룹처럼 점유율 · 순서 규칙(`FOLD_SHARE` 1.5 · `FOLD_AFTER` 14)만 따르게 한다.
  - 원칙 판단: 표시 묶음은 사용자가 허용했지만, 늘 접어 숨기는 것은 숨김이다. 그래서 묶음 이름은 두고 늘 접는 것만 뺀다.
  - 비완성차 분류는 업스트림 질문 '비완성차 경쟁사'의 답을 따른다.
  - 점유율 · 순서 접기 자체는 표시 묶음이라 둔다.
- [ ] 8-3 트리맵 Δ 색 구간(~318-330, `KO renewal.mention.treemap.steps`)은 |Δ| < 0.2pp를 '변화 없음' 색으로 칠한다. W6 기준(반올림해 0일 때만 '변화 없음')으로 바꾸고, 색 세기는 판정이 아닌 크기 눈금으로 둔다.
- [ ] 8-4 U2가 '측정되지 않음'이면 bump의 빈 점을 0 대신 비워 둔다(`_trend.py` ~578, `mention_renewal.py` ~598-599).

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
- [ ] 9-1 표본이 0인 유형 열을 고친다(Global · Website).
  - 지금: `to_type_category_rows`(~178-192)가 유형 5개를 0으로 채운다 → `type_matrix`(~901-908)에 total 0인 열이 들어간다 → `matrix`(~880-892)가 그 열의 비중을 0으로 둔다. typeGap 발견(~1019-1027)은 '추천 답변 0.0% — 40pp 낮음'까지 만든다. 프런트(`citation-body.tsx` ~798-809)도 n = 0을 막지 않는다. 원본은 '—'였다.
  - 고친 뒤: n = 0 열의 비중은 null('—')이고, live · 발견 · cap 계산에서 뺀다.
  - 재현 시험(모의 입력)부터 쓴다. U9의 실제 필터도 확인 자료로 쓴다.
- [ ] 9-2 처방 문구를 사실만 말하는 문구로 바꾼다(ko · en 같은 키).
  - `renewal.citation.sub.positiveSub`: '유지·확산할 출처'
  - `renewal.citation.sub.negativeSub`: '대응 콘텐츠가 필요한 출처'
  - `renewal.citation.tone.subtitle`: '대응할 콘텐츠가 보입니다'
- [ ] 9-3 Website 범프 범례 · 설명이 당사 도메인을 '공식(HMG) 도메인'이라 부른다(`renewal.citation.bump.legendOwn` · `bump.info`, `citation-domains.tsx` ~137). website에서는 W6 표 태그와 같게 '당사 도메인'으로 쓴다. Global은 그대로 둔다.
- [ ] 9-4 U2가 '측정되지 않음'이면 인용 추이의 빈 점을 0 대신 비워 둔다(`citation_model.py` ~249-251).
- [ ] 9-5 U3(답변 톤) · U4(`cit_m05`) · U6('당사' 태그)가 '다름'이면 Gold 정의로 맞춘다. 'Gold로 알 수 없음'이면 업스트림에 두고 고치지 않는다. U6는 Website Overview 출처 구성비의 '당사' 태그에도 쓰인다.
- [ ] 9-6 출처 카테고리가 null인 행을 'Other'로 보인다(`citation_model.py` ~518, 긍정/부정 URL 행). Gold의 Other와 구분해 '—'로 보인다.
- [ ] 9-7 도메인 표 · 서랍은 `route_context`가 website 계정 규칙을 'standard'로 읽고, 본문은 'website'로 읽는다(`citation.py` ~178-196). 전용 사이트 계정(2단계 뒤)에서 본문과 표 · 서랍의 국가 잠금이 같은지 확인하고, 다르면 website로 맞춘다.

**시험.** `test_screens_citation`, `test_gold_citations`, golden citation, 인용 render 시험, 원본 대조(Global · Website 인용).

---

### 10단계 — Citation ② 구성 추이 수치 · Website 도메인 표 전체 [3단계 부품]

**읽을 파일**
- `citation-body.tsx`: 출처 구성 카드 ~540-700
- `citation-domains.tsx` 220-260
- `BS/citation_model.py` 380-400
- 원본: `AA/citations-standard-view.tsx` 380-400, `AA/citations-view.tsx` 360-380 · 660-690 · 870-890 · 1030-1050

**할 일**
- [ ] 10-1 출처 구성 추이의 회차별 수치를 되살린다(Global · Website).
  - 지금은 줄마다 스파크라인만 있고(~683-688), 카드 CSV(~566-569)에도 회차 값이 없다.
  - 원본은 회차 축, 툴팁(회차별 인용 수), 공백 음영을 보였고, 출처를 하나 고르면 절대 인용 수로 그렸다.
  - 고친 뒤: 3단계 스파크라인 툴팁(회차 · 비중 · 인용 수)을 쓴다. 표 보기 · CSV에 회차별 인용 수와 비중을 넣는다. 출처를 하나 고르면 선을 절대 인용 수로 그린다.
- [ ] 10-2 Website 도메인 표 101위 이하를 볼 수 있게 한다.
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
- [ ] 11-1 발견(~452-520)을 W6가 Mention · Citation · Conversion에 쓴 방식으로 바꾼다. 고정 순서로 두고, 색은 방향만 나타내고, 문턱은 없앤다.
  - 지금 있는 문턱: 6pp(leak의 '비슷함'), −0.5pp(leak), 3개(engine), 3개(sweep), 0.5pp(mover), 3개(dist). `pri` 중요도로 상위 4개를 고른다.
  - leak: '후보군이 비슷한' 경쟁사를 고르는 것 자체가 문턱이다. '후보군 포함율이 가장 가까운 경쟁사와의 Top1 차'라는 사실로 바꾼다. 차가 반올림해 0이면 '같음'이다.
  - engine · sweep · dist: 값이 있으면 사실로 쓴다(엔진 2개 이상, sweep 1개 이상, 0 선택 프롬프트 1개 이상).
  - mover: |Δ|가 반올림해 0이 아니면 쓴다. 제목 '가장 큰 변화'는 최댓값이라는 사실이라 둔다(Mention · Citation과 같다).
  - 문구: `summary.how`('중요도를 매겨 4개'), `find.leak.title`('비슷하지만'), `find.sweep.detail`('콘텐츠 보강 후보')를 고친다.
  - golden `acr/*`가 바뀐다. README의 2026-10-30 'no HUB threshold' 항목에 ACR을 더한다.
- [ ] 11-2 'HMG 계열' 배지를 이름 목록(~365 · 531-533) 대신 Gold `own_bit`으로 정한다. 리더가 브랜드마다 준다(`GR/acr.py` ~38 · 101). HMG 계열 = own_bit ≠ 0이고 관점 밖인 브랜드다. U1 결과를 확인한다.
- [ ] 11-3 차종 당사 판정(~567)은 Gold `isOurs` 또는 부모 브랜드 이름 일치다. Gold `isOurs`만 쓴다.
- [ ] 11-4 원본 정렬 5종 가운데 리뉴얼에 없는 이름 · 선택 수 · 언급 수 정렬을 브랜드 표에 되살린다.
- [ ] 11-5 촘촘 모드에서 Hero의 '당사 = … 합산' 칩이 숨는다(`acr-body.tsx` ~363-366). 정보이므로 숨기지 않는다.
- [ ] 11-6 필터 무시 · 제외 안내(`filter_notices`, ~161)는 계산되지만 어느 화면에도 보이지 않는다(원본도 같다). 무시된 필터를 알리지 않으면 사용자는 그 필터가 걸린 줄 안다. 그래서 보이게 한다.

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
- [ ] 12-1 부분합을 없앤다.
  - 빠진 날이 있으면 합계 · 일별은 '모름'으로 나온다(W6).
  - 그런데 다음 값은 부분합이 나가고, 비중 · 순위도 그 부분합으로 계산된다(`conversion.py` ~93-114 · 174-196): 엔진(`analytics_reader.py` ~211-213), 채널(~216-218), 세그먼트 전환(~223-224), 입구 페이지(~227-233), 이벤트 수(~234), 시장 전환(~245 · 248).
  - 같은 규칙으로 맞춘다: 창 안에 빠진 날이 있으면 '모름'이다.
  - 원본 표도 같은 리더라 같이 바뀐다.
- [ ] 12-2 '사이트 전체'라는 이름이 두 정의에 쓰인다. Hero는 report 5 합계(`conversion.py` ~81, `conv-body.tsx` ~278-284)이고, 채널 카드는 채널 행 합(~104-109, `conv-insights.tsx` ~69-79)이다. 이름을 나누거나 한 정의로 맞춘다.
- [ ] 12-3 '시장 미연결'(`status.unmapped`, `states.pendingDesc`, `findings.coverage.detail`)을 '수집 중지'로 바꾼다. 수집기에서 `unmapped`는 관리자 중지다. 속성 칩의 total(~213)과 coverage의 total(중지 제외, ~253)도 같게 맞춘다.
- [ ] 12-4 결과 없음 문구 `states.nomatchDesc`의 '국가 선택지는 답변 측정 국가'는 W0 변경 뒤로 맞지 않는다(지금은 GA4 속성 국가). 고친다. `renewal.visibility.states.nomatchDesc`는 숨긴 화면이라 그 화면 사실에 맞는지만 본다.

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

## 진행 기록

- 2026-10-31 — 계획을 작성했다. 근거는 같은 날 중간점검이다(코드 읽기 다섯 갈래: Overview · Mention · Citation · Prompts · AI Funnel, 큰 지적은 코드로 다시 확인). 처음에는 병렬 세션으로 나누려 했으나 사용자가 한 세션이 순서대로 하는 방식으로 바꿨다. 다음은 1단계다.
- 2026-10-31 — 1단계: Gold를 읽기 전용(SELECT, release 603 · 3647)으로 U1~U12를 확인해 '확인 결과' 표를 채웠다. 같음 7(U2 · U3 · U4 · U5 · U8 · U10 · U12), 다름 5(U1 ACR만 · U6 · U7 · U9 · U11)다. 업스트림 묶음에 'D. 2026-10-31 점검' 7개를 더했다. U1 · U6에서 나온 2개와 넘겨받은 5개(Hyundai N bit 16, 비완성차 경쟁사, 미측정 website 프롬프트 2,563개, URL 카드 모집단 4 · 10, Kona 귀속)다. `loc_owned` · `cit_m05` 차이는 W6 수정 뒤 같아져(US 19.90 = 19.90) 묻지 않는다. 코드는 고치지 않았다. 다음은 2단계다.
