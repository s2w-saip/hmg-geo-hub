"""Adapter ①: the base counts from gold_db's answer-level tables (answer_fact · answer_brand_fact ·
citation_fact · acr_*_fact), never its precomputed cells (kpi_cell · brand_cell · citation_cell · url_prompt_cell), whose
definitions are upstream's. Read only; goes with gold_reader at T12 once adapter ② reads Silver.

It reads the live release: SSOT has one operational snapshot per round, and the card release is an older copy of some
rounds (global 1 of 23 fact builds differs, website 1,087 builds against 1,155), so a card read is refused. The
populations are judged by bff.metrics.judgments (metrics.gold_judged), not read from upstream's flags; is_rep is the flag the legacy screens read,
formulas.representative its rule, five old rounds differ. An ACR cell can hold several runs of a round, and SSOT counts one per cell: Context leaves
the non-representative ACR answers out of every fact read (Context.older_acr)."""
from __future__ import annotations

from collections.abc import Sequence
from copy import copy
from datetime import date

from bff.gold_reader.acr import cell_where, head_to_head
from bff.gold_reader.context import SQL, Context
from bff.metrics.catalog import CITATION_MONITORING, MONITORING, REPRESENTATIVE, SENTIMENTS, TYPES
from bff.metrics.gold_judged import in_keys, mention_columns, mention_keys, merge, official, own_url

GROUPS = {"round": "f.round_date", "engine": "f.engine_key", "country": "f.geo_key", "prompt": "f.prompt_key",
          # Gold's own keys, for the /v1 reads in gold_reader (the names above answer codes, as adapter ② will)
          "round_date": "f.round_date", "engine_key": "f.engine_key", "geo_key": "f.geo_key", "prompt_key": "f.prompt_key"}
SENTIMENT_SUMS = ",".join(f"coalesce(sum(f.{k}),0)::bigint AS {k}" for k in SENTIMENTS)
TYPE_SUMS = ",".join(f"coalesce(sum(f.t_{t}),0)::bigint AS signals_{t}" for t in TYPES)
# the source's category as of now (dim_source), not citation_cell's category at build time: an 출처 교정 applies at once
CATEGORY_JOIN = "JOIN gold.dim_source s USING(source_key) JOIN gold.dim_category c ON c.category_key=s.category_key"


def _select(group: Sequence[str]) -> str:
    return "".join(f"{GROUPS[g]} AS {g}," for g in group)


def _group_by(group: Sequence[str], *more: str) -> str:
    keys = [GROUPS[g] for g in group] + list(more)
    return f"GROUP BY {','.join(keys)}" if keys else ""


