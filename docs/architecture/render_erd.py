"""Draw the HUB DB ERDs into hmg-geo-hub-architecture.html, between its <!-- erd:NAME --> markers.

The tables, keys and foreign keys below mirror the SQL named on each figure; each table also carries a one-sentence
Korean description of what its rows hold. When a migration changes a table, change its entry here and run
`python3 docs/architecture/render_erd.py`; rows or descriptions too wide for their box, and overlapping boxes, are
reported. Layout is explicit (x, y, width per table; the bend of each edge), so a new table needs a place picked by
hand. Colours and fonts come from the document's CSS classes; the SVG carries none of its own."""
from __future__ import annotations

import re
import sys
from html import escape
from pathlib import Path

DOC = Path(__file__).resolve().parent / "hmg-geo-hub-architecture.html"
WIDTH = 1200
HEAD, ROW = 30, 18            # header band, row pitch
DESC = 42                     # description band: two lines on every table, so rows line up across tables
NAME_X = 48                   # column name after the key badge


def text_width(s: str, latin: float) -> float:
    """Estimate: `latin` px per Latin character, a full em (latin / 0.6) per Hangul syllable."""
    return sum(latin / 0.6 if "가" <= ch <= "힣" else latin for ch in s)


def wrap(s: str, width: float) -> list[str]:
    lines, line = [], ""
    for word in s.split():
        trial = f"{line} {word}".strip()
        if line and text_width(trial, 6.6) > width:
            lines.append(line)
            line = word
        else:
            line = trial
    return lines + [line]


class Table:
    """rows: (badge, column, right). right is the type, '=a|b' the allowed values,
    '→ t' a foreign key to a table drawn in another figure, '⇢ t' a reference without a foreign key."""

    def __init__(self, name, x, y, w, desc, rows, notes=()):
        self.name, self.x, self.y, self.w, self.desc, self.rows = name, x, y, w, desc, rows
        self.notes = list(notes)
        self.h = HEAD + DESC + 14 + ROW * (len(rows) + len(self.notes))

    @property
    def bottom(self) -> int:
        return self.y + self.h

    def row(self, column) -> float:
        i = [r[1] for r in self.rows].index(column)
        return self.y + HEAD + DESC + 15 + ROW * i

    def svg(self, warn) -> str:
        x, y, w = self.x, self.y, self.w
        schema, _, table = self.name.rpartition(".")
        out = [f'<rect class="tbox" x="{x}" y="{y}" width="{w}" height="{self.h}" rx="6"/>',
               f'<path class="th" d="M{x},{y + HEAD}V{y + 6}q0,-6 6,-6H{x + w - 6}q6,0 6,6V{y + HEAD}z"/>',
               f'<line class="rule" x1="{x}" y1="{y + HEAD}" x2="{x + w}" y2="{y + HEAD}"/>',
               f'<line class="hair" x1="{x + 12}" y1="{y + HEAD + DESC}" x2="{x + w - 12}" y2="{y + HEAD + DESC}"/>',
               f'<text class="m b" x="{x + 12}" y="{y + 20}"><tspan class="tsch">{escape(schema)}.</tspan>{escape(table)}</text>']
        if 24 + text_width(self.name, 7.2) > w:
            warn(f"{self.name}: title wider than {w}")
        lines = wrap(self.desc, w - 24)
        if len(lines) > 2:
            warn(f"{self.name}: description needs {len(lines)} lines")
        for i, line in enumerate(lines[:2]):
            out.append(f'<text class="desc" x="{x + 12}" y="{y + HEAD + 17 + 16 * i}">{escape(line)}</text>')
        for badge, column, right in self.rows:
            cy = self.row(column) + 4
            kind = "pk" if badge.startswith("PK") else "fk" if badge.startswith("FK") else ""
            cls, shown = ("val", right[1:]) if right.startswith("=") else \
                ("ref", right) if right.startswith("→") else ("lref", right) if right.startswith("⇢") else ("ty", right)
            if badge:
                out.append(f'<text class="kb {kind}" x="{x + 10}" y="{cy}">{escape(badge)}</text>')
            out.append(f'<text class="m" x="{x + NAME_X}" y="{cy}">{escape(column)}</text>')
            out.append(f'<text class="m sm {cls}" x="{x + w - 10}" y="{cy}" text-anchor="end">{escape(shown)}</text>')
            if NAME_X + text_width(column, 6.9) + 12 + text_width(shown, 6.6) + 10 > w:
                warn(f"{self.name}.{column}: row wider than {w}")
        for i, note in enumerate(self.notes):
            cy = self.y + HEAD + DESC + 15 + ROW * (len(self.rows) + i) + 4
            out.append(f'<text class="mu sm" x="{x + 12}" y="{cy}">{escape(note)}</text>')
            if 22 + text_width(note, 6.6) > w:
                warn(f"{self.name}: note wider than {w}")
        return "\n".join(out)


