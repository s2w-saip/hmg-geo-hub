# 개발 TODO (정본) — Website · Admin

모든 세션은 어떤 작업을 요청받든 이 파일을 먼저 읽는다. CLAUDE.md가 이 파일을 불러온다. 순서와 규칙은 사용자가 2026-10-29에 정했고, 2026-10-30에 Website 화면을 앞에 두었다. 바꾸려면 먼저 사용자에게 묻는다.

**세션의 첫 답변:** 첫 줄에 아래 '지금 할 일' 줄을 그대로 옮겨 적는다. 그래야 사용자가 이 파일을 확인했는지 알 수 있다. 사용자가 '다음 작업'처럼 대상을 말하지 않으면 '지금 할 일'을 뜻한다. 요청이 이 순서와 다르면 무엇이 다른지 말하고 사용자에게 묻는다.

**지금 할 일:** Website 하위 화면을 화면마다 세션 하나씩 병렬로 만든다('Website 화면' 절). 세션은 첫 지시로 받은 W 번호 하나만 맡는다. Admin 2단계 남은 일(코드표 · 시드 · 공식 소셜)은 다른 세션이 구현 · 시험을 마치고 커밋 · 푸시했다(`a36b835`, 사용자 확인 대기). Admin 3단계부터는 Website 뒤에 한다.

## 절대 규칙

1. **순서대로만 한다.** Admin은 0 → 1 → 2 → 3 → 4 → 5 → 6이고, 3단계는 Website 화면(W0~W5)이 끝난 뒤 시작한다. Admin 단계는 앞 단계가 완료되기 전에는 다음 단계를 시작하지 않는다. 완료란 공통 완료 기준을 모두 채우고 사용자가 확인한 상태다. 결정 대기로 막히면 규칙 2를 따른다. 단계를 건너뛸지는 사용자만 정한다. Website 화면은 아래 '병렬 규칙'을 따른다.
2. **결정은 원칙으로 정한다.** 데이터 원칙(규칙 5)과 화면 원칙(규칙 7)을 충실히 따른 결정이면 묻지 않고 진행한다. 고른 안과 다른 안을 '결정 기록'(Website는 세션 메모)에 날짜와 함께 적고 답변에서 알린다. 그 원칙으로 정할 수 없어 새 원칙이 필요하면 반드시 사용자에게 묻는다. 사용자나 업스트림만 아는 정보(명세, 키, 비용 상한, Gold 팀의 답)가 필요한 ⛔도 묻는다.
3. **세션을 마칠 때 이 파일을 고친다.** 체크 표시, '지금 할 일' 줄, '진행 기록' 한 줄을 갱신한다. 커밋한 항목에는 커밋 해시를 붙인다.
4. **각 단계는 범위 확인부터 시작한다.** 원본 화면(`front/app/[locale]/(dash)/admin/…`, Website는 `(dash)/website/…`)의 기능 목록을 뽑고, 어디까지 옮길지 규칙 2대로 정해 사용자에게 보인 뒤 설계한다.
5. **데이터 원칙은 어기지 않는다.**
   - 데이터는 한 방향으로 흐른다. HUB가 만든 입력을 Gold가 분석하고, HUB는 그 결과를 읽어 보여 준다(결정 기록 '원칙').
   - Gold에는 쓰지 않는다.
   - BFF가 Gold의 귀속(당사, 부모 브랜드, 출처 카테고리 등)을 읽을 때 덮어쓰거나, 합치거나, 다시 정하지 않는다.
   - HUB가 새 판단을 만들지 않는다. 유의성, '의미 있는 변화', 임계값, 기준 재정의가 여기에 든다.
   - 없는 정보를 만들지 않는다. 새로 만들거나 다시 계산한 분석값이 여기에 든다. 브랜드 → 모그룹 같은 표시 묶음은 괜찮다.
   - 측정 방식 · 범위가 회차마다 달라 값이 튀어도 숨기거나 경고하지 않는다.
   - 외부 API에는 수집·가공 입력만 내보내고 결과는 내보내지 않는다. GA4 속성은 외부 API에 나가지 않는다.
   - 키·토큰·자격 증명은 DB나 git에 두지 않는다. git에서 제외된 `.env.*.local`에만 둔다.
6. **커밋 · 푸시는 자동으로 한다.** 작업이 그 시험(공통 완료 기준의 시험 항목)을 통과하면 사용자 요청 없이 커밋하고 푸시한다. 원격이 앞서 있으면 그 위에 다시 얹은 뒤 푸시하고, 충돌하면 멈추고 사용자에게 말한다. VM 반영은 사용자가 정한다. 작성자 환경변수 등 나머지는 CLAUDE.md 작업 규칙을 따른다. 다른 세션이 같은 작업 트리를 쓰므로 커밋할 때는 그 작업의 파일과 공유 파일의 자기 줄만 스테이징한다.
7. **화면 원칙은 어기지 않는다.**
   - 레거시 KPI는 더 나은 데이터 인사이트를 위해 통합해 쓸 수 있다. 아예 없애지는 않는다.
   - 데스크톱 전용 촘촘 레이아웃이다. 1920×915 기준이고, 모바일 화면과 밀도 토글은 없다.
   - 설계안은 UX로 고른다. 변경 크기는 고르는 이유가 되지 않는다.

## 공통 완료 기준 (페이지마다)

- [ ] 범위를 정해 사용자에게 보였다 (규칙 4).
- [ ] 저장이 필요하면 마이그레이션을 만든다. 그 표만 쓰는 전용 DB 역할을 최소 권한으로 둔다(`hmg_account_editor` 방식). Mac 네이티브 저장소에 적용하고 `verify` 를 통과한다.
- [ ] BFF에 `hub_stores` 모듈과 `/v1/hub/*` 라우트를 둔다. 관리자 전용이고, 쓰기는 advisory lock 안에서 한다. 변경 이력을 남긴다.
- [ ] BFF 시험(`back/bff/tests`) 전체를 통과한다. 기존 시험도 포함한다.
- [ ] `/renewal/admin/…` 화면을 만든다. 촘촘 레이아웃, 1920×915 기준, 한국어 문구, render 시험을 갖춘다.
- [ ] `RENEWAL_PAGES`(`renewal-pages.ts`), `route-policy.ts` 의 `/renewal/…` 항목, 사이드바 시험을 갱신한다.
- [ ] 프런트에서 `npm run test`, `npm run typecheck`, `npm run lint` 를 통과한다.
- [ ] 같은 커밋에서 `docs/architecture/hmg-geo-hub-architecture.html` 을 고친다. 대상은 그림, DB 연결 표, 쓰기 경로, 계정 표, '마지막 갱신' 줄이고, ERD는 `render_erd.py` 를 실행해 다시 그린다.
- [ ] Playwright e2e로 새 화면의 핵심 흐름(만들기, 고치기, 중지 등)을 실제 화면에서 한 번 확인한다. 문구 · 표시 · 필터처럼 단위 · render 시험으로 확인되는 작은 변경에는 e2e를 돌리지 않는다(2026-10-30 사용자).
- [ ] 시험을 통과하면 커밋 · 푸시한다 (규칙 6). 그 뒤 사용자가 확인한다.

## Website 화면 (병렬 세션)

2026-10-30 사용자 결정: Website 하위 화면을 Admin 3단계 이후보다 먼저 만든다. 화면마다 세션 하나씩 병렬로 한다. Admin 2단계 남은 일은 다른 세션에서 따로 진행 중이다. 그 세션의 파일(`citation-sources/` 화면, `source_lists.py`, `data-008.sql` 등)은 Website 세션이 고치지 않는다.

**데이터.** Gold website(surface 2) 발행 1,087건이 2026-10-29에 활성화됐다. 회차는 2026-07-03 ~ 10-09이고, website 프롬프트는 13,232개다. KPI · 언급 · 인용 셀과 website 전용 URL 인용 셀(`url_prompt_cell`)이 있다. ACR 셀(`acr_cell_fact`)에는 website 행이 없다(⛔H).

**지금 코드.** BFF에는 원본 website 화면이 쓰던 읽기가 있다. 리뉴얼 화면은 `ctx.surface=global`로 고정이다. 공용 필터(`renewal/_components/overview-filter-model.ts`)에는 website 축 구성이 없다. 원본 website 필터는 `components/dash/website-filters.tsx`다. 축은 사이트 국가 → 언어 → 엔진이고, 브랜드 통합은 관리자만 보며, 카탈로그 축은 없다.

| 세션 | 화면 (리뉴얼 경로) | 원본 | 읽는 BFF 화면 | 선행 | 상태 |
|---|---|---|---|---|---|
| W0 | 공통 토대 | `components/dash/website-filters.tsx` | `overview/filters` · `shared/panel-options` · `citation/filter-bar` (website) | 없음 | 끝, 커밋 · 푸시(`f28395f`), 사용자 확인 대기. 쓰는 법은 아래 W0 둘째 줄 |
| W1 | Overview (`/renewal/website`) | `(dash)/website/page.tsx` | `website/summary` · `summary-deferred` · `trend` · `composition` · `geo` | W0 필터 | 구현 · 시험 완료, 커밋 · 푸시(`f28395f`), 사용자 확인 대기 |
| W2 | Answer analysis › Mention (`/renewal/website/answer-analysis/mention`) | `(dash)/website/answer-analysis/mention` | `mention/view` · `mention/as-of` (ctx.surface=website) | W0 필터 | 구현 · 시험 완료, 커밋 · 푸시(`f28395f`), 사용자 확인 대기. 읽는 화면은 `mention/rn-*` · `view-cards` · `view-weekly` · `drill-missing-prompts`(세션 메모 W2) |
| W3 | Answer analysis › Citation (`/renewal/website/answer-analysis/citation`) | `(dash)/website/answer-analysis/citation` | `citation/filter-bar` · `citation/as-of` · `citation/website` | W0 필터 | 구현 · 시험 · e2e 끝, 커밋 · 푸시(`f28395f`), 사용자 확인 대기 |
| W4 | Prompts (`/renewal/website/prompts`) | `(dash)/website/prompts` | `website/prompts-options` · `website/prompts-list` | W0 필터 키 | 구현 · 시험 · e2e 끝, 커밋 · 푸시(`f28395f`), 사용자 확인 대기. 쪽 · 엑셀은 `website/prompts-page` · `-rows`(세션 메모 W4) |
| W5 | AI Agent Funnel › AI Conversion · ACR (`/renewal/website/ai-funnel/…`) | `(dash)/website/ai-funnel/*` | `conversion/renewal-header` · `conversion/renewal`(원본도 표준과 같은 화면) · `acr/gold` | ACR은 ⛔H | Conversion 구현 · BI 개편 · 시험 끝, 커밋 · 푸시(`f28395f`), 사용자 확인 대기 · ACR은 ⛔H까지 보류 |
| W6 | 디자인 다듬기 (W1~W5 화면 전부, 2026-10-30 사용자 요청) | — | 읽기 변경 없음 | W1~W5 구현 | 디자인 · 품질 검수 수정 · 시험 끝, 커밋 · 푸시(`f28395f`), 사용자 확인 대기. 세션 메모 W6 |

W1 · W2 · W3은 W0 필터가 끝나기 전에도 범위 확인, BFF 점검, 본문 작업을 먼저 한다. 필터는 W0 것을 붙인다. 화면마다 필터를 따로 만들지 않는다.

**W0 공통 토대**

- [x] 저장된 필터 화면 키를 한 번에 더한다: `website-overview` · `website-mention` · `website-citation` · `website-prompts` · `website-conversion` · `website-acr`. 고칠 곳은 BFF `hub_stores/saved_filters.py`의 `PAGES`와 `saved-filters.tsx`의 `SavedFilterPage`다. DB에는 형식 CHECK만 있어 마이그레이션은 없다. 2026-10-30에 넣었다(미커밋). 시험 `test_website_pages_keep_their_own_lists`는 고치기 전에 실패하고 고친 뒤 통과했다. 로컬 API를 다시 띄워 지금 쓸 수 있다. 화면은 `loadSavedFilters("website-…")`와 `savedFilters={{ page: "website-…" }}`로 쓴다.
- [x] 공용 필터 모델에 website 구성을 더한다. Overview · Mention · Citation 세 stage를 website 축으로 연다. 원본 `WebsiteFilters`와 같은지 parity 시험으로 묶는다. 2026-10-30에 했다(미커밋).
  - **W1~W3이 쓰는 법:** `RnOverviewFilters`의 `props`에 `surface: "website"`를 더한다. `stage`는 W1이 `"overview"`(생략 가능), W2가 `"mention"`, W3이 `"citation"`이다. 옵션은 원본과 같은 BFF 화면에서 받는다(W1 `overview/filters`, W2 `shared/panel-options` · `shared/filter-dates`, W3 `citation/filter-bar`, 모두 website). 저장된 필터는 `website-<화면>` 키를 쓴다.
  - 축은 국가(사이트 국가) · 언어 · AI 엔진 · 기간이다. 관리자는 브랜드가 더 보이고, Citation은 출처 카테고리가 더 붙는다. 카탈로그 · 경쟁사 축은 없다. 원본과 같다(`overview-filter-model.ts` `WEBSITE_ONLY_GROUPS`).
  - 원본과 하나 다르다. 원본 website Mention · Citation 패널은 계정 범위를 Global 기준으로 봤고, 리뉴얼은 세 화면 모두 원본 Overview처럼 Website 기준으로 본다. 차이는 전용 사이트 계정(Hyundai N 등)의 국가 잠금뿐이다.
  - 시험 `website-filter-model.parity.test.tsx` 32개: 원본 패널과 같은 구조로 통과한다. website 구성을 끄면 32개가 모두 실패한다. 기존 필터 · 화면 시험 12개 파일(117개), typecheck, lint, BFF 시험 33개 모듈(490개)도 통과했다.
