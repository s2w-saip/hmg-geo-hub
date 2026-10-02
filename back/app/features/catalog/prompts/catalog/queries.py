"""catalog.prompts.catalog 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

카탈로그 스코프 술어 3종(catalog_brand_scope·catalog_market_scope·catalog_market_filter)은 core.filters 한 벌을 쓴다(목록·내보내기·
변경 이력 P-2 공유: 같은 화면의 옆 탭이 스코프 우회로가 되지 않게, B1 레드팀 원칙). 여기에는 카탈로그 전용 식만 둔다.
- presence_effective : 브랜드 유형 파생식(명시값 우선).
- 웹사이트 사이트 해석: app.website_site 기준(카탈로그 전용, 측정 이력 없는 사이트 포함. core 해석은 분석용 rd.dim_project 기준).
웹사이트 측정 메타(렌즈)는 core.cycles.Window.where 세 술어(surface·round_date·cyc_key)로만 rd.answer 를 읽는다.
렌즈 창은 게이트 없는 측정 회차 전부(현행 패리티, catalog #11): 회차 키 = Window.all_keys()(숨김 무관).
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from app.core.cycles import Window
from app.core.sqlb import Binder

ROOT_PROJECT_SQL = "SELECT project_id FROM app.project WHERE kind = 'standard_root'"
EXPORT_MAX_ROWS = 50_000
# 긴 본문 정렬 키(prompt_text·target_url·text)는 앞 256자. DB 에 길이 상한이 없어(app.prompt.text·website_prompt 두 열 모두 text) 전체
# 문자열을 커서에 실으면 커서가 쿼리 문자열 상한(cursor max_length 4096)을 넘을 수 있다: 한글 256자 = JSON 이스케이프(6바이트) 1,536바이트 = base64 약
# 2,048자. core decode_cursor 기본 text_max(512) 안이라 text_max 를 넓히지 않는다(README 명세와 다른 점 3).
SORT_TEXT_PREFIX = 256


def like_pattern(s: str) -> str:
    """ILIKE 부분 일치 패턴. \\·%·_ 는 글자 그대로(기본 ESCAPE 문자 \\)."""
    return "%" + s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


# ════════════════════════════════════════════════════════════════════════════
# 카탈로그 전용 식(app.prompt 별칭 a)
# ════════════════════════════════════════════════════════════════════════════
def presence_effective(a: str, umbrella: Sequence[str], b: Binder) -> str:
    return (f"COALESCE({a}.brand_presence, CASE WHEN {a}.brand_code IS NULL THEN NULL "
            f"WHEN {a}.brand_code = ANY({b.v(list(umbrella), 'text[]')}) THEN 'unbranded' ELSE 'branded' END)")


# ════════════════════════════════════════════════════════════════════════════
# 글로벌 카탈로그
# ════════════════════════════════════════════════════════════════════════════
# 정렬 = depth1, depth2, depth3(각 NULL 은 뒤), text, prompt_id. 키셋 행 비교를 위해 NULL 을 (IS NULL, COALESCE) 쌍으로 편다.
GLOBAL_SORT_COLS: tuple[str, ...] = (
    "(p.depth1 IS NULL)", "COALESCE(p.depth1, '')", "(p.depth2 IS NULL)", "COALESCE(p.depth2, '')",
    "(p.depth3 IS NULL)", "COALESCE(p.depth3, '')", f"left(p.text, {SORT_TEXT_PREFIX})", "p.prompt_id")
GLOBAL_SORT_TYPES = ("bool", "text", "bool", "text", "bool", "text", "text", "uuid")


def global_select(where: Sequence[str], presence_sql: str) -> str:
    return (
        "SELECT p.prompt_id, p.text, p.kind, p.scope_prompt_id, (p.scope_prompt_id IS NOT NULL) AS measured,"
        f" p.brand_code, p.brand_presence, {presence_sql} AS brand_presence_effective,"
        " p.prompt_type, p.category, p.list_type, p.depth1, p.depth2, p.depth3, p.depth4, p.funnel_stage, p.lang, p.regions,"
        f" (p.depth1 IS NULL) AS k1n, COALESCE(p.depth1, '') AS k1, (p.depth2 IS NULL) AS k2n, COALESCE(p.depth2, '') AS k2,"
        f" (p.depth3 IS NULL) AS k3n, COALESCE(p.depth3, '') AS k3, left(p.text, {SORT_TEXT_PREFIX}) AS kt"
        " FROM app.prompt p WHERE " + " AND ".join(where)
        + " ORDER BY " + ", ".join(GLOBAL_SORT_COLS))


def global_count(where: Sequence[str]) -> str:
    return "SELECT count(*)::int8 AS n FROM app.prompt p WHERE " + " AND ".join(where)


# ════════════════════════════════════════════════════════════════════════════
# 웹사이트 카탈로그
# ════════════════════════════════════════════════════════════════════════════
@dataclass(frozen=True)
class SortSpec:
    expr: str                   # q(행 + 측정 메타) 위의 정렬 식(NULL 이 나오지 않는 식)
    typ: str                    # 커서 키 형(core.pagination KeyType)
    aggregate: bool             # 측정 메타 파생값(전 범위 집계 필요 = 모양 B)
    nullable: str | None = None  # NULL 이 될 수 있는 원 열(있으면 NULL 플래그 키 sn 으로 방향과 무관하게 NULL 을 뒤로)

    def null_flag(self, direction: str) -> str:
        """정렬 첫 키 sn. 행 값 비교(모든 열 같은 방향)에서 NULL 을 늘 뒤로 두려면 방향마다 뜻을 뒤집는다:
        desc 는 '값 있음'(true 가 먼저), asc 는 '값 없음'(false 가 먼저). NULL 이 없는 열은 상수 false."""
        if self.nullable is None:
            return "false"
        return f"({self.nullable} IS NOT NULL)" if direction == "desc" else f"({self.nullable} IS NULL)"

    def key_types(self) -> tuple[str, str, str]:
        """커서 키 형 = (sn bool, sk 정렬 형, website_prompt_id uuid). WEBSITE_KEY_COLS 와 같은 순서."""
        return ("bool", self.typ, "uuid")


# 미측정(NULL) 날짜 자리값. date.min(0001-01-01)·date.max 는 asyncpg 가 -infinity·infinity 로 인코딩하므로(검증 D1 실측)
# 커서로 돌아올 때 실날짜와 비교가 깨진다. rd 날짜보다 확실히 작은 실날짜를 쓰고, 순서는 NULL 플래그 키가 정한다.
NULL_DATE = "DATE '1900-01-01'"

WEBSITE_SORTS: dict[str, SortSpec] = {
    "prompt": SortSpec(f"left(q.prompt_text, {SORT_TEXT_PREFIX})", "text", False),
    "brand": SortSpec("q.brand_code", "text", False),
    "country": SortSpec("q.country_code", "text", False),
    "lang": SortSpec("q.lang_code", "text", False),
    "target_url": SortSpec(f"left(q.target_url, {SORT_TEXT_PREFIX})", "text", False),
    "answers": SortSpec("q.answers", "int4", True),
    "last_measured": SortSpec(f"COALESCE(q.last_rd, {NULL_DATE})", "date", True, nullable="q.last_rd"),   # NULL 은 방향과 무관하게 뒤
}
WEBSITE_KEY_COLS = ("z.sn", "z.sk", "z.website_prompt_id")


WEBSITE_SITES_SQL = """
SELECT ws.site_id, ws.brand_code, ws.country_code, br.brand_bit
  FROM app.website_site ws JOIN app.brand br ON br.brand_code = ws.brand_code
 WHERE br.brand_bit = ANY(CAST(:bits AS int2[]))