class Figure:
    def __init__(self, name, height, label):
        self.name, self.height, self.label = name, height, label
        self.tables: dict[str, Table] = {}
        self.parts: list[str] = []

    def table(self, name, x, y, w, desc, rows, notes=()):
        t = self.tables[name.rpartition(".")[2]] = Table(name, x, y, w, desc, rows, notes)
        return t

    def __getitem__(self, name) -> Table:
        return self.tables[name]

    def fk(self, src, columns, dst, *, via=None, to=None, x=None, logical=False):
        """An arrow from the child's column(s) to the parent table. Several columns (a composite key) get a
        bracket. Side by side: leaves the facing edge and bends at `via` when the heights differ; `to` is the
        parent column (or y) it lands at, by default straight across if the parent spans that height.
        Stacked: a vertical arrow at `x`."""
        s, d = self.tables[src], self.tables[dst]
        cls, marker = ("ed", "url(#%s-d)" % self.name) if logical else ("e", "url(#%s-a)" % self.name)
        columns = (columns,) if isinstance(columns, str) else columns
        if s.x + s.w <= d.x or d.x + d.w <= s.x:
            right = s.x + s.w <= d.x
            sx, dx = (s.x + s.w, d.x) if right else (s.x, d.x + d.w)
            ys = [s.row(c) for c in columns]
            if len(ys) > 1:
                step = 8 if right else -8
                self.parts.append(f'<path class="e" d="M{sx},{ys[0]}h{step}V{ys[-1]}h{-step}"/>')
                sx += step
            sy = (ys[0] + ys[-1]) / 2
            ty = d.row(to) if isinstance(to, str) else to if to is not None else \
                sy if d.y + HEAD / 2 <= sy <= d.bottom - 6 else None
            if ty is None:
                raise ValueError(f"{self.name}: {src}->{dst} needs `to` (the tables do not overlap at that height)")
            if ty == sy:
                path = f"M{sx},{sy}H{dx}"
            else:
                bend = via if via is not None else (sx + dx) / 2
                path = f"M{sx},{sy}H{bend}V{ty}H{dx}"
        else:
            sy, ty = (s.bottom, d.y) if s.y < d.y else (s.y, d.bottom)
            path = f"M{x},{sy}V{ty}"
        self.parts.append(f'<path class="{cls}" d="{path}" marker-end="{marker}"/>')

    def raw(self, svg: str):
        self.parts.append(svg)

    def svg(self, warn) -> str:
        n = self.name
        defs = (f'<defs><marker id="{n}-a" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse" '
                f'markerWidth="8" markerHeight="8" orient="auto"><path class="ah" d="M0,0L10,5L0,10z"/></marker>'
                f'<marker id="{n}-d" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse" '
                f'markerWidth="8" markerHeight="8" orient="auto"><path class="ahd" d="M0,0L10,5L0,10z"/></marker></defs>')
        body = [t.svg(lambda m: warn(f"{n}: {m}")) for t in self.tables.values()]
        tables = list(self.tables.values())
        for i, t in enumerate(tables):
            if t.x + t.w > WIDTH or t.bottom > self.height:
                warn(f"{n}: {t.name} outside the {WIDTH}x{self.height} drawing")
            for u in tables[i + 1:]:
                if t.x < u.x + u.w and u.x < t.x + t.w and t.y < u.bottom + 10 and u.y < t.bottom + 10:
                    warn(f"{n}: {t.name} and {u.name} overlap")
        return (f'<svg viewBox="0 0 {WIDTH} {self.height}" role="img" aria-label="{escape(self.label)}">\n'
                + defs + "\n" + "\n".join(body + self.parts) + "\n</svg>")


