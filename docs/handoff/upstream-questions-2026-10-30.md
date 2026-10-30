# 업스트림 질문 묶음 (초안, 2026-10-30)

받는 팀은 파이프라인 · Gold 팀이다. **초안이며 아직 보내지 않았다. 사용자가 보낸다.** 이 문서 때문에 코드를 고친 것은 없다.

- 기준 데이터: Gold live global release 603(version 27). Overview만 card release 604를 읽는다. rule `2026-10-25.provisional.2`, 최신 회차 2026-10-05.
- 출처 문서:
  - `acr-next-session.html` 2절 'P2 업스트림 질문' 6개
  - `gold-metric-review.html` 5절과 6절의 '상류 확인'
  - `metric-version-mix.md` 7절(ACR 질문 1에 Mention · Citation을 더한다)
  - `admin-todo.md` 2단계의 교정값 전달 합의 요청
  - 계획 파일 결과 칸에서 S2 · S3 · S4가 '상류'로 넘긴 항목
- 질문마다 **화면 영향**, **근거**(키 · 수치), **답에 따라 HUB가 할 일**을 적었다. 같은 원인의 질문은 합쳤고, 팀 안에서는 급한 순서로 놓았다.
- 맨 끝 '뺀 것'에는 이미 해결됐거나 결정으로 닫힌 항목을 모았다.

| 팀 | 질문 | 가장 급한 것 |
|---|---:|---|
| A. 측정 · 판정 (수집, ACR 판정, 감정 · 유형, 순위) | 5 | 회차별 측정 · 판정 방식 변경 기록(metric_version) |
| B. Gold 모델 · 귀속 (dim_entity · dim_source · 카테고리 · 카탈로그) | 8 | 당사 소유 출처(owned base) 귀속 빈칸 |
| C. 기준값 연동 (HUB → 파이프라인) | 1 (세부 6) | 인용 출처 교정값 전달 방식 |
| D. 2026-10-31 점검 (B팀 6 · A팀 1, 팀별 추가분) | 7 | ACR 명부와 dim_brand의 당사 비트 차이(D1) |

---

## A. 측정 · 판정

### A1. 회차별 측정 · 판정 방식 변경 기록과 metric_version의 뜻 (가장 급함)

- **화면 영향:** ACR · Mention · Citation · Overview의 추이 · Δ · 기간 합산이 측정 방식이 다른 회차를 가로지른다. 화면은 이것을 설명할 근거가 없다.
- **근거:**
  - **ACR**
    - (질문 · 국가 · 엔진) 3,567개는 09-28 · 10-05 두 회차에 다 있다. 이 셀들에서 generic 비율이 76.8% → 2.6%로 떨어졌다(ChatGPT 76.3 → 0.5, Gemini 77.3 → 4.8). 51개국 중 41개국에서 30pp 넘게 줄었다.
    - 08-24 → 08-31에는 27% → 86%로 올랐다.
    - 모델(gpt-5-6, 3.5 Flash-Lite)과 rule_ver는 같다. 당사 Top1은 09-28 → 10-05에 +10.1pp다.
    - 예 1: DE · ChatGPT, prompt `0ff8c98e-…`
      - 09-28: build 1210, cell 26800, answer 418518. Hyundai를 골랐는데 co_generic 10으로 기록됐다.
      - 10-05: build 739, cell 3137, answer 23071. Porsche, co_single 10.
    - 예 2: FR · Gemini, `13ac1e16-…`
      - 09-28: Golf를 골랐는데 generic 10.
      - 10-05: Golf, single 10.
  - **build의 metric_version이 회차 묶음마다 다르다.** live release의 acr · cell · fact family에 6가지가 섞여 있다.
    - 07-06은 `6f14…`
    - 07-13 ~ 08-17은 `25d5dba2bd71`
    - 08-10에는 `91a3bd0f6c34` cycle 1313이 섞인다.
    - 08-24에는 `6dd8bf6e8edb` cycle 1318이 섞인다.
    - 08-31은 `6dd8`
    - 09-07 ~ 09-28은 `fe8b8b504bd4`
    - 10-05는 `89eb7cada1d7`이고, 10-05만 10-25에 만들어졌다. 나머지 build는 10-27에 다시 만들어졌는데도 버전이 묶음마다 다르다.
    - dim_cycle의 generation · ecat_ver는 비어 있다.
  - **Mention.** 같은 질문 94%인 08-31 → 09-07(6dd8 → fe8b)에서 노출률 +5.0, 점유율 −3.3, 우호도 +4.9pp다. fe8b 안 주간 변동 최대치(3.0 · 1.6 · 3.7)를 넘는다. 경쟁사 노출률도 버전 안 최대치의 약 2배다.
  - **같은 버전 안에서 난 큰 변화**(버전으로 설명되지 않음):
    - 07-27 → 08-03(25d5): 우호도(긍정 신호 비율) 5.8 ~ 10.9% → 48.4%, 유형 '비교' 67% → 30%(같은 질문 −40.8pp). 감정 · 유형 분류 체계가 바뀐 것으로 보인다.
    - 08-24 → 08-31(6dd8 → 6dd8, 같은 질문 7,460개): 노출률 −10.5pp, 유형 '비교' · '추천' −8 ~ −10.5pp.
    - 09-21 → 09-28(fe8b): 답변당 인용 수 9.6 → 20.2.
    - 09-21 회차 인용은 376,702건(답변당 9.9)이다. 09-28 · 10-05 회차(약 93만 건, 답변당 약 20)의 절반에 못 미친다.
  - **cycle 단위 이상:**
    - 08-10 `91a3` cycle 1313(391단위, DE · KR · US, ChatGPT만)은 08-03과 같은 질문으로 비교하면 같은 회차 25d5 cycle과 반대로 움직인다(노출률 −11.7 대 +3.5, 인용 점유율 −17.7 대 +7.2).
    - 07-06(6f14)은 유형 '최종 선택'이 0건이다.
- **물을 것:**
  - (a) metric_version은 무엇을 가리키나?
  - (b) 위 날짜들(07-27 → 08-03, 08-24 → 08-31, 08-31 → 09-07, 09-21 → 09-28, 09-28 → 10-05)에 수집 · 판정(ACR generic 기준, 감정 · 유형 분류, 인용 수집)이 바뀌었나?
  - (c) 회차마다 측정 방식이나 변경 내역을 Gold에서 읽을 수 있게 줄 수 있나(예: dim_cycle 열이나 변경 기록 표)?
- **답에 따라 HUB가 할 일:** 변경 내역을 받으면 추이에 '측정 방식 변경 회차'를 표기할지 사용자 결정에 올린다. 숨기거나 값을 고치지는 않는다(ACR 회차 간 비교는 측정 방식이 바뀌어도 그대로 보이기로 2026-10-29에 정했다). 회차별 표시 필드가 생기면 BFF가 읽어 추이 툴팁에 붙인다.

### A2. ID 시장 답변 전량이 집계 대상에서 빠지는 이유 (elig=false)