- [x] 새 Gold 데이터로 위 표의 BFF 화면을 한 번씩 불러 본다. 5xx나 빈 값이 나오면 아래 '점검 결과'에 적고 그 화면 세션에 넘긴다.

**병렬 규칙**

1. 세션은 첫 지시로 받은 W 번호 하나만 맡는다. 사용자가 'W1 시작'처럼 번호만 말해도 그 행을 맡으라는 뜻이다. 되묻지 않고 범위 확인부터 시작한다(규칙 4). 첫 답변은 '지금 할 일' 줄, 맡은 행(W 번호와 화면), 원본 화면 기능 목록 순서로 쓴다.
2. 고칠 수 있는 파일은 셋이다.
   - 자기 화면 폴더 `renewal/website/<화면>/`.
   - 재사용하는 표준 화면의 `_components`. W1은 `renewal/dashboard/_components`, W2는 `renewal/standard/answer-analysis/mention/_components`, W3은 `…/citation/_components`, W5는 `renewal/standard/ai-funnel/conversion` · `acr`의 `_components`. 표준 화면 동작은 그대로 두고 시험으로 확인한다.
   - 그 화면의 BFF website 분기. W1은 `screens/overview.py`의 website_*, W2는 `mention_*.py`의 website 분기, W3은 `citation.py`의 website 부분, W4는 `website_prompts.py`, W5는 `acr.py`의 `acr/gold`.
3. 공통 코드는 W0만 고친다: `renewal/_components/*`, `components/dash/*`, `components/renewal-ui*`, BFF `_filters.py` · `_query.py` · `shared.py` · `hub_stores/saved_filters.py`. 다른 세션은 필요해도 고치지 않고 사용자에게 말한다.
4. 공유 목록에는 자기 줄만 더하고, 고치기 직전에 다시 읽는다: `renewal-pages.ts`, `route-policy.ts`의 `/renewal/website…` 항목, `rn-sidebar.render.test.tsx`, `messages/ko.json` · `en.json`, `[...slug]/page.tsx`의 `FIRST_CHILD`. 새 문구는 `renewal.website.<화면>` 아래에 둔다.
5. 로컬 실행(front 3333, API 5555)은 하나를 같이 쓴다. BFF를 고친 세션은 API를 다시 띄운다. 그동안 다른 세션 화면이 잠깐 끊긴다.
6. 시험은 자기 화면 시험, `npm run typecheck`, `npm run lint`를 돌린다. 다른 세션 파일에서 난 실패는 고치지 않고 진행 기록에 적는다. BFF를 고쳤으면 커밋 전에 BFF 시험 전체를 돌린다.
7. 원본 website 화면과 같은 BFF 화면을 읽으므로 숫자가 같아야 한다. 같은 필터로 원본(`/ko/website/…`)과 한 번 대조한다.
8. 커밋 · 푸시는 규칙 6대로 시험을 통과하면 한다. 자기 파일과 공유 파일의 자기 줄만 올린다(`git add -p`). `git fetch`를 먼저 한다.
9. 이 파일에서는 자기 행의 상태 칸, '세션 메모'의 자기 줄, 진행 기록 한 줄만 고친다. '지금 할 일' 줄은 Website 전체가 끝날 때 고친다.
10. 완료 기준은 '공통 완료 기준' 중 읽기 화면에 맞는 것이다: 범위 확인, render 시험, 메뉴 · 경로 · 사이드바 시험, test · typecheck · lint, BFF를 고쳤으면 BFF 시험 전체, 핵심 흐름 e2e 한 번(필터 바꾸기, 드릴다운), 사용자 확인. 저장소 · `hub_stores` · 아키텍처 문서는 구조나 BFF 라우트를 바꿀 때만 해당한다.

**세션 메모** (세션마다 자기 줄만)

- W2 · W3: `mention-body.tsx` · `citation-body.tsx`의 다른 작업 변경('순위 변화' 제목 '최근 N회차')은 2026-10-31 따로 커밋했다(`911a7d3`).
- W0: 2026-10-30 레거시 필터 대조 뒤 사용자 지시('추천대로 진행')로 세 가지를 맞췄다. 다른 W 세션의 파일도 고쳤으니 커밋 때 함께 본다.
  - Mention 비교 브랜드 '자동' = 레거시 규칙(스냅샷 점유율 1위 외부 브랜드, `mention_surfaces.comparison_of`). Gold 리더 추이에 `pin_top_rival`(상위 10 밖이면 그 브랜드를 `pinned`로 더함)을 더했고, 리뉴얼 Mention의 KPI 브랜드 추이 읽기가 모두 이것을 쓴다(`mention_renewal.py`, `mention_data.py`의 `pin_top`, `_trend.py`). 경쟁사 평균선과 순위 변화 차트는 상위 10 그대로다. website 필터 없음 Toyota → Tata, 독일 Volkswagen(레거시와 같음). Global은 Toyota 그대로. golden `mention/rn-fix-*` · `rn-live-*` 18개는 요청 키만 바꿨다(출력 같음, golden README).
  - AI Conversion 국가 선택지 = 계정이 읽을 수 있는 GA4 속성의 국가(중지 제외, 브랜드로 좁힘). 새 읽기 `analytics/properties`(`analytics_reader.properties`, `api.py`), `conversion.py property_options`. Gold Global 옵션 읽기는 뺐다. 선택지가 없으면 공용 패널이 국가 축을 숨긴다(URL에 국가가 남아 있으면 지울 수 있게 둔다). Global · Website 둘 다다.
  - 인용 하위 화면 2개(website)에 적용 필터 칩. `website/answer-analysis/citation/_shared/website-citation-filters.tsx`(메인 화면의 옵션 함수도 이리 옮김). 칩을 빼면 목록이 처음부터 다시 읽힌다: 공용 `RnFilterRuntime reset`이 쪽 · 커서를 지우고, 긍정/부정 URL은 검색어도 지운다(검색 중 탭 개수 재사용 규칙). Global 하위 화면은 그대로다.
- W5: 2026-10-30 사용자 결정(추천안). Conversion은 표준 리뉴얼 화면을 그대로 쓴다. 같은 BFF 화면 · 본문 · 필터(기간 + GA4 축, 국가는 측정 로케일 목록)이고 BFF는 고치지 않았다. ACR은 ⛔H가 풀릴 때까지 만들지 않는다(원본도 메뉴에서 숨김, website 행 0개, ACR website 필터에는 W0 구성이 더 필요). 경로 정책 행은 두지 않았다. 새 행은 W0 전용 `components/dash/sidebar.tsx`의 아이콘 표가 필요하고, '/renewal/x = x' 규칙이 원본 권한을 그대로 준다(`route-policy.test.ts`에 대응 한 줄). 커밋은 W0의 `website-conversion` 키(미커밋)에 기대고, `rn-sidebar.render.test.tsx`의 미구현 표시 개수 줄(12 → 11)은 다른 W 세션도 고치는 줄이다. 같은 날 BI 개편(사용자 요청, 추천안): 같은 GA4 데이터라 공용 본문(`standard/ai-funnel/conversion/_components`)을 고쳐 Global · Website 리뉴얼 AI Conversion에 함께 적용했다. 다른 W 세션이 쓰지 않는 BFF `screens/conversion.py` · `hub_stores/analytics_reader.py`도 고쳤다(리더는 응답 항목만 늘림, 기존 값 그대로).
- W1: 2026-10-30 사용자 결정(추천안, 완료까지 추천안으로 진행). 원본 구성(카드 내용 · 출처 · 전환, KPI 추이, 출처별 구성비, 시장별 현황)을 리뉴얼 부품으로 다시 그렸고 같은 BFF 화면을 읽는다(화면 코드는 그대로, 공용 리더만 아래처럼 고쳤다). 카드는 website 분석 화면(Mention · Citation · AI Conversion)을 새 탭으로 연다. 시장별 현황은 리뉴얼 Overview 표(`GeoOverview`)를 쓰되 원본처럼 점유율로 시작하고, 권역 없는 묶음(콜롬비아 · CPO · 유럽 연합 · MIDDLEEAST · worldwide)은 그 표의 '권역 미분류'로 보인다. 브랜드를 하나 고르기 전에는 관리자에게만 고르라는 안내가 보인다. 경쟁사 대비 SOV(41067.2% vs Tata)는 정의대로 계산된 값이라 그대로 보인다. 타겟 출처 인용률은 카드 값(답변 단위, `url_prompt_cell`)과 Δ · 추이(인용 단위, `kpi_cell`)가 서로 다른 측정이었다. 사용자 지시('남기지 말고 다 해')로 공용 리더 `gold_reader/metrics.py`를 고쳤다. website · project 추이의 URL 지표 3개(타겟 출처 · 자사 URL · 타겟 URL 인용률)도 카드와 같은 `url_prompt_cell` 값을 읽는다. 기간 비교에는 이 지표가 없다. 영향은 `website/trend`와 `website/summary-deferred`의 Δ뿐이고, 원본 `/website`도 같이 바뀐다. 2026-10-09 회차 전체 기준 추이 마지막 점은 22.8% → 65.3%(= 카드), Δ는 +4.6pp → +1.4pp다. 경로 정책 행은 두지 않았다(W5와 같음, `route-policy.test.ts`에 대응 한 줄). 2026-10-30 사용자 요청 'SSS급 BI 개편(정보 유실 없이, 없는 정보 증강만 금지)'으로 화면을 다시 짰다. 순서는 KPI(핵심 요약 4줄 + 카드) → HMG 브랜드별 비교(관리자, 브랜드 미선택) → 엔진별 비교 | 출처별 구성비 → KPI 추이(지표마다 작은 차트 6개 + 회차별 답변 수 · 공백) → 시장별 현황(지도 + 지표 5개 · 답변 · 당사 순위 · 선두 브랜드 한 표)이다. 새 BFF 화면 `website/brands`(브랜드마다 summary-deferred를 따로 읽음)와 `website/engines`(엔진 간 일관성 배지가 쓰는 kpi/engines 행)는 Gold 값을 펼칠 뿐이다. 최고 · 최저는 지표 방향만 따르고, 핵심 요약은 섹션 값을 다시 적을 뿐 임계값을 쓰지 않는다. 브랜드 · 엔진 · 국가 행을 누르면 필터 패널 토글로 그 조건이 걸린다. 레거시에서 빠졌던 시장 당사 순위 · 선두 브랜드와 수집 공백 표시(회차 줄)도 되살렸다. 아키텍처 문서의 'screens 빌더 88개'는 이미 HEAD(86)와 다르고 여러 W 세션이 화면을 더하고 있어, 커밋 시점에 실제 수로 맞춘다.
- W2: 2026-10-30 사용자 결정(추천안, 완료까지 추천안으로 진행). 리뉴얼 Global Mention(본문, BFF `mention/rn-*`)을 ctx.surface=website로 쓴다. 그래서 읽는 화면은 위 표의 `mention/view`가 아니라 `mention/rn-*`다. 2026-10-30 사용자 지시: 기존 KPI는 변형은 되지만 없애지 않는다. 정보를 잃지 않고 인사이트를 주도록 개편하되, 없는 정보를 만들지 않는다. 그래서 원본 website 값을 모두 남기고 세 가지를 더했다.
  - KPI 세부 지표('이번 회차 요약' 아래): 원본 요약 카드 6개와 감정 카드의 긍정 · 부정 신호 수를 설명하는 KPI 탭 아래로 묶었다(노출률: 측정 · 미언급 프롬프트, 점유율: 전체 언급 · 언급 브랜드 · 복수 언급 답변, 우호도: 긍정 · 부정 신호, 우선 노출도: Top 3 비율). 묶음 제목을 누르면 그 탭이 열린다. 값 · Δ · 기준일은 BFF `mention/view-cards`(`mention_surfaces.py`, 원본과 같은 읽기)다.
  - 미언급 프롬프트 목록(새 드릴다운): 미언급 수를 누르면 그 구성원(측정 − 언급 프롬프트, 카드와 같은 `kpi_cell` 조건)과 프롬프트별 답변 수 · 답변 속 브랜드 언급 합(`answer_fact.ment_total`)이 나오고, '다른 브랜드 언급 / 브랜드 언급 없음'으로 나뉜다. 프롬프트를 누르면 답변 원문이 열린다. Gold 리더 `mentions/missing-prompts`(`gold_reader/drilldown.py`, `readers.py` 한 줄), BFF `mention/drill-missing-prompts`, 프록시 `/api/scope/missing-prompts`(`_drill/proxy.ts`의 화면 목록 한 줄). 목록 길이는 카드 수와 같다(필터 없음 836, 미국 150, 미국+2026-09 0, Gemini 1,053).
  - 주별 브랜드 언급 수(브랜드 상세 끝): 원본 주간 Top10 추이를 브랜드마다 자기 눈금의 선, 최근 주 언급, 직전 주 대비로 보이고, 표로 보기에서 모든 주의 값을, CSV로 내보내기를 준다. BFF `mention/view-weekly`.
  - 표준 본문에는 빈 자리 두 개(`afterSummary` · `brandsExtra`)만 더했다. 표준 화면은 그대로다.
  - 그대로 남은 차이: 유형 조각을 눌러 프롬프트로 내려가는 기능은 리뉴얼(Global 포함)에 없다. 국가별 표는 website에서 브랜드를 하나 골라야 나온다(W1 Overview에 있음).
  - Gold 귀속 이상(보고 대상): Kona가 HMG가 아닌 별도 브랜드로 잡혀, 미국 미언급 목록에 Kona 질문이 들어간다.
  - BFF: `mention_renewal.py`의 `_begin`이 ctx.surface를 따른다(`surface_filters`, global은 그대로). `mention_data.py`의 KPI 브랜드 추이(`load_brand_trend` · `load_first_position`)는 surface와 관계없이 지표 셋(노출률 · 점유율 · 순위)을 읽는다. 원본 website · project 화면(`load_mentions_live`)은 SOV만 읽는 그대로다. 이 수정이 없으면 website의 순위 변화 · 순위 스파크라인 · 노출률 경쟁사 평균선이 빈다.
  - 브랜드 축: `scope.all` 계정에 ctx.admin을 보낸다(W0 패널이 브랜드 축을 보이는 기준). 원본은 role admin만이었다.
  - 표준 `_components`(`mention-brands.tsx`): 서랍(브랜드 프롬프트 · 인용 출처, 감정 프롬프트)은 경로에 `/website/`가 있으면 surface=website를 붙인다(답변 원문 창과 같은 규칙). 새 문구는 없다(표준 문구에 Global 표현이 없다). 경로 정책 행은 두지 않았다(W1 · W5와 같음).
  - 발견(기존 결함, W2 범위 밖): 브랜드 서랍의 프롬프트 · 인용 출처 탭은 어느 브랜드를 열어도 같은 목록(당사 목록)을 보인다. BFF `mention_drilldown.py`는 `mention_brand=<이름>`을 보내는데, Gold 리더(`gold_reader/drilldown.py`의 `mention_prompts`, 인용 도메인 읽기)는 `brand_key`만 받고 이름은 무시한다. Global · Website, 원본 · 리뉴얼 모두 같다. 따로 고친다(재현 시험 → 수정).