def operations() -> Figure:
    """hmg_operations: back/hub_storage/operations-001.sql, operations-002.sql."""
    f = Figure("ops", 662, "HUB 운영 DB system 스키마 ERD. user_account와 project_reference가 중심이고, "
               "project_reference는 데이터 DB catalog.project와 같은 UUID만 보관한다.")
    f.table("system.project_member", 616, 40, 270, "사용자가 어느 프로젝트에 어떤 역할로 속하는지 담는다.", [
        ("PK FK", "project_id", "uuid"), ("PK FK", "user_id", "uuid"), ("", "role", "=owner|editor|viewer"),
        ("", "created_at", "timestamptz")])
    f.table("system.user_account", 316, 236, 250, "HUB 사용자 한 명당 한 행으로, 로그인 아이디·이름·메일·활성 여부를 담는다.", [
        ("PK", "user_id", "uuid"), ("UK", "subject", "text"), ("", "display_name", "text"), ("", "email", "text"),
        ("", "status", "=active|disabled"), ("", "created_at", "timestamptz")])
    f.table("system.user_credential", 16, 170, 250, "사용자 비밀번호의 scrypt 해시와 마지막 변경 시각을 담는다.", [
        ("PK FK", "user_id", "uuid"), ("", "password_hash", "=scrypt$…"), ("", "changed_at", "timestamptz")])
    f.table("system.global_role", 16, 326, 250, "프로젝트와 무관한 전역 역할을 담으며, 지금은 최상위 관리자(admin)뿐이다.", [
        ("PK FK", "user_id", "uuid"), ("", "role", "=admin"), ("", "granted_at", "timestamptz")])
    f.table("system.schema_migration", 16, 500, 250, "이 DB에 적용한 마이그레이션 파일과 체크섬을 기록한다.", [
        ("PK", "version", "text"), ("", "sha256", "text"), ("", "applied_at", "timestamptz")])
    f.table("system.project_setting_version", 616, 236, 270, "프로젝트 SW 설정을 바꿀 때마다 새 버전 행을 쌓는다.", [
        ("PK FK", "project_id", "uuid"), ("PK", "version", "integer"), ("", "settings", "jsonb"),
        ("FK", "changed_by", "uuid"), ("", "created_at", "timestamptz")])
    f.table("system.audit_event", 616, 448, 270, "누가 어느 프로젝트에서 무엇을 했는지 남기는 감사 이력이다.", [
        ("PK", "event_id", "bigint identity"), ("FK", "actor_id", "uuid"), ("FK", "project_id", "uuid"),
        ("", "action", "text"), ("", "details", "jsonb"), ("", "occurred_at", "timestamptz")])
    f.table("system.project_reference", 930, 236, 254, "데이터 DB catalog.project에 있음을 확인한 프로젝트 UUID 목록이다.", [
        ("PK", "project_id", "⇢ catalog.project"), ("", "validated_at", "timestamptz")])
    f.table("system.integration", 930, 408, 254, "프로젝트별 GA4·SEO·Gold 연동 설정과 비밀 저장소 참조를 담는다.", [
        ("PK", "integration_id", "uuid"), ("FK", "project_id", "uuid"), ("", "provider", "=ga4|seo|gold"),
        ("", "config", "jsonb"), ("", "credential_ref", "text"), ("", "enabled", "boolean"),
        ("", "updated_at", "timestamptz")], notes=["UNIQUE (project_id, provider)"])
    f.fk("user_credential", "user_id", "user_account")
    f.fk("global_role", "user_id", "user_account")
    f.fk("project_member", "user_id", "user_account", via=591, to="user_id")
    f.fk("project_setting_version", "changed_by", "user_account")
    f.fk("audit_event", "actor_id", "user_account", via=591, to="created_at")
    f.fk("project_member", "project_id", "project_reference", via=911, to=f["project_reference"].y + HEAD / 2)
    f.fk("project_setting_version", "project_id", "project_reference")
    f.fk("audit_event", "project_id", "project_reference", via=911, to="validated_at")
    f.fk("integration", "project_id", "project_reference", x=1060)
    return f