- **화면 영향:**
  - Global prompts에 '미측정'이 503행 나온다.
  - 인도네시아(ID · id)는 답변이 있는데도 모든 KPI 화면에서 빠진다(std_in 0).
- **근거:**
  - 미측정 503행은 10-05를 포함해 매 회차 답변이 있다(job_index served · analysis complete). 예: 23926은 08-31 ~ 10-05 6회차 × chatgpt · gemini.
  - 10-05 `answer_fact` elig=false는 980건(497 prompt)이다.
  - 503행 중 500행은 ID 시장 · id 언어이고, ID · id std_in은 0이다.
  - 나머지 3행은 UA 2 · KZ 1(uk · ru)이다. UA는 std_in 404, KZ는 400이라 그 시장 데이터는 있다.
- **답에 따라 HUB가 할 일:**
  - 의도한 제외라면 Global prompts 미측정 사유 문구와 시장 목록에 '집계 제외(사유)'를 적는다.
  - 판정 오류라면 Gold 재빌드를 기다린다. HUB 코드는 바꾸지 않는다.

### A3. AI 우선 노출도 rk의 산정 기준

- **화면 영향:** Overview · Mention의 우선 노출도 정의 문구('답변에서 먼저 언급된 순서')가 Gold 값과 맞지 않을 수 있다. 값 자체는 Gold rk와 같다.
- **근거:**
  - `answer_brand_fact.rk`가 first_pos 순위와 같은 비율은 55%다.
  - 표본(answer_key 2)에서는 브랜드 엔티티의 평균 언급 위치(avg_position) 순위였고, 동순위를 공유했다. Bentley 2위가 첫 등장이 더 이른 Hyundai 3위보다 앞선다.
  - 이름 조인 근사로는 85%가 같다.
- **답에 따라 HUB가 할 일:** 받은 산정 기준대로 Overview · Mention의 정의 · 산식 툴팁 문구를 고친다. 값 계산은 바꾸지 않는다.

### A4. ACR 반복 측정 · 후보 데이터의 단위

- **화면 영향:** ACR '결선 맞대결'과 '차종 전환율'의 정의와 표본 안내가 이 단위에 달려 있다.
- **근거:**
  - **valid_acr.** 10-05 셀 3,761개에 run 3,761, job · iter 3,763개인데 valid_acr 중앙값은 10이다. 독립된 답 10개인지, 답 하나를 10번 판정한 것인지 알 수 없다.
  - **acr_iter_shortlist는 셀당 대표 반복 1개만 담는다.** 2,843 ÷ 35,927 = 7.9%다. 결선 맞대결은 이 표(level 1)와 `acr_iter_fact.winner_brand_key`로 센다.
  - **acr_entity_fact level 2.** 후보로 오르지 않은 행(appearance 0, 선택 0)이 있다. 최근 3회차 907행이고, 후보 목록 밖 언급(off_shortlist)은 1,941건이다.
    - 차종 전환율은 이 표를 쓰고, 정의상 이 행을 분모에서 뺀다.
    - 이 행을 넣으면 값이 바뀐다. 예: Toyota Corolla Hybrid 18.1%(330셀) → 15.8%(376셀).
- **답에 따라 HUB가 할 일:**
  - 독립된 답 10개라면 지금 '반복 측정' 문구를 유지한다. 답 하나를 10번 판정한 것이라면 결선 맞대결 · 차종 전환율의 정의와 표본 문구를 고친다.
  - level 2의 appearance 0 행이 뜻하는 바에 따라 차종 전환율 분모(지금은 뺌)를 사용자 결정에 다시 올린다.
  - shortlist에 반복 전체가 들어오면 맞대결 카드의 '셀당 반복 1개 표본' 안내를 지운다.

### A5. 같은 회차 안의 중복 측정과, 한 날짜의 회차 둘

- **화면 영향:**
  - ACR '측정 셀'은 '셀(질문 × 엔진 × 국가)'인데 같은 셀을 두 번 센다.
  - 같은 날짜를 고른 기간 합산에는 두 회차가 섞인다.
  - 08-24 cycle 하나가 Mention에만 들어가고 Citation에서는 빠진다.
- **근거:**
  - **ACR 같은 회차 재측정.**
    - 최대 20셀이 6개 measured_date에 걸친다.
    - 전체 19,111개 그룹 중 3,266개가 2셀 이상이고, is_rep가 2개인 그룹이 997개다.
    - 10-05에는 같은 (질문 · 엔진 · 국가 · 언어) 셀 190묶음(194셀)이 둘 다 acr_in이다(is_rep는 하나).
    - is_rep만 세면 셀 3,761 → 3,567, 반복 35,927 → 34,406, 포함율 92.1%, Top1 12.4%가 된다.
  - **한 round_date에 servable 회차가 둘이다.**
    - 08-24: cyc 1316(08-18 ~ 19 측정)과 1318(08-25 ~ 29 측정). time=2026-08-24이면 셀 1,731에 고유 조합 704, 겹치는 조합 622다.
    - 07-13 · 08-10 · 08-17도 겹친다(248 · 69 · 58).
    - cyc 1318은 hidden_scope 2라 Citation에서만 숨겨진다.
- **물을 것:**
  - (a) 같은 회차 재측정의 이유와, 대표 셀이 둘일 때 어느 것을 써야 하는지.
  - (b) 한 날짜에 회차가 둘인 이유.
  - (c) hidden_scope 2의 뜻.
- **답에 따라 HUB가 할 일:**
  - 대표 셀 규칙을 받으면, 리더가 그 셀만 세도록 바꿀지 사용자 결정에 올린다(셀 · 반복 · 포함율 값이 바뀐다).
  - hidden_scope 뜻에 따라 08-24 Mention · Citation 차이를 설명하는 문구를 붙인다.

### A팀에 보낼 메시지

