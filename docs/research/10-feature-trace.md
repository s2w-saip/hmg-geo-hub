# 10. 기능 명세서 원자료 — 화면별 요약 (hmg-geo-research-preview-7639b9e)

조사 방법: 6개 조사 갈래가 `screen-fn-map.tsv`의 fn 보유 route 25개를 분담(page.tsx·_components·messages/ko.json·lib/scope/server.ts·lib/db/repositories/* 열람, `git grep -n` 실측). 원자료는 `10-feature-trace.tsv`(214행). 이 문서는 그 산출물의 화면별 요약과 교차 발견 사항이다.

## 화면별 요약 (구획 수·함수 수·확인/미확인)

| route | 구획 수 | 함수(고유) 수 | 확인/미확인 비고 |
| --- | --- | --- | --- |
| /dashboard | 4(측정기준일pill·필터바·핵심지표요약·GEO현황) | 14개 실호출 + 8개 요청목록엔 있으나 이 화면 미호출(오탐/타화면전용) | 실호출 함수 정의는 전수 확인. 미러 세부 FROM절 일부 미확인(fetchLatestAnchorDay·fetchPeriodCompare·fetchStandardCompetitorSources·fetchStandardGeoKpi 체인) |
| /projects/[id]/analysis/citation | 3(요약/트렌드/표)+필터·달력 | 6 | 확인 6, tables는 미러 내부 SQL 미열람이라 "추정" |
| /projects/[id]/analysis/mention | 5(요약/비교/감정유형/트렌드/표)+필터·달력 | 8(요청목록 fetchStandardSubKpis는 호출 미검출) | 확인 7 / 미확인 1 |
| /projects/[id] | 3(헤더/필터/KPI7종)+지역옵션 | 6 | 확인 5 / 미확인 1(page.tsx 직접호출 경로 불확실) |
| /projects/[id]/setting | 6(일반/AI엔진/소유base/추적URL/추적대상/Scope연결) | 6 | 확인 4 / 미확인 2(engine history·tracked-entities repo 정확 file:line) |
| /projects/[id]/intent/google-keyword | 2(project/member 조회·키워드뷰) | 3 | 확인 2 / 미확인 1(trackedKeywordRepository 정확 라인) |
| /standard/ai-funnel/acr | 8(필터·달력·ACR표·KPI4종·추이·battle·전환율표·territory)+empty | 6 | 확인 8/8. **표준측은 실데이터(scope_acr_rollups)** |
| /standard/ai-funnel/conversion | 11(필터·GA4미연동안내·pending·KPI·국가표·추이·엔진별·페이지별·방문수) | 7(요청목록 2개론 커버 안 됨, GA4 함수 5개 추가 발견) | 확인 10/11. 실데이터는 전부 **GA4 Data API 직결**, Scope 무관 |
| /standard/ai-funnel/visibility | 4(필터+요약카드+산점도+표) | 필터 2뿐, 본문 3구획은 **정적 fixture(DB 미조회)** | 구조 확인 4/4, 실데이터 0/4 |
| /standard/prompts | 3(헤더메타/카탈로그탭/변경이력탭) | 3 | 확인 3/3 |
| /standard/answer-analysis/citation(+prompts,+tone-urls) | 10(측정기준일pill·필터바·측정개요·인용현황·출처카테고리·톤별도메인·Δ류)+하위2탭 | 15+3+3=21(중복 제외 고유 다수) | 확인 다수, 부분미확인 2(fetchLatestAnchorDay·fetchPeriodCompare 본문) |
| /standard/answer-analysis/mention | 11(필터바·측정개요·4KPI탭[히어로/경쟁사/엔진/유형]·본문트렌드+표) | 15 | 확인 12 / 부분미확인 3(fetchLatestAnchorDay, fetchStandardKpiHeroSubKpis 본문, cachedKpiStanceDist/cachedKpiTypes FROM절) |
| /website/ai-funnel/acr | 9(헤더·필터×2·본문6구획) | 필터 2뿐, 본문 6구획은 **정적 fixture(sample.ts), SNB에서도 숨김(hidden:true)** | 확인 9/9(구조), 실데이터 0/6 — **표준측과 달리 website ACR은 완전 샘플** |
| /website/ai-funnel/conversion | 11 | 9(GA4 7개+필터2) | 확인 10/11. **standard/ai-funnel/conversion과 컴포넌트·함수 100% 공유**(모두 GA4, scope 무관) |
| /website/answer-analysis/citation | 11(헤더·필터×6·기준일칩·요약카드4종·본문5구획) | 8 | 확인 6, 부분미확인 5(딜러비중 산식·앵커테이블 체인 등) |
| /website/answer-analysis/mention | 11(헤더·필터×5·요약카드×2·본문5구획·드릴다운2종·신호다이얼로그·답변모달) | 9+4(드릴다운·모달 추가발견) | 확인 6, 부분미확인 7(체인 세부) |
| /website/prompts | 4(헤더·필터×3·표·다운로드) | 9(요청목록 7 + export 2 추가) | 확인 7 / 미확인 2 |
| /website(메인 대시보드) | 5구획(필터·①요약KPI·②추이·③구성·④GEO) | 16개 실호출 + 12개 요청목록엔 있으나 **실제 미호출(오탐 확정)** | 실호출 16/16 정의 확인. summary_table→scope_mirror 폴백 체인 표층까지만(viaSummary/viaTrend/withWebsite 내부 SQL 미열람) |
| /admin/standards/entities | 1(엔티티 카탈로그 표) | 1 | 확인 |
| /admin/standards/prompts | 1(프롬프트 목록 표) | 1 | 확인 |
| /raw-data-qa/answers/[jobId] | 4(답변원문+낱알/검수상태/노트/네비) | 4 | 확인 3, 미확인 1(getReview 본문) |
| /raw-data-qa/answers | 3(진행률/필터바/목록) | 3 | 확인(줄번호 일부 근사) |
| /raw-data-qa/notes | 2(요약/목록) | 2 | 확인 |

**합계**: 화면 25개(전량 조사), `10-feature-trace.tsv` 214행(구획×함수 매칭 단위, 화면 미호출/오탐 행 포함), 원자료 내 `read_path` 컬럼이 "미확인"인 행 17개(약 8%) — 대부분 다단 호출 체인(mirrorCache→aggregate*FromMirror)의 최하단 SQL FROM절까지 못 내려간 경우다.

## 표준(fetchStandard*) ↔ 웹사이트(fetchWebsite*) 쌍 목록

| 표준 | 웹사이트 | 비고 |
| --- | --- | --- |
| fetchStandardMentions (server.ts:3726) | fetchWebsiteMentions (server.ts:4983) | 둘 다 `MentionsLive\|null` 반환 |
| fetchStandardCitations (server.ts:3894) | fetchWebsiteCitations (server.ts:5011) | 둘 다 `aggregateCitationsFromMirror`(server.ts:1236/4313)로 수렴 |
| fetchStandardSubKpis (server.ts:2021) | fetchWebsiteSubKpis (server.ts:4880) | |
| fetchStandardSubKpisPrev (server.ts:2028) | fetchWebsiteSubKpisPrev (server.ts:4911) | |
| fetchStandardSignalPrompts (server.ts:3923) | fetchWebsiteSignalPrompts (server.ts:3931) | |
| fetchStandardBrandMentionPrompts (server.ts:3876) | fetchWebsiteBrandMentionPrompts (server.ts:5002) | |
| fetchBrandCitations (server.ts:4041) | fetchWebsiteBrandCitations (server.ts:5220) | |
| fetchStandardAnswerBody (server.ts:4053) | fetchWebsiteAnswerBody (server.ts:4088) | |
| listMeasuredRegions / listMeasuredScopeMatrix (scope-aggregates.ts:7488/7636) | listWebsiteCountries / listWebsiteScopeMatrix (website-sites.ts:175/142) | 코드 주석에 짝임을 명시(website-sites.ts:101-102,129) |
| listStandardCatalogScoped (standards.ts:287) | listWebsitePromptsScoped (website-sites.ts:507) | 역할은 같은 짝, 시그니처는 다름 |

**짝이 없는 것(확인됨)**:
- **fetchStandardAcr ↔ (없음)**: `/website/ai-funnel/acr`는 `fetchWebsiteAcr`를 호출하지 않는다(`git grep`결과 0건). 표준측 컴포넌트(`AcrLiveView`, 실데이터)를 쓰지 않고 별도의 샘플 컴포넌트(`AcrView`, `standard/ai-funnel/_data/sample.ts` 하드코딩)를 재사용한다. 즉 "표준/웹사이트 쌍"이 아니라 **표준=실데이터, 웹사이트=정적 샘플**의 비대칭 구조.
- **ai-funnel/conversion**: standard·website 둘 다 `getAiConversionLive`/`getAiTrafficConversionRollup`/`getAiVisitsLive`(GA4, `lib/ga4/conversion.ts`)를 그대로 공유. `fetchWebsite*` 짝이 애초에 없다(GA4는 scope 미러와 무관).
- **website 전용(표준측 대응 없음)**: fetchWebsiteTargetHitRate, readWebsitePromptQuery
- **짝 미확인**: listWebsiteBrands

## 미확인 목록(종합)

1. **다단 호출 체인 하단 SQL** — `fetchLatestAnchorDay`(server.ts:5509)·`fetchPeriodCompare`(server.ts:5568)·`fetchStandardCompetitorSources`(server.ts:3301)·`fetchStandardGeoKpi`(server.ts:4018)·`viaSummary`/`viaTrend`/`withWebsite`(/website 공통 헬퍼)의 최하단 FROM절 — mirrorCache/aggregate*FromMirror 명명 규칙과 이미 확인한 동종 함수(aggregateCitationsFromMirror·aggregateMentionsFromMirror)로 강하게 추정했으나 개별로 다시 열람하지 못함.
2. **/projects/[id]/setting** — `effectiveAiEngines`·`listEngineHistory`·`trackedBrandRepository`/`trackedCompetitorRepository`/`trackedVehicleRepository`의 정확한 file:line(import는 확인, 정의부 미열람).
3. **/projects/[id]/intent/google-keyword** — `trackedKeywordRepository.listForProject` 정확 라인.
4. **/raw-data-qa/answers/[jobId]** — `getReview`(qa-review.ts:862) 본문(qa_answer_reviews 테이블 추정, 미확정).
5. **/standard/ai-funnel/conversion** — `resolveProperty`/`resolveProperties`(ga4/property-map.ts) 내부 매핑 테이블 로직.
6. **/website/answer-analysis/citation** — 딜러·마켓 비중 산식, 도메인 share/coverageRate 산식(i18n 키만 확인, 계산식 미열람).
7. **/website 메인** — `fetchStandardAggregates`~`fetchStandardSourceComposition` 등 12개 함수는 website page.tsx·_data/live.ts에 import가 전혀 없어 **실제 미호출(오탐 확정)**으로 판정. 요청 목록(screen-fn-map.tsv)의 기계추출이 /dashboard 화면과 route 인접성으로 혼입한 것으로 추정.
8. **런타임 플래그 상태**(reportTruth, websiteOwnedUnit 등) — DB 접속 금지 범위라 코드상 분기만 확인, 실제 활성 여부는 미확인.

## 핵심 발견(구조적)

- **/standard/ai-funnel/visibility**와 **/website/ai-funnel/acr**는 화면이 존재하지만 **DB/Scope를 전혀 읽지 않는 정적 샘플**이다(전자는 `SAMPLE_VISIBILITY_*` fixture, 후자는 `standard/ai-funnel/_data/sample.ts`). 재설계 시 "화면은 있으나 기능이 없는" 항목으로 분리 판단 필요.
- **/website/ai-funnel/conversion**과 **/standard/ai-funnel/conversion**은 Scope 미러와 무관하게 **GA4 Data API를 직접 호출**하는 별도 계열이다 — summary_* 사실표·scope_mirror 재설계 범위 밖.
- **/dashboard**와 **/website**는 함수 목록이 기계추출 단계에서 섞여 있었다(website page.tsx가 dashboard 전용 함수 12개를 "호출하는 것처럼" 기록됨) — 재설계 스펙에서 이 12개는 제외해야 한다.