def catalog() -> Figure:
    """hmg_analytics catalog / publication / published: back/hub_storage/data-002.sql, -003, -004."""
    f = Figure("cat", 552, "HUB 데이터 DB의 catalog·publication 스키마 ERD와 published 뷰. 프로젝트와 프롬프트는 "
               "정체성 행과 버전 행으로 나뉘고, publication.project_access 승인을 통과한 것만 published 뷰에 보인다.")
    f.table("catalog.project_version", 16, 40, 260, "프로젝트 정의(JSON)가 바뀔 때마다 버전 한 행을 쌓는다.", [
        ("PK FK", "project_id", "uuid"), ("PK", "version", "integer"), ("", "definition", "jsonb"),
        ("", "sha256", "text"), ("", "recorded_at", "timestamptz")])
    f.table("catalog.project", 316, 40, 260, "프로젝트의 영구 UUID와 출처(Gold 가져옴·HUB 생성)를 담는 정체성 표다.", [
        ("PK", "project_id", "uuid"), ("", "origin", "=gold|hub"), ("UK", "source_id", "uuid"),
        ("", "registered_at", "timestamptz")])
    f.table("catalog.prompt", 626, 40, 260, "프롬프트의 영구 UUID, 소속 프로젝트, 출처를 담는 정체성 표다.", [
        ("PK", "prompt_id", "uuid"), ("FK", "project_id", "uuid"), ("", "origin", "=gold|hub"),
        ("UK", "source_id", "uuid"), ("", "registered_at", "timestamptz")])
    f.table("catalog.prompt_version", 936, 40, 248, "프롬프트 본문과 분류 정의를 버전별로 쌓고, HUB 편집이면 기록자를 남긴다.", [
        ("PK FK", "prompt_id", "uuid"), ("PK", "version", "integer"), ("", "text", "text"),
        ("", "definition", "jsonb"), ("", "sha256", "text"), ("", "recorded_at", "timestamptz"),
        ("", "recorded_by", "⇢ user_account")])
    f.table("catalog.project_ga4_property", 16, 290, 260, "프로젝트와 GA4 속성의 연결이며, 실제 연동이 확인된 것만 등록한다.", [
        ("PK FK", "project_id", "uuid"), ("PK FK", "prop_key", "→ ga4_property")])
    f.table("publication.project_access", 316, 290, 260, "프로젝트별 projects·prompts·ga4·seo 공개 승인 여부와 승인자를 담는다.", [
        ("PK FK", "project_id", "uuid"), ("", "projects", "boolean"), ("", "prompts", "boolean"),
        ("", "ga4", "boolean"), ("", "seo", "boolean"), ("", "approved_by", "text"),
        ("", "approved_at", "timestamptz")])
    f.fk("project_version", "project_id", "project")
    f.fk("prompt", "project_id", "project")
    f.fk("prompt_version", "prompt_id", "prompt")
    f.fk("project_ga4_property", "project_id", "project", via=296, to="registered_at")
    f.fk("project_access", "project_id", "project", x=446)

    gy = 310
    views = [["projects", "prompts", "ga4_daily", "ga4_users_window", "ga4_values"],
             ["ga4_properties", "seo_visibility_daily", "seo_crawl_daily", "seo_device_daily", "seo_priority"],
             ["urls", "countries", "crawl_bots", "engines"]]
    g = [f'<rect class="vgrp" x="646" y="{gy}" width="538" height="222" rx="8"/>',
         f'<text class="m b" x="662" y="{gy + 26}">published.*<tspan class="mu" dx="10">외부 공개 계약 v1 · 뷰 14개</tspan></text>',
         f'<text class="mu sm" x="662" y="{gy + 46}">hmg_data_external은 이 스키마만 SELECT · 모두 security_barrier 뷰</text>']
    for col, names in enumerate(views):
        for i, name in enumerate(names):
            g.append(f'<text class="m" x="{662 + 180 * col}" y="{gy + 80 + 20 * i}">{name}</text>')
    prompt_bottom, access_y = f["prompt"].bottom, f["project_access"].y + 50
    g += [f'<text class="mu sm" x="662" y="{gy + 190}">읽는 곳: catalog.current_* · analytics.ga4_* · analytics.current_page_* · ref.*</text>',
          f'<text class="mu sm" x="662" y="{gy + 208}">사전 뷰(urls·countries·engines…)는 공개된 측정 행이 쓰는 키만 보인다</text>',
          f'<path class="e" d="M576,{access_y}H646" marker-end="url(#cat-a)"/>',
          f'<text class="mu sm" x="611" y="{access_y - 8}" text-anchor="middle">승인분만</text>',
          f'<path class="e" d="M756,{prompt_bottom}V{gy}" marker-end="url(#cat-a)"/>',
          f'<text class="mu sm" x="764" y="{(prompt_bottom + gy) // 2 + 4}">current_* 뷰 (최신 버전)</text>']
    f.raw("\n".join(g))
    return f