- W3: 2026-10-30 사용자 결정(추천안, 완료까지 추천안으로 진행). 리뉴얼 Global Citation 본문을 website 데이터로 쓴다(BFF `citation/website` + ctx.variant=renewal). 같은 날 사용자 요청으로 BI 개편을 했다(정보를 잃지 않고, 없는 정보를 만들지 않는다). 순서는 프롬프트 단위 → 인용 단위다: 이번 회차 요약(첫 문장 = 자사 · 타겟 URL 인용률 · 공식(당사) + Δ) → 사이트 인용 도달(측정 → 자사 URL → 타겟 페이지 깔때기, 단계 사이 수는 같은 Gold 답의 두 값 차이, 직전 회차 Δ, 엔진별 같은 깔때기) → 프롬프트(공식(당사) URL 인용 · 미인용 상위 5개, 원본의 화면 목록) → 인용 비중(공식(HMG) · 공식(당사) · 딜러, 전체 인용 · 도메인 · 출처 분류 수 칩) → 출처 구성 → 맥락 → 도메인. 요약 카드의 발견 규칙은 새로 만들지 않았다(판정 기준을 HUB가 새로 정하지 않음). 하위 화면 2개(`prompts` · `tone-urls`)는 BFF `citation/prompts` · `tone-urls`의 ctx.surface=website 분기로 읽는다.
  - 도달 Δ: 직전 회차 = 페이지의 다른 Δ와 같은 회차(카테고리 추이의 직전 유효 회차). 그 날 하루로 K-1을 한 번 더 읽는다(하루 = 그 회차와 정확히 같음을 Gold에서 확인: 10-09 하루 = 스냅샷). 기간 모드는 직전 같은 길이 기간이다. 값 출처(발행 / 실시간)가 다르면 비교하지 않는다. 엔진별은 인용 읽기가 찾은 엔진마다 K-1 한 번이고, 전체는 엔진 평균이 아니라 한 엔진이라도 인용한 프롬프트다.
  - Δ 기준: website의 Overview 카드 Δ(인용 점유율 추이)는 공식(당사)의 값이다(10-09 24.9%, 공식(HMG) 61.7%). 그래서 공식(HMG) 타일과 출처 구성 행은 카테고리 Δ를 쓰고(−5.0pp), 카드 Δ(−3.6pp)는 공식(당사) 타일에 붙인다. 기간 모드에서 공식(당사)는 직전 같은 길이 기간의 인용 읽기 값과 비교한다.
  - 관찰(업스트림 질문 후보): 공식(당사) 값(인용 사실 `citation_fact.loc_owned`)과 추이 마지막 점(셀 `cit_m05`)이 일부 필터에서 다르다(US 18.9 vs 19.9, en 18.3 vs 18.4, 필터 없음은 같음). 값은 원본처럼 인용 읽기 값이고, Δ는 표준 리뉴얼 카테고리 Δ처럼 추이 계열 안에서 계산한다.
  - 커밋: W0의 `surface: "website"`(미커밋)에 기댄다. 경로 정책 행은 두지 않았다(W1 · W2 · W5와 같음). 공유 줄: `rn-sidebar.render.test.tsx` 미구현 표시 개수(8 → 7), `citation-body.tsx`의 다른 작업 줄('climb' weeks)은 섞지 않는다.
- W4: 2026-10-30 사용자 결정(추천안, 완료까지 추천안으로 진행). 원본 기능(필터, 검색, 8열 표, 정렬, 쪽, 엑셀)을 리뉴얼 목록 틀로 옮기고 행 상세 시트를 더했다. 쪽은 번호 · 25/50/100이고, URL에는 q · sort · dir · size만 남긴다(새 조건은 1쪽부터). 필터는 W0 website 패널(stage overview)이고 선택지는 원본과 같은 `website/prompts-options`다. 엔진 · 기간이 측정 렌즈(행은 그대로, 측정 열만 그 범위)라는 설명은 패널 `axisHelp` · `hint`와 목록 위 한 줄로 보인다.
  - BFF 결함(원본 화면도 같았음, 재현 시험 → 수정): Gold 리더 `gold_reader/catalog.py`의 website 분기(`sf == 2`, 이 화면만 씀)에서 검색 · 정렬 · 렌즈가 듣지 않았다. 리더는 화면이 보내는 `search`를 읽지 않았고(본문만 찾음), 늘 prompt_id 순이었고, 늘 전체 회차 · 엔진을 셌다. 사용자가 W4가 이 분기를 고치도록 승인했다. 고친 것: 검색은 본문 + 타겟 URL(LIKE 문자 그대로), 정렬은 원본 규칙(빈 값 뒤, 동점은 id)에 글자 열은 ICU(`und-x-icu`, Gold 기본 정렬은 한글을 정렬하지 못함), 렌즈는 Gold가 노출하는 회차만 센다(servable · hidden_scope · view_date, 전체 측정 횟수 278,031 → 252,437). 집계 CTE는 MATERIALIZED로 고정했다(국가 + 언어를 함께 고르면 8.5초, 렌즈를 더하면 15초 제한 초과 → 0.4초). 도메인은 scheme 없는 타겟에서도 읽는다.
  - BFF 화면 2개를 `website_prompts.py`에 더했다: `website/prompts-page`(번호 쪽), `website/prompts-rows`(엑셀용 전체 행). 브라우저 읽기는 GET 프록시 `app/api/website/prompts/[view]/route.ts`(새 파일, W4 파일 목록 밖)로 한다. 로컬 모드는 `/api/hub/*` 밖의 POST를 막아 서버 액션을 쓸 수 없다. 아키텍처 문서는 빌더 수(88)와 프록시 줄만 고쳤다.
  - 원본 결함(원본 파일이라 고치지 않음): `/api/website/prompts/export`는 xlsx 대신 JSON 첫 100행을 `.xlsx` 이름으로 내려보낸다(리더가 `format=xlsx`를 처리하지 않음). 리뉴얼 엑셀은 브라우저에서 만든다.
  - 레거시 대조(2026-10-30, 같은 URL 조건 11개 + 2쪽): 총 개수 · 행 순서 · 측정 값이 모두 같다. 다른 것은 표시(허브 코드 이름, 날짜 형식, 엔진 이름)와 기능(번호 쪽, 상세 시트, 정상 엑셀)뿐이다. 두 화면 공통: Hyundai N 사이트 프롬프트 228개(Gold `site_brand_bit = 16`, Gold 가상 코드 `HYUNDAI-N`)는 리더 `BRAND_NAMES`에 16이 없어 브랜드가 빈칸이고, 브랜드 필터로 고를 수 없다. 후속으로 다룬다.
  - BI 개편(2026-10-30 사용자 요청: 정보는 잃지 않고, 없는 정보를 증강하지 않는 범위에서 인사이트 화면). 새 수는 모두 목록 행의 Gold 값을 세거나 더한 것이고, 판정 · 추정 · 변화율은 없다.
    - 목록 위 인사이트: KPI 5개(목록 · 측정됨/미측정 · 엔진별 측정 횟수 · 회차 · 최근 회차 측정), 회차별 측정 프롬프트, 마지막 측정 회차, 측정 깊이 · 엔진 조합, 시장(국가 × 브랜드), 언어, 타겟 사이트.
    - 차트를 누르면 목록을 좁힌다(m · rd · last · eset · ans, URL에 남음). 국가 · 언어는 패널 필터를 토글하고, 사이트는 검색한다.
    - 행: 원본 8개 정보를 모두 유지한다(국가 · 언어는 '시장' 한 칸, 엔진은 엔진별 측정 막대 + 범례 · 툴팁). 회차 띠(렌즈 회차 중 측정된 회차)를 더했고, 상세 · 엑셀에는 첫 측정 · 측정 회차 · 엔진별 측정 횟수를 더했다.
    - BFF: 리더 website 분기가 행마다 회차 · 첫 측정 · 엔진별 횟수를 보낸다. 집계는 목록 프롬프트로 좁혔고, 전체 0.85초 · 필터 시 0.2~0.4초다. 새 화면은 `website/prompts-insights`이고, 좁히기는 `prompts-page` · `-rows`에 있다.
    - 실데이터에서 보인 것: 07-24 · 08-07 · 08-14 회차는 측정 프롬프트가 적다. 마지막 측정이 07-17 · 07-03인 프롬프트가 2,563개다. Gemini로만 측정된 프롬프트가 188개다. 측정 깊이는 6회 · 23회 부근에 몰려 있다.
  - W0 영역 관찰: 기간 축 달력의 '기본 회차' 표시는 이 화면 뜻(고르지 않으면 모든 회차)과 다르다. 축 도움말로 설명했다. 엔진 선택지는 원본처럼 ChatGPT · Gemini이고, Gold에는 deepseek 측정도 있다(website 338 프롬프트). 경로 정책 행은 두지 않았다(다른 W 세션과 같음, `route-policy.test.ts`에 대응 한 줄).

