"""현행 프로필(legacy profile): 운영 hmg-geo(2670a16 + read_screens 14키)와 같은 데이터·같은 회차에서 값이 같도록 되돌리는 정의별 스위치.

근거: 제품 결정 19·23~25(2026-10-01) "같은 데이터·같은 회차에서 운영과 값이 완전히 같게, 예외 없음(GEN·G20·RESUB 결함까지 현행 재현)".
계획서 notes/hgh-impl/revert-to-current-plan-20261001.md 5절(되돌림 명세)·6절(WU). 이 모듈은 WU-1 골격이다:
- 스위치 목록(SWITCHES)과 이후 WU 매핑, 프로필 값(LegacyProfile), 활성화 규칙(parse_profile·active_profile)만 둔다.
- 스위치가 전부 꺼짐(OFF)이면 core 빌더가 내는 SQL·응답이 이 모듈 도입 전과 바이트 같다(tests/core/test_legacy_profile.py).
- 구현되지 않은 스위치(IMPLEMENTED 밖)는 켤 수 없다(설정 적재 때 ValueError). WU 가 자기 스위치를 구현하면 IMPLEMENTED 에 넣고
  단위 시험 틀(test_legacy_profile.py 의 WU 자리)을 채운다. 모든 스위치가 구현되면 DEFAULT_SPEC 을 "current" 로 바꾼다(결정: 최종 기본값 = 현행).

종류(kind)
- read        조회 시점 정의(모수·창·축·옵션). 켜고 끄면 곧바로 응답이 바뀐다(결과 캐시 키에 프로필 지문이 들어간다: core.result_cache.build_id).
- projection  적재·투영 시점 정의(rd 열 값을 정하는 규칙). 켜고 끄면 재투영이 필요하다. 설정은 같은 곳에서 읽지만 적재기가 소비한다.
- freeze      동결(발행 생성·이관) 시점 정의(동결 세대 보관 행을 정하는 규칙, rd 는 그대로). 켜고 끄면 동결 세대 재생성·재이관이 필요하다(재투영 불필요).
              bulk 시드 입력이 아니다(ingest.testkit.PROJECTION_SEED_ARGS 밖). 소비 = ingest.frz(freeze·ops_import).

규약: 표준 라이브러리만 쓴다(core.measure 빌더를 대조 러너가 Python 3.9 에서 재사용한다).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, fields
from functools import lru_cache


@dataclass(frozen=True)
class SwitchSpec:
    tag: str            # 계획서 2절 사유 태그
    wu: str             # 채울 워크유닛(계획서 6절). "신규" = 계획서에 WU 가 없던 K 태그(결정 23~25 로 재현 대상이 됨)
    kind: str           # read | projection | freeze
    summary: str        # 현행 정의(되돌림 목표) 한 줄
    slot: str = ""      # 스위치 자리(분기를 쓸 곳). core.* 자리는 require_slot 로 표시돼 있고, 그 밖은 WU 가 기능 모듈·적재기에 새로 둔다
    db: str = ""        # 쓰는 DB 변경(DB-v2.15 열 등), 없으면 빈 문자열


# 스위치 이름 → 명세. 이름은 LegacyProfile 필드와 같다(한 벌: test_legacy_profile 이 대조한다).
SWITCHES: dict[str, SwitchSpec] = {
    "cell_rep": SwitchSpec(
        "A1", "WU-2", "read",
        "모수 = 회차 셀(회차·프롬프트·엔진·지역) 대표 1건(스냅샷, 축 on 기간 경로도 회차마다). 자식 표(answer_brand·answer_stance·citation)도 대표만",
        slot="core.measure.mention_population·citation_population(+ 자식 표 별칭, table 인자)",
        db="rd.answer.is_rep + 자식 사본 rd.answer_brand·answer_stance·citation.is_rep(DB-v2.15 P85, 전파 = rd.propagate_answer_gates)"),
    "rep_pick_latest_first": SwitchSpec(
        "A1", "WU-2", "projection",
        "대표 선정 = 셀 서빙 답변 중 measured_at DESC NULLS FIRST, job_id 1건을 게이트 전에 굳히고 그 답변이 elig 가 아니면 셀 대표 없음"
        "(surface-global.ts:464-478·surface-website.ts:307-317, 읽기 게이트 summary-trend-aggregates.ts:674-700). 끄면 hub R05 = elig 후보 안 최신",
        slot="ingest.project.apply REP_UPDATE(적재기 활성 프로필)·seed-40(psql 변수 rep_latest_first)·back/migration/fill-v215-rep.sql(재투영)",
        db="rd.rep_expected(int4[], bool)(DB-v2.15 P85)"),
    "rep_round_date_cell": SwitchSpec(
        "A1·R04CIT(답변분석 경로)", "WU-12", "projection",
        "is_rep = 답변분석 경로 대표(scope-aggregates.ts:1820-1851 anchorRoundCellAnswerIdsSubquery·cell-snapshot.ts:104-115: round_date 마다"
        " 셀(프롬프트, 엔진, 답변 region) 1건, 후보 = elig_nc ∧ 서빙 ∧ 숨김 아님 회차, 원본 시각 DESC, job_id DESC). 후보 밖 회차는 종전 회차 셀 규칙."
        " 답변분석 인용 계열(인용 숨김 회차를 후보에서 뺀다)이 다른 대표를 쓰는 답변은 보정 표 rd.rep_cit_delta, 답변분석 인용 모수 = is_rep XOR 소속."
        " 카드·추이 셀 대표(집계층 회차 셀·미러 시각)는 제품 결정 31 로 동결 스냅샷 층(frz)이 맡는다: 카드 요청은 freeze_at_publish 의 카드 뷰(셀 = 동결 셀, is_rep 참)를"
        " 읽으므로 이 스위치는 freeze_at_publish 와 함께 켠다(동결 세대 없는 회차의 rd 행만 답변분석 is_rep 을 읽는다, REP_PATH)."
        " rep_pick_latest_first·freeze_at_publish 가 함께 켜져야 한다",
        slot="core.measure.citation_population(rep_term) + ingest.project.apply REP_UPDATE_SEAT·ingest.cycles.ledger 투영 훅"
             "·seed-40 §8(psql 변수 rep_round_date_cell)·back/migration/fill-v219-rep.sql(재투영)",
        db="rd.rep_cit_delta·rd.rep_rules·rd.reselect_rep_seat·rd.assert_rep_seat(DB-v2.19 P109~P110)"),
    "acr_iter_unfolded": SwitchSpec(
        "A15", "WU-2", "read",
        "분석 없는 ACR 반복 job 을 접지 않는다(현행 sync.ts:1365): 셀 대표로 뽑히면 반복 순번과 무관하게 모수에 든다(acr_in 술어를 뺀다)."
        " cell_rep 이 켜져 있어야 한다(자식 표에 acr_in·elig 사본이 없어 셀 대표 밖에서는 표현 불가)",
        slot="core.measure.mention_population·citation_population"),
    "gap_in_population": SwitchSpec(
        "A16", "WU-2(WU-10 판정)", "read",
        "분석 결손 답변을 언급 모수에 넣는다(언급 0). WU-10 R5 로 확정(리포트 = 결손 포함, 현행 언급 계열도 포함)."
        " cell_rep 이 켜져 있어야 한다(answer_stance 는 결손 답변 행이 있어 std_in 사본만으로 셀 대표 밖 표현 불가)",
        slot="core.measure.mention_population"),
    "card_slot_rep": SwitchSpec(
        "R04CIT", "WU-3", "read",
        "대시보드 카드 경로(요청 card=true)의 기간 창 = 한 자리(round_date) 한 회차: 자리마다 언급 대표(숨김 'all' 제외 → 완결성 0.9 통과 →"
        " 늦은 앵커 → cycle_id)·인용 대표(인용 숨김까지 제외한 같은 사다리)만 읽고, 글로벌은 언급 대표 완결성 < 0.9 인 자리를 통째로 뺀다"
        "(현행 viaGlobalS1 server.ts:1945-1958·viaTrend :5124 → cycle-set.ts:883 restrictToTrendSlotSet·:773 restrictToSlotRepresentative,"
        " 웹사이트는 (프로젝트, 자리) 그룹·완결성 없음 server.ts:4894). 옛 이름 card_family_any('all' 계열)는 WU-0 모사가 이 규칙을 근사한 것이다"
        "(글로벌 08-24 자리: 언급 대표 = 인용 숨김 회차 551, 정상 회차 413 은 언급에서 빠진다)",
        slot="core.cycles.resolve_window(card)"),
    "summary_all_engines": SwitchSpec(
        "DFLT·DC-01", "WU-3", "read",
        "대시보드 카드 경로(요청 card=true: 카드·GEO·엔진 배지·경쟁사·도메인·추이·기간 비교)의 엔진 필터 없음 = 전 엔진(비기본 엔진 포함)."
        " 현행 집계층 사실표는 회차 run 의 모든 target 을 싣고(surface-website.ts:296 CELL_KEY, surface-global.ts:471) 리더는 엔진을 고른 때만"
        " 거른다(summary-trend-aggregates.ts:730, 기간 비교 summary-period-compare.ts 가 같은 trendWhere). 미러 앵커 경로(답변분석 화면)는 기본 엔진"
        "(scope-aggregates.ts:1944 anchorDefaultEngineScope) = 허브 기본. 옛 이름 period_gates 의 R07PUB·R07SCOPE 는 14키에서 소멸(WU-0)",
        slot="core.measure.scope_where(card)"),
    "catalog_incl_deleted": SwitchSpec(
        "A41", "WU-4", "read",
        "글로벌 카탈로그 모집단에 소프트 삭제 행을 포함(surface-global.ts:117-135 CAT_CTE 에 deleted_at 술어 없음: 브랜드 집합 catalog_brands 와 "
        "in_root_catalog 둘 다). 전부 삭제된 프롬프트(stg 103개·9,304 답변, 2026-08-18 삭제)의 답변도 모수에 남는다",
        slot="core.measure.scope_where(글로벌 bgrp → 삭제 포함 카탈로그 술어: Refs.cat_diff 보정 집합 형, 모르면 rd.dim_prompt.cat_mask_all 세미조인)"
             "·mention_population·citation_population"
             "(글로벌 std_in·cit_in → std_in_nc·cit_in_nc = 카탈로그 게이트를 뺀 모수, 카탈로그 게이트는 세미조인이 건다)·applied_prompts_sql. "
             "cell_rep 과 함께면 rep_pick_latest_first 필수(현행 대표 게이트 = 카탈로그 무관 elig_nc)",
        db="rd.dim_prompt.cat_mask_all·in_root_catalog_all(DB-v2.15 P88), rd.answer.elig_nc + 사실 표 4종 std_in_nc·cit_in_nc(DB-v2.15 P89)"),
    "display_name_latin": SwitchSpec(
        "NAME", "WU-4", "projection",
        "롤업 엔티티 대표 표기 = 라틴 우선 → 사전순을 운영 DB 콜레이션(ICU en-US)으로(scope-aggregates.ts:238-254 ROLLUP_NAMES). "
        "stg(libc en_US)에서는 'KG모빌리티' < 'KGM' 이라 표시 브랜드가 KG모빌리티로 갈렸다. "
        "그리고 표시 브랜드 키 = 정본 표시명 문자열 그대로(운영 생성기 brandExprs context.ts:134-145 + bg GROUP BY load.ts:79-98, 리더 brand_name 합산): "
        "대소문자만 다른 표기(Vivo·vivo)는 두 행, 경쟁사 도메인 토큰 정본('smart')이 언급 표기('Smart')를 덮지 않는다(2026-10-02 frz 4차 40 회차 실패). "
        "대표 표기 원천 = 지금 Brand 행 ∪ 원장 ing.entity_brand_name(DB-v2.26, 본 적 있는 Brand 표기를 지우지 않는다): 원천 정리로 Brand 행이 "
        "모두 사라진 엔티티(Wahl·Sharp·Arrival)도 제품 표기로 대체되지 않고 엔티티 이름·비경쟁 판정을 유지한다",
        slot="ingest.project.apply _ig_names·PRIOR_NAMES·NAME_CHANGED(queries.name_coll) + seed-3x-common §3 name_key·brand_bare·§5 _names"
             "(GUC hgh.legacy_name: 시드 = PGOPTIONS, 적재기 = ingest.common.rules.set_name_rule)(재투영: dim_brand_name 부터 bulk 시드)"),
    "brand_exposure_per_alias": SwitchSpec(
        "G20", "신규", "read",
        "브랜드 노출 답변 수를 (답변, 롤업 id) 단위로 센다(fold.ts:468,486 answers = count(DISTINCT job_id) 를 (brand_id, brand_name) 별로, "
        "리더 summary-trend-aggregates.ts:966-999 가 표시명으로 합산 → 별칭 id 수만큼 중복). 순위 열은 보호(fold.ts:420-440, 영향 없음)",
        slot="core.measure.competitor_rows_sql exposure_answers(= sum(rid_n))",
        db="rd.answer_brand.rid_n(DB-v2.15 P89)"),
    "m05_den_hostless": SwitchSpec(
        "G21A", "WU-5", "read",
        "⑤ 분모·GEO 국가 분모 = 호스트 없는 인용 포함(도메인 목록·인용 화면 프롬프트 목록은 제외 유지). 현행 집계층 ⑤ 분모 = domains(total)"
        " (도메인 NULL 인용 포함, lib/summary/generate/context.ts:205-231·summary-global-aggregates.ts:858)",
        slot="core.measure.m05_den_col·citation_counts_sql(m05_den)",
        db="rd.answer.cit_n_all(DB-v2.15 P86, 적재기·seed-40 이 쓴다)"),
    "cit_hostless_per_row": SwitchSpec(
        "G21A", "WU-5", "projection",
        "호스트 없는 인용 = 인용 행 자신의 도메인이 없는 행(현행 scope_citations.domain NULL → 그룹 키 '' → 도메인 목록 제외·⑤ 분모 포함,"
        " citation-group-key.ts:57). 허브는 URL 단위 최빈 도메인(rd.dim_url)으로 출처를 붙여, 같은 URL 에 도메인 있는 행이 하나라도 있으면"
        " 도메인 없는 행도 그 출처로 셌다(stg 2026-10-01: 'https://...' 4행 중 3행이 도메인 NULL 인데 '..' 출처로 cit_n·도메인 목록에 들어감)",
        slot="ingest.project.apply 인용 판정(_ig_cr source_key, 적재기 활성 프로필)·seed-40 §6(psql 변수 cit_row_host)"),
    "web_owned_target_base": SwitchSpec(
        "OWN4", "WU-5", "projection",
        "웹사이트 자사(loc_owned) 의 '타겟 ⊂ 자사' 항 = 인용 base NORM(쿼리 제거) ∈ 유닛 타겟 base NORM 집합(현행 생성기 unitOwnedSql"
        " scripts/summary/surface-website.ts:244-256 t.turl_base = cn.nb, turl_base = citation_url_base_norm(target_url)). 허브는 tracked NORM"
        " (쿼리 보존) ∈ turls 라 'tucson.beijing-hyundai.com.cn/?media=cxzt' 처럼 쿼리가 붙은 타겟 호스트 인용을 자사에서 뺐다"
        "(OWN4: C08 beijing-hyundai.com.cn 881 대 877, stg 웹사이트 31행)",
        slot="ingest.project.apply 인용 판정(_ig_cr loc_owned website, 적재기 활성 프로필)·seed-40 §6(psql 변수 web_tgt_base)"),
    "trend_grid": SwitchSpec(
        "XAXIS_G·XAXIS_W", "WU-6", "read",
        "추이 x축 = 원장 자리 최신 13개(글로벌 KST 월요일·웹 KST 금요일), 완결성 0.9 갭, 끝쪽 미발행 절단",
        slot="core.cycles.resolve_recent_window + analytics/trend/series(DEFAULT_WINDOW·build_slots)"),
    "web_url_rate": SwitchSpec(
        "A2", "WU-7", "read",
        "웹사이트 URL 인용률 발행값 라우팅 = 현행 X.reportTruth(server.ts:5452-5518·truth-axes.ts:81-364): 폴백 축(엔진·출처·택소노미·커스텀)이면"
        " 라이브, 기간은 from = to 하루만 그 날짜 회차, 발행 사이트 선택 = 계정 스코프 권한 게이트(좁히지 않음)·브랜드는 발행물 어휘·국가·언어가"
        " 어휘 분기 유닛에 닿으면 라이브·헤드라인 풀. 라이브 값의 모수 단위(프롬프트, 기간 = 창 안 1회 이상 적중)는 허브 url_prompts 가 이미 같다",
        slot="core.measure.r09_reason·url_rates·report_publications(req = ReadContext.r09)"),
    "web_geo_answer_region": SwitchSpec(
        "GEOAX", "WU-7", "read",
        "웹사이트 국가 경쟁 축 = 현행 집계층 국가(surface-website.ts:302-305 COALESCE(ws.country_code, a.region): 사이트 국가, 사이트 없는"
        " 프롬프트만 답변 region). 14키 현행은 기간도 집계층 경로(S4.periodRoute)라 답변 region(미러 scope-aggregates.ts:7424)을 쓰지 않는다."
        " 보고서 유닛 모수(web_registered_only) 위에서는 허브 geo_key(사이트 국가) = 현행 국가(stg 2026-10-01 216,783/216,783 답변)라"
        " 조회 식은 바꾸지 않는다: 이 스위치는 web_registered_only 를 요구하는 표식이다(core.profile.REQUIRES)",
        slot="analytics/geo/markets(없음: web_registered_only 모수로 성립)"),
    "web_registered_only": SwitchSpec(
        "WEBREG16", "WU-7", "read",
        "웹 집계층 모수 = 보고서 유닛 소속 프롬프트만(summary-website-aggregates.ts:226-240·summary-trend-aggregates.ts:718-727: report_fs 있음"
        " ∧ 제외 유닛 아님). URL 인용률 프롬프트 단위(url_prompts)와 답변 분석(비카드) 요청은 게이트 없음: 카드 경로(MeasureScope.card = CommonFilters.card)에만 건다",
        slot="core.measure.mention_population·citation_population(website 표면, web_unit_pred)",
        db="app.website_report_unit·app.website_report_excluded·rd.web_report_prompt(DB-v2.16 P91~P93, 채우기 fill-v216.sql)"),
    "web_accuracy_flat": SwitchSpec(
        "CACC6", "WU-12", "read",
        "웹사이트 ⑥ 인용 정확도 = 현행 정의. 카드(card=true, 기간 없음)·추이: 분모 = 자사 인용 답변(유닛 모수), 분자 = 그중 같은 보고서 유닛"
        "(프로젝트 × report_fs) 프롬프트 전체의 타겟 URL 중 하나라도 인용한 답변(생성기 surface-website.ts:805-820 ut flat → summary_answers.unit_target,"
        " 리더 summary-website-aggregates.ts:1164-1180·1570-1585). 기간 카드(현행 cumulative = 미러)·비카드: 모수 = 비카드(유닛 게이트 없음·자리"
        " 대표 없음), 타겟 = 화면 사이트 전체 타겟 URL(언어 축 좁힘) 중 하나라도 인용, 분모 = 자사 ∨ 타겟(scope-aggregates.ts:8831-8849·8970-9010)."
        " 허브 기본(분자 = 자기 프롬프트 타겟 tgt_cited ∧ 자사)과 다른 것은 분자의 타겟 범위와 기간 카드의 모수다."
        " 카드 몫(유닛 플래그)은 S4 부터 동결 층의 생성 시점 셀 판정(frz.card_web)으로 센다: freeze_at_publish 를 요구한다(창에 세대 없는 회차가"
        " 있으면 현행처럼 요청 전체가 비카드 = 미러 정의)",
        slot="analytics/kpi/summary·trend/series(⑥ 정확도 문장 accuracy_counts_sql, 카드 몫 = 동결 읽기 frz.card_web)",
        db="rd.web_target_url(DB-v2.20 P111, 미러 정의 타겟 URL 사전 해석, 채우기 fill-v220.sql)"),
    "filter_options": SwitchSpec(
        "F1W4", "WU-8", "read",
        "웹사이트 국가·매트릭스·언어 옵션 = 등록 사이트(측정 창 무관), 엔진 옵션 = 기본 엔진 목록(정적), 글로벌 = 상태·지역 스코핑 무관 rd.job·기본 엔진",
        slot="analytics/filters/options service(build_legacy_global·build_legacy_website·default_engines)"),
    "compare_epoch_gate": SwitchSpec(
        "OLDNONE(F07)", "WU-9", "read",
        "기간 비교 Δ 적용일 게이트(cur.hi < 2026-09-08 이면 비교 안 함 = 현행 null·종전 Δ. 운영 DB period_compare_epoch 행 없음 = 상수)",
        slot="analytics/kpi/compare service(meta.suppressed['*'] before_epoch) + front adapters/compare(null)"),
    "compare_suppress": SwitchSpec(
        "OLDNONE(F07)", "WU-9", "read",
        "현행이 표현 못 하는 축(depth2·3, admin 다중 브랜드)의 Δ 를 '―' 로 억제(U4-N1, 전 지표 unsupported)",
        slot="analytics/kpi/compare service(legacy_unsupported_reason) → front adapters/compare(그대로 '―')"),
    "card_brand_cap": SwitchSpec(
        "BRANDCAP", "WU-12", "read",
        "대시보드 카드 경로(요청 card=true)의 브랜드 목록 = 집계층 브랜드 축 상위 200행(summary-trend-aggregates.ts:353 DEFAULT_LIMITS.brand,"
        " :1014-1022 row_number ORDER BY mentions DESC, brand_name, 당사 행 포함). 절단은 명부 제외(withExcludedBrands, 캐시 밖) 전이고 잘린 몫은"
        " 잔여 행이라 합계·brand_count 는 그대로. 언급 화면(S2.mention 은 14키 밖 = 미러)은 절단 없음 → card=false 요청은 그대로",
        slot="analytics/mentions/brands service(_card_kept: 경쟁 행 선택 모집단)"),
    "compare_cycle_set": SwitchSpec(
        "F07(WU-12)", "WU-12", "read",
        "기간 비교 Δ 창 회차 = 노출된 발행 회차 전부: 글로벌은 함대 가시성(fleet_visible) 무관이라 자리 병합으로 비서빙이 된 회차"
        "(08-10·08-17 자리의 둘째·셋째 회차)도 값·원장·첫 발행에 든다(현행 summary-period-compare.ts:218-236 ledgerScopeConds 는 웹사이트만"
        " fleet_visible, :300-324 buildCompareCycleSet = 발행 회차 전부, 자리 대표로 좁히지 않는다). 웹사이트는 servable 그대로",
        slot="analytics/kpi/compare service → core.cycles.resolve_window·ledger_rows·first_published(fleet_any)"),
    "freeze_at_publish": SwitchSpec(
        "GEN", "S3(동결 층, 결정 31·32)", "read",
        "대시보드 카드 경로(요청 card=true, core.card_routes) 값 = 발행(생성) 시점 동결 값: 회차 셀 대표(미러 시각)·생성 뒤 바뀐 답변은 옛 행·"
        "in_full_cycle 게이트(글로벌 추이 격자 제외)·동결 카탈로그 비트(현행 cycle.ts:271-301 세대 고정, swap.ts, trendWhere"
        " summary-trend-aggregates.ts:674-720). 스냅샷 카드는 최신 동결 회차(현행 픽의 active_generation_id IS NOT NULL, 없으면 미러)."
        " 기간·추이 창에 세대 없는 발행 회차(구멍)가 있으면 요청 전체를 비카드(현행 미러 폴백 cycle-set.ts:336-357·400-401)로 내린다(S4)."
        " 웹 보고 유닛 소속·⑥ 유닛 플래그·URL 인용률 job 플래그·택소노미 축(퍼널·목록·depth·존재)·브랜드 표시명도 생성 시점 값(S4)."
        " 현행이 사실표를 떠나는 그 밖의 사유(출처 필터·웹 같은 주 중복·plan·점 하나·빈 집계, URL 인용률 url_hits 미커버 = 그 2장만)도 경로별로 비카드(S4b,"
        " core.filters.FROZEN_ROUTES), 동결 읽기의 버림 판정은 동결 축, 개명 브랜드는 세대 이름별 행."
        " 동결 층은 S1 이관·S2 발행 생성기가 채운다",
        slot="core.facts.fact_tables(카드 뷰 frz.card_*·격자 뷰 frz.grid_*)·core.measure.catalog_all_pred(동결 카탈로그 비트)"
             "·unit_gate_of·accuracy_counts_sql(frz.card_web)·frozen_taxon_pred(frz.card_axis)·core.cycles(frz_judge 창 판정, card 스냅샷 후보)"
             "·core.filters.ReadContext.card_window·analytics/trend/series(격자 = ReadContext.frz_grid)·브랜드 표시명(frz.card_brand_name)",
        db="frz 스키마(DB-v2.21 보관 관문·리프 권한·DB-v2.22 발행 생성기·DB-v2.23 카드·격자 뷰·DB-v2.24 웹 셀 판정·택소노미 축·브랜드 표시명)"),
    "resub_phantom_exclude": SwitchSpec(
        "RESUB", "WU-3b", "projection",
        "답변 회차 = run 의 원장 멤버십(ing.cycle_run): 현행 앵커 표 cycle_id = summary_cycle_runs(0078 refresh_answer_cycle_anchors run_ctx"
        " :821-845, run 수준 값)이고 사실표 생성기도 멤버 run 만 읽는다(lib/summary/generate/cycle.ts:316-323). 허브 코호트 규칙(pin → 원장"
        " 선택, 0078 결함 B 순위)은 앵커 날짜(anchor_src)에만 남는다. 원장 이관 회차 좌석 = 현행 사실표 자리(앵커 표 min(round_date) by cycle_id,"
        " anchor-axis.ts:254-266). stg hmg_r2 2026-10-01: 재제출 39건 → 원장 09-17 유령 회차 935~940(미발행, 좌석 09-18), pin 13,814건 →"
        " 원장 08-01·08-02 회차 315~338(발행·함대 노출, 좌석 07-24). 예외: 운영자 pin(origin 'operator')이 회차로 풀린 코호트는 hub pin 규칙",
        slot="투영: ingest.project.apply queries.runc_sql(적재기 활성 프로필)·seed-40 §2b(psql 변수 attrib_member)·seed-20 §7-3 좌석 이관"
             "(psql 변수 attrib_member)·back/migration/reproject-attrib-member.py(적재된 DB 1회 재투영)"),
    "domains_card_by_host": SwitchSpec(
        "F04 도메인 접기", "WU-12", "read",
        "대시보드 카드 경로(card=true)의 도메인 목록 = 도메인(호스트) 단위: 공식 소셜 계정 그룹 키(facebook.com/HyundaiMotorGroupTV 등)를 그 도메인"
        " 행에 합친다. 현행 카드 집계(summary-global-aggregates.ts:827-837 toStandardAggregates domains, summary-website-aggregates.ts:557·727)는"
        " summary_trend_domains 의 axis 'domain'(GROUP BY domain)을 읽고, 인용 화면 도메인 표(summary-citation-read.ts:172)만 axis 'group'(그룹 키)이다."
        " 허브는 출처 그룹 키(rd.dim_source.skey) 단위라 C01 facebook.com 2,567(구 2,570)·C04 youtube.com 5,838(구 5,839)로 갈렸다",
        slot="analytics/citations/domains queries.domains_sql·_totals_sql(card 요청이면 출처 키를 도메인 대표 출처 키로 접는다)"),
    "brand_card_fold": SwitchSpec(
        "G01CF", "be/int3-smartfold", "freeze",
        "동결 층(카드·추이 격자) answer_brand = 운영 summary 세부층 접기: 언급을 (답변, 롤업 id, 표시명)으로 묶어 is_competitor = 그룹 bool_or(언급 행 pass),"
        " 언급 = 그룹 전 언급 합, first_rank = 그룹 전 언급 min(avg_position)(비경쟁 언급 포함), 순위 = 경쟁 행만 표시명 단위 min(first_rank) 의 rank()"
        "(2670a16 load.ts:78-98·context.ts:143-144·fold.ts:319-323·492-509). 카드 점유율 분모(답변 ment_total)·당사 언급도 접힌 경쟁 행에서 낸다"
        "(summary-global-aggregates.ts:524-530·fold.ts:752-765 comp_mentions). rd·미러 화면은 그대로(언급 행 단위 비경쟁 제외): 같은 답변·같은 표시"
        " 브랜드에 경쟁·비경쟁 행이 공존하고 접기 결과가 rd 와 다른 답변만 동결 세대에 보관 출처 'fold' 로 보관한다(ingest.frz.fold, DB-v2.27 frz.keep_fold)."
        " 2026-10-02 stg frz 이관 드라이런 924 회차 중 글로벌 3 회차 실패(Smart: bare-only 비경쟁 Brand + 경쟁 Product Smart Fortwo)",
        slot="ingest.frz.fold(공존 답변 접기, 적재기 stage 재사용) ← ingest.frz.freeze(S2 발행·재생성)·ingest.frz.ops_import(S1 이관, 단언 all_mentions 보정·comp_mentions)",
        db="frz.kept src 'fold'·frz.keep_fold(int4, jsonb)(DB-v2.27 P141~P143), 선택 입력 mig_src.frz_ops_sum_comp(운영 comp_mentions)"),
}

# 구현이 끝난 스위치(WU 가 채운 뒤 여기에 넣는다). 여기 없는 스위치를 켜면 설정 적재가 실패한다.
IMPLEMENTED: frozenset[str] = frozenset({
    "compare_epoch_gate", "compare_suppress",       # WU-9(analytics.kpi.compare, 2026-10-01)
    "compare_cycle_set",                            # WU-12(analytics.kpi.compare 창 회차 = 글로벌 함대 가시성 무관, 2026-10-01)
    "trend_grid",                                   # WU-6(core.cycles.resolve_trend_grid + analytics.trend.series, 2026-10-01)
    "cell_rep", "rep_pick_latest_first", "acr_iter_unfolded", "gap_in_population",   # WU-2(core.measure 모수 + 적재 대표, 2026-10-01)
    "catalog_incl_deleted", "display_name_latin", "brand_exposure_per_alias",         # WU-4(A41·NAME·G20, 2026-10-01)
    "filter_options",                               # WU-8(analytics.filters.options, 2026-10-01)
    "card_slot_rep", "summary_all_engines",         # WU-3(core.cycles.resolve_window(card)·core.measure.scope_where(card), 2026-10-01)
    "web_url_rate", "web_geo_answer_region", "web_registered_only",                   # WU-7(A2·GEOAX·WEBREG16, 2026-10-01)
    "resub_phantom_exclude",                        # WU-3b(ingest.project.apply runc_sql·seed-40 §2b·seed-20 §7-3 좌석, 2026-10-01)
    "m05_den_hostless", "cit_hostless_per_row", "web_owned_target_base",   # WU-5(G21A·OWN4: core.measure ⑤ 분모 + 적재 인용 판정, 2026-10-01)
    "rep_round_date_cell",                          # WU-12(is_rep = 답변분석 경로 규칙 + 인용 계열 보정, DB-v2.19 P109~P110, 2026-10-01)
    "card_brand_cap",                               # WU-12(analytics.mentions.brands 카드 경로 브랜드 200 상한, 2026-10-01)
    "domains_card_by_host",                         # WU-12(analytics.citations.domains 카드 경로 도메인 접기, 2026-10-01)
    "web_accuracy_flat",                            # WU-12(CACC6: 웹 ⑥ 인용 정확도 분자·기간 카드 모수, 2026-10-01)
    "freeze_at_publish",                            # S3(동결 층 카드 읽기 치환, DB-v2.21~v2.23, 2026-10-01)
    "brand_card_fold",                              # be/int3-smartfold(동결 층 answer_brand = 운영 summary 접기, DB-v2.27, 2026-10-02)
})

# 함께 켜야 하는 스위치(키가 켜지면 값의 스위치도 켜져 있어야 한다). 해석 규칙(parse_profile)과 LegacyProfile 생성 둘 다 검사한다.
REQUIRES: dict[str, tuple[str, ...]] = {
    "acr_iter_unfolded": ("cell_rep",),
    "gap_in_population": ("cell_rep",),
    "web_geo_answer_region": ("web_registered_only",),
    # 답변분석 is_rep(rd.answer.is_rep = 답변분석 셀 규칙) 위에서 카드 경로가 회차 셀 대표(현행 집계층 셀)를 읽으려면 동결 층이 셀 집합을 쥐어야 한다
    "rep_round_date_cell": ("rep_pick_latest_first", "freeze_at_publish"),
    # 동결 카드 뷰는 셀 대표 1건만 담고(cell_rep 모수와 같은 뜻), 글로벌 카탈로그 판정은 동결 비트(삭제 행 포함 = A41 정의) 하나다
    # 동결 웹 카드 모수 = 생성 시점 보고 유닛 소속(현행 summary_answers.report_fs 게이트): 유닛 게이트 자리(WEBREG16)가 켜져 있어야 건다(S4)
    "freeze_at_publish": ("cell_rep", "catalog_incl_deleted", "web_registered_only"),
    # ⑥ 카드 몫(카드·기간 없음 = 집계층 유닛 플래그)은 동결 층이 맡는다(S4: frz.card_web unit_owned·unit_target). 기간 카드·비카드(미러 정의)만 이 스위치의 자리
    "web_accuracy_flat": ("web_registered_only", "freeze_at_publish"),
    # 접기는 동결 층에만 둔다(rd·미러 화면 그대로): 동결 읽기가 켜져 있어야 의미가 있고, 접기 키(표시명)는 NAME 규칙의 브랜드 키다
    "brand_card_fold": ("freeze_at_publish", "display_name_latin"),
}

# 설정(HGH_LEGACY_PROFILE)이 없을 때의 프로필. 결정 19·23~25 의 최종값은 "current" 이지만 스위치가 전부 구현될 때까지는 "off".
DEFAULT_SPEC = "off"


@dataclass(frozen=True)
class LegacyProfile:
    """정의별 스위치 값. 기본(전부 False) = 새 백엔드 정의(현 동작). 필드 순서·이름 = SWITCHES."""
    cell_rep: bool = False
    rep_pick_latest_first: bool = False
    rep_round_date_cell: bool = False
    acr_iter_unfolded: bool = False
    gap_in_population: bool = False
    card_slot_rep: bool = False
    summary_all_engines: bool = False
    catalog_incl_deleted: bool = False
    display_name_latin: bool = False
    brand_exposure_per_alias: bool = False
    m05_den_hostless: bool = False
    cit_hostless_per_row: bool = False
    web_owned_target_base: bool = False
    trend_grid: bool = False
    web_url_rate: bool = False
    web_geo_answer_region: bool = False
    web_registered_only: bool = False
    web_accuracy_flat: bool = False
    filter_options: bool = False
    compare_epoch_gate: bool = False
    compare_suppress: bool = False
    card_brand_cap: bool = False
    compare_cycle_set: bool = False
    freeze_at_publish: bool = False
    resub_phantom_exclude: bool = False
    domains_card_by_host: bool = False
    brand_card_fold: bool = False

    def __post_init__(self) -> None:
        for name, needs in REQUIRES.items():
            if getattr(self, name):
                miss = [n for n in needs if not getattr(self, n)]
                if miss:
                    raise ValueError(f"현행 프로필 스위치 {name} 은 {', '.join(miss)} 이 함께 켜져야 한다(core.profile.REQUIRES)")
        # A41 + A1: 셀 대표(is_rep)를 모수로 읽을 때 삭제 포함 카탈로그가 통하려면 대표가 카탈로그 무관(elig_nc)으로 골라져 있어야 한다.
        # 그 규칙은 현행 대표 규칙(rep_pick_latest_first, 현행 선정은 카탈로그를 보지 않는다)뿐이다: hub 규칙(elig 후보)은 전부 삭제된 프롬프트의
        # 셀에 대표를 두지 않아 A41 이 조용히 빠진다(WU-4 병합, 2026-10-01).
        if self.catalog_incl_deleted and self.cell_rep and not self.rep_pick_latest_first:
            raise ValueError("현행 프로필 스위치 catalog_incl_deleted 와 cell_rep 을 함께 켜면 rep_pick_latest_first 도 켜져야 한다"
                             "(셀 대표가 카탈로그 무관 elig_nc 로 골라져야 삭제된 카탈로그 프롬프트의 셀이 남는다)")

    @property
    def on(self) -> tuple[str, ...]:
        """켜진 스위치 이름(SWITCHES 순서)."""
        return tuple(f.name for f in fields(self) if getattr(self, f.name))

    @property
    def is_off(self) -> bool:
        return not self.on

    @property
    def spec(self) -> str:
        """정규 표기: 'off' | 'current'(전부) | 켜진 이름 쉼표 목록(SWITCHES 순서)."""
        on = self.on
        if not on:
            return "off"
        if len(on) == len(SWITCHES):
            return "current"
        return ",".join(on)

    @property
    def fingerprint(self) -> str:
        """결과 캐시 키용 지문(정규 표기의 sha256 앞 12자). OFF 는 캐시 키에 넣지 않는다(core.result_cache.build_id)."""
        return hashlib.sha256(self.spec.encode("utf-8")).hexdigest()[:12]


OFF = LegacyProfile()
CURRENT = LegacyProfile(**{name: True for name in SWITCHES})


def parse_profile(raw: str | None, *, require_implemented: bool = True) -> LegacyProfile:
    """'off'(기본·빈 값) | 'current' | 스위치 이름 쉼표 목록. 모르는 이름은 ValueError.
    require_implemented=True(설정 적재 경로)면 IMPLEMENTED 밖 스위치가 켜질 때 ValueError(구현 전 스위치를 운영에서 켜지 못하게).
    시험·WU 빌더는 require_implemented=False 로 만들어 자기 자리를 시험한다."""
    s = (raw or "").strip().lower()
    if s in ("", "off"):
        return OFF
    names = list(SWITCHES) if s == "current" else [x.strip() for x in s.split(",") if x.strip()]
    unknown = sorted(set(names) - set(SWITCHES))
    if unknown:
        raise ValueError(f"HGH_LEGACY_PROFILE 에 모르는 스위치: {unknown}(허용: off | current | {', '.join(SWITCHES)})")
    prof = LegacyProfile(**{n: True for n in names})
    if require_implemented:
        missing = [n for n in prof.on if n not in IMPLEMENTED]
        if missing:
            raise ValueError("HGH_LEGACY_PROFILE: 아직 구현되지 않은 스위치는 켤 수 없다: "
                             + ", ".join(f"{n}({SWITCHES[n].wu})" for n in missing))
    return prof


@lru_cache(maxsize=16)
def _parsed(spec: str) -> LegacyProfile:
    return parse_profile(spec, require_implemented=False)


def active_profile() -> LegacyProfile:
    """프로세스 활성 프로필(설정 HGH_LEGACY_PROFILE, 없으면 DEFAULT_SPEC). 설정 적재 때 이미 검증됐다(core.config.load_settings)."""
    from app.core.config import get_settings

    return _parsed(get_settings().legacy_profile)


# NAME(display_name_latin): 운영 hmg-geo DB(Supabase PG 17.6)의 기본 콜레이션 = ICU en-US(2026-10-01 pg_database 실측: datlocprovider 'i',
# datlocale 'en-US'). 현행 ROLLUP_NAMES 의 ORDER BY brand 는 이 콜레이션으로 돈다. hub stg(RDS)는 libc en_US.UTF-8 이라 순서가 다르다
# ('KGM' < 'KG모빌리티': 운영 참, stg 거짓). ICU 미리 정의 콜레이션 이름은 PG 가 initdb 때 만든다(ICU 빌드 필수, RDS·postgres:17 이미지 포함).
LEGACY_NAME_COLLATION = "en-US-x-icu"


def name_collation(profile: LegacyProfile) -> str:
    """롤업 대표 표기 정렬의 콜레이션 절(적재 SQL 에 그대로 붙인다). display_name_latin 이면 ' COLLATE "en-US-x-icu"', 아니면 빈 문자열(DB 기본)."""
    return f' COLLATE "{LEGACY_NAME_COLLATION}"' if profile.display_name_latin else ""


def require_slot(profile: LegacyProfile, *names: str) -> None:
    """core 빌더의 스위치 자리 표식. 이 자리에 걸린 스위치가 켜졌는데 아직 구현되지 않았으면(IMPLEMENTED 밖) NotImplementedError.
    설정 경로는 parse_profile 이 먼저 막으므로, 여기는 코드가 직접 만든 프로필(시험·대조 러너)이 조용히 옛 정의로 도는 것을 막는 2차 방어다.
    WU 가 자리를 채울 때: 그 스위치 분기를 이 호출 뒤에 쓰고 IMPLEMENTED 에 이름을 넣는다."""
    for n in names:
        if n not in SWITCHES:
            raise ValueError(f"모르는 스위치 자리: {n}")
        if getattr(profile, n) and n not in IMPLEMENTED:
            raise NotImplementedError(f"현행 프로필 스위치 {n}({SWITCHES[n].tag})는 {SWITCHES[n].wu} 가 채울 자리다(아직 구현 안 됨)")