def ga4() -> Figure:
    """hmg_analytics GA4: back/analytics/schema.sql, operations.sql."""
    f = Figure("ga4", 494, "HUB 데이터 DB의 GA4 표 ERD. ga4_row와 ga4_users_window가 ga4_property를 가리키고, "
               "차원 키는 kind별로 ga4_value를 가리킨다.")
    f.table("analytics.ga4_row", 70, 40, 290, "GA4 보고서 5종의 세션·사용자·조회·이벤트를 날짜·차원 조합별로 담는다.", [
        ("PK FK", "prop_key", "smallint"), ("PK", "report", "=1~5"), ("PK", "date", "date"),
        ("PK FK", "channel_key", "integer"), ("PK FK", "source_key", "integer"), ("PK FK", "device_key", "integer"),
        ("PK FK", "nvr_key", "integer"), ("PK FK", "page_key", "integer"), ("PK FK", "event_key", "integer"),
        ("FK", "engine_key", "→ dim_engine"), ("", "is_ai", "boolean"), ("", "is_conv", "boolean"),
        ("", "sessions", "integer"), ("", "users_day", "integer"), ("", "page_views", "integer"),
        ("", "key_events", "integer"), ("", "event_count", "integer")])
    f.table("analytics.ga4_property", 410, 40, 340, "수집 대상 GA4 속성과 그 브랜드·국가·연결 상태·전환 기준을 담는다.", [
        ("PK", "prop_key", "smallint"), ("UK", "property_id", "text"), ("", "brand_bit", "integer"),
        ("FK", "geo_key", "→ dim_country"), ("", "status", "=active|pending_grant|unmapped"),
        ("", "source", "=registry|project_override|env"), ("", "conv_basis", "=1|2")])
    f.table("analytics.ga4_value", 410, 300, 340, "채널·소스·기기·방문자 유형·이벤트·페이지 값의 사전이다.", [
        ("PK", "kind", "=channel|source|device|nvr|event|page"), ("PK", "value_key", "integer"),
        ("", "value", "text"), ("FK", "url_key", "→ dim_url (page만)")],
        notes=["← ga4_row 6개 키 · users_window.page_key"])
    f.table("analytics.ga4_users_window", 800, 40, 300, "기간·코호트·필터별로 중복을 뺀 정확한 사용자 수를 담는다.", [
        ("PK FK", "prop_key", "smallint"), ("PK", "window_end", "date"), ("PK", "window_days", "integer"),
        ("PK", "cohort", "=ai|total|general"), ("PK", "engine_mask", "integer"), ("PK", "device_mask", "integer"),
        ("PK", "nvr_mask", "integer"), ("PK FK", "page_key", "integer"), ("", "users", "integer")])
    f.fk("ga4_row", "prop_key", "ga4_property")
    f.fk("ga4_row", ("channel_key", "source_key", "device_key", "nvr_key", "page_key", "event_key"), "ga4_value",
         via=389, to="kind")
    f.fk("ga4_users_window", "prop_key", "ga4_property")
    f.fk("ga4_users_window", "page_key", "ga4_value", via=775, to="kind")
    return f


