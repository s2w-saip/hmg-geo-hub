"""analytics.kpi.engines 읽기 SQL. 기능 고유 SQL 은 없다.

엔진별 행은 core.measure.fetch_counts(group_by engine) 한 번 스캔이다(K-1 과 같은 빌더라 행 합 = 카드, D6).
part → core.measure part 매핑만 둔다(열만 좁힌다. 스캔은 rd.answer 한 번).
"""
from __future__ import annotations

PART_MAP: dict[str, tuple[str, ...]] = {
    "all": ("mentions", "rank_detail", "citations"),
    "exposure": ("mentions", "rank_detail"),
    "sov": ("mentions",),
    "favorability": ("mentions",),
    "position": ("mentions", "rank_detail"),
    "citation": ("citations",),
}

# 응답 필드 ← core.measure 카운트 열(part 별로 채워지는 필드). cit_owned ← cit_m05(M05 분자: global = 출처 카테고리 Official (HMG),
# website·project = 표면 자사): 엔진 일관성 배지(citation_share)가 카드 ⑤ 와 같은 분자를 쓴다(동기화 S1 BE-B, 제품 책임자 Q1 (a)).
FIELDS_BY_PART: dict[str, dict[str, str]] = {
    "mentions": {"answers": "answers", "tracked": "tracked", "rank_sum": "rank_sum", "ranked": "ranked",
                 "total_mentions": "total_mentions", "tracked_mentions": "own_mentions", "sent_mentions": "sent_all",
                 "positive_mentions": "sent_pos", "negative_mentions": "sent_neg"},
    "rank_detail": {"multi": "multi", "top1": "top1", "top3": "top3"},
    "citations": {"cit_total": "cit_total", "cit_owned": "cit_m05"},
}