```text
[문의] HMG GEO HUB — 측정·판정 방식 확인 5건 (Gold live global release 603, rule 2026-10-25.provisional.2, 최신 회차 2026-10-05)

1. 회차별 측정·판정 방식 변경과 metric_version의 뜻 (가장 급함)
 - ACR: 09-28과 10-05에 모두 있는 (질문·국가·엔진) 3,567개에서 generic 비율이 76.8% → 2.6%(ChatGPT 76.3 → 0.5, Gemini 77.3 → 4.8, 51개국 중 41개국 −30pp 넘음). 08-24 → 08-31은 27% → 86%. 모델(gpt-5-6, 3.5 Flash-Lite)과 rule_ver는 같음.
   예) DE·ChatGPT prompt 0ff8c98e-…: 09-28 build 1210 cell 26800 answer 418518, Hyundai 선택인데 co_generic 10 / 10-05 build 739 cell 3137 answer 23071, Porsche co_single 10.
   예) FR·Gemini 13ac1e16-…: 09-28 Golf 선택 generic 10 / 10-05 Golf single 10.
 - build metric_version이 회차 묶음마다 다름(acr·cell·fact 모두): 07-06 6f14 / 07-13~08-17 25d5dba2bd71 / 08-10 cycle 1313 91a3bd0f6c34 / 08-24 cycle 1318·08-31 6dd8bf6e8edb / 09-07~09-28 fe8b8b504bd4 / 10-05 89eb7cada1d7(10-05만 10-25 생성, 나머지 10-27 재생성). dim_cycle generation·ecat_ver는 비어 있음.
 - Mention·Citation(같은 질문 기준): 08-31 → 09-07(6dd8 → fe8b) 노출률 +5.0, 점유율 −3.3, 우호도 +4.9pp(같은 버전 안 주간 변동 최대 3.0·1.6·3.7을 넘음).
 - 같은 버전 안의 큰 변화: 07-27 → 08-03(25d5) 긍정 신호 비율 5.8~10.9% → 48.4%, 유형 '비교' 67% → 30% / 08-24 → 08-31(6dd8) 노출률 −10.5pp, 유형 비교·추천 −8~−10.5pp / 09-21 → 09-28(fe8b) 답변당 인용 수 9.6 → 20.2, 09-21 회차 인용 376,702건으로 09-28·10-05(약 93만)의 절반 이하.
 - 08-10 cycle 1313(91a3, DE·KR·US, ChatGPT만, 391단위)은 같은 회차 25d5 cycle과 반대로 움직임(08-03 대비 노출률 −11.7 대 +3.5, 인용 점유율 −17.7 대 +7.2). 07-06(6f14)은 유형 '최종 선택'이 0건.
 물을 것: (a) metric_version은 무엇인가요? (b) 위 날짜들에 수집·판정(ACR generic 기준, 감정·유형 분류, 인용 수집)이 바뀌었나요? (c) 회차별 측정 방식이나 변경 내역을 Gold에서 읽을 수 있게(dim_cycle 열 등) 주실 수 있나요?

2. ID 시장 답변 전량이 elig=false인 이유
 - Global prompts 미측정 503행은 10-05 포함 매 회차 답변이 있음(job_index served·analysis complete). 10-05 answer_fact elig=false 980건(497 prompt).
 - 503행 중 500행이 ID 시장/id 언어(ID·id std_in 0). 나머지 3행은 UA 2·KZ 1(uk·ru)인데 UA std_in 404, KZ 400으로 시장 데이터는 있음.
 물을 것: 의도된 제외인가요? 그렇다면 사유를 알려 주세요.

3. answer_brand_fact.rk 산정 기준
 - 화면 정의는 '답변에서 당사보다 먼저 언급된 브랜드 수 + 1'인데, rk가 first_pos 순위와 같은 비율은 55%. 표본(answer_key 2)에서는 avg_position 순위로 보였고 동순위 공유(Bentley 2위가 첫 등장이 더 이른 Hyundai 3위보다 앞섬).
 물을 것: rk는 무엇을 기준으로 매기나요? 동순위 규칙은?

4. ACR 반복·후보 데이터의 단위
 - 10-05 셀 3,761개에 run 3,761, job·iter 3,763개인데 valid_acr 중앙값 10. 독립된 답 10개인가요, 답 하나를 10번 판정한 것인가요?
 - acr_iter_shortlist는 셀당 대표 반복 1개만 담음(2,843 ÷ 35,927 = 7.9%). 반복 전체를 담을 계획이 있나요?
 - acr_entity_fact level 2에 후보로 오르지 않은 행(appearance 0, 선택 0)이 있음(최근 3회차 907행, off_shortlist 1,941건). 이 행은 무엇인가요? 차종 전환율 분모에 넣어야 하나요?

5. 같은 회차 안 중복 측정과 한 날짜의 회차 둘
 - 같은 회차 재측정: 최대 20셀, 6개 measured_date. 19,111개 그룹 중 3,266개가 2셀 이상, is_rep 2개인 그룹 997개. 10-05에는 같은 (질문·엔진·국가·언어) 셀 190묶음(194셀)이 둘 다 acr_in.
 - 08-24에 servable 회차 2개(cyc 1316 08-18~19 측정, cyc 1318 08-25~29 측정, 겹치는 조합 622). 07-13·08-10·08-17도 겹침(248·69·58). cyc 1318은 hidden_scope 2라 Citation에서만 빠짐.
 물을 것: (a) 재측정 이유와 대표 셀이 둘일 때 쓸 셀 (b) 한 날짜에 회차가 둘인 이유 (c) hidden_scope 2의 뜻
```

---

## B. Gold 모델 · 귀속

### B1. 당사 소유 출처(owned base) 귀속 빈칸과 브랜드 관점

- **화면 영향:**
  - Citation '공식(당사) URL 인용 프롬프트'(10-05: 5,646 / 미인용 5,758)가 적게 나올 수 있다.
  - 도메인 표의 HMG 태그와 도메인 상세의 국가 배지가 빈다.
  - Kia 계정의 AI 인용 점유율에는 현대 · 제네시스 출처가 들어간다.
- **근거:**
  - 공식(HMG) 인용 233,628건 중 110,433건에 owned base(owner_key)가 없다.
  - kia.com 상위 URL 100개 중 53개는 owner_key가 없다(owners.kia.com/us, update.kia.com, org-/stg-worldwide, press 등). 31개는 owner는 있지만 geo_code가 없다(worldwide.kia.com/en 103, www.kia.com/eu 139).
  - brand=Kia의 인용 점유율(`kpi_cell` cit_m05)은 23.58%(93,111 / 394,883)로, HMG 3사 공식 출처를 모두 센다. Kia 소유 출처만 세면 19.57%다.
- **답에 따라 HUB가 할 일:**
  - owner · geo가 채워지면 HUB는 고칠 것이 없다(숫자 · 태그 · 배지가 따라온다).
  - cit_m05의 3사 합산이 의도라면 지금 정의 문구('브랜드와 무관하게 HMG 3사')를 유지한다. 아니라면 재빌드를 기다린다.

### B2. 경쟁사 출처의 브랜드 빈칸과 Smart 분류

- **화면 영향:**
  - Overview 'AI 인용 점유율' 경쟁사 행과 Citation 경쟁사 선택에서 BYD · Stellantis · GM · GWM 계열이 빠진다.
  - AI 점유율 분모에서 Smart가 빠진다(영향 작음).
- **근거:**
  - 공식(경쟁사) 출처 903개 중 41개(7,186건)에 `competitor_brand_key`가 없다(stellantis.com · gm.com · bydauto.* · gwm.* 등).
  - 'Smart'는 비경쟁(kind 3)인데 smart.com은 공식(경쟁사)이다(38회).
- **답에 따라 HUB가 할 일:** 채워지면 화면에 그대로 나온다. HUB 코드는 바꾸지 않는다(BFF가 귀속을 다시 정하지 않는다).

### B3. ACR 엔티티 · 브랜드 귀속 (dim_entity · dim_brand · keep · brand_key 0)

- **화면 영향:** ACR 경쟁 구도 · 선택 분포 · 결선 맞대결 · 차종 표에 다음이 그대로 보인다.
  - 자동차가 아닌 브랜드
  - 중국어 차종명
  - '선택 없음'에 섞인 선택
  - 이름 없는 브랜드