def seo() -> Figure:
    """hmg_analytics SEO and build bookkeeping: back/analytics/schema.sql, operations.sql."""
    f = Figure("seo", 610, "HUB 데이터 DB의 SEO 표와 ops 스키마 ERD. page_* 표는 빌드별로 쌓이고, "
               "ops.seo_active_build가 프로젝트·날짜마다 보여 줄 빌드를 정한다.")
    f.table("ops.build", 16, 40, 250, "SEO 데이터 빌드 한 번당 한 행으로, 규칙 버전·상태·검증 결과를 담는다.", [
        ("PK", "build_id", "bigint"), ("", "family", "text"), ("", "slice_key", "text"), ("", "status", "text"),
        ("", "rule_ver", "text"), ("", "started_at", "timestamptz"), ("", "finished_at", "timestamptz")],
        notes=["외 실행 메타 열 9개 (schema.sql)"])
    f.table("analytics.page_visibility_daily", 312, 40, 280, "빌드별로 페이지·날짜마다 검색 노출 수와 AI 크롤 수 합계를 담는다.", [
        ("PK FK", "build_id", "bigint"), ("PK FK", "project_key", "→ dim_project"), ("PK FK", "url_key", "→ dim_url"),
        ("PK", "date", "date"), ("FK", "geo_key", "→ dim_country"), ("", "seo_impressions", "integer"),
        ("", "ai_crawls", "integer")])
    f.table("analytics.page_crawl_daily", 638, 40, 280, "빌드별로 페이지·날짜·크롤러 봇마다 크롤 횟수를 담는다.", [
        ("PK FK", "build_id", "bigint"), ("PK FK", "project_key", "smallint"), ("PK FK", "url_key", "integer"),
        ("PK FK", "date", "date"), ("PK FK", "bot_key", "smallint"), ("", "hits", "integer")])
    f.table("analytics.dim_crawl_bot", 964, 112, 220, "AI 크롤러 봇 사전이며, 봇이 속한 엔진을 가리킨다.", [
        ("PK", "bot_key", "smallint"), ("UK", "code", "text"), ("FK", "engine_key", "→ dim_engine")])
    f.table("analytics.page_seo_device_daily", 638, 274, 280, "빌드별로 페이지·날짜·기기마다 검색 노출 수를 담는다.", [
        ("PK FK", "build_id", "bigint"), ("PK FK", "project_key", "smallint"), ("PK FK", "url_key", "integer"),
        ("PK FK", "date", "date"), ("PK FK", "device_key", "→ ga4_value"), ("", "seo_impressions", "integer")])
    f.table("analytics.page_priority", 312, 292, 280, "빌드별로 프로젝트 페이지의 우선순위와 산정 규칙 버전을 담는다.", [
        ("PK FK", "build_id", "bigint"), ("PK FK", "project_key", "→ dim_project"), ("PK FK", "url_key", "→ dim_url"),
        ("", "priority", "smallint"), ("", "rule_ver", "text")])
    f.table("ops.seo_active_build", 16, 310, 250, "프로젝트·날짜마다 화면과 공개 뷰에 보일 검증된 빌드를 가리킨다.", [
        ("PK FK", "project_key", "→ dim_project"), ("PK", "date", "date"), ("FK", "build_id", "bigint"),
        ("", "version", "bigint"), ("", "updated_at", "timestamptz")])
    f.table("ops.data_version", 964, 292, 220, "ref·ga4·seo 묶음의 데이터가 바뀔 때마다 오르는 버전 번호다.", [
        ("PK", "scope", "=ref|ga4|seo"), ("", "version", "bigint"), ("", "updated_at", "timestamptz")])
    f.table("ops.schema_migration", 964, 452, 220, "이 DB에 적용한 마이그레이션 파일과 체크섬을 기록한다.", [
        ("PK", "version", "text"), ("", "sha256", "text"), ("", "applied_at", "timestamptz")])
    f.fk("page_visibility_daily", "build_id", "build")
    f.fk("page_crawl_daily", ("build_id", "project_key", "url_key", "date"), "page_visibility_daily")
    f.fk("page_crawl_daily", "bot_key", "dim_crawl_bot")
    f.fk("page_seo_device_daily", ("build_id", "project_key", "url_key", "date"), "page_visibility_daily",
         via=615, to="ai_crawls")
    f.fk("page_priority", "build_id", "build", via=289, to="finished_at")
    f.fk("seo_active_build", "build_id", "build", x=141)
    vy = max(f["seo_active_build"].bottom, f["page_priority"].bottom, f["page_seo_device_daily"].bottom) + 36
    sab = f["seo_active_build"].bottom
    f.raw(f'<rect class="vgrp" x="312" y="{vy}" width="606" height="60" rx="8"/>\n'
          f'<text class="m b" x="328" y="{vy + 24}">analytics.current_page_*<tspan class="mu" dx="10">뷰 4개</tspan></text>\n'
          f'<text class="mu sm" x="328" y="{vy + 44}">page_* ⋈ ops.seo_active_build · 프로젝트·날짜마다 지정된 빌드의 행만</text>\n'
          f'<path class="ed" d="M141,{sab}V{vy + 30}H312" marker-end="url(#seo-d)"/>\n'
          f'<text class="mu sm" x="150" y="{sab + 34}">보일 빌드 지정</text>')
    return f


