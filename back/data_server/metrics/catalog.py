"""Every KPI formula the BFF owns: SSOT service/metric-definitions.md's 19 metrics and 7 common conditions, then the
values the screens show beyond them. docs/ssot-staging/service/metric-definitions.md is rendered from this file
(data_server.metrics.render_definitions)."""
from __future__ import annotations

from dataclasses import dataclass

#: Stored with every precomputed (Gold) and cached value. A definition change moves it.
DEFINITION_VERSION = "2026-11-07.3"

# Populations (SSOT 공통 조건)
MONITORING = "monitoring"                 # 모니터링 답변
REPRESENTATIVE = "representative"         # 대표 답변
CITATION_MONITORING = "citation_monitoring"  # 인용 모니터링 답변
URL_MEASURED = "url_measured"             # website 측정 답변 · 프롬프트
ACR_REPETITION = "acr_repetition"         # ACR 셀 · 반복

POPULATIONS = {
    MONITORING: "모니터링 답변: 집계 자격이 있고 분석이 빠지지 않은 답변. ACR 측정은 셀마다 최신 반복 1회만 넣는다",
    REPRESENTATIVE: "대표 답변: 모니터링 답변 중 회차(cycle) · 프롬프트 · 엔진 · 국가 · 언어 조합마다 측정 시각이 가장 늦은 1건. 그 답변이 집계 자격이 없으면 그 조합에는 없다(레거시 규칙)",
    CITATION_MONITORING: "인용 모니터링 답변: 모니터링 답변과 같되 분석이 빠진 답변도 넣는다",
    URL_MEASURED: "website 측정 답변: 사이트에 등록된 프롬프트의 대표 답변. 프롬프트 단위 값은 그 프롬프트 수로 센다",
    ACR_REPETITION: "ACR 측정: 셀 = 프롬프트 × 엔진 × 국가, 반복 = 같은 셀을 여러 번 물은 것",
}

#: SSOT's seven common conditions, as this code applies them.
COMMON_CONDITIONS = (
    ("모니터링 답변", POPULATIONS[MONITORING].split(": ", 1)[1]),
    ("인용 모니터링 답변", POPULATIONS[CITATION_MONITORING].split(": ", 1)[1]),
    ("대표 답변", POPULATIONS[REPRESENTATIVE].split(": ", 1)[1]),
    ("당사", "계정 관점의 자사 브랜드 합. 기본은 Hyundai + Kia + Genesis. 여러 브랜드면 브랜드 값을 더하지 않고 답변마다 판정한다"
           "(노출 = 어느 한 브랜드 언급, 순위 = 가장 앞선 브랜드)"),
    ("회차", "수집이 시작된 날짜로 구분한다. 주 1회"),
    ("Δ", "값이 있는 직전 회차 대비 차(비율은 pp). 기간을 고르면 바로 앞 같은 길이 기간 대비. 반올림 전 값으로 뺀다"),
    ("권역 값", "권역 안 국가의 분자 · 분모를 더해 다시 계산한다"),
)

TYPES = ("mention", "recommendation", "comparison", "definition", "final_choice")
TYPE_NAMES = {"mention": "단순 언급", "recommendation": "추천", "comparison": "비교", "definition": "정의", "final_choice": "최종 선택"}
SENTIMENTS = {"s_pos": "긍정", "s_neu": "중립", "s_neg": "부정", "s_mix": "혼합"}