- **근거:**
  - **비자동차 엔티티가 브랜드로 집계된다.** Lidl 6 · Mercadona 1 · Kirkland Signature 1 · Wald International 1회 선택이 있고, 분포 hover에 NASA · Canon · Giorgio Armani 등이 나온다.
  - **keep.** 10-05 회차에서 keep=false 엔티티가 선택된 311회가 '선택 없음'으로 보인다(기간 09-21 ~ 10-05는 326회).
  - **brand_key 0 '(이름 없음)'.**
    - `acr_iter_fact.winner_brand_key`가 단일 선택이 아닌 반복(result_type 2 · 4 · null)에서 0이다(10-05 605회).
    - `acr_iter_shortlist` level 1에 후보로 6,445행 있고, 그중 당사와 함께 오른 반복이 1,487개다.
    - 07-01 ~ 10-05 전체에서 winner 0은 22,016 / 26,002회다.
  - **차종명 · 소속.**
    - 伊兰特(dim_entity 175) · 途胜가 중국어 그대로다.
    - 'Škoda Octavia Combi' · 'Skoda Octavia Combi'가 두 행이다. 'Everest' 등도 있다.
    - 같은 엔티티가 반복마다 다른 소속 브랜드를 받아, 차종 66개가 132행으로 나온다.
- **물을 것:**
  - (a) 비자동차 엔티티를 브랜드로 둘지.
  - (b) keep의 정의.
  - (c) brand_key 0이 '브랜드 없음'이 맞는지, 후보 목록의 0은 무엇인지.
  - (d) rep_name 정규화와, 반복마다 parent_brand_key가 달라지는 이유.
- **답에 따라 HUB가 할 일:**
  - keep · brand_key 0의 정의에 따라 결선 맞대결의 경쟁사 제외 규칙(지금은 0을 뺌)과 '선택 없음' 문구를 고친다.
  - 이름 · 소속은 Gold가 고치면 그대로 따라간다. HUB가 거르거나 합치지 않는다.

### B4. 출처 카테고리 귀속이 의심스러운 곳

- **화면 영향:** Citation 출처 구성 · 출처 선호 매트릭스의 공식(경쟁사) · 딜러 · 마켓 · 소셜 비중이 이 귀속을 따른다.
- **근거:** 아래 출처들의 카테고리가 성격과 맞지 않아 보인다.

  | 출처 | 지금 카테고리 |
  |---|---|
  | bmwgroup.com · global.toyota · toyota-europe.com · toyota-global.com | 딜러 · 마켓 |
  | rolls-roycemotorcars.com | 기타 |
  | apple.com | 소셜 · 영상 |

- **답에 따라 HUB가 할 일:**
  - 파이프라인 규칙으로 고치면 재빌드를 기다린다.
  - 규칙으로 고치지 않으면 HUB 관리자가 Admin › 인용 출처 분류에서 교정한다. 교정값은 C1 경로로 넘어간다.

### B5. 콜롬비아 · 베트남의 권역 미분류

- **화면 영향:** Overview 시장별 현황에 '권역 미분류' 76.2(CO · VN)가 나오고, 두 나라가 Asia · Latin America 권역 합계에서 빠진다.
- **근거:** `dim_country`에서 CO · VN의 region_key가 0(코드 '')이다. CO는 Latin America, VN은 Asia일 것으로 보인다.
- **답에 따라 HUB가 할 일:** 고쳐지면 권역 합계가 저절로 바뀐다. HUB 코드는 바꾸지 않는다.

### B6. 인용 URL을 묶는 단위 (url vs url_norm)

- **화면 영향:** Citation '긍정 · 부정 답변에 인용된 URL'의 총계와 순위. 같은 기사가 utm 파라미터로 나뉜다.
- **근거:**
  - Consumer Reports 성적표 기사가 4위 431(`?utm_source=chatgpt.com`)과 6위 371로 나뉜다. url_norm 기준이면 802로 2위가 된다.
  - 총계(A 조건)는 긍정 226,805 → 130,284, 부정 10,877 → 7,326으로 바뀐다(url_norm 기준).
- **답에 따라 HUB가 할 일:** url_norm을 쓰라고 하면, 리더의 톤별 URL · 도메인 상세 묶음 키를 바꿀지 사용자 결정에 올린다(총계와 순위가 바뀐다).

### B7. 프롬프트 카탈로그 · 분류 값의 빈칸과 자리표시

- **화면 영향:** ACR은 번역 질문끼리 묶거나 주제별로 볼 수 없다. Global prompts에서는 언어 필터 누락, '-' 옵션, 영어 화면의 한국어 퍼널, 깨진 문구, 삭제 표시인데 '측정중'인 행, 중복 행이 생긴다.
- **근거:**
  - **ACR 프롬프트 940개**
    - prompt_id 940개 중 729개가 한 나라에서만 쓰인다. 번역 질문끼리 묶는 키가 필요하다.
    - depth1 ~ 4 · list_type · presence가 모두 비어 있고, funnel은 하나뿐이다.
  - **Global 카탈로그**
    - 'Je údržba IONIQ 5 drahá?'(CZ · SK) 2행이 lang_key 0이다.
    - Depth3 코드 '-'가 1,275행에 있다(자리표시).
    - 퍼널 코드가 한국어뿐이고 영문 라벨이 없다.
    - `dim_prompt.text`가 깨진 1건이 있다(f80b3790…, '…del EV?ículo?').
    - `pub_prompt.catalog_deleted=true`(10-05)인 13행(12 prompt, 모두 ko)이 catalog_entry · std_in을 유지한다.
    - catalog_entry 중복 행이 2쌍이다(prompt_key 10681 Hyundai × 2 속성 같음, 4220 Kia × 2 속성 다름).
- **답에 따라 HUB가 할 일:**
  - 값이 채워지면 필터 · 배지에 그대로 나온다.
  - catalog_deleted의 뜻에 따라 Global prompts의 '측정중' 상태 표기를 고칠지 정한다.
  - 번역 묶음 키가 생기면 ACR 질문 묶음 보기를 제안한다.

### B8. kpi_cell과 citation_fact의 인용 수 차이 (낮음)

- **화면 영향:** 없음(0.1 단위 표시에는 드러나지 않음).
- **근거:** cit_total 935,276 vs citation_fact 935,282(6건). 09-28은 927,800 vs 927,801이다.
- **답에 따라 HUB가 할 일:** 원인만 기록한다.

### B팀에 보낼 메시지