def ref() -> Figure:
    """hmg_analytics ref dictionaries: back/analytics/schema.sql, operations.sql."""
    f = Figure("ref", 672, "HUB 데이터 DB의 ref 사전 ERD. URL은 출처와 자사 기준 주소를, 출처는 분류와 경쟁 브랜드를, "
               "프로젝트는 국가를, 국가는 대륙을 가리킨다.")
    f.table("ref.dim_owned_base", 16, 100, 260, "자사 URL로 판정하는 주소 접두사와 그 브랜드·국가·언어를 담는다.", [
        ("PK", "owner_key", "smallint"), ("UK", "kind", "text"), ("UK", "prefix", "text"), ("", "host", "text"),
        ("", "brand_code", "text"), ("", "brand_bit", "integer"), ("", "geo_code", "text"),
        ("", "language", "text")], notes=["UNIQUE (kind, prefix)"])
    f.table("ref.dim_url", 322, 40, 260, "측정에 나온 URL 사전으로, 정규화 주소와 출처·자사 기준을 가리킨다.", [
        ("PK", "url_key", "integer"), ("UK", "url_hash", "text"), ("", "url", "text"), ("", "title", "text"),
        ("", "url_norm", "text"), ("", "url_base_norm", "text"), ("", "host", "text"), ("", "domain", "text"),
        ("FK", "source_key", "integer"), ("FK", "owner_key", "smallint"), ("", "rule_ver", "text")])
    f.table("ref.dim_source", 628, 40, 260, "출처 도메인 사전으로, 분류·소셜 여부·자사·경쟁 브랜드 판정을 담는다.", [
        ("PK", "source_key", "integer"), ("UK", "skey", "text"), ("", "domain", "text"), ("", "is_social", "boolean"),
        ("FK", "category_key", "smallint"), ("", "category_src", "smallint"), ("", "owned_brand_bit", "integer"),
        ("FK", "competitor_brand_key", "integer"), ("", "rule_ver", "text")])
    f.table("ref.dim_category", 934, 50, 250, "출처 분류 이름과 표시 순서를 담는다.", [
        ("PK", "category_key", "smallint"), ("UK", "name", "text"), ("", "slug", "text"), ("", "ord", "integer")])
    f.table("ref.dim_brand", 934, 224, 250, "자사·경쟁 브랜드 이름 사전이다.", [
        ("PK", "brand_key", "integer"), ("UK", "name", "text"), ("UK", "bare", "text"), ("", "kind", "smallint"),
        ("", "own_bit", "integer"), ("", "first_seen", "date")])
    f.table("ref.dim_project", 16, 400, 260, "Scope 프로젝트·사이트 UUID에 이 DB의 프로젝트 키를 매기는 사전이다.", [
        ("PK", "project_key", "smallint"), ("UK", "scope_project_id", "uuid"), ("", "surface", "smallint"),
        ("", "is_root", "boolean"), ("", "project_id", "uuid"), ("", "site_id", "uuid"),
        ("", "site_brand_bit", "integer"), ("FK", "site_geo_key", "smallint"), ("", "regions", "text[]")])
    f.table("ref.dim_country", 322, 440, 260, "국가 코드 사전으로, 국가가 속한 대륙과 화면 표시 속성을 담는다.", [
        ("PK", "geo_key", "smallint"), ("UK", "code", "text"), ("FK", "region_key", "smallint"), ("", "kind", "text"),
        ("", "virtual_brand_bit", "integer"), ("", "hidden_standard", "boolean")],
        notes=["code는 대소문자 무시 UNIQUE"])
    f.table("ref.dim_region", 628, 470, 260, "국가를 묶는 대륙 사전이다.", [
        ("PK", "region_key", "smallint"), ("UK", "code", "text")])
    f.table("ref.dim_engine", 934, 450, 250, "AI 엔진 코드 사전이다.", [
        ("PK", "engine_key", "smallint"), ("UK", "code", "text"), ("", "is_default", "boolean")],
        notes=["ga4_row · dim_crawl_bot이 참조"])
    f.fk("dim_url", "owner_key", "dim_owned_base")
    f.fk("dim_url", "source_key", "dim_source")
    f.fk("dim_source", "category_key", "dim_category")
    f.fk("dim_source", "competitor_brand_key", "dim_brand")
    f.fk("dim_project", "site_geo_key", "dim_country")
    f.fk("dim_country", "region_key", "dim_region")
    return f


FIGURES = (operations, catalog, ga4, seo, ref)


def render() -> dict[str, str]:
    warnings: list[str] = []
    figures = {f.name: f.svg(warnings.append) for f in (make() for make in FIGURES)}
    for w in warnings:
        print("warning:", w, file=sys.stderr)
    return figures


def main() -> None:
    doc = DOC.read_text(encoding="utf8")
    for name, svg in render().items():
        doc, n = re.subn(rf"(<!-- erd:{name} -->).*?([ \t]*<!-- /erd:{name} -->)",
                         lambda m: m.group(1) + "\n" + svg + "\n" + m.group(2), doc, flags=re.S)
        if n != 1:
            sys.exit(f"{DOC.name}: marker erd:{name} not found exactly once")
    DOC.write_text(doc, encoding="utf8")
    print(f"{DOC.name}: {len(FIGURES)} ERD figures drawn")


if __name__ == "__main__":
    main()