- W6: 2026-10-30 사용자 요청('website 하위메뉴 디자인 다듬기', 지적 10개 모두 해결). 디자인 규칙과 Global 화면에 견줘 고쳤고, 데이터 · BFF · W0 공통 코드는 그대로다. 다른 W 세션 파일을 고쳤으니 커밋 때 함께 본다.
  - 제목: 다섯 화면을 '웹사이트 + Global 제목'으로 맞췄다(웹사이트 AI 답변 성과 요약 · 웹사이트 프롬프트 · 웹사이트 언급 분석 · 웹사이트 인용 분석 · 웹사이트 AI 유입 전환). 새 문구는 `renewal.website.overview.title` · `mention.title` · `conversion.title`이다. 원본 `website.dashboard.title`은 그대로 둔다.
  - Prompts 머리에 기준 칩 '주 1회 측정 | 측정 회차 {첫} ~ {끝}'(목록 `roundAxis`, 렌즈 회차)을 넣었다. 머리 높이가 다른 화면과 같아져 필터 · 본문이 움직이지 않는다. '목록 인사이트'는 20px 구역 제목이 되었고, 기준 문구는 칩으로 옮겼다.
  - 기준 문구 반복을 없앴다. Mention KPI 세부 지표는 칩 '증감 = 직전 회차(날짜) 대비' 하나만 둔다. 각주는 없앴다. 카드 기준일(`mention/view-cards`)이 요약 기준일(`mention/rn-asof`)과 다를 때만 날짜 칩을 더한다. Citation 도달 카드는 '실시간 집계' · '발행 리포트 값' 칩을 빼고 같은 뜻의 각주만 남겼다(문구 `chipLive` · `chipPublished` 삭제).
  - Overview KPI 카드는 532 → 474px다. 구역 이름을 구분선 위에 얹었고, 엔진 간 일관성 · 분자/분모 · 경쟁사 대비 SOV를 한 목록으로 묶었으며, 값 줄도 좁혔다. 값은 모두 그대로다. 남은 높이는 발견 4개(86px)와 타일 8개의 근거 줄이라, 더 줄이려면 무언가를 가려야 한다.
  - 증감: 반올림해 0이면 '변화 없음'(KPI 칩 · 브랜드 표, Global 브랜드 표 · Mention과 같음), 증감이 없는 URL 타일은 빈 칩 대신 흐린 글자 '증감 미제공'(`renewal.website.overview.noDelta`)이다.
  - KPI 추이 작은 차트 6개는 모두 당사 남색이다(점유율의 '나빠짐' 빨강 · 범례 점 없앰). 끝 라벨은 짧은 이름이고, 순위 눈금은 축마다 자릿수를 하나로 맞췄다(0.95 · 1.00 · 1.05 · 1.10). 엔진별 비교 · 출처별 구성비 두 카드는 높이를 맞췄다.
  - Mention KPI 세부 지표는 셈마다 한 줄(이름 · 값 16px · 증감)이다. 카드 안 구역 높이는 232 → 163px이고, 셈이 하나인 구역의 빈칸도 줄었다. Citation 프롬프트 구역은 카드 속 카드 대신 한 카드 두 칸 + 세로 구분선이다.
  - Overview 핵심 요약 4장은 사용자 요청(같은 날)으로 문장 대신 리스트로 바꿨다. 카드 머리에 주제 · 짧은 메모(증감 개수, 지표 일관성)를 두고, 값마다 '이름 — 값' 한 줄을 둔다. 리스트 카드는 `_overview/website-findings-view.tsx`이고, 공용 `RnFindingGrid`는 제목을 한 덩어리로만 그려서 따로 만들었다. 증감 줄의 화살표는 타일과 같은 규칙을 따른다(값 방향 · 좋아짐/나빠짐 색). 예전 문장은 순위가 나빠져도 ▼로 썼다. 엔진 줄에는 엔진 표의 '가장 앞섬 · 가장 뒤짐'을 붙였다. 남색 카드는 474 → 493px다(리스트 줄 높이).
  - KPI 추이의 회차별 답변 수에 막대를 얹었다(사용자 요청, 같은 날). 칸마다 0부터 같은 눈금이고, 숫자 · 공백 표시는 막대 아래에 그대로 있다. 답변이 적은 07-24 · 08-07 · 08-14 회차가 바로 보인다.
  - 2026-10-31 사용자 결정(추천안): 답변 수 막대는 중립 회색이다(답변 수에는 좋은 쪽이 없고 당사 계열도 아니다). 칸에 마우스를 올리거나 초점을 두면 공용 `useRnTruncTip` 툴팁이 회차 · 답변 수 · 직전 회차 대비 증감(보이는 두 수의 차, 색 없음)을 보인다. 첫 회차와 답변 수가 없는 직전 회차는 비교하지 않는다. 같은 작업에서 언급 공백 회차가 '0'으로 보이던 것을 '—'로 고쳤다(`website/trend`는 그 회차에 0을 보낸다).
  - Prompts '마지막 측정 회차' 카드를 뺐다(사용자, 같은 날). 빈 자리는 '회차별 측정 프롬프트'를 넓혀 채웠다. 프롬프트별 최근 측정은 목록 열 · 정렬 · 공유 URL의 `last` 좁히기로 남고, 미측정 수는 KPI에 있다. 카드가 가려내던 2,563개는 등록(`dim_prompt.web_reg`)은 되어 있지만, Gold `job_index`에 07-17(2,290개) · 07-03(273개) 뒤로 작업이 한 건도 없다(서비스하지 않는 회차 포함, 2026-10-30 확인). 열람 화면 사용자가 할 일이 아니라 측정 범위 질문이다. 업스트림 질문 후보: "웹 카탈로그에 등록된 website 프롬프트 2,563개가 7월 이후 측정되지 않습니다. 의도한 제외라면 등록을 해제하고, 아니라면 측정 대상에 다시 넣어 주실 수 있을까요?" 측정 범위를 보는 화면이 필요해지면 Admin 6단계(분석 엔진 · 측정 관리, ⛔C)에서 다룬다. BFF `website/prompts-insights`의 `lastMeasured`는 이제 화면이 쓰지 않는다(W4 BFF, 손대지 않음).
  - 그대로 둔 것: AI Conversion 본문(GA4 수집 전 빈 상태), Citation 하위 2화면(Global 하위 화면과 같은 틀이라 고치면 Global도 바뀜).
  - 품질 검수 뒤 수정(2026-10-30, 사용자 '1부터 3까지 쭉'). 결함은 재현 시험이 수정 전에 실패하는 것을 확인한 뒤 고쳤다.
    - 데이터 결함
      - Mention 주별 언급 수: 측정 없는 회차(분모 0)는 0이 아니라 공백이다(`mention_data.to_mention_trend`).
      - Citation 공식(당사): Gold 정의(website = loc_owned ∨ tgt_hit, `citation_cell` 설명)로 바꿨다(`gold_reader/citations.own_citation`). 도메인 표 · 서랍 · 프롬프트 분할 모두 같다. 미국 18.9 → 19.9이고, 당사 인용 프롬프트 8,736 → 8,815(= 도달 카드)다.
      - Citation 미인용: 인용 0건 프롬프트를 빼서 Gold 정의와 맞췄다(1,287 → 1,131).
      - Overview 기간 모드: 기간 결과가 없는 타일 · 브랜드 칸 · 요약에 회차 Δ를 쓰지 않는다('기간 증감 미제공').
      - Prompts 도메인 파싱(`catalog.target_host`): `kia.ro//…`의 도메인이 빈칸이 되지 않는다. 라벨은 '타겟 도메인'이다.
    - 요약 발견 기준값(추천안): Mention · Citation · Conversion 모두 기준값을 뺐다.
      - 순서는 정해진 순서로 둔다(Mention `FINDING_ORDER`, Citation `FINDING_ORDER`). 색은 방향만 나타낸다.
      - 다음을 없앴다: 부정 신호 +0.3pp 문턱, 엔진 5pp · 4pp, 유형 −1.5pp, 기회 40%, 출처 선호 1pp, 순위 3계단, '구매 의도가 가장 강한 유형', 매트릭스 30건 미만 회색, Conversion 표본 50명 · 입구 페이지 50% 문턱.
      - 처방 문구('보강 대상', '기회', '강점 영역')는 중립 문구로 바꿨다. golden 25건을 다시 썼다(README '2026-10-30 no HUB threshold').
    - 라벨 · 보이는 것 · 나머지
      - Overview: 시장 표 가상 코드 라벨(월드와이드(글로벌)), 경쟁사 값 안 잘림, 선두 브랜드 열은 showLead일 때만, '점유율 1위 경쟁사' 라벨, 경쟁사 대비 SOV '410.7배', 순위 축 1부터, '언급 · 인용 공백', 0에 가까운 기간 칩은 '변화 없음'.
      - Mention: 순위 표 '변화 없음', 주 라벨 '6/29 주', 기간 모드 세부 지표 Δ는 색 없음, 미언급 구분 수는 Gold 전체 수(리더 counts), 경쟁사 평균의 집합 이름.
      - Citation: website 도메인 태그 '당사', 회차 라벨(주 → 회차), 추이선 문구 '세로 범위 최소 2pp'.
      - Prompts: 시장 커버리지 색 범례.
      - Conversion
        - 전환율 정의는 '사용자 100명당 전환 수'다.
        - 수집기 창이 있는데 빠진 날이 있으면 합계는 모름이다(부분합 금지).
        - 엔진을 고르면 채널 비교를 계산하지 않고 이유를 보인다.
        - 보고서를 섞는 대체 계산을 없앴다. 중지 속성은 측정 범위에서 뺐다. '잘 전환합니다' 문구를 바꿨다.
    - 남긴 것(이유)
      - 'HMG 계열' 배지의 이름 목록: 지금 결과가 같다. 행마다 Gold HMG 플래그를 따로 실어야 해서 Global golden이 크게 바뀐다.
      - `pct1_or_zero`: 원본 계약을 golden이 고정한다. 아무것도 측정되지 않은 경우에만 0이다.
      - 브랜드 → 모그룹 표시 묶음: 사용자가 표시 묶음은 허용했다.
      - 카테고리 추이의 빌드 시점 category_key: Gold 설계다.
      - 엔진 필터의 DeepSeek: 원본과 공유하는 W0 필터다.
      - Gold 질문 4건: Hyundai N bit 16, 비완성차 경쟁사, 등록 프롬프트 2,563개 미측정, URL 카드 population 4 · 10.

**점검 결과** (W0)

2026-10-30에 확인했다. 시험 관리자로 로컬 API(5555)를 직접 불렀다. 19개 화면이 모두 200이고, 응답은 0.0~1.5초였다.

- 모두 같은 기준일 2026-10-09다. 필터 옵션은 국가 72 · 언어 39 · 매트릭스 141 · 회차 14다.
- W1: 카드는 `state=ok`다(Hyundai 가시성 95.6% = 3356/3512). 추이는 14점, 구성은 출처 8 · 주제 0이다. 주제 0은 website 프롬프트에 카탈로그 분류가 없어서다.
  - GEO는 브랜드를 고르지 않으면 시장 0이다(원본과 같다). 브랜드 하나를 고르면 시장 6이다.
- W2: `mention/view`는 브랜드 436 · 추이 14점이다.
- W3: `citation/website`는 도메인 200 · 카테고리 13이고, 자사 · 타겟 URL 인용률(`targetHitRate`)은 live다. `citation/as-of`의 경쟁사 옵션은 0이다.
- W4: 프롬프트는 12,729개(255쪽)이고, 브랜드 옵션은 Genesis · Hyundai · Kia다.
- W5: `acr/gold`는 비어 있다(브랜드 0 · 셀 0, ⛔H와 같다). `conversion/renewal`은 `state=noprop`이다(GA4 속성 · 수집 전, 표준 화면과 같다).

## 결정 대기 (⛔)

| ID | 질문 | 막는 단계 | 상태 |
|---|---|---|---|
| A | 기준값(출처 분류, 시드 키워드, 엔티티 역할)을 누가 정하나. **추천:** HUB가 정본을 갖는다. HUB에서 편집한 값을 외부 API로 업스트림에 주고, Gold가 재가공한 뒤 화면에 반영된다. Gold 가져오기는 HUB가 고친 항목을 덮어쓰지 않는다. **다른 길:** 열람만 하고, 수정은 업스트림에 요청한다. 덮어쓰기(BFF가 읽을 때 적용)는 규칙 5 때문에 후보가 아니다. | 2 · 3 · 4 | 2026-10-30 결정 |
| B | GA4 '검증' 버튼. 원칙('BFF는 GA4를 부르지 않는다')을 지키면 검증 결과는 수집기 실행 결과(권한 대기 / 활성)로 보인다. 누르자마자 확인하려면 BFF가 GA4를 부르도록 구조를 바꿔야 한다. | 1의 검증 항목만 | 2026-10-29 결정 |
| C | 분석 엔진 · 리포트 관리 · 측정 크레딧 명세. 운영 웹(hmg-geo.vercel.app) 화면 캡처나 설명이 필요하다. | 6 | 미정 |
| D | 키워드 도구. DataForSEO · OpenRouter 키를 인계받는지, BFF가 유료 외부 API를 불러도 되는지, 비용 상한을 어떻게 둘지. | 5 | 미정 |
| E | 고객 관심. 커뮤니티 수집 소스를 HUB가 새로 가질지. 2026-10-30 확인: Gold 표 86개에 없고, 저장소에서 이 목록(원본 `app.standard_source`)을 읽는 수집기도 없다. 원본 관리 CRUD만 쓴다. | 3 | 미정 |
| F | 엔티티 카탈로그. 원본의 초안·검토·적용 흐름을 옮길지, 글로벌 프롬프트처럼 버전 행과 변경 이력만 둘지. | 4 | 미정 |
| G | 출처 시드 · 공식 소셜 목록의 정본. Gold `dim_source`에는 결과(분류 출처 4 · 2)만 있고, 원래 값은 원본 HUB 앱 파일이다(`front/lib/citation-categorizer/seed.json` 795개 · `official-social.ts` 9개, 2026-10-30 대조). HUB 편집 대상으로 할지, 파일로 둘지, Gold 열람만 할지. | 2 (공통 구조 '소유') | 2026-10-30 결정: HUB 편집 대상 |
| H | Website ACR. Gold `acr_cell_fact`에 website(surface 2) 행이 0개다(global 89,808 · project 76, 2026-10-30). 표 설명에는 'Website · Project ACR'에 쓴다고 되어 있다. 원본 website ACR은 `acr/gold`로 surface website를 읽는다. Gold 팀에 가공 예정인지 묻는다. | W5의 ACR | 미정 |
| I | Project 화면(목록, 상세의 Dashboard · Intent · Prompt · Analysis · AI Agent Funnel · Setting)을 이 목록의 어디에 둘지. 지금은 어느 todo에도 없다. | 없음 | 미정 |