```text
[문의] HMG GEO HUB — Gold 모델·귀속 확인 8건 (Gold live global release 603, card 604, 최신 회차 2026-10-05)

1. 당사 소유 출처(owned base) 귀속 빈칸
 - 공식(HMG) 인용 233,628건 중 110,433건에 owner_key 없음. kia.com 상위 URL 100개 중 owner_key 없음 53(owners.kia.com/us, update.kia.com, org-/stg-worldwide, press 등), owner는 있으나 geo_code 없음 31(worldwide.kia.com/en, www.kia.com/eu).
 - brand=Kia일 때 인용 점유율(kpi_cell cit_m05) 23.58%(93,111/394,883)가 HMG 3사 공식 출처를 모두 셈. Kia 소유 출처만이면 19.57%.
 물을 것: owner_key·geo_code를 채울 계획이 있나요? cit_m05의 3사 합산은 의도인가요?

2. 경쟁사 출처의 브랜드 빈칸
 - 공식(경쟁사) 출처 903개 중 41개(7,186건)에 competitor_brand_key 없음(stellantis.com·gm.com·bydauto.*·gwm.* 등) → BYD 등이 경쟁사 인용에서 빠짐.
 - 'Smart'가 비경쟁(kind 3)인데 smart.com은 공식(경쟁사)(38회).
 물을 것: 채워 주실 수 있나요? Smart 분류가 맞나요?

3. ACR 엔티티·브랜드 귀속
 - 비자동차 엔티티 선택: Lidl 6·Mercadona 1·Kirkland Signature 1·Wald International 1(분포에 NASA·Canon·Giorgio Armani 등).
 - keep=false 엔티티가 선택된 311회 → keep의 정의는?
 - brand_key 0 '(이름 없음)': acr_iter_fact.winner_brand_key가 단일 선택이 아닌 반복(result_type 2·4·null)에서 0(10-05 605회, 07-01~10-05 22,016/26,002회). acr_iter_shortlist level 1에도 후보로 6,445행(당사와 함께 오른 반복 1,487). '브랜드 없음'이 맞나요? 후보 목록의 0은 무엇인가요?
 - 차종명: 伊兰特(dim_entity 175)·途胜, 'Škoda Octavia Combi'·'Skoda Octavia Combi' 두 행, 'Everest'. 같은 엔티티가 반복마다 다른 소속 브랜드를 받아 차종 66개가 132행.
 물을 것: 비자동차 처리, keep 정의, brand_key 0의 뜻, rep_name 정규화와 parent_brand_key가 반복마다 달라지는 이유.

4. 출처 카테고리 귀속 확인
 - bmwgroup.com·global.toyota·toyota-europe.com·toyota-global.com = 딜러·마켓, rolls-roycemotorcars.com = 기타, apple.com = 소셜·영상.
 물을 것: 규칙으로 고치실 건가요? 아니면 HUB 교정값(아래 별도 문의)으로 넘기면 될까요?

5. dim_country CO·VN region_key 0(코드 '') → 권역 합계에서 빠짐. CO = Latin America, VN = Asia가 맞나요?

6. 인용 URL 묶음 단위: 화면은 dim_url.url 단위라 utm 파라미터로 같은 기사가 나뉨(Consumer Reports 기사 431 + 371, url_norm이면 802). 긍정 URL 총계 226,805 → url_norm 130,284, 부정 10,877 → 7,326. 어느 단위를 보여야 하나요?

7. 프롬프트 카탈로그·분류 값
 - ACR 프롬프트 940개: prompt_id 729개가 한 나라 전용(번역 질문 묶음 키가 있나요?), depth1~4·list_type·presence 비어 있고 funnel 하나.
 - Global: 'Je údržba IONIQ 5 drahá?'(CZ·SK) 2행 lang_key 0 / Depth3 코드 '-' 1,275행 / 퍼널 코드 한국어뿐(영문 라벨?) / dim_prompt.text 깨짐 1건(f80b3790…, '…del EV?ículo?') / pub_prompt.catalog_deleted=true(10-05)인 13행(12 prompt, ko)이 catalog_entry·std_in 유지 / catalog_entry 중복 2쌍(prompt_key 10681 Hyundai×2, 4220 Kia×2 속성 다름).
 물을 것: 각 항목이 의도인지, 정리 계획이 있는지. catalog_deleted의 뜻은?

8. (낮음) kpi_cell cit_total 935,276 vs citation_fact 935,282(6건), 09-28 927,800 vs 927,801. 차이 원인은?
```

---

## C. 기준값 연동 (HUB → 파이프라인)

### C1. 인용 출처 교정값 전달 방식 합의

- **화면 영향:** HUB Admin › 인용 출처 분류에서 고친 값이 화면 숫자에 닿으려면 파이프라인이 이 값을 읽어야 한다. 그 전까지 화면은 행마다 '반영 대기'로 보인다.
- **근거:**
  - HUB가 출처 카테고리 교정(override), 출처 분류 코드표(카테고리 13개 · 분류 출처 코드 1~6), 시드 · 공식 소셜 목록의 정본을 갖는다(2026-10-30 결정 A · 코드표 · G). 자동 분류(규칙)는 파이프라인이 정한다. 시드 · 공식 소셜 목록은 원래 원본 HUB 앱 파일(`seed.json` · `official-social.ts`)에서 나왔다.
  - 교정값은 외부 API family `source_override`(source `hub_edit`)로 내보낸다. 키는 소문자 · 앞 `www.`를 뺀 skey이고, 값은 `dim_category.slug`다.
  - 변경은 `change_seq` · etag로 알린다.
  - 처음 값은 Gold에 있던 교정 2건(arxiv.org, danawa.com)이다.
- **답에 따라 HUB가 할 일:**
  1. 폴링 주기를 받으면 화면의 '반영 대기' 안내에 적는다.
  2. 원복 동작을 받으면 원복 버튼 설명을 맞춘다.
  3. 반영 확인 기준이 다르면 BFF의 applied / pending 판정 기준을 바꾼다.
  4. 키 정규화가 다르면 HUB 키 규칙을 맞추는 마이그레이션을 만든다.
  5. 파이프라인 쪽 직접 교정을 멈추기로 하면 'Gold에만 있음' 상태는 예외로만 남는다.
  6. API 키는 받은 호출자 이름으로 `manage.py ext-key-issue`를 실행해 발급한다.
  7. 코드표와 시드 · 공식 소셜 목록을 받는 방식을 들으면 2단계 남은 작업(범위 확인 전)의 설계에 반영한다.
  - 3단계 시드 키워드와 4단계 엔티티 역할도 같은 방식으로 넘길 예정이라, 이 합의가 그 둘의 틀이 된다.

### C팀에 보낼 메시지