"""


def website_rows_cte(row_where: Sequence[str], b: Binder, site_ids: Sequence[str]) -> str:
    """s(스코프·필터 통과 사이트) → r(행 필터 통과 웹사이트 프롬프트)."""
    w = ["true", *row_where]
    return (
        "s AS (SELECT ws.site_id, ws.brand_code, ws.country_code FROM app.website_site ws"
        f" WHERE ws.site_id = ANY({b.v(list(site_ids), 'uuid[]')})),"
        " r AS (SELECT wp.website_prompt_id, wp.site_id, wp.prompt_text, wp.target_url, wp.domain, wp.lang_code, wp.owned_base_url,"
        " wp.scope_prompt_id, s.brand_code, s.country_code FROM app.website_prompt wp JOIN s ON s.site_id = wp.site_id"
        " WHERE " + " AND ".join(w) + ")")


def lens_empty(win: Window | None) -> bool:
    """렌즈 창에 측정 회차가 하나도 없나(숨김 무관: Window.empty 는 row 계열 키로 판정하므로 쓰지 않는다)."""
    return win is None or win.lo is None or win.hi is None or not win.all_keys()


def lens_cte(win: Window | None, b: Binder, engine_keys: Sequence[int] | None, prompt_keys: Sequence[int] | None = None) -> str:
    """m(prompt_key 별 측정 메타). 창이 비면 빈 관계(사실 표를 읽지 않는다). 현행 패리티(catalog #11, front website-sites.ts:386-407
    websitePromptLens): 발행·노출일·숨김 게이트 없이 창의 측정 회차 전부(Window.all_keys)."""
    if lens_empty(win):
        return ("m AS (SELECT CAST(NULL AS int4) AS prompt_key, 0 AS answers, CAST(NULL AS date) AS last_rd,"
                " CAST(NULL AS int2[]) AS engine_keys WHERE false)")
    assert win is not None
    w = win.where("a", "row", b, keys=win.all_keys())
    if engine_keys is not None:
        w.append(f"a.engine_key = ANY({b.ints(engine_keys)})")
    if prompt_keys is not None:
        w.append(f"a.prompt_key = ANY({b.ints(prompt_keys, 'int4')})")
    return ("m AS (SELECT a.prompt_key, count(*)::int4 AS answers, max(a.round_date) AS last_rd,"
            " array_agg(DISTINCT a.engine_key ORDER BY a.engine_key) AS engine_keys FROM rd.answer a WHERE "
            + " AND ".join(w) + " GROUP BY a.prompt_key)")


def website_joined(rows_cte: str, lens: str, sort: SortSpec, direction: str) -> str:
    """q = r ⋈ dim_prompt(scope_prompt_id → prompt_key) ⋈ m. 정렬 키 sn(NULL 플래그)·sk 를 함께 낸다."""
    return (
        f"WITH {rows_cte}, {lens},"
        " q AS (SELECT r.*, COALESCE(m.answers, 0) AS answers, m.last_rd, COALESCE(m.engine_keys, CAST('{}' AS int2[])) AS engine_keys"
        " FROM r LEFT JOIN rd.dim_prompt dp ON dp.prompt_id = r.scope_prompt_id AND dp.surface = 2"
        " LEFT JOIN m ON m.prompt_key = dp.prompt_key)"
        f" SELECT q.*, {sort.null_flag(direction)} AS sn, {sort.expr} AS sk FROM q")


def website_rows_only(rows_cte: str, sort: SortSpec, direction: str) -> str:
    """모양 A(네이티브 정렬): 행만 먼저 자른다. 측정 메타는 페이지 키로 따로(website_page_meta)."""
    return f"WITH {rows_cte}, q AS (SELECT r.* FROM r) SELECT q.*, {sort.null_flag(direction)} AS sn, {sort.expr} AS sk FROM q"


def website_count(rows_cte: str) -> str:
    return f"WITH {rows_cte} SELECT count(*)::int8 AS n FROM r"


PAGE_PROMPT_KEYS_SQL = """
SELECT dp.prompt_key, dp.prompt_id FROM rd.dim_prompt dp
 WHERE dp.surface = 2 AND dp.prompt_id = ANY(CAST(:ids AS uuid[]))
"""


def website_page_meta(lens: str) -> str:
    return f"WITH {lens} SELECT m.prompt_key, m.answers, m.last_rd, m.engine_keys FROM m"