## 기준값 편집 공통 구조

2단계(2026-10-30)에서 정했다. 3·4단계도 이 구조를 따른다. 예시는 2단계 이름이다.

- **소유.** 사람이 정한 값은 HUB가 갖는다(출처 교정, 시드 키워드, 엔티티 역할). 출처 분류 코드표(카테고리 13개 · 분류 출처 코드 1~6)도 HUB가 정본이다(결정 기록 '코드표'). 출처의 시드 · 공식 소셜 목록도 HUB가 편집하는 정본이다(결정 기록 G). Gold에는 결과로만 있고 원래 값은 원본 HUB 앱 파일이다. 편집 화면을 만들기 전까지 화면은 Gold 값을 열람만 한다. 자동 판정(출처 자동 분류, 발견 엔티티)은 Gold 소유이고 HUB는 읽기만 한다. Gold 가져오기의 거울 family(`source` · `keyword` · `entity`, source `gold`)는 그대로 둔다.
- **저장.** 데이터 DB `catalog`에 종류마다 현재 값 표와 이력 표를 하나씩 둔다. 예: `catalog.source_override`(키, 값, `status` active·cleared, `origin` gold_import·hub, 시각과 행위자)와 `catalog.source_override_event`(`changes = {필드: [전, 후]}`, 행위자, `published_seq`). 행은 지우지 않고, 원복은 `cleared`다.
- **키와 값.** 키는 파이프라인이 비교하는 정규형이다(출처: 소문자, 앞 `www.` 제거). 값은 Gold 코드만 받는다(출처 카테고리: `gold.dim_category.slug`). Gold는 쓰기 전에 잠금 밖에서 읽는다. 검증은 DB CHECK와 BFF 양쪽에서 한다.
- **처음 값.** `manage.py import-<종류>`가 Gold에서 사람이 정한 값을 한 번 가져온다(`origin = gold_import`, 행위자 없음). HUB에 값이 하나라도 있으면 거부한다. 2단계는 `import-source-overrides`이고, 가져온 값은 Gold `dim_source.category_src = 1`인 2건이다.
- **Gold 재가져오기.** `sync-gold-catalog`는 HUB 편집 표에 권한이 없고, HUB family도 기록하지 않는다. 그래서 HUB 편집이 남는다. HUB 값과 Gold 값이 다르면 덮어쓰지 않고 화면에 상태로만 보인다.
- **업스트림 전달.** 쓰기마다 같은 트랜잭션에서 활성 값 전체를 family 하나(`source_override`, source `hub_edit`)의 새 set으로 기록한다. 내용이 같으면 기록하지 않는다. 기록은 전용 함수 `catalog.publish_<종류>()`(SECURITY DEFINER)만 한다. 다른 역할이 `hub_edit` set을 쓰면 트리거가 막는다. 외부 API는 기존 경로 `GET /ext/v1/reference/<family>`로 내보내고, 공개는 `manage.py publish-reference <family>`로 승인한다.
- **change_seq 알림.** 기록은 catalog lock(617427413) 안에서 하므로 순번이 커밋 순서다. 소비자는 `GET /ext/v1/reference`의 `change_seq` · etag를 폴링하고, 바뀐 family만 다시 읽는다. `hub_edit`은 `ext.meta.hub_reference`(source `hub`만)에 들지 않으므로, 편집해도 `contract_version`이 바뀌지 않는다.
- **변경 이력.** 같은 트랜잭션에서 이력 행을 남긴다(누가, 무엇을 전 → 후, 실린 목록 순번). 화면에는 행마다 이력 서랍을 둔다.
- **전용 DB 역할.** 화면 하나의 입력 묶음마다 하나를 둔다. 예: 인용 출처 분류의 교정 · 시드 · 공식 소셜 · 코드표는 `hmg_source_override_editor` 하나가 쓴다(2026-10-30, 같은 관리자가 같은 화면에서 고치는 한 묶음). 표마다 필요한 열만 UPDATE하고, 발행은 종류마다 있는 함수로만 한다.
  - 권한: 편집 표 INSERT, 값 · 상태 · 시각 · 행위자 열 UPDATE, 이력 INSERT, 발행 함수 EXECUTE.
  - 없음: 키 · origin · 메모 UPDATE, DELETE, 다른 catalog 표, reference_set 직접 INSERT, 운영 DB 접속.
  - 비밀번호는 `.env.source-override-db.local`, 연결은 `.env.hub-edit.local`의 `HGH_SOURCE_OVERRIDE_EDITOR_DB_URL`.
- **BFF.** `hub_stores/<종류>.py`와 `/v1/hub/<종류>`를 둔다. 관리자 전용이고, 쓰기는 catalog lock 안에서 한다(5초 대기 뒤 503). 목록은 Gold 값과 HUB 값을 나란히 주고 `state`를 붙인다: applied(Gold가 HUB 값을 적용함), pending(아직), upstream(Gold에만 있음). 같은지 비교만 하므로 새 판단이 아니다.
- **화면 반영 시점 문구.** "고친 값은 HUB에 저장되고 외부 API 목록으로 파이프라인에 넘어간다. 화면 숫자에는 파이프라인이 가져가 Gold를 다시 만든 뒤 반영되고, 그 전까지 '반영 대기'로 보인다." '저장 즉시 반영'은 쓰지 않는다.
- **3단계 시드 키워드.** 그대로 쓴다. 거울은 family `keyword`(term · term_norm · 수집 조건)이고, HUB 표 키는 term_norm, 값은 수집 조건(location · language)이다. Gold `kw_suggestion.is_seed`는 2026-10-30 기준 84 term이다.
- **4단계 엔티티 역할.** 그대로 쓴다. 거울은 family `entity`(registry_role 지정분, 2026-10-30 기준 own 5 · excluded 14)이고, HUB 표 키는 Gold `entity_id`, 값은 역할과 자사 브랜드다. Gold에 있는 엔티티에만 역할을 줄 수 있다. 편집 흐름은 F 결정을 따른다.

## 단계

### 0. 계정 관리(사용자 관리) 마무리

- [x] 2026-10-29에 만든 계정 관리 작업을 커밋한다. 같은 날 커밋·푸시했다(`768d7f6`).
- [ ] VM 반영(`manage.py init`, `vm.sh bff`, 관리자 등록)은 사용자가 직접 한다. 다음 단계를 막지 않는다.

### 1. GA4 연동 (`/admin/ga4`)

목표는 속성 목록을 파일(`.local/ga4-properties.json`)에서 HUB 데이터 DB로 옮기는 것이다. 관리자가 화면에서 등록·수정·중지하고, 수집기는 DB에서 목록을 읽는다.

- [x] 범위를 확인한다. 원본(`ga4-registry-client.tsx`)에는 속성 이벤트 목록, 프로젝트별 덮어쓰기, 레거시 가져오기가 있다. 이 셋을 옮길지 확인한다. 2026-10-29 확인, 아래 '결정 기록'의 GA4 범위 줄.
- [x] 등록부 표를 설계한다. 수집기가 데이터 DB에만 접속하므로 데이터 DB에 둔다. (`data-006.sql`)
  - 담을 값: 속성 ID, 브랜드, 국가, 전환 기준(key_events / events와 이벤트 목록), 수집 여부(`enabled`, 중지). 한 시장에 수집하는 속성은 하나(원본 규칙).
  - `analytics.ga4_property`는 수집기의 기록으로 둔다. 수집기가 실행마다 등록부를 복사하고, 중지한 속성은 `unmapped`(리더가 뺌)로 둔다. 결과는 새 표 `ga4_collect_status`.
  - 변경 이력은 같은 DB의 `ga4_registry_event`(같은 트랜잭션).
- [x] 전용 DB 역할을 만든다. `hmg_ga4_registry_editor`: 등록부 INSERT·UPDATE(속성 ID 제외), 이력 INSERT, 지우기 권한 없음. Mac 저장소에 적용, `verify` 통과.
- [x] 입력 검증은 `load_registry` 규칙과 같게 한다. DB CHECK와 BFF 둘 다 둔다. 이벤트 이름은 GA4 규칙을 BFF·화면에서 본다.
- [x] 수집기가 DB 등록부를 읽게 한다. 파일 읽기와 예시 파일은 없앴다. 전환 기준을 바꾸면 다음 실행이 저장된 이벤트 행 전체의 `is_conv`를 다시 정한다. `test_ga4_collect.py` 갱신(PostgreSQL 시험 포함).
- [x] 화면을 만든다(`/renewal/admin/ga4`).
  - 목록 열: 시장(브랜드·국가), 속성 ID, 전환 기준, 수집 설정(+반영 대기), 수집 결과(수집기 값과 시각), 마지막 수집일.
  - 등록·수정 폼, 중지·재개, 변경 이력, 전환 이벤트 고르기(수집된 최근 90일 이벤트 + 직접 입력), 저장한 필터.
- [x] ⛔B 검증 버튼은 두지 않는다(2026-10-29 결정). 상태 열에 수집기가 마지막 실행에서 남긴 값(수집됨 / 권한 대기)과 그 시각을 보이고, 등록 직후에는 '수집 전'으로 보인다.
- [x] 같은 커밋에서 절차 문서를 새 방식으로 고친다: `scripts/vm.sh` 의 ga4 안내, 인계 문서 `p4-acr-model-denominator.html` 7-3절 13·18번, CLAUDE.md 'GA4 수집 시작' 줄.
- [x] 공통 완료 기준을 채운다. 2026-10-29 사용자가 확인했고 커밋·푸시했다(`08b533c`).

### 2. 인용 출처 분류 (`/admin/standards/citation-sources`)

이 단계에서 기준값 편집의 공통 구조를 세운다. 3·4단계는 그 구조를 따른다.

- [x] 범위를 확인한다. 원본(`domain-list.tsx`)에는 도메인 목록, 카테고리 교정, 후보 도메인이 있다. 2026-10-30, 결정 기록 '2 범위'.
- [x] A 결과에 따라 구조를 만든다. HUB가 정본이다. 교정만 HUB 표 `catalog.source_override`에 두고, Gold `source` 거울 family는 건드리지 않는다. 외부 API에는 새 family `source_override`(source `hub_edit`)로 내보낸다(`data-007.sql`). 아래 '기준값 편집 공통 구조'.
- [x] 후보 도메인과 인용 수는 Gold 읽기 값을 그대로 쓴다(최신 회차 · 글로벌 live, 인용 화면과 같은 모수).
- [x] 화면에는 반영 시점을 사실대로 적는다(업스트림 재가공 뒤에 반영, 행마다 반영 대기 / 반영됨). '저장 즉시 반영' 문구는 쓰지 않는다.
- [x] 정한 구조를 이 파일의 '기준값 편집 공통 구조' 절에 적는다.
- [x] 업스트림 합의 요청 초안을 쓴다(아래). 사용자가 보낸다.
- [x] 출처 분류 코드표를 HUB 정본으로 둔다(결정 기록 '코드표' · '2 남은 범위'). `catalog.source_code`(카테고리 13 · 분류 출처 6, `data-008.sql`)와 기준값 종류 `source_code`. 화면 코드표 탭은 이름 · 설명 · 카테고리 순서만 고친다. 시드 카테고리 검사는 이 코드표를 쓴다(교정은 아직 Gold `dim_category`).
- [x] ⛔G를 묻고 정한다. 2026-10-30 결정: 시드 · 공식 소셜 목록은 HUB 편집 대상이다.
- [x] 시드 · 공식 소셜 목록을 HUB에서 편집한다(결정 G · '2 남은 범위'). `catalog.source_seed` · `source_social`과 기준값 종류 `source_seed` · `source_social`, 화면 시드 · 공식 소셜 탭. 처음 값은 `manage.py import-source-lists`(시드 795 · 소셜 9 · 코드 19). 쓰기는 교정과 같은 `hmg_source_override_editor`(공통 구조 '전용 DB 역할').
- [ ] 공통 완료 기준을 채운다. 교정 탭은 커밋·푸시(`e12eeb5`), Mac 적용, e2e를 마쳤고 '전체' 두 번 결함을 고쳤다. 시드 · 공식 소셜 · 코드표 탭은 2026-10-30 Mac 적용(`init` 008 · `import-source-lists` · `verify`), BFF 시험 전체(32개 모듈 479개, 새 `test_hub_source_lists` 11개는 실 DB 롤백 포함), 프런트 typecheck · lint · 관련 시험 301개, 아키텍처 문서 · ERD, e2e 한 번(시드 · 소셜 · 코드표 핵심 흐름, 끝 상태는 처음과 같음)을 마쳤고 2026-10-30 사용자 요청으로 커밋 · 푸시했다(`a36b835`). 남은 것: 사용자 확인.