```text
[HMG GEO HUB] 인용 출처 분류 교정값 전달 방식 확인 요청

HUB가 출처 카테고리 교정(override), 출처 분류 코드표, 시드·공식 소셜 목록의 정본을 갖게 되었습니다. 자동 분류(규칙)는 지금처럼 파이프라인이 정합니다. 교정값은 외부 API(https://10.0.20.132:8087/ext/)로 드립니다.
- GET /ext/v1/reference: family source_override의 change_seq·etag
- GET /ext/v1/reference/source_override: 활성 교정 전체(키 = 소문자·앞 www. 뺀 skey, category = dim_category.slug)

확인 부탁드립니다.
1. change_seq·etag가 바뀌면 목록 전체로 교정 입력을 바꾸는 방식(폴링)이 가능한가요? 주기는 얼마인가요?
2. 목록에서 빠진 키(원복)는 기본 분류(소셜 → 당사 → 시드 → 규칙 → Other)로 되돌려 주시나요?
3. 반영 확인은 Gold dim_source의 category_src=1과 category_key로 하려고 합니다. 맞나요? 셀(citation_cell) 재빌드는 언제 하나요?
4. 키 정규화 규칙(소문자, 앞 www. 제거, 소셜은 계정 키)이 파이프라인과 같은가요?
5. 지금 파이프라인 쪽 교정 2건(arxiv.org, danawa.com)을 HUB 초기값으로 가져왔습니다. 앞으로 파이프라인 쪽에서 직접 교정하지 않는 것으로 정리해도 될까요?
6. API 키 발급 대상(호출자 이름)을 알려 주세요.
7. 출처 분류 코드표(카테고리 13개, 분류 출처 코드 1~6)와 시드·공식 소셜 목록도 HUB가 정본으로 관리하고, 같은 방식(외부 API, change_seq)으로 드립니다: GET /ext/v1/reference/source_code · source_seed(도메인 → 카테고리) · source_social(계정 키, 도메인, URL 매칭 규칙 [{prefix, boundary}], 카테고리 officialHmg). 지금 이 값들을 어디서 가져가시는지(dim_category 설명에는 HUB 코드표의 투영이라고 되어 있습니다), 이 목록으로 바꿔도 되는지 알려 주세요.

참고: 다음 단계로 시드 키워드(family keyword)와 엔티티 역할(family entity)도 같은 방식(HUB 정본, 외부 API, change_seq)으로 드릴 예정입니다. 이 방식에 문제가 있으면 함께 알려 주세요.
```

---

## D. 2026-10-31 점검

리뉴얼 중간점검 1단계(`renewal-audit.md`)에서 Gold를 읽기 전용으로 확인하고 더한 질문이다.
- 기준은 live global release 603(최신 회차 2026-10-05)과 live website release 3647(card 3648, 최신 회차 2026-10-09)이다.
- 근거 쿼리는 `renewal-audit.md` '확인 결과' 표(U1 ~ U12)에 있다.
- D1 · D2는 이번 확인(U1 · U6)에서 나왔다. D3 ~ D7은 Website 세션(W2 · W4 · W6)이 남긴 질문이다.
- 받는 팀은 질문마다 적었다. 보낼 메시지는 끝에 팀별 추가분으로 모았다.

### D1. ACR 명부의 당사 비트와 dim_brand의 당사 비트가 다른 브랜드 2개 (B팀)

- **화면 영향:** ACR은 `acr_entity_fact.own_bit`(명부)로 당사를 센다. 그래서 두 이름이 관점 비트가 맞으면 당사로 들어가고, HMG 형제 표시(이름 Hyundai · Kia · Genesis)는 받지 못한다. Mention · Overview는 `dim_brand.own_bit`를 써서 영향이 없다.
- **근거:**
  - release 603 acr 빌드의 level 1 · keep 행에서 own_bit ≠ 0인 이름은 Hyundai · Kia · Genesis 외에 둘이 더 있다.
    - '제네시스 마그마': own_bit 4, 5행 · appearance 5 · choice 0, 08-24 · 09-07 · 09-14.
    - 'Hyundai Canada': own_bit 1, 2행 · appearance 2 · choice 0, 09-14.
  - 두 brand_key의 `dim_brand`는 own_bit 0 · kind 2(경쟁)다.
  - `dim_brand`에서 own_bit ≠ 0인 브랜드는 Hyundai(1) · Kia(2) · Genesis(4) 셋뿐이다.
- **답에 따라 HUB가 할 일:** HUB는 귀속을 다시 정하지 않고 Gold 값을 그대로 쓴다. 차종 · 지역 법인 이름이 level 1로 잡힌 것이라면 Gold가 부모 브랜드로 접은 뒤 그대로 반영된다.

### D2. Website 자사 사이트인데 당사 공식 도메인이 아니고 Dealer & Marketplace로 분류된 출처 (B팀)

- **화면 영향:** Website 인용에서 당사 태그(자사 인용 = loc_owned ∨ tgt_hit)는 붙는데, 출처 카테고리는 Official (HMG)이 아닌 곳이 있다. 공식(HMG) 비중과 공식(당사) 인용이 서로 다른 출처 묶음을 센다.
- **근거:**
  - website release 3647 전 회차에서 자사 인용이 1건 이상인 출처는 54개다. 그중 12개는 `dim_source.owned_brand_bit = 0`이다: hyundai.pe(자사 13,361 / 전체 13,478) · hyundaipr.com · beijing-hyundai.com.cn · kia.cn · hyundaiksa.com · kiavietnam.com.vn · kiaphilippines.com · hyundaicolombia.co · hyundai-me.com · kia.uz · hyundai-n.com.cn · kia.am.
  - 12개 중 8개는 dealerMarketplace, 4개(hyundai.pe · kia.cn · kia.uz · kia.am)는 officialHmg이고, 모두 category_src 5(규칙)다.
  - 반대 방향(B1과 같은 종류)도 있다. global hyundai.lt(owned_brand_bit 1)의 10-05 인용 9건은 모두 cars.hyundai.lt URL이라 owner_key가 없다(base `hyundai.lt`의 호스트와 다름). kia.pt도 09-28 1건이 owner_key 없음이다.
- **물을 것:** 사이트 운영사(현지 배급사 · 합작 법인) 도메인을 owned_brand_bit와 당사 도메인 분류(분류 출처 3)에 넣어야 하나요? 아니면 지금처럼 Website 자사 판정(web_unit)만 하나요? cars.hyundai.lt 같은 하위 호스트를 base에 넣을 계획도 있나요?
- **답에 따라 HUB가 할 일:** 당사 태그는 Gold 표면별 자사 정의(`citation_cell` 설명)를 그대로 쓴다. 분류가 바뀌면 화면에 그대로 반영된다.

### D3. 완성차가 아닌 브랜드가 경쟁 브랜드(kind 2)로 잡힘 (B팀)

- **화면 영향:** Mention 순위 표, 경쟁사 평균, 비교 브랜드 후보, Overview 경쟁사에 AI 비서 · 지도 앱 · 스포츠 · 패션 브랜드가 경쟁사로 들어간다. HUB는 브랜드 → 모그룹 표시 묶음에서 이 이름들을 '완성차 아님' 묶음으로 접고 있다.
- **근거:**
  - release 603 · 10-05 global, `brand_cell` competitive 행의 언급 수다. 모두 `dim_brand` kind 2(경쟁)다.
    - Huawei 542 · Alexa 314 · Alphabet 221 · Apollo 202 · Formula 1 199
    - Giorgio Armani 193 · Waze 140 · G2 127 · Mobis 96(HMG 계열 부품사) · Uber 41 · Nokia 9
  - 반면 Apple(2,617)과 Google(3,024)은 kind 3(비경쟁)이라 competitive = false 행에만 있다.
  - 한 브랜드의 competitive가 셀마다 다른 경우도 있다. 같은 release에서 smart는 경쟁 행 179 · 비경쟁 행 740 언급(각 9회차)이고, Cruise는 8 · 15다. B2의 Smart 질문과 같은 원인일 수 있다.
  - ACR에서도 비자동차 엔티티가 선택된다(B3).