class GoldCurrentSource:
    def __init__(self, ctx: Context) -> None:
        if ctx.card:
            raise ValueError("The metric layer reads one snapshot: the live release, not the card one")
        self.ctx = ctx
        self.surface = ctx.surface
        self.snapshot_id = f"gold-release:{ctx.release['release_id']}:{ctx.release['version']}"

    def for_rounds(self, rounds: Sequence[date]) -> GoldCurrentSource:
        ctx = copy(self.ctx)
        ctx.selected_dates = sorted(rounds)
        return GoldCurrentSource(ctx)

    def _gate(self, b: SQL, population: str, alias: str = "f") -> str:
        if population == CITATION_MONITORING:
            return self.ctx.citation_monitoring(b, alias)
        gate = self.ctx.monitoring(b, alias)
        return f"{gate} AND {alias}.is_rep" if population == REPRESENTATIVE else gate

    async def _rows(self, sql: str, args: list, group: Sequence[str] = ()) -> list[dict]:
        rows = [dict(r) for r in await self.ctx.conn.fetch(sql, *args)]
        # Gold's engine and country keys -> the codes an adapter on another source answers too
        for axis, table, key in (("engine", "dim_engine", "engine_key"), ("country", "dim_country", "geo_key")):
            if axis in group and rows:
                codes = {r[key]: r["code"] for r in await self.ctx.conn.fetch(f"SELECT {key},code FROM gold.{table}")}
                for r in rows:
                    r[axis] = codes.get(r[axis])
        return rows

    # ── 언급 ──

    def _per_answer(self, b: SQL, group: Sequence[str], where: str, table: str, columns: str) -> str:
        """Per answer (with the read's group, its prompt and whether it is representative): `columns` over `table`'s rows."""
        return f"""SELECT {_select(group)}f.answer_key AS a_,f.prompt_key AS p_,f.is_rep AS rep_,{columns}
            FROM gold.{table} f WHERE {where} {_group_by(group, 'f.answer_key', 'f.prompt_key', 'f.is_rep')}"""

    async def answer_counts(self, population: str, group: Sequence[str] = (), *, prompts: bool = False) -> list[dict]:
        b = SQL()
        where = self.ctx.predicate(b, family="fact") + f" AND {self._gate(b, population)}"
        # A distinct count sorts every row: only when asked (gold_reader.metrics.counts measured the same).
        distinct = ",count(DISTINCT f.prompt_key)::bigint AS measured_prompts" if prompts else ""
        rows = await self._rows(f"""SELECT {_select(group)}count(*)::bigint AS answers,count(*) FILTER(WHERE f.is_rep)::bigint AS rep_answers{distinct}
            FROM gold.answer_fact f WHERE {where} {_group_by(group)}""", b.args, group)
        b = SQL()
        where = self.ctx.predicate(b, family="fact") + f" AND {self._gate(b, population)}"
        inner = self._per_answer(b, group, where, "answer_brand_fact", mention_columns(self.ctx, b, "f"))
        distinct = """,count(DISTINCT m.p_) FILTER(WHERE m.tracked)::bigint AS mentioned_prompts,
            count(DISTINCT m.p_) FILTER(WHERE m.own_m>=2)::bigint AS multi_prompts""" if prompts else ""
        keys = "".join(f"m.{g}," for g in group)
        sums = await self._rows(f"""SELECT {keys}count(*) FILTER(WHERE m.tracked)::bigint AS tracked,count(*) FILTER(WHERE m.rep_ AND m.tracked)::bigint AS rep_tracked,
            coalesce(sum(m.own_m),0)::bigint AS own_mentions,coalesce(sum(m.total),0)::bigint AS total_mentions,
            coalesce(sum(m.sent_pos),0)::bigint AS sent_pos,coalesce(sum(m.sent_neg),0)::bigint AS sent_neg,coalesce(sum(m.sent_all),0)::bigint AS sent_all,
            coalesce(sum(m.fp),0)::bigint AS rank_sum,count(m.fp)::bigint AS ranked,
            count(*) FILTER(WHERE m.fp=1)::bigint AS top1,count(*) FILTER(WHERE m.fp<=3)::bigint AS top3,
            coalesce(sum(m.rk),0)::bigint AS rk_sum,count(m.rk)::bigint AS rk_count,
            count(*) FILTER(WHERE m.own_m>=2)::bigint AS multi_answers,
            coalesce(sum(m.own_m) FILTER(WHERE m.own_m>=2),0)::bigint AS multi_mentions{distinct}
            FROM ({inner}) m {('GROUP BY ' + keys.rstrip(',')) if group else ''}""", b.args, group)
        columns = ["tracked", "rep_tracked", "own_mentions", "total_mentions", "sent_pos", "sent_neg", "sent_all", "rank_sum", "ranked", "top1", "top3",
                   "rk_sum", "rk_count", "multi_answers", "multi_mentions", *(("mentioned_prompts", "multi_prompts") if prompts else ())]
        return merge(rows, sums, group, columns)

    async def own_brand_counts(self, population: str, group: Sequence[str] = ()) -> list[dict]:
        b = SQL()
        where = self.ctx.predicate(b, family="fact") + f" AND {self._gate(b, population)} AND (f.own_bit & {b.bind(self.ctx.bits)})<>0"
        answers = ",".join(f"count(DISTINCT f.answer_key) FILTER(WHERE f.t_{t}>0)::bigint AS t_{t}" for t in TYPES)
        sql = f"""SELECT {_select(group)}{answers},{TYPE_SUMS},{SENTIMENT_SUMS}
            FROM gold.answer_brand_fact f WHERE {where} {_group_by(group)}"""
        return await self._rows(sql, b.args, group)

    async def brand_counts(self, population: str, group: Sequence[str] = (), *, prompts: bool = False,
                           brand_keys: Sequence[str] | None = None) -> list[dict]:
        """Every competitive brand's row; 당사's brands are rows too (is_own), as sibling HMG brands stay rivals of a
        one-brand perspective. rank_sum · ranked = first_pos: among the competitive brands (the only rows with one) it is
        '먼저 언급된 경쟁 브랜드 수 + 1'."""
        b = SQL()
        where = self.ctx.predicate(b, family="fact") + f" AND {self._gate(b, population)} AND {self.ctx.competitive(b)}"
        if brand_keys:  # compared as text, as the ?brand_key= values come
            where += f" AND f.brand_key::text=ANY({b.bind(list(brand_keys), 'text[]')})"
        distinct = (""",count(DISTINCT f.prompt_key)::bigint AS prompts,
            count(DISTINCT f.prompt_key) FILTER(WHERE f.mention_count>=2)::bigint AS multi_prompts""" if prompts else "")
        # per brand_key first, the names joined after: grouping by the name sorted every row by its text (metrics.brand_rows)
        sql = f"""WITH a AS (SELECT {_select(group)}f.brand_key,coalesce(sum(f.mention_count),0)::bigint AS mentions,count(*)::bigint AS answers,
            count(*) FILTER(WHERE f.is_rep)::bigint AS rep_answers,
            coalesce(sum(f.first_pos) FILTER(WHERE f.first_pos>0),0)::bigint AS rank_sum,count(*) FILTER(WHERE f.first_pos>0)::bigint AS ranked,
            coalesce(sum(f.rk) FILTER(WHERE f.rk>0),0)::bigint AS rk_sum,count(*) FILTER(WHERE f.rk>0)::bigint AS rk_count,
            count(*) FILTER(WHERE f.mention_count>=2)::bigint AS multi_answers,
            coalesce(sum(f.mention_count) FILTER(WHERE f.mention_count>=2),0)::bigint AS multi_mentions,
            {TYPE_SUMS},{SENTIMENT_SUMS}{distinct}
            FROM gold.answer_brand_fact f WHERE {where} {_group_by(group, 'f.brand_key')})
            SELECT a.*,d.name,d.own_bit,(d.own_bit & {b.bind(self.ctx.bits)})<>0 AS is_own
            FROM a JOIN gold.dim_brand d USING(brand_key) ORDER BY a.mentions DESC,d.name"""
        return await self._rows(sql, b.args, group)

    async def funnel_prompt_counts(self) -> list[dict]:
        """측정 프롬프트 per funnel stage."""
        b = SQL()
        where = self.ctx.predicate(b, family="fact") + f" AND {self.ctx.monitoring(b)}"
        return await self._rows(f"""SELECT t.code AS funnel,count(DISTINCT f.prompt_key)::int AS measured_prompts
            FROM gold.answer_fact f JOIN gold.dim_prompt p USING(prompt_key) LEFT JOIN gold.dim_taxon t ON t.taxon_key=p.funnel_key
            WHERE {where} GROUP BY t.code ORDER BY t.code IS NULL,measured_prompts DESC,t.code""", b.args)

    async def applied_prompts(self) -> int:
        """The prompts the catalog applies to the read, measured or not."""
        from bff.gold_reader.catalog import prompts
        return (await prompts(self.ctx))["meta"]["page"]["total"]

    async def branded_answers(self) -> list[dict]:
        """Per country, the representative answers of the prompts the brand_presence=branded pick selects (the catalog rule of
        Context.create), within the read's own scope."""
        b = SQL()
        keys = [r["prompt_key"] for r in await self.ctx.conn.fetch(f"""SELECT DISTINCT ce.prompt_key FROM gold.catalog_entry ce
            WHERE ce.build_id=ANY({b.bind(self.ctx.builds.get('fact', []), 'bigint[]')}) AND (ce.brand_bit & {b.bind(self.ctx.bits | 8)})<>0
            AND ce.presence_key IN (SELECT taxon_key FROM gold.dim_taxon WHERE lower(code)='branded')""", *b.args)]
        b = SQL()
        where = self.ctx.predicate(b, family="fact") + f" AND {self.ctx.monitoring(b)} AND f.is_rep AND f.prompt_key=ANY({b.bind(keys, 'int[]')})"
        return await self._rows(f"SELECT f.geo_key,count(*)::bigint AS answers FROM gold.answer_fact f WHERE {where} GROUP BY f.geo_key", b.args)

    async def rival_citations(self) -> list[dict]:
        """Each competitor's official sources per country: the citations a rival's AI 인용 점유율 counts."""
        from bff.gold_reader.citations import predicate
        b = SQL()
        where = predicate(self.ctx, b)
        return await self._rows(f"""WITH a AS (SELECT f.geo_key,f.source_key,count(*)::int AS citations
            FROM gold.citation_fact f WHERE {where} GROUP BY f.geo_key,f.source_key)
            SELECT a.geo_key,br.name,sum(a.citations)::int AS citations FROM a JOIN gold.dim_source s USING(source_key)
            JOIN gold.dim_category c ON c.category_key=s.category_key JOIN gold.dim_brand br ON br.brand_key=s.competitor_brand_key
            WHERE c.slug='officialCompetitor' GROUP BY a.geo_key,br.name""", b.args)

    async def type_sides(self, bits: int) -> list[dict]:
        """Per side (own = the brand's own_bit meets `bits`) and type, over the rows that carry the type: mentions (m_), rows (n_),
        distinct answers (a_) and the rows' sentiment sums. Per answer first, so an answer counts once a side."""
        b = SQL()
        where = self.ctx.predicate(b, family="fact") + f" AND {self.ctx.monitoring(b)} AND {self.ctx.competitive(b)}"
        columns = ("s_pos", "s_neu", "s_neg", "s_mix")
        inner, outer = [], []
        for t in TYPES:
            hit = f"f.t_{t}>0"
            inner += [f"sum(f.t_{t}) FILTER(WHERE {hit}) AS m_{t}", f"count(*) FILTER(WHERE {hit}) AS n_{t}",
                      *(f"sum(f.{col}) FILTER(WHERE {hit}) AS {col}_{t}" for col in columns)]
            outer += [f"coalesce(sum(g.m_{t}),0)::bigint AS m_{t}", f"coalesce(sum(g.n_{t}),0)::bigint AS n_{t}",
                      f"count(*) FILTER(WHERE g.n_{t}>0)::int AS a_{t}",
                      *(f"coalesce(sum(g.{col}_{t}),0)::bigint AS {col}_{t}" for col in columns)]
        return await self._rows(f"""WITH g AS (SELECT f.answer_key,(br.own_bit & {b.bind(bits, 'int')})<>0 AS own,{','.join(inner)}
            FROM gold.answer_brand_fact f JOIN gold.dim_brand br USING(brand_key) WHERE {where} GROUP BY 1,2)
            SELECT g.own,{','.join(outer)} FROM g GROUP BY g.own""", b.args)

    async def stance_counts(self) -> list[dict]:
        b = SQL()
        where = self.ctx.predicate(b, family="fact") + f" AND {self.ctx.monitoring(b)}"
        return await self._rows(f"""SELECT s.own_bit,s.stance,count(*)::int AS n
            FROM gold.answer_fact f JOIN gold.answer_stance_fact s
            ON (s.build_id,s.surface,s.round_date,s.answer_key)=(f.build_id,f.surface,f.round_date,f.answer_key)
            WHERE {where} AND s.first_turn GROUP BY s.own_bit,s.stance""", b.args)

    async def own_multi_prompts(self, group: Sequence[str] = ()) -> list[dict]:
        """The prompts where 당사 is mentioned twice or more in an answer: distinct, so not additive over groups."""
        b = SQL()
        where = self.ctx.predicate(b, family="fact") + f" AND {self.ctx.monitoring(b)} AND (f.own_bit & {b.bind(self.ctx.bits)})<>0"
        inner = self._per_answer(b, group, where, "answer_brand_fact", "sum(f.mention_count) AS own_m")
        keys = "".join(f"m.{g}," for g in group)
        sql = f"""SELECT {keys}count(DISTINCT m.p_) FILTER(WHERE m.own_m>=2)::bigint AS multi_prompts FROM ({inner}) m {('GROUP BY ' + keys.rstrip(',')) if group else ''}"""
        return await self._rows(sql, b.args, group)

    async def type_counts(self, population: str) -> list[dict]:
        """Per side (own / rival) and type, over the rows that carry the type: m_<t> mentions, a_<t> answers (one per
        side) and <sentiment>_<t> sums, as gold_reader.advanced.types sums them."""
        b = SQL()
        where = self.ctx.predicate(b, family="fact") + f" AND {self._gate(b, population)} AND {self.ctx.competitive(b)}"
        inner, outer = [], []
        for t in TYPES:
            hit = f"f.t_{t}>0"
            inner += [f"sum(f.t_{t}) FILTER(WHERE {hit}) AS m_{t}", f"count(*) FILTER(WHERE {hit}) AS n_{t}",
                      *(f"sum(f.{k}) FILTER(WHERE {hit}) AS {k}_{t}" for k in SENTIMENTS)]
            outer += [f"coalesce(sum(g.m_{t}),0)::bigint AS m_{t}", f"count(*) FILTER(WHERE g.n_{t}>0)::bigint AS a_{t}",
                      *(f"coalesce(sum(g.{k}_{t}),0)::bigint AS {k}_{t}" for k in SENTIMENTS)]
        sql = f"""WITH g AS (SELECT f.answer_key,(f.own_bit & {b.bind(self.ctx.bits)})<>0 AS own,{','.join(inner)}
            FROM gold.answer_brand_fact f WHERE {where} GROUP BY 1,2)
            SELECT g.own,{','.join(outer)} FROM g GROUP BY g.own"""
        return await self._rows(sql, b.args)

    # ── 인용 ──

    def _citation_where(self, b: SQL, alias: str = "f") -> str:
        return self.ctx.predicate(b, alias, family="fact", measure_family="citations") + f" AND {self.ctx.citation_monitoring(b, alias)}"

    async def _owned(self, b: SQL) -> str:
        """자사 URL 인용: website = 등록한 것, project = its rows' mark (gold_judged.own_url), global = 관점의 소유 베이스 (좁히는 규칙은 gold.dim_owned_base)."""
        if self.ctx.sf == 1:
            from bff.gold_reader.citations import owned_bases  # gold_reader reads through this adapter
            return f"f.owner_key=ANY({b.bind(await owned_bases(self.ctx), 'smallint[]')})"
        return await own_url(self.ctx, b)

    async def citation_counts(self, group: Sequence[str] = (), *, owned: bool = True) -> list[dict]:
        """`owned` False: no 자사 URL count on global, which alone scans the citations (only the URL rates read it)."""
        b = SQL()
        where = self._citation_where(b)
        sql = f"""SELECT {_select(group)}count(*)::bigint AS base_answers,count(*) FILTER(WHERE f.analysis_state>=2)::bigint AS gap_answers
            FROM gold.answer_fact f WHERE {where} {_group_by(group)}"""
        rows = await self._rows(sql, b.args, group)
        b = SQL()
        where = self._citation_where(b)
        # global 자사 is judged citation by citation, against the bases a country or language pick narrows
        registered = await own_url(self.ctx, b)
        judged = await self._owned(b) if self.ctx.sf == 1 and owned else registered
        sql = f"""SELECT {_select(group)}count(*) FILTER(WHERE f.source_key<>0)::bigint AS citations,count(*)::bigint AS citations_all,
            count(*) FILTER(WHERE {official('f')})::bigint AS official,count(*) FILTER(WHERE f.tgt_hit)::bigint AS target,
            count(*) FILTER(WHERE {judged})::bigint AS owned,count(*) FILTER(WHERE {registered} OR f.tgt_hit)::bigint AS owned_or_target
            FROM gold.citation_fact f WHERE {where} {_group_by(group)}"""
        by_key = {tuple(r[g] for g in group): r for r in await self._rows(sql, b.args, group)}
        for r in rows:
            cited = by_key.get(tuple(r[g] for g in group), {})
            r.update({k: cited.get(k, 0) for k in ("citations", "citations_all", "official", "target", "owned", "owned_or_target")})
        return rows

    async def category_counts(self, group: Sequence[str] = ()) -> list[dict]:
        b = SQL()
        where = self._citation_where(b) + " AND f.source_key<>0"
        sql = f"""WITH a AS (SELECT {_select(group)}f.source_key,count(*)::bigint AS citations
            FROM gold.citation_fact f WHERE {where} {_group_by(group, 'f.source_key')})
            SELECT {''.join(f'a.{g},' for g in group)}c.slug,c.name,sum(a.citations)::bigint AS citations FROM a {CATEGORY_JOIN}
            GROUP BY {''.join(f'a.{g},' for g in group)}c.slug,c.name"""
        return await self._rows(sql, b.args, group)

    async def domain_rows(self) -> list[dict]:
        """도메인 표: per source (of the citations the read's 출처 · 브랜드 picks leave), largest first. Per source_key first, the names
        joined after: the distinct counts sort the rows by a 4-byte key instead of the source's text columns."""
        from bff.gold_reader.citations import own_citation, predicate
        b = SQL()
        where = predicate(self.ctx, b)
        owned = await own_citation(self.ctx, b)
        return await self._rows(f"""WITH a AS (SELECT f.source_key,
            count(*)::int AS citations,count(DISTINCT f.answer_key)::int AS answers,
            count(DISTINCT f.prompt_key)::int AS prompts,
            count(*) FILTER(WHERE {owned})::int AS owned,
            bool_or(f.tgt_hit) AS target
            FROM gold.citation_fact f WHERE {where} AND f.source_key<>0 GROUP BY f.source_key)
            SELECT s.skey,s.domain,s.is_social,s.owned_brand_bit,s.competitor_brand_key,
            c.category_key,c.slug,c.name AS category_name,br.name AS competitor_brand,
            a.citations,a.answers,a.prompts,a.owned,a.target
            FROM a JOIN gold.dim_source s USING(source_key)
            LEFT JOIN gold.dim_category c ON c.category_key=s.category_key
            LEFT JOIN gold.dim_brand br ON br.brand_key=s.competitor_brand_key
            ORDER BY a.citations DESC,s.skey""", b.args)

    async def domain_answers(self) -> int:
        """Coverage's denominator: the citation monitoring answers (of the mentioned brand's, on a brand row's drill)."""
        from bff.gold_reader.citations import mentioned
        b = SQL()
        where = self.ctx.predicate(b, family="fact", measure_family="citations") + f" AND {self.ctx.citation_monitoring(b)}"
        if self.ctx.mention:
            where += " AND " + mentioned(self.ctx, b)
        return await self.ctx.conn.fetchval(f"SELECT count(DISTINCT f.answer_key)::int FROM gold.answer_fact f WHERE {where}", *b.args)

    async def source_engine_counts(self) -> list[dict]:
        """Per engine and source: the category totals and each category's top sources come from these."""
        from bff.gold_reader.citations import predicate
        b = SQL()
        where = predicate(self.ctx, b)
        return await self._rows(f"""WITH a AS (SELECT f.engine_key,f.source_key,count(*)::int AS citations
            FROM gold.citation_fact f WHERE {where} AND f.source_key<>0 GROUP BY f.engine_key,f.source_key)
            SELECT a.engine_key,a.citations,s.skey,coalesce(s.domain,s.skey) AS domain,c.category_key,c.slug,c.name AS category_name
            FROM a JOIN gold.dim_source s USING(source_key) JOIN gold.dim_category c ON c.category_key=s.category_key""", b.args)

    async def source_round_counts(self, categories: Sequence[str] | None = None) -> list[dict]:
        """Per round and source: its citations, for the 출처 · 카테고리 추이 (the category as of now, as category_counts)."""
        b = SQL()
        where = self._citation_where(b) + " AND f.source_key<>0" + self._category_pick(b, categories)
        return await self._rows(f"""WITH a AS (SELECT f.round_date,f.source_key,count(*)::bigint AS citations
            FROM gold.citation_fact f WHERE {where} GROUP BY f.round_date,f.source_key)
            SELECT a.round_date,s.skey,s.domain,c.slug,c.name AS category,a.citations FROM a JOIN gold.dim_source s USING(source_key)
            LEFT JOIN gold.dim_category c ON c.category_key=s.category_key""", b.args)

    async def source_categories(self) -> list[dict]:
        """The categories this surface has citations in, over every round: the 출처 filter's options."""
        b = SQL()
        where = self.ctx.predicate(b, family="fact", measure_family="citations", dates=False, dimensions=False, taxonomy=False) + f" AND {self.ctx.citation_monitoring(b)}"
        return await self._rows(f"""SELECT DISTINCT c.slug,c.name,c.ord FROM (SELECT DISTINCT f.source_key FROM gold.citation_fact f WHERE {where}) k
            JOIN gold.dim_source s USING(source_key) JOIN gold.dim_category c ON c.category_key=s.category_key ORDER BY c.ord,c.slug""", b.args)

    def _category_pick(self, b: SQL, categories: Sequence[str] | None) -> str:
        if not categories:
            return ""
        return (" AND f.source_key IN (SELECT s.source_key FROM gold.dim_source s JOIN gold.dim_category d USING(category_key) "
                f"WHERE d.slug=ANY({b.bind(list(categories), 'text[]')}))")

    async def source_counts(self) -> list[dict]:
        b = SQL()
        where = self._citation_where(b) + " AND f.source_key<>0"
        owned = await self._owned(b)
        sql = f"""WITH a AS (SELECT f.source_key,count(*)::bigint AS citations,count(DISTINCT f.answer_key)::bigint AS answers,
            count(DISTINCT f.prompt_key)::bigint AS prompts,count(*) FILTER(WHERE {owned})::bigint AS owned,bool_or(f.tgt_hit) AS target
            FROM gold.citation_fact f WHERE {where} GROUP BY f.source_key)
            SELECT a.citations,a.answers,a.prompts,a.owned,a.target,s.skey,coalesce(s.domain,s.skey) AS domain,s.is_social,
            s.competitor_brand_key,c.slug,c.name AS category,br.name AS competitor_brand
            FROM a JOIN gold.dim_source s USING(source_key) LEFT JOIN gold.dim_category c ON c.category_key=s.category_key
            LEFT JOIN gold.dim_brand br ON br.brand_key=s.competitor_brand_key ORDER BY a.citations DESC,s.skey"""
        return await self._rows(sql, b.args)

    async def prompt_citation_counts(self) -> dict:
        b = SQL()
        where = self._citation_where(b)
        owned = await self._owned(b)
        row = await self.ctx.conn.fetchrow(f"""WITH p AS (SELECT f.prompt_key,count(*) FILTER(WHERE f.source_key<>0) AS hosted,
            count(*) FILTER(WHERE {owned}) AS own FROM gold.citation_fact f WHERE {where} GROUP BY f.prompt_key)
            SELECT count(*) FILTER(WHERE p.hosted>0)::bigint AS cited_prompts,count(*) FILTER(WHERE p.own>0)::bigint AS own_cited_prompts,
            count(*) FILTER(WHERE p.hosted>0 AND p.own=0)::bigint AS uncited_prompts FROM p""", *b.args)
        return dict(row)

    async def type_category_counts(self, categories: Sequence[str] | None = None) -> list[dict]:
        """Per category, the citations of the answers where 당사 has each type (t_<type>)."""
        b = SQL()
        answers = self.ctx.predicate(b, "x", family="fact") + f" AND (x.own_bit & {b.bind(self.ctx.bits)})<>0"
        where = self._citation_where(b) + self._category_pick(b, categories)
        marks = ",".join(f"bool_or(x.t_{t}>0) AS t_{t}" for t in TYPES)
        counts = ",".join(f"count(*) FILTER(WHERE t.t_{t})::bigint AS t_{t}" for t in TYPES)
        sums = ",".join(f"sum(a.t_{t})::bigint AS t_{t}" for t in TYPES)
        sql = f"""WITH t AS (SELECT x.build_id,x.surface,x.round_date,x.answer_key,{marks} FROM gold.answer_brand_fact x WHERE {answers} GROUP BY 1,2,3,4),
            a AS (SELECT f.source_key,{counts} FROM gold.citation_fact f
                  JOIN t ON (t.build_id,t.surface,t.round_date,t.answer_key)=(f.build_id,f.surface,f.round_date,f.answer_key)
                  WHERE {where} GROUP BY f.source_key)
            SELECT c.category_key,c.slug,c.name,{sums} FROM a {CATEGORY_JOIN} GROUP BY c.category_key,c.slug,c.name"""
        return await self._rows(sql, b.args)

    async def tone_counts(self) -> dict:
        """The answers where 당사's sentiment leans positive or negative: their distinct URLs, citations and answers."""
        from bff.gold_reader.citations import predicate
        keys = await mention_keys(self.ctx, measure_family="citations")
        b = SQL()
        where = predicate(self.ctx, b)
        positive, negative = in_keys(b, "f", keys.leans_positive), in_keys(b, "f", keys.leans_negative)
        rows = await self.ctx.conn.fetch(f"""SELECT CASE WHEN {positive} THEN 'positive' ELSE 'negative' END AS tone,
            count(*)::bigint AS citations,count(DISTINCT coalesce(u.url_norm,u.url))::bigint AS urls,count(DISTINCT f.answer_key)::bigint AS answers
            FROM gold.citation_fact f JOIN gold.dim_url u ON u.url_key=f.url_key WHERE {where} AND ({positive} OR {negative}) GROUP BY 1""", *b.args)
        tone = {k: {"urls": 0, "citations": 0, "answers": 0} for k in ("positive", "negative")}
        for r in rows:
            tone[r["tone"]] = {k: r[k] for k in ("urls", "citations", "answers")}
        return tone

    async def url_counts(self, group: Sequence[str] = ()) -> list[dict]:
        """자사 · 타겟 URL 인용률 count prompts, AI 타겟 출처 인용률 answers. 자사 URL = 소유 URL only (SSOT); 당사 도메인 is 소유 ∨ 타겟,
        so the target answers stay inside their denominator. On website the prompts are the registered ones and the answers
        the representative ones (url_prompt_cell: url_den = web_reg ∧ is_rep, 20,326 of 20,329 on 2026-10-09); on project every eligible
        answer (73 of 73 projects equal the cell's url_den, 2026-11-06). Global has no URL rates."""
        website = self.ctx.sf == 2

        def scope(b: SQL) -> str:
            return self.ctx.predicate(b, family="fact") + (" AND f.prompt_key IN (SELECT p.prompt_key FROM gold.dim_prompt p WHERE p.web_reg)" if website
                                                           else f" AND {self.ctx.eligible(b)}")
        b = SQL()
        rows = await self._rows(f"""SELECT {_select(group)}count(DISTINCT f.prompt_key)::bigint AS url_prompts FROM gold.answer_fact f WHERE {scope(b)} {_group_by(group)}""", b.args, group)
        b = SQL()
        where = scope(b)
        own = await own_url(self.ctx, b)
        inner = self._per_answer(b, group, where, "citation_fact", f"""count(*) FILTER(WHERE {own}) AS owned,count(*) FILTER(WHERE f.tgt_hit) AS target,
            count(*) FILTER(WHERE {own} OR f.tgt_hit) AS owned_or_target""")
        rep = "c.rep_ AND " if website else ""
        keys = "".join(f"c.{g}," for g in group)
        cited = await self._rows(f"""SELECT {keys}count(DISTINCT c.p_) FILTER(WHERE c.owned>0)::bigint AS url_own_prompts,
            count(DISTINCT c.p_) FILTER(WHERE c.target>0)::bigint AS url_target_prompts,
            count(*) FILTER(WHERE {rep}c.owned_or_target>0)::bigint AS url_own_answers,
            count(*) FILTER(WHERE {rep}c.owned_or_target>0 AND c.target>0)::bigint AS url_target_answers
            FROM ({inner}) c {('GROUP BY ' + keys.rstrip(',')) if group else ''}""", b.args, group)
        return merge(rows, cited, group, ("url_own_prompts", "url_target_prompts", "url_own_answers", "url_target_answers"))

    # ── ACR ──

    def _acr_where(self, b: SQL) -> str:
        return cell_where(self.ctx, b)

    async def acr_totals(self, group: Sequence[str] = ()) -> list[dict]:
        b = SQL()
        where = self._acr_where(b)
        sql = f"""SELECT {_select(group)}count(*)::bigint AS cells,coalesce(sum(f.valid_acr),0)::bigint AS iterations,
            count(DISTINCT f.prompt_key)::bigint AS acr_prompts,count(DISTINCT f.engine_key)::bigint AS engines
            FROM gold.acr_cell_fact f WHERE {where} {_group_by(group)}"""
        return await self._rows(sql, b.args, group)

    async def acr_brand_counts(self, group: Sequence[str] = ()) -> list[dict]:
        b = SQL()
        where = self._acr_where(b)
        sql = f"""SELECT {_select(group)}br.name AS brand,bool_or((x.own_bit & {b.bind(self.ctx.bits)})<>0) AS is_own,bool_or(x.own_bit<>0) AS is_hmg,
            coalesce(sum(x.choice),0)::bigint AS choice,coalesce(sum(x.appearance),0)::bigint AS appearance,
            count(DISTINCT x.acr_cell_key) FILTER(WHERE x.appearance<>0)::bigint AS appeared_cells
            FROM gold.acr_cell_fact f JOIN gold.acr_entity_fact x ON x.build_id=f.build_id AND x.acr_cell_key=f.acr_cell_key AND x.keep AND x.level=1
            JOIN gold.dim_brand br ON br.brand_key=x.brand_key WHERE {where} AND coalesce(br.name,'')<>''
            {_group_by(group, 'br.name')}"""
        return await self._rows(sql, b.args, group)

    async def acr_own_cells(self) -> int:
        """당사's cells over its brands (a cell counts once, so the brand rows do not add up to it)."""
        b = SQL()
        where = self._acr_where(b)
        return await self.ctx.conn.fetchval(f"""SELECT count(DISTINCT x.acr_cell_key) FROM gold.acr_cell_fact f
            JOIN gold.acr_entity_fact x ON x.build_id=f.build_id AND x.acr_cell_key=f.acr_cell_key AND x.keep AND x.level=1
            AND (x.own_bit & {b.bind(self.ctx.bits)})<>0 AND x.appearance<>0 WHERE {where}""", *b.args)

    async def acr_pair_counts(self) -> list[dict]:
        """Per prompt × engine × country × brand: the rows 당사 상태, the prompt's winner and the 분포 sheets count from."""
        return await self.acr_brand_counts(("prompt", "engine", "country"))

    async def acr_model_counts(self) -> list[dict]:
        b = SQL()
        where = self._acr_where(b)
        sql = f"""SELECT x.entity_key,en.rep_name AS model,parent.name AS brand,coalesce(bit_or(parent.own_bit),0) AS own_bit,
            coalesce(sum(x.choice),0)::bigint AS model_choice,coalesce(sum(f.valid_acr),0)::bigint AS model_iterations,count(*)::bigint AS cells
            FROM gold.acr_cell_fact f JOIN gold.acr_entity_fact x ON x.build_id=f.build_id AND x.acr_cell_key=f.acr_cell_key AND x.keep AND x.level=2 AND x.appearance<>0
            JOIN gold.dim_entity en ON en.entity_key=x.entity_key LEFT JOIN gold.dim_brand parent ON parent.brand_key=x.parent_brand_key
            WHERE {where} AND coalesce(en.rep_name,'')<>'' GROUP BY 1,2,3"""
        return await self._rows(sql, b.args)

    async def acr_duel_counts(self) -> dict:
        b = SQL()
        return await head_to_head(self.ctx, self._acr_where(b), b.args)