**업스트림 합의 요청 초안** (사용자가 파이프라인 팀에 보낸다)

> [HMG GEO HUB] 인용 출처 분류 교정값 전달 방식 확인 요청
>
> HUB가 출처 카테고리 교정(override), 출처 분류 코드표, 시드 · 공식 소셜 목록의 정본을 갖게 되었습니다. 자동 분류(규칙)는 지금처럼 파이프라인이 정합니다. 교정값은 외부 API(https://10.0.20.132:8087/ext/)로 드립니다.
> - `GET /ext/v1/reference`: family `source_override`의 `change_seq` · etag
> - `GET /ext/v1/reference/source_override`: 활성 교정 전체(키 = 소문자 · 앞 `www.` 뺀 skey, `category` = `dim_category.slug`)
>
> 확인 부탁드립니다.
> 1. `change_seq` · etag가 바뀌면 목록 전체로 교정 입력을 바꾸는 방식(폴링)이 가능한가요? 주기는 얼마인가요?
> 2. 목록에서 빠진 키(원복)는 기본 분류(소셜 → 당사 → 시드 → 규칙 → Other)로 되돌려 주시나요?
> 3. 반영 확인은 Gold `dim_source`의 `category_src=1`과 `category_key`로 하려고 합니다. 맞나요? 셀(`citation_cell`) 재빌드는 언제 하나요?
> 4. 키 정규화 규칙(소문자, 앞 `www.` 제거, 소셜은 계정 키)이 파이프라인과 같은가요?
> 5. 지금 파이프라인 쪽 교정 2건(arxiv.org, danawa.com)을 HUB 초기값으로 가져왔습니다. 앞으로 파이프라인 쪽에서 직접 교정하지 않는 것으로 정리해도 될까요?
> 6. API 키 발급 대상(호출자 이름)을 알려 주세요.
> 7. 출처 분류 코드표(카테고리 13개, 분류 출처 코드 1~6)와 시드 · 공식 소셜 목록도 HUB가 정본으로 관리하고, 같은 방식(외부 API, change_seq)으로 드립니다: `GET /ext/v1/reference/source_code` · `source_seed`(도메인 → 카테고리) · `source_social`(계정 키, 도메인, URL 매칭 규칙 `[{prefix, boundary}]`, 카테고리 officialHmg). 지금 이 값들을 어디서 가져가시는지(`dim_category` 설명에는 HUB 코드표의 투영이라고 되어 있습니다), 이 목록으로 바꿔도 되는지 알려 주세요.

### 3. 고객 관심 데이터 관리 (`/admin/standards/customer-interest`) ⛔E

- [ ] 범위를 확인한다. 원본은 `keyword-list.tsx`, `source-list.tsx`, 소셜 스크레이핑 흐름이다.
- [ ] 시드 키워드는 2단계 공통 구조로 만든다. Gold `keyword` 기준값(term, location, language)이다.
- [ ] 커뮤니티 수집 소스는 E 결정을 따른다. Gold에 해당 표가 정말 없는지 먼저 확인한다.
- [ ] 공통 완료 기준을 채운다.

### 4. 엔티티 카탈로그 (`/admin/standards/entities`) ⛔F

영향이 가장 크다. 역할 지정이 모든 KPI의 당사 판정을 정한다.

- [ ] 범위를 확인한다. 원본에는 목록, 서랍, 초안, 검토, 적용, 버전, 감사 화면이 있다.
- [ ] 역할(자사 / 경쟁 / 제외) 편집은 2단계 공통 구조로 만든다. Gold `entity` 기준값(registry_role 지정분)이다.
- [ ] `dim_entity` 에는 분석이 찾은 행과 사람이 정한 행이 섞여 있다. 외부 API로 무엇을 낼지 사용자에게 확인한다.
- [ ] 발견 브랜드와 언급 수는 Gold 값을 그대로 쓴다. 부모 브랜드 등 귀속을 BFF가 합치거나 고치지 않는다.
- [ ] F 결정에 따라 편집 흐름을 만든다.
- [ ] 공통 완료 기준을 채운다.

### 5. 키워드 도구 (`/admin/keyword-tools`) ⛔D

- [ ] 범위를 확인한다. 원본(`components/keyword/keyword-tools.tsx`)은 검색량 조회, 키워드→프롬프트 생성, CSV를 갖췄다.
- [ ] 키는 `.env.*.local` 에만 두고, BFF만 읽는다. 외부 호출 원칙이 바뀌는 것을 아키텍처 문서에 적는다.
- [ ] 관리자 전용으로 하고, D에서 정한 비용 상한을 지킨다.
- [ ] 생성한 프롬프트를 저장하는 흐름이 있으면 기존 글로벌 프롬프트 편집 경로를 쓴다.
- [ ] 공통 완료 기준을 채운다.

### 6. 분석 엔진 · 리포트 관리 · 측정 크레딧 ⛔C

- [ ] 명세를 받는다. 받은 뒤 페이지별 하위 항목을 이 파일에 더한다.
- [ ] 측정 크레딧 › 계정 목록은 미뤄 둔 '운영 웹 계정 가져오기'와 같이 한다.

## 결정 기록

| 날짜 | ID | 결정 | 근거 |
|---|---|---|---|
| 2026-10-29 | 순서 | 0 → 6 순서로 한다 | 사용자 승인 |
| 2026-10-29 | 1 범위 | 옮긴다: 등록·수정 폼(전환 기준 포함), 목록(상태, 마지막 수집일), 중지·재개(원본의 삭제 대신), 전환 이벤트 고르기. 옮기지 않는다: 속성 ID 없는 '대기 시장', 프로젝트별 덮어쓰기 목록. 전환 이벤트 목록은 수집기가 쌓은 최근 90일 이벤트 이름·횟수로 보이고, 수집 전 속성은 이름을 직접 입력한다. | 사용자 선택. 대기 시장은 수집기·화면 어디에도 쓰이지 않는다. 프로젝트별 속성 데이터와 리뉴얼 프로젝트 화면이 없다. BFF는 GA4를 부르지 않는다. |
| 2026-10-29 | 1 파일 | 파일 등록부(`.local/ga4-properties.json`)를 없앤다. 수집기는 DB 등록부만 읽는다. 파일 읽기 코드와 예시 파일을 지운다. | 사용자 선택. GA4 인계 전이라 가져올 값이 없다. |
| 2026-10-29 | B | 검증 버튼을 두지 않는다. 수집기 실행 결과(수집됨 / 권한 대기)와 시각을 상태 열에 그대로 보인다. | 사용자 선택. 'BFF는 GA4를 부르지 않는다' 원칙을 지킨다. |
| 2026-10-29 | 원칙 | 데이터는 한 방향으로 흐른다. HUB가 만든 데이터(프롬프트 목록, URL 기반 페이지 특성 등)는 Gold가 원천 데이터로 가져가 분석하고, HUB는 Gold의 분석 결과를 읽어 보기 좋게 가공해 보여준다. HUB가 가공한 결과를 Gold가 다시 가져가는 일은 없다. | 사용자 설명 |
| 2026-10-29 | A · 2 범위 (바뀜) | 다른 세션에서 '기준값은 Gold의 분석 결과, HUB는 열람만'으로 정하고 열람 전용 2단계를 만들었다(미커밋). 2026-10-30 A로 바뀌어 쓰지 않는다. 그 작업은 `.local/backup/2026-10-30-step2-readonly/`(git 제외)에 남겼다. | 2026-10-30 사용자 확정(아래 'A 확정') |
| 2026-10-30 | A | HUB가 정본이다. 사람이 정하는 기준값(출처 분류 교정, 시드 키워드, 엔티티 역할)은 HUB DB에서 CRUD로 관리하고 변경 이력을 남긴다. 편집값은 외부 API로 업스트림에 넘기고, 화면 숫자에는 Gold 재가공 뒤 반영된다. Gold 가져오기는 HUB가 고친 항목을 덮어쓰지 않는다. 분석이 자동으로 정한 값(자동 분류, 발견 엔티티)은 Gold 소유로 두고 HUB는 읽기만 한다. | 편집 화면이 서비스에 있고 관리자가 실제로 고친다. 사람이 정한 값의 원본은 편집하는 곳의 DB다. 업스트림이 HUB 값을 읽는 합의가 있어야 편집이 숫자에 닿는다(2단계 업스트림 질문 초안). |
| 2026-10-30 | 2 범위 | 옮긴다: 관리자 전용, 목록(인용 수 상위 500 + 교정한 도메인 전부, 인용 수는 Gold 최신 회차 · 글로벌), 열(도메인 · 인용 수 · 카테고리 · 분류 출처 배지 · 메모 표시 · 작업), 요약, 필터(미분류 · 카테고리 · 검색), 정렬, 셀렉트 즉시 저장, 원복, 당사 도메인 덮어쓰기 경고(Gold `owned_brand_bit` 기준), 하단 힌트, 조회 실패 구분, 변경 이력. 편집은 교정(override)만 하고 시드 · 소셜은 Gold 열람만 한다. 더한다: 행별 반영 상태(반영 대기 / 반영됨, HUB 값과 Gold 값 비교). 메모는 표시만. 원복은 행을 지우지 않고 cleared로 남기며 업스트림 목록에서 뺀다. family `source_override`, 출처 구분 `hub_edit`(외부 API contract_version에서 뺌), 처음 값은 Gold 교정 2건(arxiv.org, danawa.com). 옮기지 않는다: 캐시 태그 무효화, 소스 스위치, 대기 큐(409). 업스트림 합의 요청 초안은 사용자가 보낸다. | 원본 기능 목록과 Gold · HUB 데이터 사실을 확인한 뒤 추천안대로 정했다. |
| 2026-10-30 | A 확정 | 두 세션이 A를 반대로 정했다(10-29 열람 전용, 10-30 HUB 정본). 사용자가 HUB 정본(`e12eeb5`)을 확정했다. | Gold에는 사람이 정한 값의 원본이 없다. `dim_source`는 출처 1개당 최종 카테고리와 분류 출처 코드만 갖고, 표 설명은 '입력: 데이터 분석팀'이다. 원래 값은 원본 HUB 앱에 있다. 교정은 원본 앱 DB `citation_domain_overrides`, 시드는 `seed.json`(Gold 시드 701건 모두 같은 카테고리), 공식 소셜은 `official-social.ts`(Gold 8건 모두 포함)다. `geo_readonly`는 Gold에 SELECT만 가진다. |
| 2026-10-30 | 코드표 | 출처 분류 코드표(카테고리 13개, 분류 출처 코드 1~6)도 HUB가 정본이다. | 사용자 결정. Gold `dim_category` 표 설명이 'GEO HUB 출처 카테고리 코드표의 투영'이고, 원래 값은 `taxonomy.ts`다. `dim_source.category_src`는 smallint이고 코드표 없이 열 설명('1 교정 2 공식 소셜 3 당사 도메인 4 시드 5 규칙 6 Other')에만 뜻이 있다. 카테고리 번호는 `answer_fact.cit_c<k>` 열 번호와 묶여 있어, 카테고리를 더하거나 빼는 일은 Gold 변경이 따라야 한다. |
| 2026-10-30 | G | 출처 시드 · 공식 소셜 목록은 HUB 편집 대상이다(HUB 정본). | 사용자 결정. Gold에는 결과만 있고 원래 값은 원본 HUB 앱 파일이다(시드 701건 · 소셜 8건 모두 일치). |
| 2026-10-30 | Website 우선 | Website 하위 화면을 Admin 3단계 이후보다 먼저 만든다. Admin 2단계 남은 일은 다른 세션에서 진행 중이다. 화면마다 세션 하나씩 병렬로 하고, 공용 필터 등 공통 코드는 W0 세션만 고친다. | 사용자 결정. Gold 팀이 website 데이터 가공을 마쳤다(website 발행 2026-10-29 활성). |
| 2026-10-30 | W0 추천안 | W0는 모두 추천 기준대로 개발하고, 끝날 때까지 정할 일은 추천안으로 정해 바로 진행한다. 정한 것은 이 파일에 적는다. 첫 적용: website 필터는 원본 축 그대로 옮기고 더하는 것은 없다. 계정 범위는 세 화면 모두 Website 기준이다. | 사용자 지시(W0 세션). 같은 날 W1 · W4 · W5 세션도 같은 지시를 받았다. |
| 2026-10-30 | 2 남은 범위 | 코드표: HUB DB가 갖고 외부 API로 내보낸다. 화면에서는 이름(한국어 · 영어) · 순서 · 설명만 고치고, 카테고리를 더하거나 빼는 일은 막는다(Gold `cit_c<k>` 열과 묶임). 분류 출처 코드 1~6은 이름 · 설명만 고친다. 시드: 교정과 따로 둔 목록으로, 같은 편집 공통 구조(추가 · 카테고리 변경 · 제외, 이력, 반영 상태)를 쓴다. 처음 값은 `seed.json` 795개다. 공식 소셜: 계정 단위로 추가 · 수정 · 중지하고 이력을 남긴다. 매칭 규칙(접두어 · 경계)도 편집하고, 카테고리는 Official (HMG)로 고정한다. 처음 값은 `official-social.ts` 9개다. 화면: 인용 출처 분류에 탭 4개(교정 · 시드 · 공식 소셜 · 코드표)를 두고 메뉴는 그대로 둔다. 원본 코드 파일은 손대지 않는다(기존 화면이 씀). 가져온 뒤의 정본은 HUB DB다. 범위 밖: 당사 도메인 목록(분류 출처 3, 4단계와 묶임). | 사용자 확인(추천안). 시드를 교정과 합치면 우선순위(교정 > 공식 소셜 > 당사 > 시드)가 바뀌어 Gold 분류 결과가 달라진다. |
| 2026-10-31 | 결정 · 커밋 | 데이터 · 화면 원칙(규칙 5 · 7)을 충실히 따른 결정은 묻지 않고 진행하고, 새 원칙이 필요하면 반드시 묻는다(규칙 2, Website 세션의 추천안 규칙을 모든 작업으로 넓힘). 커밋 · 푸시는 시험을 통과하면 자동으로 한다(규칙 6). VM 반영은 사용자가 정한다. 레거시 KPI는 더 나은 인사이트를 위해 통합해 쓸 수 있지만 없애지 않는다(규칙 7). 규칙 5에는 이미 정한 데이터 원칙(한 방향 흐름 · 없는 정보 금지 · 측정 변화 그대로)을 모았다. | 사용자 결정. 푸시도 자동으로 한다(같은 날 사용자). |

## 진행 기록

- 2026-10-29 — 이 목록을 작성했다. 다음은 0단계다.
- 2026-10-29 — 0단계: 계정 관리 작업을 커밋·푸시했다(`768d7f6`). 커밋 전에 시험을 다시 돌려 모두 통과했다(BFF 30개 모듈, 관련 프런트 시험 12개 파일, typecheck, lint). 언급·인용 '순위 변화' 제목 변경과 `p4-acr-model-denominator.html` 19~23번 행은 다른 세션 작업이라 넣지 않았다. VM 반영은 사용자가 한다. 다음은 1단계 범위 확인이다.
- 2026-10-29 — 1단계: 범위를 확인하고 결정 B를 정했다. GA4 등록부(DB · BFF · 수집기 · 화면 · 문서)를 만들었다. BFF 시험 전체, 관련 프런트 시험, typecheck, lint, 저장소 `verify`, Playwright e2e 10단계를 통과했다. 커밋될 파일만 얹은 임시 작업 트리에서 다시 검증한 뒤 사용자 요청으로 커밋·푸시했다(`08b533c`). 다음은 2단계(⛔A 결정부터)다.
- 2026-10-30 — 2단계: 범위를 확인했다(결정 기록 '2 범위'). '기준값 편집 공통 구조' 절과 업스트림 합의 요청 초안을 썼다. 구현을 마쳤고 같은 날 사용자 요청으로 커밋·푸시했다(`e12eeb5`).
  - 저장소: `data-007.sql`(`catalog.source_override` · `source_override_event` · 발행 함수 · `hub_edit` 트리거), `hmg_source_override_editor`, `manage.py import-source-overrides`.
  - BFF와 화면: `hub_stores/source_overrides.py`, `/v1/hub/source-overrides*`, `/renewal/admin/standards/citation-sources`, `/api/hub/source-overrides`. 메뉴, 경로 정책, 아키텍처 문서와 ERD도 고쳤다.
  - Windows Docker 저장소: `init`과 `verify`를 통과했고, 처음 값 2건을 가져왔다.
  - 시험: BFF 464개 중 실패 0(`test_live_reads`는 이미지에 jsonschema가 없어 불러오기 오류). 새 시험 11개, 롤백 트랜잭션 실DB 쓰기 확인. 프런트 typecheck · lint 통과, 관련 시험 4개 파일 통과.
  - 기준 회차: 목록의 인용 수 회차(2026-10-05)가 리뉴얼 인용 화면 기본 회차(`citation/as-of`)와 같음을 Gold에서 확인했다.
  - 남은 것: API 재빌드 뒤 Playwright e2e(테스트 관리자 필요: `set-admin`은 비대화형 셸에서 비밀번호 입력이 멈춰 등록하지 못했다), Mac 저장소 적용, 사용자 확인, 커밋.
- 2026-10-30 — Mac 작업 트리를 `95964b7`로 받았다. 다른 세션이 만든 열람 전용 2단계(미커밋)와 원격 `e12eeb5`가 같은 화면을 반대 결정으로 만들어, 사용자가 HUB 정본을 확정했다('A 확정'). 열람 전용 작업은 `.local/backup/2026-10-30-step2-readonly/`와 `git stash`에 남겼다. 언급 · 인용 '순위 변화' 제목('최근 N회차/주')과 `p4-acr-model-denominator.html` 19~23번 행은 다시 얹었다(미커밋). 결정 '코드표'와 ⛔G를 더했다.
- 2026-10-30 — 2단계: Mac 저장소에 `007_source_overrides`를 적용했다(`init`, `import-source-overrides` 2건, `verify` 통과). API를 다시 띄우고 e2e(danawa.com 저장 → 원복 → 다시 저장, 이력 서랍)를 돌렸다. 끝 상태는 처음과 같고, 이력 3건과 업스트림 목록 v2~v4가 남았다. e2e 화면에서 필터 패널의 '전체'가 두 번 나오고 둘 다 선택되는 결함을 찾았다. `axisOptions`가 ALL을 넣고 `RnRadioAxis`도 '전체'를 그렸다. render 시험으로 재현한 뒤 고쳤다. 결정 G(시드 · 공식 소셜 = HUB 편집)를 기록했고, e2e는 새 화면의 핵심 흐름에만 돌리기로 완료 기준을 고쳤다.
- 2026-10-30 — 사용자 결정으로 Website 화면을 앞에 두었다('Website 우선'). Gold website 데이터를 확인했다: 발행 1,087건 2026-10-29 활성, ACR 셀은 website 0행(⛔H). 'Website 화면' 절(세션 W0~W5, 병렬 규칙)을 썼다. 같은 시각 다른 세션이 Admin 2단계 남은 일(`data-008.sql`, `source_lists.py`, 코드표 · 시드 · 소셜 화면)을 만들고 있어 그대로 두었다.
- 2026-10-30 — 2단계 남은 일: 범위를 확인했다(결정 기록 '2 남은 범위'). 시드 · 공식 소셜 · 코드표를 HUB 정본으로 만들었다(`data-008.sql`, `manage.py import-source-lists`, `hub_stores/source_lists.py`, `/v1/hub/source-seeds` · `source-socials` · `source-codes`, 화면 탭 3개, 아키텍처 문서 · ERD). Mac 적용 · `verify`, BFF · 프런트 시험, e2e 한 번을 마쳤다. e2e 실패 1건은 스크립트 타이밍 문제였고 같은 흐름을 따로 다시 돌려 정상임을 확인했다. 전용 DB 역할은 화면 묶음마다 하나로 정했다(공통 구조 '전용 DB 역할'). 사용자 요청으로 커밋 · 푸시했다(`a36b835`).
- 2026-10-30 — W5: 범위를 확인했다(추천안, 세션 메모 W5). `/renewal/website/ai-funnel/conversion`을 만들었다(page · page 시험, `RENEWAL_PAGES`, 사이드바 · 경로 시험 줄). 시험: 관련 5개 파일 285개 통과, typecheck · lint 통과. e2e 9단계 통과(상위 경로 → conversion, 사이드바 현재 항목, 기간 7일, 국가 US → '해당 데이터 없음', 초기화). 원본 `/ko/website/ai-funnel/conversion`과는 같은 필터에서 둘 다 'GA4 속성 없음'이다(GA4 인계 전이라 숫자 대조는 수집 뒤). ACR은 ⛔H까지 보류했다. 마지막 재실행에서 `rn-sidebar.render.test.tsx`의 'knows exactly the renewal pages' 1건이 실패했다. W1이 진행 중인 `renewal/website/page.tsx`의 `/website` 줄이 아직 `RENEWAL_PAGES`에 없어서이고, W5 파일 문제는 아니다.
- 2026-10-30 — W0: 저장된 필터 키 6개(`website-*`), website 필터 구성(`surface: "website"`, parity 시험 32개), BFF website 화면 19개 점검(모두 200, 결과는 '점검 결과')을 마쳤다. 시험: BFF 33개 모듈 490개, 프런트 필터 · 화면 시험 12개 파일 117개, typecheck, lint 통과. 미커밋. 사용자 지시로 W0 결정은 추천안으로 했다(결정 기록 'W0 추천안').
- 2026-10-30 — W1: 범위를 확인했다(추천안, 세션 메모 W1). `/renewal/website`를 만들었다(page, `_overview/website-overview-body.tsx`, render 시험 16개 · page 시험 5개, `RENEWAL_PAGES` · 사이드바 · 경로 시험 줄, 문구 `renewal.website.overview`). 필터는 W0의 `surface: "website"`, 저장 필터 키는 `website-overview`다. 시험: 자기 시험 21개, 사이드바 · 경로 · `[...slug]` · 리뉴얼 Overview 시험, typecheck · lint 통과. e2e 7단계 통과(열기, 브랜드 Kia 적용, 시장별 현황, 원본 `/ko/website?brand=Kia`와 카드 8개의 값 · Δ · 분자 · 분모 일치, 카드 → website Mention 새 탭, 우선 노출도 계열, 처음 상태). e2e에서 우선 노출도 눈금 중복('1.1' 두 번)을 찾아 고쳤다. `rn-sidebar.render.test.tsx`의 'knows exactly the renewal pages' 1건은 W2의 페이지 줄이 `RENEWAL_PAGES`에 들어오기 전이라 실패했고, 다른 W 세션이 각자 줄을 더한 뒤 다시 돌려 통과했다(관련 10개 파일 331개). 이어서 사용자 지시로 타겟 출처 인용률 불일치를 고쳤다(`gold_reader/metrics.py`, 세션 메모 W1). 수정 전 실패하는 시험 3개를 `test_gold_metrics`에 더했고, 수정 뒤 BFF 시험 전체 496개가 통과했다(5개 건너뜀). API를 다시 띄워 실제 Gold 값을 확인했고 e2e 7단계를 다시 통과했다(원본과 같음, Kia 63.2% · +2.2pp). 원본 `/ko/website`와 8개 조건(필터 없음, 브랜드 Kia · Hyundai, Hyundai + US, Genesis + en, 엔진 gemini, 기간 9/1~10/9, Kia + 기간)으로 대조했다. 카드 8개(값 · Δ · 엔진 일관성 · 분자 · 분모 · 경쟁사 SOV · 출처 문구), 출처 구성비, 시장별 권역 · 국가 점유율이 모두 같다. 대조 중 시장별 현황의 시작 지표를 원본과 같은 점유율로 바꿨다. 이어서 BI 개편(세션 메모 W1): BFF `website/brands` · `website/engines`와 시험 5개(배지 = 일관성 행 확인 포함), 화면 파일 6개(`website-kpis` · `-breakdowns` · `-trend` · `-sources` · `-markets` · `-findings`)와 시험 36개. BFF 시험 전체 523개, typecheck · lint 통과. e2e 7단계(구역 전부, 일관성 행 = 카드 배지, 브랜드 행 → brand, 시장 열 → 지도 · 순서, 국가 행 → geography, 엔진 행 → engine, 카드 → 새 탭) 통과. 레거시 대조 8개 조건 모두 같고, 브랜드 표 3행은 레거시에서 그 브랜드를 고른 카드 8개와 같다. 미커밋.
- 2026-10-30 — W2: 범위를 확인했다(추천안, 세션 메모 W2). `/renewal/website/answer-analysis/mention`을 만들었다(page · page 시험 3개, 서랍 요청 시험 3개, `RENEWAL_PAGES` · 사이드바 · 경로 시험 줄). BFF 두 곳(`mention_renewal.py`의 `_begin`, `mention_data.py`의 KPI 브랜드 추이)은 재현 시험 2개가 수정 전에 실패하는 것을 확인한 뒤 고쳤다. 시험: BFF 33개 모듈 503개, 프런트 Mention 관련 7개 파일 37개, 사이드바 · 경로 270개 통과. typecheck · lint에서 W2 파일은 깨끗하다. 남은 오류는 진행 중인 W4 `website-prompts-read.ts`와 W3 `citation-body.tsx`에 있다. API를 다시 띄웠다. e2e 8단계 통과: 기본 KPI 4개, 국가 미국 적용 뒤 값 변경, 원본 `/ko/website/answer-analysis/mention?geography=US`와 브랜드 행(점유율 · 언급률 · 평균 위치) 일치, 브랜드 서랍(프롬프트 · 답변 원문 · 인용 출처)과 감정 서랍이 모두 surface=website로 200. 기간(2026-09 · 미국)도 원본과 같다. e2e에서 브랜드 서랍 목록 결함(기존, 세션 메모 W2)을 찾았다. 미커밋.
- 2026-10-30 — W3: 범위를 확인했다(추천안, 세션 메모 W3). `/renewal/website/answer-analysis/citation`과 하위 화면 `prompts` · `tone-urls`를 만들었다. 표준 인용 `_components`에 website 타일(공식(당사), 자사 · 타겟 URL 인용률)을 더했고 표준 화면은 그대로다(render 시험). BFF `citation.py`: `citation/website`의 renewal 변형, 하위 화면 website 분기, 공식(당사) Δ · 추이(`load_own_share_line`). 시험: BFF 33개 모듈 전체 통과(새 시험 5개, citation golden 그대로), 프런트 인용 · 사이드바 · 경로 시험 303개, typecheck · lint 통과. API를 다시 띄웠다. e2e 14항목 통과: 첫 화면 값, 국가 미국 적용 뒤 값(공식(당사) 18.9 · HMG 53.1 · URL 83.8/63.4 · 프롬프트 260/92), 출처 행 토글(URL 인용률 '산출하지 않음'), 도메인 서랍, 하위 화면 개수, 원본 `/ko/website/answer-analysis/citation?geography=US`와 숫자 일치. 미커밋.
- 2026-10-30 — W4: 범위를 확인했다(추천안, 세션 메모 W4). `/renewal/website/prompts`를 만들었다(page · loading, 목록 · 상세 render 시험 7개, GET 프록시와 시험 6개, `RENEWAL_PAGES` · 사이드바 · 경로 시험 줄, 문구 `renewal.website.prompts`). BFF는 리더 website 분기를 고치고(재현 시험 5개가 수정 전 실패, 수정 후 통과) 화면 2개를 더했다. 시험: BFF 33개 모듈 492개 통과(건너뜀 5), 프런트 관련 시험 · typecheck · lint 통과. e2e 한 번(열기 → 국가 독일 288개 → 검색 ev6 5개 → 측정 횟수 정렬 → 다음 쪽 → 상세 → 엔진 렌즈(행 288개 그대로) → 엑셀). 원본 `/ko/website/prompts`도 같은 조건에서 288개다. 미커밋, 사용자 확인 대기.
- 2026-10-30 — W2: 사용자 지시(기존 KPI는 없애지 않는다)로 원본 website 요약 카드 6개를 '언급 현황' 카드로 되살렸다(BFF `mention/view-cards`, 카드 · render 시험 3개, BFF 시험 2개는 수정 전 실패 확인). 실제 화면에서 필터 없음 · 미국 · 미국+2026-09의 카드 값과 Δ가 원본과 같고, Global Mention에는 카드가 없다. 시험: BFF 33개 모듈 509개, W2 · 표준 Mention 시험 28개 통과, typecheck · lint 통과. API를 다시 띄웠다. 미커밋.
- 2026-10-30 — W2: 사용자 지시(정보를 잃지 않는 BI 개편, 없는 정보 증강 금지)로 화면을 다시 짰다(세션 메모 W2): KPI 세부 지표(KPI별 묶음, 탭 이동), 미언급 프롬프트 목록(Gold 리더 · BFF · 프록시 새로 추가, 다른 브랜드 언급 / 없음으로 나눔, 답변 원문), 주별 브랜드 언급 수(선 · 표 · CSV). 시험: BFF 534개(새 시험 7개, 수정 전 실패 확인), 프런트 W2 · 표준 Mention 33개 통과, W2 파일 typecheck · lint 통과(남은 tsc 오류는 W1 · W4 · W5 진행 중 파일). API를 다시 띄웠다. 실제 화면 e2e 통과: 묶음 → 탭 이동, 미언급 836 → 세그먼트 63 / 773 → 답변 원문(surface=website 200), 주별 11행 · 표로 보기. 미커밋.
- 2026-10-30 — W3 BI 개편: 사용자 요청('정보 유실 없이 인사이트, 없는 정보 증강 금지'). website 화면만 다시 배치했다(세션 메모 W3). 새 카드 2개(`citation-website.tsx`: 도달 · 프롬프트)와 BFF `load_url_reach`. 표준 화면은 그대로다(render 시험). 시험: BFF 33개 모듈 전체 통과(`test_screens_citation` 31개 중 도달 시험 3개 추가, golden 그대로), 프런트 인용 · 사이드바 · 경로 305개, 제 파일 typecheck · lint 통과. e2e 16항목 통과(도달 깔때기 · 엔진 표, 미국 필터, 출처 행 → 도달 '계산하지 않음', 서랍, 하위 화면, 원본 대조). legacy 대조 8개 조건 × 9개 값 + 도메인 상위 10행이 모두 같다(출처 필터로 공식(HMG)이 빠질 때만 '0.0%' 대신 '—'). 미커밋.
- 2026-10-30 — W4 BI 개편: 목록 인사이트(KPI 5개 · 카드 6개)와 차트 → 목록 좁히기 · 패널 필터, 행 회차 띠 · 엔진별 측정 막대, 상세 · 엑셀 추가 열을 만들었다(세션 메모 W4 'BI 개편'). 시험: BFF 33개 모듈 523개 통과(건너뜀 5), W4 render 14개 · 라우트 7개, typecheck · lint 통과(conversion 3건 · `preview-w5` 사이드바 시험 실패는 W5 작업 중 파일). e2e(회차 막대 → 마지막 측정 겹쳐 좁히기 2,290개 → 모두 해제 12,729개 → 엔진 조합 188개 → 시장 독일 패널 필터 288개 → 사이트 검색 107개 → 엑셀 13열 → 상세) 통과. 해제 뒤 목록이 갱신되지 않던 결함을 e2e에서 찾아 고쳤다. 미커밋, 사용자 확인 대기.
- 2026-10-30 — W5 BI 개편: 레거시 정보(페이지 조회 수 합계, 기간 사용자 원자료, 일별 표)를 되살리고, 수집기가 이미 쌓은 값으로 인사이트를 더했다. 채널 비교(AI Assistant vs 다른 채널, GA4 주요 이벤트), 전환 변화 분해(유입 규모 + 세션당 전환, 산술 항등식), 기기 · 신규/재방문 구성, 같은 입구 페이지의 일반 유입, 시장별 AI · 일반 전환율, 이벤트 AI · 일반 분할이다. 추정 · 채움 · 유의성 판정은 없다. 시험: BFF 33개 모듈 523개 통과(새 단언 6개, fixture 재생성), 프런트 render 10개 · 관련 4개 파일 282개, typecheck · lint 통과. fixture 미리보기 화면 캡처로 1920×915 배치를 확인했고(임시 경로는 지웠다), 새 리더 SQL은 로컬 저장소에서 읽기 역할로 EXPLAIN 했다. API를 다시 띄운 뒤 e2e 9단계를 통과했다.
- 2026-10-30 — W0: Website 화면 BI · 데이터 출처 점검(병렬 감사 4건, 결과는 대화로 보고)과 레거시 필터 대조 뒤, 사용자 지시로 필터 차이 세 가지를 맞췄다(세션 메모 W0). 재현 시험은 수정 전 실패를 확인했다(리더 `pin_top_rival` 1, Mention 평균 · 요청 2, Conversion 화면 · 리더 2, 빈 국가 축 render 1). 시험: BFF 33개 모듈 540개(golden 포함), 리뉴얼 프런트 39개 파일 303개, typecheck · lint 통과. API를 다시 띄워 실제 화면으로 확인했다(website Mention 'Tata · 자동', Conversion 국가 축 없음, 하위 화면 칩 × → 260 → 8,736개 · 2,060 → 134,811개). 아키텍처 문서의 HUB 읽기 경로 줄을 고쳤다. 미커밋.
- 2026-10-30 — W6: 사용자 요청으로 Website 하위 화면 디자인 지적 10개를 고쳤다(세션 메모 W6). 1920×915 화면 캡처로 전후를 대조했다(Overview KPI 카드 532 → 474px, Mention KPI 세부 지표 구역 232 → 163px). 시험: website · 표준 인용 · 표준 언급 · 셸 · 경로 정책 20개 파일 395개, typecheck, lint(오류 0) 통과. 고친 시험은 W1 KPI · 브랜드 표 · 추이, W2 KPI 세부 지표다(새 표시 규칙에 맞춤). 표시만 바꿔 e2e는 돌리지 않았다(완료 기준). 미커밋.
- 2026-10-30 — W6: 사용자 요청으로 Overview 핵심 요약을 리스트 카드로 바꿨다(세션 메모 W6). 시험: W1 5개 파일 41개(리스트 render 3개, 순위 화살표 1개 추가), typecheck, lint 오류 0. 화면 캡처로 전체 · Kia 조건을 확인했다. 미커밋.
- 2026-10-30 — W6: 사용자 요청으로 KPI 추이의 회차별 답변 수를 막대 + 숫자로 바꿨다. 시험: W1 37개(막대 높이 시험 1개 추가), typecheck, lint 오류 0. 화면 캡처로 확인했다. 미커밋.
- 2026-10-30 — W6: 사용자와 검토한 뒤 Prompts '마지막 측정 회차' 카드를 뺐다(세션 메모 W6, 업스트림 질문 후보 포함). 시험: Prompts 14개, typecheck, lint 오류 0. 화면 캡처로 확인했다. 미커밋.
- 2026-10-30 — W6: 사용자 요청으로 Website 화면 품질을 검수했다(보이는 것 · 인사이트 · 데이터 출처). 화면 캡처를 직접 검토했고, 출처 감사 4건(Overview · Mention · Citation · Prompts+AI Conversion, 읽기 전용, Gold SQL 확인 포함)을 돌렸다. 결과는 대화로 보고했다. 가장 큰 결함은 넷이다. Mention 주별 언급 수가 측정 없는 주를 0으로 그린다(미국 7/20 · 8/3 · 8/10). Citation 공식(당사)가 Gold 정의(website = loc_owned ∨ tgt_hit, `citation_cell` 설명)보다 좁다. Citation 미인용에 인용 0건 프롬프트가 들어간다. Overview 기간 모드에서 타겟 출처 Δ가 회차 Δ로 나온다. 요약 발견의 HUB 기준값(Mention · Citation · Conversion, Global 표준에서 옴)은 사용자 결정이 필요하다. 아무것도 고치지 않았다.
- 2026-10-30 — W6: 품질 검수 결과를 1~3단계로 고쳤다(세션 메모 W6 '품질 검수 뒤 수정'). 고친 범위는 BFF(리더 3 · 화면 4 · HUB 리더 1), front(W1~W4 · 표준 언급 · 인용 · 전환 `_components`), 문구다. 시험: BFF 34개 모듈 550개(새 시험: `test_gold_citations`, 주별 공백, 대상 도메인, 미언급 구분 수, 전환 기준값 · 부분합 · 채널 · 대체 계산, golden 25건 재작성), front renewal 43개 파일 589개, typecheck · lint 오류 0. API를 다시 띄워 실제 화면을 확인했다: 기간 모드 · Kia 시장 표 · Mention 요약 순서 · 미국 주별 공백 · Citation 미국 19.9% · 1,131 · 당사 태그 · Prompts 64. 미커밋.
- 2026-10-31 — W6: 사용자 결정으로 KPI 추이 답변 수 막대를 중립 회색으로 바꾸고 직전 회차 대비 증감 툴팁을 붙였다(세션 메모 W6). 언급 공백 회차의 '0'을 '—'로 고쳤다. 재현 시험 3개(회색 막대, 툴팁, 공백 '—')는 고치기 전에 실패했다. 시험: 리뉴얼 39개 파일 316개 · renewal-ui · dash 475개, typecheck 오류 0, lint 오류 0. 실제 화면에서 14회차 툴팁 값을 확인했다. 커밋 전 점검: BFF 시험 전체 550개 통과. front 시험 전체에서 작업 트리만 실패하던 `test/bff-boundary.test.ts`(Website Overview `page.tsx`가 옛 `lib/scope/engines`를 읽음)를 같은 폴더 `engineLabel`로 고쳤다. 남은 실패 23개 파일 · 121개는 HEAD에서도 똑같이 실패한다(옛 `lib/scope` · `lib/db` 시험). 미커밋.
- 2026-10-31 — W0~W6 커밋 · 푸시: 사용자 승인으로 Website 작업 전체를 한 커밋으로 올렸다(`f28395f`). 화면 폴더 · W0 필터 · 같이 쓰는 BFF 리더 · golden 압축 파일이 얽혀 W 번호별로 나눌 수 없었다. 그 앞에 다른 작업의 '순위 변화' 제목 짝(문구 4줄 · 본문 2줄, BFF는 이미 HEAD)을 따로 올렸다(`911a7d3`). `p4-acr-model-denominator.html` 19~23번 행(다른 세션의 언급 BI 검토 메모)은 넣지 않았다. 시험: BFF 550개, front Website · 경계 시험 84개, typecheck · lint 통과. front 전체 실패 23개 파일은 부모 커밋에서도 같다.
- 2026-10-31 — 원칙 정리: 사용자 결정으로 규칙 2(원칙을 따르면 자동 진행) · 4 · 6(자동 커밋 · 푸시) · 7(화면 원칙 새로 둠), 공통 완료 기준, CLAUDE.md 작업 규칙을 고쳤다(결정 기록 '결정 · 커밋').