- **물을 것:** kind 2와 3을 나누는 기준이 무엇인가요? 위 이름들을 kind 3으로 옮길 계획이 있나요? 한 브랜드의 competitive가 셀마다 다른 이유도 알려 주세요.
- **답에 따라 HUB가 할 일:** Gold kind를 그대로 쓰고 표시 묶음만 둔다. 분류가 바뀌면 HUB의 '완성차 아님' 이름 목록을 줄인다.

### D4. Hyundai N 사이트 브랜드 비트 16 (B팀)

- **화면 영향:** Website › Prompts에서 Hyundai N 사이트 프롬프트의 브랜드 칸이 비고, 브랜드 필터로 고를 수 없다. 관점(`dim_perspective.own_bits` 1 ~ 7)과 `dim_brand.own_bit`(1 · 2 · 4)에 16이 없다. 그래서 Hyundai N 사이트를 당사 브랜드 관점으로 묶을 수 없다.
- **근거:**
  - `dim_project`(surface 2)의 site_brand_bit 값은 1 · 2 · 4 · 16이다. web_reg 프롬프트 수는 1이 프로젝트 50개 · 5,587, 2가 54개 · 5,107, 4가 20개 · 1,807, 16이 3개 · 228이다.
  - `dim_country`에 가상 브랜드 코드 HYUNDAI-N이 있다(kind virtual_brand, virtual_brand_bit 16).
  - 열 설명은 '사이트 브랜드 비트'뿐이다.
- **물을 것:** 16은 Hyundai의 하위 브랜드인가요, 별도 브랜드인가요? 관점 · 브랜드 필터에서 Hyundai(1)로 접어야 하나요?
- **답에 따라 HUB가 할 일:** 답에 따라 리더 브랜드 이름표(`BRAND_NAMES`)에 16을 더하거나, Hyundai로 접는다.

### D5. 등록됐지만 7월 뒤로 측정되지 않은 website 프롬프트 2,563개 (A팀)

- **화면 영향:** Website › Prompts에 미측정 · 오래된 측정 행으로 남는다. 열람 화면 사용자가 할 수 있는 일은 없다.
- **근거:** `dim_prompt`(surface 2 · web_reg)는 12,729개다. `job_index`(surface 2)로 본 마지막 회차는 다음과 같다.
  - 10-09 10,021 · 09-25 5 · 09-04 37 · 08-28 103 · 07-17 2,290 · 07-03 273.
  - 07-17 · 07-03의 2,563개는 그 뒤 작업이 한 건도 없다(서비스하지 않는 회차 포함).
- **물을 것:** "웹 카탈로그에 등록된 website 프롬프트 2,563개가 7월 이후 측정되지 않습니다. 의도한 제외라면 등록을 해제하고, 아니라면 측정 대상에 다시 넣어 주실 수 있을까요?"(W6 문구)
- **답에 따라 HUB가 할 일:** 화면은 측정값을 그대로 보인다. 측정 범위를 보는 화면이 필요해지면 Admin 6단계(⛔C)에서 다룬다.

### D6. Website URL 인용률의 모집단: population 4와 10 (B팀)

- **화면 영향:** Website Overview · Citation의 자사 · 타겟 URL 인용률 라이브 값은 HUB가 `url_prompt_cell` population 4로 읽는다. 발행값(`report_value`)과 모수가 다를 수 있다.
- **근거:**
  - `dim_population`에서 4는 url · web_reg · all이고, 10은 url · web_reg · report_unit이다.
  - 10-09 website 전체의 두 모집단이다.

    | population | 분모 답변 | 자사 URL 인용 | 타겟 URL 인용 | 측정 프롬프트 |
    |---|---:|---:|---:|---:|
    | 4 | 20,326 | 15,062 (74.1%) | 9,829 (48.4%) | 10,021 |
    | 10 | 19,500 | 14,561 (74.7%) | 9,554 (49.0%) | 9,677 |
- **물을 것:** 화면 라이브 값에는 어느 모집단이 맞나요? 10(보고 유닛)은 발행값과 같은 모수를 만들려는 것인가요? 엔진 · 기간 필터처럼 발행값을 쓸 수 없을 때 10을 써야 하나요?
- **답에 따라 HUB가 할 일:** 리더가 읽는 population_key를 답대로 고른다. 지금은 4다.

### D7. Kona가 Hyundai가 아닌 별도 경쟁 브랜드로 잡힘 (B팀)

- **화면 영향:** Website Mention 미국 미언급 프롬프트 목록에 Kona 질문이 들어간다(W2). Kona 언급이 당사가 아니라 경쟁사 언급으로 셈해진다.
- **근거:**
  - `dim_brand`에서 'Kona'(brand_key 5100)는 kind 2 · own_bit 0이다. `dim_entity`에도 'Kona'가 Brand 엔티티로 있다(brand_key 5100).
  - Kona 차종 엔티티('Hyundai Kona', 'KONA Eléctrica' 등 Product)는 brand_key 1(Hyundai)이다.
  - website release 3647에서 'Kona' 경쟁 언급은 159건이다. 08-28 · 09-04 · 09-11에 나왔고, 미국은 61 · 26 · 22건이다.
- **물을 것:** 'Kona' Brand 엔티티를 Hyundai로 접거나 차종(level 2)으로 옮겨 주실 수 있나요?
- **답에 따라 HUB가 할 일:** HUB는 귀속을 다시 정하지 않는다. Gold가 고치면 그대로 반영된다.

### D 안에서 확인만 하고 보내지 않는 것

- **W3 'loc_owned와 cit_m05 차이'.** Website 자사 인용은 Gold 정의(`citation_cell` 설명)대로 loc_owned ∨ tgt_hit이고, kpi_cell cit_m05도 같은 값이다. HUB가 W6에서 이 정의로 바꿨다. 10-09 값은 둘이 같다: 전체 24.93 = 24.93, US 19.90 = 19.90, en 18.38 = 18.38이다. loc_owned만 세면 US 18.93, en 18.29가 되는데, 이것이 W3가 본 차이다. 물을 것이 없다.
- **같음으로 끝난 확인.** 인용 톤(U3), Global 공식(HMG) Δ의 cit_m05(U4), 우호도 분모(U5), 비교의 답변당 언급 수(U10), 카탈로그 빈 값(U8), 프롬프트 시장 태그(U12)는 Gold와 같거나 값이 있었다. 질문할 것이 없다.

### D절 팀별 추가분