#: Base counts: what a data source adapter counts. key -> (단위, 뜻, 어댑터 ① gold_db 대응)
BASE_COUNTS: dict[str, tuple[str, str, str]] = {
    # answers (answer_counts)
    "answers": ("답변", "모수 답변 수", "answer_fact 행 수"),
    "tracked": ("답변", "당사 브랜드가 1회 이상 언급된 답변", "answer_brand_fact 관점의 당사 행이 있는 답변"),
    "own_mentions": ("언급", "당사 언급 횟수", "answer_brand_fact 당사 행 Σmention_count"),
    "total_mentions": ("언급", "전체 브랜드 언급 횟수", "answer_brand_fact 경쟁 브랜드 행 Σmention_count"),
    "sent_pos": ("언급", "당사 언급의 긍정 감성", "answer_brand_fact 당사 행 Σs_pos"),
    "sent_neg": ("언급", "당사 언급의 부정 감성", "answer_brand_fact 당사 행 Σs_neg"),
    "sent_all": ("언급", "당사 언급의 전체 감성(긍정 · 중립 · 부정 · 혼합)", "answer_brand_fact 당사 행 Σ(s_pos + s_neu + s_neg + s_mix)"),
    "rank_sum": ("순위", "당사 언급 순위 합. 순위 = 당사보다 먼저 언급된 경쟁 브랜드 수 + 1", "답변별 당사 행 first_pos 중 0 아닌 최솟값의 합"),
    "ranked": ("답변", "언급 순위가 있는 당사 답변", "그 최솟값이 있는 답변"),
    "top1": ("답변", "당사 언급 순위가 1인 답변", "그 최솟값 = 1"),
    "top3": ("답변", "당사 언급 순위가 3 이하인 답변", "그 최솟값 ≤ 3"),
    "rk_sum": ("순위", "대조용: 업스트림 경쟁 순위 합", "답변별 당사 행 rk 중 0 아닌 최솟값의 합"),
    "rk_count": ("답변", "대조용: 업스트림 경쟁 순위가 있는 답변", "그 rk 최솟값이 있는 답변"),
    "multi_answers": ("답변", "당사 언급이 2회 이상인 답변", "답변별 당사 행 Σmention_count ≥ 2"),
    "multi_mentions": ("언급", "그 답변들의 당사 언급 횟수", "같은 조건의 Σmention_count"),
    "measured_prompts": ("프롬프트", "측정된 고유 프롬프트", "count(DISTINCT prompt_key)"),
    "mentioned_prompts": ("프롬프트", "당사가 언급된 고유 프롬프트", "tracked 답변의 count(DISTINCT prompt_key)"),
    # the own brands' rows (own_brand_counts); t_<type> answers count an answer once
    **{f"t_{t}": ("답변", f"'{TYPE_NAMES[t]}' 유형으로 당사가 나온 답변", f"answer_brand_fact 당사 행 t_{t} > 0의 고유 답변") for t in TYPES},
    **{f"signals_{t}": ("언급", f"당사 언급의 '{TYPE_NAMES[t]}' 유형 신호 수", f"answer_brand_fact 당사 행 Σt_{t}") for t in TYPES},
    **{k: ("언급", f"당사 언급의 {v} 감성", f"answer_brand_fact 당사 행 Σ{k}") for k, v in SENTIMENTS.items()},
    # a brand's row (brand_counts)
    "brand_mentions": ("언급", "그 브랜드 언급 횟수", "answer_brand_fact Σmention_count, 비경쟁 사전 밖"),
    "brand_answers": ("답변", "그 브랜드가 나온 답변", "answer_brand_fact 행 수, 비경쟁 사전 밖"),
    "brand_prompts": ("프롬프트", "그 브랜드가 언급된 고유 프롬프트", "count(DISTINCT prompt_key)"),
    "top_rival_mentions": ("언급", "언급 1위 경쟁사의 언급 횟수(당사 · HMG 형제 브랜드 · 명부 제외 브랜드 제외)", "brand_mentions의 최댓값"),
    # citations (citation_counts, category_counts, source_counts)
    "base_answers": ("답변", "인용 모니터링 답변", "answer_fact, 인용 모니터링 규칙"),
    "gap_answers": ("답변", "분석이 빠진 답변", "그중 analysis_state ≥ 2"),
    "citations": ("인용", "전체 출처 인용 횟수(호스트 있는 인용)", "citation_fact source_key ≠ 0 행 수"),
    "citations_all": ("인용", "호스트 없는 인용까지 센 횟수", "citation_fact 행 수"),
    "official": ("인용", "출처 카테고리 공식 (HMG) 인용", "citation_fact × dim_source 카테고리 공식 (HMG) 행 수"),
    "owned": ("인용", "자사 URL 인용. website · project = 등록한 소유 URL · 대표 주소의 오리진에 속한 모든 URL, 아직 등록하지 않은 project = 추출 표시, global = 관점의 소유 베이스", "등록 URL 규칙(미등록 project loc_owned) · global owner_key"),
    "target": ("인용", "타겟 URL 인용. website = 프롬프트에 지정한 URL, project = 등록한 추적 URL과 그 하위, 아직 등록하지 않은 project와 global = 추출 표시", "프롬프트 target_url · 추적 URL 규칙(미등록 tgt_hit)"),
    "category_citations": ("인용", "그 출처 카테고리 인용", "citation_fact × dim_source.category_key(조회 시점 값)"),
    "source_citations": ("인용", "그 출처 인용", "citation_fact 행 수"),
    "source_answers": ("답변", "그 출처를 인용한 답변", "count(DISTINCT answer_key)"),
    "source_prompts": ("프롬프트", "그 출처를 인용한 프롬프트", "count(DISTINCT prompt_key)"),
    "cited_prompts": ("프롬프트", "호스트 있는 인용이 1건 이상인 프롬프트", "citation_fact source_key ≠ 0"),
    "own_cited_prompts": ("프롬프트", "자사 URL이 1회 이상 인용된 프롬프트", "citation_fact 자사 판정"),
    "uncited_prompts": ("프롬프트", "인용은 있지만 자사 URL 인용이 없는 프롬프트", "cited_prompts − own_cited_prompts"),
    # the website's URL measures (url_counts)
    "url_prompts": ("프롬프트", "측정 프롬프트", "dim_prompt web_reg인 answer_fact의 고유 prompt_key"),
    "url_own_prompts": ("프롬프트", "자사 URL이 1회 이상 인용된 프롬프트", "자사 URL 인용 행이 있는 답변의 고유 prompt_key"),
    "url_target_prompts": ("프롬프트", "그 프롬프트에 지정한 타겟 URL이 인용된 프롬프트", "타겟 URL 인용 행이 있는 답변의 고유 prompt_key"),
    "url_own_answers": ("답변", "당사 도메인이 인용된 답변", "대표 답변 중 자사 URL 또는 타겟 인용 행이 있는 답변"),
    "url_target_answers": ("답변", "당사 타깃 도메인이 인용된 답변", "그중 타겟 URL 인용 행이 있는 답변"),
    # ACR (acr_totals, acr_brand_counts, acr_model_counts, acr_duel_counts)
    "cells": ("셀", "전체 셀", "acr_cell_fact 행 수, acr_in"),
    "iterations": ("반복", "전체 반복", "Σvalid_acr, acr_in"),
    "acr_prompts": ("프롬프트", "측정 프롬프트", "count(DISTINCT prompt_key)"),
    "choice": ("반복", "브랜드가 최종 1순위로 선택된 횟수", "acr_entity_fact level 1 Σchoice, keep"),
    "appearance": ("언급", "후보 언급 횟수", "acr_entity_fact level 1 Σappearance, keep"),
    "appeared_cells": ("셀", "브랜드가 후보로 1회 이상 나온 셀", "appearance ≠ 0의 고유 셀"),
    "model_choice": ("반복", "후보군에 오른 차종이 최종 선택된 횟수", "acr_entity_fact level 2 Σchoice"),
    "model_iterations": ("반복", "그 차종이 후보로 나온 셀의 반복 합", "level 2 appearance ≠ 0 셀의 Σvalid_acr"),
    "duel_iterations": ("반복", "당사 · 경쟁사가 함께 후보에 오른 반복", "acr_iter_shortlist level 1"),
    "own_wins": ("반복", "그중 당사가 선택된 횟수", "acr_iter_fact winner_brand_key"),
    "rival_wins": ("반복", "그중 경쟁사가 선택된 횟수", "acr_iter_fact winner_brand_key"),
}