```text
[문의 추가] HMG GEO HUB — Gold 모델·귀속 확인 6건 (2026-10-31 점검, Gold live global release 603, website release 3647)

1. ACR 명부 당사 비트와 dim_brand 당사 비트가 다른 브랜드 2개
 - acr_entity_fact level 1(keep)에서 '제네시스 마그마' own_bit 4(5행, 08-24·09-07·09-14), 'Hyundai Canada' own_bit 1(2행, 09-14). 두 brand_key의 dim_brand는 own_bit 0·kind 2.
 물을 것: 어느 쪽이 맞나요? 차종·지역 법인 이름이 브랜드(level 1)로 잡힌 것이면 부모 브랜드로 접어 주실 수 있나요?

2. Website 자사 사이트인데 owned_brand_bit 0인 출처 12개
 - hyundai.pe(자사 13,361/13,478)·hyundaipr.com·beijing-hyundai.com.cn·kia.cn·hyundaiksa.com·kiavietnam.com.vn·kiaphilippines.com·hyundaicolombia.co·hyundai-me.com·kia.uz·hyundai-n.com.cn·kia.am. 8개는 dealerMarketplace, 4개는 officialHmg, 모두 category_src 5.
 - global hyundai.lt는 10-05 인용 9건이 모두 cars.hyundai.lt라 owner_key 없음(B1과 같은 종류).
 물을 것: 사이트 운영사 도메인을 당사 공식 도메인(분류 출처 3)에 넣어야 하나요? 하위 호스트를 base에 넣을 계획이 있나요?

3. 완성차가 아닌 브랜드가 경쟁(kind 2)
 - 10-05 global 경쟁 언급: Huawei 542·Alexa 314·Alphabet 221·Apollo 202·Formula 1 199·Giorgio Armani 193·Waze 140·G2 127·Mobis 96(HMG 계열 부품사)·Uber 41·Nokia 9. Apple·Google은 kind 3.
 - smart(경쟁 179·비경쟁 740)·Cruise(8·15)는 같은 release 안에서 competitive가 셀마다 다름.
 물을 것: kind 2·3의 기준은? 위 이름을 kind 3으로 옮길 계획이 있나요? competitive가 셀마다 다른 이유는?

4. Hyundai N 사이트 브랜드 비트 16
 - dim_project(website) site_brand_bit 16: 프로젝트 3개, web_reg 프롬프트 228개. dim_country HYUNDAI-N(virtual_brand_bit 16). 관점 own_bits·dim_brand own_bit에는 16이 없음.
 물을 것: 16은 Hyundai의 하위 브랜드인가요, 별도 브랜드인가요? 관점·브랜드 필터에서 Hyundai로 접어야 하나요?

5. Website URL 인용률 모집단 population 4·10
 - 10-09 전체: pop 4 분모 20,326·자사 74.1%·타겟 48.4%·프롬프트 10,021 / pop 10 분모 19,500·자사 74.7%·타겟 49.0%·프롬프트 9,677. HUB 라이브 값은 4를 읽음.
 물을 것: 화면 라이브 값에는 어느 모집단이 맞나요? 10은 발행값과 같은 모수를 만들려는 것인가요?

6. Kona 귀속
 - dim_brand 'Kona'(5100) kind 2·own_bit 0, dim_entity에도 Brand 엔티티. Kona 차종 엔티티는 brand_key 1(Hyundai). website 'Kona' 경쟁 언급 159건(08-28·09-04·09-11, 미국 61·26·22).
 물을 것: 'Kona'를 Hyundai로 접거나 차종으로 옮겨 주실 수 있나요?
```

```text
[문의 추가] HMG GEO HUB — 측정 범위 확인 1건 (2026-10-31 점검, Gold live website release 3647)

1. 등록됐지만 7월 뒤로 측정되지 않은 website 프롬프트 2,563개
 - dim_prompt(website, web_reg) 12,729개의 job_index 마지막 회차: 10-09 10,021 / 09-25 5 / 09-04 37 / 08-28 103 / 07-17 2,290 / 07-03 273.
 물을 것: 웹 카탈로그에 등록된 website 프롬프트 2,563개가 7월 이후 측정되지 않습니다. 의도한 제외라면 등록을 해제하고, 아니라면 측정 대상에 다시 넣어 주실 수 있을까요?
```

---

## 뺀 것 (해결됐거나 결정으로 닫힘)

| 항목 | 출처 | 뺀 이유 |
|---|---|---|
| ACR 회차 간 비교를 숨길지, '다른 회차끼리 비교해도 되나', 회차별 '비교 가능' 표시 요청 | ACR P2 질문 1(b) · (c) | 측정 방식이나 범위가 바뀌어도 비교를 그대로 보이기로 2026-10-29에 정했다. 숨김 코드도 지웠다. A1은 변경 내역을 설명 · 표기용으로만 묻는다 |
| ACR 차종 전환율 분모 중복 | P4 | 2026-10-28 완료. Gold 기준 영향 없음, 수정 없음 |
| Overview 경쟁사 인용 브랜드를 BFF가 도메인 토큰으로 다시 매핑하던 문제 | 리뷰 #29 | 2026-10-29 수정. Gold competitor_brand를 쓴다. 남은 빈칸 41곳만 B2로 묻는다 |
| Mention 트리맵 모그룹 묶음, 모그룹 귀속 컬럼 제공 여부 | 리뷰 5절 Mention · #66 | 모그룹 묶음은 화면 묶음 규칙으로 두기로 2026-10-29에 정했다. Gold가 귀속 컬럼을 낼 계획을 따로 알려 오면 그때 다시 본다 |
| 우선 노출도 단위 '위' / '번째' 혼용 | 리뷰 #48 | HUB 문구 문제다. 리뉴얼 Mention · Overview를 '번째'로 맞췄다(2026-10-30). rk 산정 기준만 A3로 묻는다 |
| Global prompts '미측정' 설명과 0건 문구 | 리뷰 Global #9 · #21 | HUB 문구다. 2026-10-30 고쳤다. elig=false 사유만 A2로 묻는다 |
| Mention 우호도 추이의 '시간 초과' 안내, '추이 18회차', 유형 추이 없음 | 리뉴얼 Mention BI 리뷰 | HUB 리더 · 화면 문제다. 927bb1f · 907f10d에서 풀렸다. 감정 분류 단절만 A1로 묻는다 |
| 톤별 URL 검색이 텍스트 앵커(`#:~:text=`)만 가진 URL 2건을 못 찾음 | 리뷰 0절 | 계약(스킴 · 프래그먼트 제외)대로 동작한다. HUB 규칙이라 업스트림 질문이 아니다 |
| 톤별 URL B 조건(US · ChatGPT) 11 ~ 13초 | 리뷰 하위 #33 | HUB 리더 SQL 성능 과제다 |
| ACR `territory_limit` · `battle_limit` 무시 | ACR P5 | HUB 계약 · 화면 결정 사항이다 |
| Mention · Citation 추이의 metric_version 표기 여부 | `metric-version-mix.md` 7절 | HUB 결정 사항이다. A1의 답을 본 뒤 정한다 |
| 공용 필터 안내 문구(`dashboard.filters.defaultScopeHint`) | ACR 다음 세션 2절 | HUB 문구다 |