@dataclass(frozen=True)
class Metric:
    key: str
    name: str             # the screen's name (legacy KPI name where one exists)
    family: str           # 언급 · 인용 · ACR · 측정 · AI 가시성 · 고객 관심
    kind: str             # rate (num ÷ den, %) · avg (num ÷ den, a position) · multiple (N배) · count · derived
    num: str              # base count key, or the formula in words for a derived value
    den: str = ""         # base count key
    population: str = ""
    higher_is_better: bool = True
    ssot: bool = False    # one of SSOT's 19
    gold: bool = True     # shown on an unfiltered first screen: precomputed
    dims: tuple[str, ...] = ("전체", "회차")
    screens: str = ""
    note: str = ""
    review: str = ""      # how it differs from what the screens read today; '분석팀 리뷰 필요' when set
    needs: str = ""       # a base count that must not be zero: without it the round has no value at all (no text order before 2026-09-07)


_MARKET = ("전체", "회차", "엔진", "국가", "권역")
_BRAND = (*_MARKET, "브랜드")
_OUTSIDE = "서비스 수집값(gold_db의 analytics 스키마). Silver 밖"

METRICS: tuple[Metric, ...] = (
    # ── 언급: SSOT ──
    Metric("exposure", "AI 노출률", "언급", "rate", "tracked", "answers", REPRESENTATIVE, ssot=True, dims=_BRAND,
           screens="Overview · Mention · Website · Project", note="경쟁사 값은 brand_answers ÷ answers",
           review="이전 Mention 화면은 모니터링 답변으로 셌다(2026-10-05 34,452/44,979 = 76.60%). SSOT 분모는 대표 답변(34,255/44,740 = 76.56%). 반복 측정이 많은 Project는 차이가 크다(예: 591/809 = 73.1% → 129/162 = 79.6%)"),
    Metric("share", "AI 점유율", "언급", "rate", "own_mentions", "total_mentions", MONITORING, ssot=True, dims=_BRAND,
           screens="Overview · Mention · Website · Project", note="한 답변 안 여러 번 언급 포함. 경쟁사 값은 brand_mentions ÷ total_mentions",
           review="이전 화면은 Overview 카드 38.91%(대표 답변) · Mention 38.72%(ACR 셀당 여러 답변)로 달랐다. SSOT 공통 조건의 모니터링 답변(ACR 셀당 1건)이면 323,266/830,518 = 38.92%"),
    Metric("favorability", "AI 우호도", "언급", "rate", "sent_pos", "sent_all", MONITORING, ssot=True, dims=_BRAND,
           screens="Overview · Mention · Website · Project", note="언급 단위",
           review="이전 화면은 Overview 카드 53.95% · Mention 54.12%로 달랐다. SSOT 공통 조건의 모니터링 답변이면 174,341/323,266 = 53.93%"),
    Metric("priority", "AI 우선 노출도", "언급", "avg", "rank_sum", "ranked", MONITORING, higher_is_better=False, ssot=True, dims=_BRAND,
           screens="Overview · Mention · Website · Project", note="순위 = 당사보다 먼저 언급된 경쟁 브랜드 수 + 1. 비경쟁 · 노이즈 브랜드는 뺀다. 낮을수록 앞",
           review="화면은 지금 업스트림 경쟁 순위(rk)로 센다(Overview 2.345 · Mention 2.353). SSOT 문구는 먼저 언급된 경쟁 브랜드 수 + 1(텍스트 순서, 76,706/34,273 = 2.238). rk는 텍스트 순서와 55%만 같고 동순위가 있다. gold_db는 global 2026-09-07 · website 2026-09-11 이전 회차에 텍스트 순서 값이 없어 그 회차는 빈칸이다"),
    Metric("top3_rate", "Top 3 노출 비율", "언급", "rate", "top3", "tracked", MONITORING, ssot=True, dims=_BRAND, needs="ranked",
           screens="레거시 Overview · Mention", note="순위는 AI 우선 노출도와 같다",
           review="이전 화면은 rk 기준(대표 답변 79.7%). SSOT 순위 · 모니터링 답변 기준이면 27,619/34,274 = 80.58%. 텍스트 순서가 없는 회차는 빈칸"),
    *(Metric(f"type_exposure_{t}", f"멘션 유형별 노출 · {TYPE_NAMES[t]}", "언급", "rate", f"t_{t}", "answers", MONITORING, ssot=True, dims=_MARKET,
             screens="Mention · Website Mention") for t in TYPES),
    Metric("competitor_sov", "경쟁사 대비 SOV", "언급", "multiple", "own_mentions", "top_rival_mentions", MONITORING, ssot=True, dims=("전체",),
           screens="Website Overview", note="N배로 표시(vs 언급 1위 경쟁사)"),
    # ── 언급: SSOT 밖의 화면 값 ──
    Metric("negative_rate", "부정 비율", "언급", "rate", "sent_neg", "sent_all", MONITORING, higher_is_better=False, dims=_MARKET, screens="Mention"),
    *(Metric(f"sentiment_{k}", f"감정 분포 · {v}", "언급", "rate", k, "sent_all", MONITORING, dims=("전체",), screens="Mention") for k, v in SENTIMENTS.items()),
    Metric("type_favorability", "유형별 긍정 비율", "언급", "derived", "그 유형 신호가 붙은 당사 행의 긍정 ÷ 그 행들의 감성 합", dims=("전체", "유형"), screens="Mention"),
    Metric("type_share", "유형 안 점유율", "언급", "derived", "그 유형 신호 중 브랜드 몫 = 브랜드 Σt ÷ 전체 브랜드 Σt", dims=("전체", "유형", "브랜드"), screens="Mention"),
    Metric("top1_rate", "1위 답변 비율", "언급", "rate", "top1", "tracked", MONITORING, dims=_MARKET, needs="ranked", screens="레거시 Overview · Mention", review="Top 3 노출 비율과 같은 순위 차이"),
    Metric("multi_answers", "복수 언급 답변", "언급", "count", "multi_answers", population=MONITORING, dims=_BRAND, screens="레거시 Mention"),
    Metric("brand_mentions", "브랜드 언급 수", "언급", "count", "brand_mentions", population=MONITORING, dims=("전체", "회차", "브랜드"), screens="Mention"),
    Metric("mention_rank", "회차별 언급 순위", "언급", "derived", "회차마다 언급 수 내림차순 순위", dims=("회차", "브랜드"), screens="Mention"),
    Metric("mentioned_prompts", "언급 프롬프트", "언급", "count", "brand_prompts", population=MONITORING, dims=("전체", "브랜드"), screens="Mention"),
    Metric("parent_group_share", "모그룹 묶음 언급 · 비중", "언급", "derived", "브랜드 언급을 모그룹으로 더한 값 ÷ total_mentions", dims=("전체",), screens="Mention", note="표시용 그룹핑"),
    Metric("standing", "순위 칩(N개 브랜드 중 M위)", "언급", "derived", "지표 값 순서에서 당사 자리, 비교 대상 브랜드 수", dims=("전체",), screens="Overview · Mention"),
    Metric("gap", "격차", "언급", "derived", "당사 − 비교 브랜드(우선 노출도는 비교 브랜드 − 당사, + = 당사가 앞섬)", dims=("회차",), screens="Mention"),
    Metric("engine_consistency", "엔진 간 일관성", "언급", "derived", "엔진별 값의 최솟값 ÷ 최댓값", dims=("전체",), screens="Website Overview"),
    Metric("branded_split", "브랜드 포함 · 미포함 질문 값", "언급", "derived", "같은 지표를 브랜드 포함 여부 필터로 다시 센 값", dims=("전체",), screens="Mention · Overview 시장별"),
    Metric("total_mentions", "전체 언급 수", "언급", "count", "total_mentions", population=MONITORING, dims=_MARKET, screens="레거시 · Website Mention"),
    Metric("positive_mentions", "긍정 키워드 언급 수", "언급", "count", "sent_pos", population=MONITORING, dims=_MARKET, screens="레거시 · Website Mention"),
    Metric("negative_mentions", "부정 키워드 언급 수", "언급", "count", "sent_neg", population=MONITORING, dims=_MARKET, screens="레거시 · Website Mention"),
    Metric("mentions_per_answer", "답변당 언급 수", "언급", "avg", "own_mentions", "answers", MONITORING, dims=("전체",), screens="레거시 기간 비교", note="증감률로 표시"),
    Metric("brand_count", "언급 브랜드 수", "언급", "derived", "경쟁 브랜드 행 수 + 당사 1행 + 명부 제외 브랜드 행 수", dims=("전체",), screens="레거시 · Website Mention · Mention"),
    Metric("unmentioned_prompts", "미언급 프롬프트 수", "언급", "derived", "measured_prompts − mentioned_prompts", dims=("전체",), screens="레거시 · Website Mention"),
    Metric("unmentioned_split", "다른 브랜드 언급 · 브랜드 언급 없음 · 일부 엔진만 빠짐", "언급", "derived", "미언급 프롬프트를 전체 언급 유무로 나눈 수, 측정 엔진보다 언급 엔진이 적은 프롬프트 수", dims=("전체",), screens="Website Mention"),
    Metric("market_gaps", "브랜드 언급 없는 답변 · 언급 답변 변화", "언급", "derived", "국가별 전체 언급이 0인 모니터링 답변 수, tracked의 Δ", dims=("국가",), screens="Website Mention"),
    Metric("multi_rate", "복수 언급률 · 복수 언급 점유율 · 프롬프트", "언급", "derived", "브랜드 multi_answers ÷ answers, 브랜드 multi_mentions ÷ 표 브랜드 합, 복수 언급 고유 프롬프트", dims=("전체", "브랜드"), screens="레거시 Mention"),
    Metric("rival_average", "경쟁사 평균(상위 N개사)", "언급", "derived", "언급 상위 N개 경쟁사 값 중 값이 있는 것의 평균. 엔진별은 레거시 규칙, 추이선은 회차마다 상위 10개사의 노출률 · 점유율, 유형별은 상위 5개사의 유형 안 점유율", dims=("엔진", "회차", "유형"), screens="레거시 Mention · Mention · Project Mention", note="사용자 레거시 예외(2026-11-05). 추이선 · 유형별은 D-11로 되살림(2026-11-06). 분석팀 리뷰 필요"),
    Metric("own_type_mix", "멘션 유형별 점유율 · 유형별 언급 건수(당사)", "언급", "derived", "당사 signals_<유형> ÷ 당사 5개 유형 합", dims=("전체", "유형"), screens="레거시 Mention"),
    Metric("branded_share", "브랜드 포함(시장별)", "언급", "derived", "국가별 브랜드 포함 프롬프트의 답변 수 ÷ answers", dims=("국가",), screens="Overview 시장별"),
    Metric("prompt_mentions", "프롬프트별 언급 수 · 점유율 · 신호 수 · 최고 순위", "언급", "derived", "프롬프트마다 브랜드 언급(또는 신호) ÷ 그 브랜드 합, 프롬프트 답변 중 가장 앞선 순위", gold=False, dims=("프롬프트", "브랜드"), screens="브랜드 서랍 · 신호 서랍", note="서랍을 열 때 조회 시점 집계"),
    # ── 인용: SSOT ──
    Metric("citation_share_global", "AI 인용 점유율(global)", "인용", "rate", "official", "citations", CITATION_MONITORING, ssot=True, dims=_MARKET,
           screens="Overview · Citation", note="공식 (HMG) = HMG 3사 공식 사이트와 공식 소셜 계정",
           review="이전 화면은 Overview 카드 233,239/934,592 = 24.96% · Citation 233,628/935,276 = 24.98%로 달랐다. SSOT 공통 조건의 인용 모니터링 답변(ACR 셀당 1건)이면 233,610/935,072 = 24.98%"),
    Metric("citation_share_website", "AI 인용 점유율(website)", "인용", "rate", "owned", "citations", CITATION_MONITORING, ssot=True, dims=_MARKET,
           screens="Website Overview · Citation", note="자사 URL = 측정 설정의 소유 URL · 등록 대표 주소의 오리진에 속한 모든 URL. 하위 도메인은 다른 오리진이라 등록해야 센다",
           review="이전 화면은 업스트림 표시(loc_owned)로 셌다(2026-10-09 103,274/415,271 = 24.87%). 등록한 URL의 오리진으로 세면 159,229/415,271 = 38.34%"),
    Metric("category_share", "인용 비중", "인용", "rate", "category_citations", "citations", CITATION_MONITORING, ssot=True, dims=(*_MARKET, "카테고리"),
           screens="Citation · Website Citation", note="출처 카테고리별. 예: 공식 (HMG) · 딜러·마켓",
           review="Δ · 추이는 지금 빌드 시점 카테고리(citation_cell)로 읽는다. 조회 시점 dim_source로 통일"),
    Metric("owned_url_rate", "자사 URL 인용률(website)", "인용", "rate", "url_own_prompts", "url_prompts", URL_MEASURED, ssot=True, dims=("전체", "회차", "엔진"), screens="Website Overview · Citation · Project", note="프롬프트 단위",
           review="Project Dashboard 타일은 답변 단위로 셌다(own_url_hits ÷ url_den). SSOT는 프롬프트 단위. 자사 URL은 등록한 URL의 오리진으로 센다(website 2026-10-09 8,736 → 9,584/10,021, 87.18 → 95.64%)"),
    Metric("target_url_rate", "타겟 URL 인용률(website)", "인용", "rate", "url_target_prompts", "url_prompts", URL_MEASURED, ssot=True, dims=("전체", "회차", "엔진"), screens="Website Overview · Citation · Project", note="다른 프롬프트의 타겟 인용은 뺀다",
           review="Project Dashboard 타일은 지금 답변 단위로 센다(tgt_hits ÷ url_den). SSOT는 프롬프트 단위"),
    Metric("target_source_rate", "AI 타겟 출처 인용률(website)", "인용", "rate", "url_target_answers", "url_own_answers", URL_MEASURED, ssot=True, dims=("전체", "회차", "엔진"), screens="Website Overview", note="답변 단위",
           review="분모는 자사 URL ∨ 타겟 인용 답변이다. 자사 URL을 등록한 URL의 오리진으로 세면서 website 2026-10-09 9,829/15,062 = 65.26% → 9,829/17,740 = 55.41%"),
    Metric("uncited_prompts", "공식(당사) URL 미인용 프롬프트", "인용", "count", "uncited_prompts", population=CITATION_MONITORING, ssot=True, dims=("전체",), screens="Citation · Website Citation"),
    Metric("coverage", "커버리지", "인용", "rate", "source_answers", "base_answers", CITATION_MONITORING, ssot=True, dims=("전체", "출처"), screens="Citation"),
    # ── 인용: SSOT 밖의 화면 값 ──
    Metric("cited_prompts", "공식(당사) URL 인용 프롬프트", "인용", "count", "own_cited_prompts", population=CITATION_MONITORING, dims=("전체",), screens="Citation"),
    Metric("source_share", "도메인 인용 점유율", "인용", "rate", "source_citations", "citations", CITATION_MONITORING, dims=("전체", "회차", "출처"), screens="Citation · Website Overview"),
    Metric("source_prompts", "도메인 인용 프롬프트", "인용", "count", "source_prompts", population=CITATION_MONITORING, dims=("전체", "출처"), screens="Citation"),
    Metric("domain_rank", "주별 도메인 순위", "인용", "derived", "회차마다 인용 수 내림차순 순위(인용 상위 15개)", dims=("회차", "출처"), screens="Citation"),
    Metric("rival_citation_share", "경쟁사 공식 출처 인용 점유율", "인용", "derived", "경쟁사 공식 출처 인용을 그 브랜드로 더한 값 ÷ citations", dims=("전체", "국가", "브랜드"), screens="Overview"),
    Metric("own_citation_share", "공식(당사) 인용 비중", "인용", "rate", "owned", "citations", CITATION_MONITORING, dims=("전체", "회차"), screens="Website Citation"),
    Metric("engine_category", "엔진 × 출처 카테고리", "인용", "derived", "엔진별 category_citations ÷ 그 엔진 citations", dims=("엔진", "카테고리"), screens="Citation"),
    Metric("type_category", "멘션 유형 × 출처 카테고리", "인용", "derived", "그 유형으로 당사가 나온 답변의 인용을 카테고리로 나눈 비중", dims=("유형", "카테고리"), screens="Citation"),
    Metric("tone_urls", "긍정 · 부정 답변의 인용 URL", "인용", "derived", "당사 감성이 긍정(부정)으로 기운 답변의 고유 URL · 인용 · 답변 수", dims=("전체",), screens="Citation"),
    Metric("analysis_gap", "분석 누락 답변", "인용", "rate", "gap_answers", "base_answers", CITATION_MONITORING, higher_is_better=False, dims=("전체",), screens="레거시 Overview"),
    Metric("total_citations", "전체 인용 수", "인용", "count", "citations", population=CITATION_MONITORING, dims=("전체", "회차", "엔진"), screens="Citation · Website Citation"),
    Metric("citations_per_answer", "답변당 인용 수", "인용", "avg", "citations", "base_answers", CITATION_MONITORING, dims=("전체",), screens="레거시 기간 비교", note="증감률로 표시"),
    Metric("unique_sources", "인용 도메인 수", "인용", "derived", "인용된 고유 출처 수", dims=("전체", "회차"), screens="Citation · Website Citation"),
    Metric("own_prompt_share", "공식(당사) URL 인용 · 미인용 몫", "인용", "rate", "own_cited_prompts", "cited_prompts", CITATION_MONITORING, dims=("전체",), screens="Citation · Project Citation"),
    Metric("source_mix", "출처별 구성비 · 기타", "인용", "derived", "상위 7개 출처 인용 ÷ citations, 기타 = 나머지", dims=("전체",), screens="Website Overview · Project"),
    Metric("category_standing", "공식(HMG) 순위 · 상위 %", "인용", "derived", "출처 카테고리 인용 순서에서 공식(HMG) 자리, 브랜드 순위 ÷ 표 브랜드 수", dims=("전체",), screens="Citation · 레거시 Mention"),
    Metric("source_drill", "도메인 서랍 인용 URL · 프롬프트 몫", "인용", "derived", "출처의 고유 URL 수, URL별 · 프롬프트별 인용 ÷ 출처 인용", gold=False, dims=("출처",), screens="도메인 서랍", note="서랍을 열 때 조회 시점 집계"),
    Metric("prompt_citations", "프롬프트별 인용 수", "인용", "derived", "프롬프트마다 전체 인용 수", gold=False, dims=("프롬프트",), screens="공식(당사) URL 인용 · 미인용 프롬프트"),
    # ── ACR: SSOT ──
    Metric("top1_acr", "Top1 ACR(선택률)", "ACR", "rate", "choice", "iterations", ACR_REPETITION, ssot=True, dims=("전체", "회차", "브랜드"), screens="ACR"),
    Metric("candidate_rate", "후보군 포함율", "ACR", "rate", "appeared_cells", "cells", ACR_REPETITION, ssot=True, dims=("전체", "브랜드"), screens="ACR"),
    Metric("model_conversion", "차종별 선택 전환율", "ACR", "rate", "model_choice", "model_iterations", ACR_REPETITION, ssot=True, dims=("차종",), screens="ACR"),
    Metric("acr_average_line", "브랜드 평균선 · 평균선 대비", "ACR", "derived", "평균선 기울기 k = 표시된 브랜드의 Top1 ACR 합 ÷ 후보군 포함율 합, 평균선 대비 = Top1 ACR − k × 후보군 포함율", dims=("브랜드",), screens="ACR", note="단위가 달라(셀 · 반복) 비교 기준이고 전환율이 아니다. D-11로 되살림(2026-11-06). 분석팀 리뷰 필요"),
    Metric("head_to_head", "맞대결", "ACR", "rate", "own_wins", "duel_iterations", ACR_REPETITION, ssot=True, dims=("엔진", "브랜드"), screens="ACR", note="경쟁사 값은 rival_wins ÷ duel_iterations",
           review="SSOT 분모는 함께 후보에 오른 반복인데, gold_db acr_iter_fact는 셀마다 반복 1회 정도만 둔다(35,927회 중 3,763회). 표본 값이다"),
    # ── ACR: SSOT 밖의 화면 값 ──
    Metric("choice_count", "최종 선택(1순위 횟수)", "ACR", "count", "choice", population=ACR_REPETITION, dims=("전체", "브랜드"), screens="ACR"),
    Metric("appearance_count", "후보 언급 수", "ACR", "count", "appearance", population=ACR_REPETITION, dims=("전체", "브랜드"), screens="ACR"),
    Metric("model_cells", "후보군 등장(차종)", "ACR", "derived", "그 차종이 후보로 나온 셀 수", dims=("차종",), screens="ACR"),
    Metric("acr_standing", "당사 순위 · 1위와 격차", "ACR", "derived", "당사 선택 수보다 많이 선택된 경쟁 브랜드 수 + 1, 당사 Top1 ACR − 선택 수 1위 경쟁사 Top1 ACR", dims=("전체",), screens="ACR"),
    Metric("own_state", "당사 상태(선택 · 후보 탈락 · 미등장)", "ACR", "derived", "프롬프트 × 국가 × 엔진마다: 당사 Σchoice > 0 선택, Σappearance > 0 후보 탈락, 그 외 미등장", dims=("전체", "국가", "엔진"), screens="ACR"),
    Metric("prompt_winner", "프롬프트 × 엔진 1위 브랜드", "ACR", "derived", "프롬프트 × 엔진마다 가장 많이 선택된 브랜드(국가 합산, 동점은 이름순)", dims=("프롬프트", "엔진"), screens="ACR"),
    Metric("choice_distribution", "선택 분포", "ACR", "derived", "국가 × 엔진 시트의 질문마다 브랜드별 Σchoice ÷ Σvalid_acr", dims=("국가", "엔진", "프롬프트"), screens="ACR"),
    # ── 측정 규모 ──
    Metric("answers", "답변 수", "측정", "count", "answers", population=REPRESENTATIVE, dims=_MARKET, screens="Overview · Website Overview"),
    Metric("measured_prompts", "측정 프롬프트", "측정", "count", "measured_prompts", population=MONITORING, dims=("전체", "회차"), screens="레거시 Overview · Prompts"),
    Metric("acr_scale", "측정 셀 · 반복 · 프롬프트 · 엔진", "측정", "derived", "cells · iterations · acr_prompts · 엔진 수", dims=("전체",), screens="ACR"),
    Metric("website_measurement", "프롬프트 측정 횟수 · 회차 · 엔진 조합", "측정", "derived", "프롬프트별 회차 · 엔진 측정 집합(측정 로그)", gold=False, dims=("프롬프트",), screens="Website Prompts", note="값이 아닌 측정 메타데이터. job_index를 그대로 읽는다"),
    Metric("project_counts", "프로젝트 현황(프롬프트 · 답변 · 회차 · 커스텀 태그)", "측정", "derived", "프로젝트의 프롬프트 수, 정상 완료 답변 수(job 기준), 회차 수, 커스텀 태그 수", dims=("프로젝트",), screens="Project 목록 · Dashboard", note="답변 수의 모수가 지표의 답변과 다르다(모든 정상 완료 답변)"),
    Metric("prompt_states", "프롬프트 상태 수(측정 중 · 초안 · 중지 · 삭제됨 · 타겟 지정)", "측정", "derived", "서비스 DB 프롬프트의 상태별 수", gold=False, dims=("프로젝트",), screens="Project Prompt · Setting", note="입력 원본의 개수. 지표 정의 밖"),
    Metric("round_counts", "측정 회차 · 미측정 회차", "측정", "derived", "답변이 있는 회차 수(인용은 citations > 0), 추이 축 길이", dims=("기간",), screens="레거시 기간 비교 · Mention"),
    Metric("prompt_coverage", "최근 회차 측정 · 미측정 · 시장 커버리지 · 엔진 조합", "측정", "derived", "목록 프롬프트를 회차 · 국가 × 브랜드 · 엔진 집합별로 센 수와 몫", dims=("프롬프트",), screens="Website Prompts · Global Prompts"),
    Metric("answer_detail", "답변 한 건의 언급 수 · 인용 수", "측정", "derived", "답변 1건의 브랜드 언급 합, 인용 수", gold=False, dims=("답변",), screens="답변 모달 · Overview 근거"),
    # ── 분석 데이터 밖: Silver에서 오지 않는 값. 정의는 입력(수집 로그 · 키워드 · 소셜)이 정해진 뒤 ──
    Metric("visibility_coverage", "AI 크롤 커버리지 · 읽힌 날 · 마지막 크롤", "AI 가시성", "derived", "AI 크롤이 있는 페이지 ÷ 페이지(우선순위 1 · 전체), 크롤된 날 ÷ 관측 일수", gold=False, dims=("전체",), screens="AI 가시성(메뉴 숨김)", note=_OUTSIDE),
    Metric("visibility_interest", "AI 크롤 · 검색 노출 · AI 관심도", "AI 가시성", "derived", "Σai_crawls, Σseo_impressions, Σai_crawls ÷ Σseo_impressions × 10,000", gold=False, dims=("전체", "페이지"), screens="AI 가시성(메뉴 숨김)", note=_OUTSIDE),
    Metric("visibility_concentration", "상위 N% 집중도 · 지니 계수", "AI 가시성", "derived", "상위 N% 페이지의 AI 크롤 ÷ 전체, 1 − 2 × 로렌츠 곡선 아래 넓이", gold=False, dims=("전체",), screens="AI 가시성(메뉴 숨김)", note=_OUTSIDE),
    Metric("visibility_expected", "달성률 · 부족분 · 기대 크롤", "AI 가시성", "derived", "기대 = 페이지 검색 노출 × (Σai ÷ Σseo), 달성률 = ai ÷ 기대, 부족분 = max(0, 기대 − ai)", gold=False, dims=("페이지",), screens="AI 가시성(메뉴 숨김)", note=_OUTSIDE + ". HUB 기준선이라 D-11과 함께 본다"),
    Metric("visibility_mix", "엔진 · 크롤러 · 섹션 · 우선순위별 몫", "AI 가시성", "derived", "그 묶음의 크롤 ÷ 전체, 차이 = AI 몫 − 검색 몫", gold=False, dims=("엔진", "섹션"), screens="AI 가시성(메뉴 숨김)", note=_OUTSIDE),
    Metric("interest_keywords", "검색량 · 경쟁도 · CPC · 순위", "고객 관심", "derived", "키워드 수집값 그대로(kw_*)", gold=False, dims=("키워드",), screens="Customer Interest · 레거시 Project intent", note="계산 없음. 자리는 업스트림 질문 2.4"),
    Metric("interest_social", "총 발화 · 맥락 · 요구 · 연결 강도", "고객 관심", "derived", "소셜 수집값 그대로(ctx_*)", gold=False, dims=("주제",), screens="Customer Interest · 레거시 Project intent", note="계산 없음. 자리는 업스트림 질문 2.4"),
    Metric("service_ga4", "AI Conversion(GA4)", "측정", "derived", "GA4 수집값. 지표 정의 밖", gold=False, dims=(), screens="AI Conversion", note="T7.7, SSOT 'GA4 추후 논의' 답 뒤"),
)

BY_KEY = {m.key: m for m in METRICS}
