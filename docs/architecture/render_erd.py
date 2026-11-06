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
    '→ t' a foreign key to a table drawn in another figure, '⇢ t' a reference without a foreign key.
    Allowed values too long for the row go on a second line under it."""

    def __init__(self, name, x, y, w, desc, rows, notes=()):
        self.name, self.x, self.y, self.w, self.desc, self.rows = name, x, y, w, desc, rows
        self.notes = list(notes)
        self.pitch = [2 if right.startswith("=") and not self.fits(column, right[1:]) else 1 for _, column, right in rows]
        self.h = HEAD + DESC + 14 + ROW * (sum(self.pitch) + len(self.notes))

    def fits(self, column, shown) -> bool:
        return NAME_X + text_width(column, 6.9) + 12 + text_width(shown, 6.6) + 10 <= self.w

    @property
    def bottom(self) -> int:
        return self.y + self.h

    def row(self, column) -> float:
        i = [r[1] for r in self.rows].index(column)
        return self.y + HEAD + DESC + 15 + ROW * sum(self.pitch[:i])

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
            if not self.fits(column, shown) and cls == "val":
                cy += ROW
                if 22 + text_width(shown, 6.6) > w:  # the continuation line has no badge, so it may start at the left pad
                    warn(f"{self.name}.{column}: allowed values wider than {w} even on their own line")
            elif not self.fits(column, shown):
                warn(f"{self.name}.{column}: row wider than {w}")
            out.append(f'<text class="m sm {cls}" x="{x + w - 10}" y="{cy}" text-anchor="end">{escape(shown)}</text>')
        for i, note in enumerate(self.notes):
            cy = self.y + HEAD + DESC + 15 + ROW * (sum(self.pitch) + i) + 4
            out.append(f'<text class="mu sm" x="{x + 12}" y="{cy}">{escape(note)}</text>')
            if 22 + text_width(note, 6.6) > w:
                warn(f"{self.name}: note wider than {w}")
        return "\n".join(out)


class Figure:
    def __init__(self, name, height, label):
        self.name, self.height, self.label = name, height, label
        self.tables: dict[str, Table] = {}
        self.parts: list[str] = []

    def table(self, name, x, y, w, desc, rows, notes=(), key=None):
        """`key`: the figure's own name for it, when two schemas in one figure hold a table of the same name."""
        t = self.tables[key or name.rpartition(".")[2]] = Table(name, x, y, w, desc, rows, notes)
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
    """geohub_operations_db: back/hub_storage/operations-001.sql … operations-004.sql."""
    f = Figure("ops", 776, "HUB 운영 DB system 스키마 ERD. user_account와 project_reference가 중심이고, "
               "project_reference는 입력 DB catalog.project와 같은 UUID만 보관한다. "
               "global_role은 계정의 역할과 열람 범위, saved_filter는 계정별 저장한 필터다.")
    f.table("system.project_member", 616, 40, 270, "사용자가 어느 프로젝트에 어떤 역할로 속하는지 담는다.", [
        ("PK FK", "project_id", "uuid"), ("PK FK", "user_id", "uuid"), ("", "role", "=owner|editor|viewer"),
        ("", "created_at", "timestamptz")])
    f.table("system.user_account", 316, 236, 250, "사용자 한 명당 한 행: 로그인 아이디·이름·메일·상태·마지막 로그인.", [
        ("PK", "user_id", "uuid"), ("UK", "subject", "text"), ("", "display_name", "text"), ("", "email", "text"),
        ("", "status", "=active|disabled"), ("", "created_at", "timestamptz"), ("", "last_sign_in_at", "timestamptz")],
        notes=["로그인 아이디는 대소문자 없이 유일"])
    f.table("system.user_credential", 16, 40, 250, "scrypt 비밀번호 해시와 변경 시각. must_change: 발급한 비밀번호.", [
        ("PK FK", "user_id", "uuid"), ("", "password_hash", "=scrypt$…"), ("", "changed_at", "timestamptz"),
        ("", "must_change", "boolean")])
    f.table("system.global_role", 16, 236, 250, "계정의 역할과 열람 범위다. 행이 없으면 로그인할 수 없다.", [
        ("PK FK", "user_id", "uuid"), ("", "role", "=admin|hq|region|country"), ("", "brands", "text[]"),
        ("", "regions", "text[] RHQ id"), ("", "countries", "text[] ISO"), ("", "granted_at", "timestamptz"),
        ("", "updated_at", "timestamptz")], notes=["admin 빈 값 · hq 브랜드만", "region +권역 · country +국가", "region · country 브랜드는 하나"])
    f.table("system.schema_migration", 16, 530, 250, "이 DB에 적용한 마이그레이션 파일과 체크섬을 기록한다.", [
        ("PK", "version", "text"), ("", "sha256", "text"), ("", "applied_at", "timestamptz")])
    f.table("system.project_setting_version", 616, 236, 270, "프로젝트 SW 설정을 바꿀 때마다 새 버전 행을 쌓는다.", [
        ("PK FK", "project_id", "uuid"), ("PK", "version", "integer"), ("", "settings", "jsonb"),
        ("FK", "changed_by", "uuid"), ("", "created_at", "timestamptz")])
    f.table("system.audit_event", 616, 448, 270, "누가 어느 프로젝트에서 무엇을 했는지 남기는 감사 이력이다.", [
        ("PK", "event_id", "bigint identity"), ("FK", "actor_id", "uuid"), ("FK", "project_id", "uuid"),
        ("", "action", "text"), ("", "details", "jsonb"), ("", "occurred_at", "timestamptz")])
    f.table("system.project_reference", 930, 236, 254, "입력 DB catalog.project에 있음을 확인한 프로젝트 UUID 목록이다.", [
        ("PK", "project_id", "⇢ catalog.project"), ("", "validated_at", "timestamptz")])
    f.table("system.integration", 930, 408, 254, "프로젝트별 GA4·SEO·Gold 연동 설정과 비밀 저장소 참조를 담는다.", [
        ("PK", "integration_id", "uuid"), ("FK", "project_id", "uuid"), ("", "provider", "=ga4|seo|gold"),
        ("", "config", "jsonb"), ("", "credential_ref", "text"), ("", "enabled", "boolean"),
        ("", "updated_at", "timestamptz")], notes=["UNIQUE (project_id, provider)"])
    f.table("system.saved_filter", 316, 490, 250, "계정이 화면마다 저장한 필터로, 화면의 필터 쿼리를 그대로 담는다.", [
        ("PK", "filter_id", "uuid"), ("FK", "user_id", "uuid"), ("", "page", "text"), ("", "name", "text"),
        ("", "query", "text"), ("", "is_default", "boolean"), ("", "position", "integer"),
        ("", "created_at", "timestamptz"), ("", "updated_at", "timestamptz")],
        notes=["기본 필터는 user_id·page마다 하나"])
    f.fk("user_credential", "user_id", "user_account", to=f["user_account"].y + HEAD / 2)
    f.fk("saved_filter", "user_id", "user_account", x=441)
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
    """geohub_bm_db catalog / publication: back/hub_storage/input-001.sql, input-002.sql."""
    f = Figure("cat", 740, "HUB 입력 DB의 프로젝트 · 프롬프트 · 측정 설정 ERD. 프로젝트와 프롬프트는 정체성 행과 버전 행으로 나뉘고, "
               "측정 설정은 프로젝트마다 버전 행을 쌓는다. publication.project_access 승인을 통과한 것만 프롬프트·기준정보 API로 나간다.")
    f.table("catalog.project_version", 16, 40, 260, "프로젝트 정의(JSON) 버전을 쌓고, HUB 편집이면 기록자를 남긴다.", [
        ("PK FK", "project_id", "uuid"), ("PK", "version", "integer"), ("", "definition", "jsonb"),
        ("", "sha256", "text"), ("", "recorded_at", "timestamptz"), ("", "recorded_by", "⇢ user_account"),
        ("", "change_seq", "bigint")])
    f.table("catalog.project", 316, 40, 260, "프로젝트의 영구 UUID와 출처(Gold 가져옴·HUB 생성)를 담는 정체성 표다.", [
        ("PK", "project_id", "uuid"), ("", "origin", "=gold|hub"), ("UK", "source_id", "uuid"),
        ("", "registered_at", "timestamptz")])
    f.table("catalog.prompt", 626, 40, 260, "프롬프트의 영구 UUID, 소속 프로젝트, 출처를 담는 정체성 표다.", [
        ("PK", "prompt_id", "uuid"), ("FK", "project_id", "uuid"), ("", "origin", "=gold|hub"),
        ("UK", "source_id", "uuid"), ("", "registered_at", "timestamptz")])
    f.table("catalog.prompt_version", 936, 40, 248, "프롬프트 본문과 분류 정의를 버전별로 쌓고, HUB 편집이면 기록자를 남긴다.", [
        ("PK FK", "prompt_id", "uuid"), ("PK", "version", "integer"), ("", "text", "text"),
        ("", "definition", "jsonb"), ("", "sha256", "text"), ("", "recorded_at", "timestamptz"),
        ("", "recorded_by", "⇢ user_account"), ("", "change_seq", "bigint")])
    f.table("catalog.project_measurement_version", 16, 290, 280, "프로젝트 측정 설정을 바꿀 때마다 한 버전을 쌓는다. 최신 버전이 현재 값이다.", [
        ("PK FK", "project_id", "uuid"), ("PK", "version", "integer"), ("", "brands", "text[]"), ("", "countries", "text[]"),
        ("", "engines", "text[]"), ("", "cadence", "=weekly|biweekly|monthly"), ("", "acr_repeats", "integer"), ("", "web_units", "jsonb"),
        ("", "owned_urls", "text[]"), ("", "tracked_urls", "text[]"), ("", "tracked_targets", "jsonb"), ("", "origin", "=gold_import|hub"),
        ("", "sha256", "text"), ("", "change_seq", "bigint"), ("", "recorded_at", "timestamptz"), ("", "recorded_by", "⇢ user_account")],
        notes=["처음 값은 Gold가 가진 값만 · 나머지는 빈칸"])
    f.table("publication.project_access", 336, 290, 260, "프로젝트별 projects·prompts 공개 승인 여부와 승인자를 담는다.", [
        ("PK FK", "project_id", "uuid"), ("", "projects", "boolean"), ("", "prompts", "boolean"), ("", "approved_by", "text"),
        ("", "approved_at", "timestamptz"), ("", "access_seq", "bigint")])
    f.fk("project_version", "project_id", "project")
    f.fk("prompt", "project_id", "project")
    f.fk("prompt_version", "prompt_id", "prompt")
    f.fk("project_measurement_version", "project_id", "project", via=306, to="registered_at")
    f.fk("project_access", "project_id", "project", x=466)

    gy = 310
    g = [f'<rect class="vgrp" x="646" y="{gy}" width="538" height="150" rx="8"/>',
         f'<text class="m b" x="662" y="{gy + 26}">catalog.current_*<tspan class="mu" dx="10">최신 버전을 고르는 뷰</tspan></text>',
         f'<text class="m" x="662" y="{gy + 58}">current_project</text>',
         f'<text class="m" x="842" y="{gy + 58}">current_prompt</text>',
         f'<text class="m" x="1022" y="{gy + 58}">current_measurement</text>',
         f'<text class="mu sm" x="662" y="{gy + 88}">화면 편집 역할과 Gold 가져오기는 버전 행을 더하기만 한다(UPDATE · DELETE 없음)</text>',
         f'<text class="mu sm" x="662" y="{gy + 108}">측정 설정 API: /ext/v1/projects/{{id}}의 measurement</text>',
         f'<text class="mu sm" x="662" y="{gy + 128}">프로젝트 change_seq · etag는 정의와 측정 설정을 함께 따른다</text>']
    f.raw("\n".join(g))
    return f


def external() -> Figure:
    """geohub_bm_db reference values and the prompt and reference API boundary: back/hub_storage/input-001.sql (the structure of data-005, -007
    ... -010 and -013 as it moved) and input-002.sql (the reference values the store owns, versions of every list, who reads what)."""
    f = Figure("ext", 1610, "HUB 입력 DB의 기준정보와 프롬프트·기준정보 API 경계 ERD. 기준값은 종류별 set과 항목으로 쌓이고, 호출자는 수집 또는 분석으로 키와 허용 프로젝트를 가지며, "
               "ext 뷰는 트랜잭션 설정 hgh.key_hash로 한 호출자의 범위만 보여 준다. 아래 두 줄은 관리자가 Admin › 인용 출처 분류에서 고치는 "
               "출처 분류 입력(교정 · 시드 · 공식 소셜 · 코드표)과 그 버전, Admin › 고객 관심 데이터 관리에서 고치는 시드 키워드 · 커뮤니티 소스, 그 이력이고, "
               "Admin › 엔티티 카탈로그에서 고치는 엔티티 역할이고, 각각 기준값 종류 source_override · source_seed · source_social · source_code · "
               "interest_keyword · interest_source · entity_role로 발행된다. 엔티티 역할 옆의 reference_source는 관리 화면이 없는 기준정보 8종의 원본이다.")
    f.table("catalog.reference_set", 16, 40, 280, "기준값 한 종류의 한 버전이다. 하나라도 바뀌면 그 종류 전체를 새 set으로 쌓는다.", [
        ("PK", "set_id", "uuid"), ("UK", "family", "text"), ("UK", "version", "integer"), ("", "item_count", "integer"),
        ("", "sha256", "text"), ("", "source", "=gold|hub|hub_edit"), ("", "source_release", "jsonb"), ("", "change_seq", "bigint"),
        ("", "recorded_at", "timestamptz")], notes=["UNIQUE (family, version) · 24종"])
    f.table("catalog.reference_item", 336, 40, 250, "set에 든 항목 하나로, 자연키와 정의(JSON)를 담는다.", [
        ("PK FK", "set_id", "uuid"), ("PK", "item_key", "text"), ("", "definition", "jsonb")])
    f.table("publication.reference_access", 626, 40, 270, "기준값 종류별 공개 승인이다. HUB 코드표 세 종류는 늘 공개된다.", [
        ("PK", "family", "⇢ reference_set"), ("", "enabled", "boolean"), ("", "approved_by", "text"),
        ("", "approved_at", "timestamptz"), ("", "access_seq", "bigint")])
    f.table("catalog.sync_run", 936, 40, 248, "Gold 가져오기 한 번당 한 행으로, 읽은 것과 기록한 것, 거부 사유를 남긴다.", [
        ("PK", "run_id", "uuid"), ("", "started_at", "timestamptz"), ("", "finished_at", "timestamptz"),
        ("", "result", "=running|ok|refused|failed"), ("", "reason", "text"), ("", "gold_versions", "jsonb"),
        ("", "gold_release", "jsonb"), ("", "counts", "jsonb"), ("", "removal_candidates", "jsonb")])
    y2 = 350
    f.table("publication.api_key", 16, y2, 280, "호출자의 API 키다. 원문은 발급 때 한 번만 보이고 sha256만 저장한다.", [
        ("PK", "key_id", "uuid"), ("FK", "client_id", "uuid"), ("UK", "key_hash", "text"), ("", "created_by", "text"),
        ("", "created_at", "timestamptz"), ("", "expires_at", "timestamptz"), ("", "revoked_at", "timestamptz"),
        ("", "revoked_by", "text"), ("", "revoke_reason", "text")], notes=["호출자당 유효 키 ≤ 2 (관리 명령)"])
    f.table("publication.api_client", 336, y2, 250, "외부 API를 부르는 시스템 하나다. 비활성이면 모든 키가 막힌다.", [
        ("PK", "client_id", "uuid"), ("UK", "name", "text"), ("", "status", "=active|disabled"), ("", "audience", "=collect|analyze"),
        ("", "created_by", "text"), ("", "created_at", "timestamptz")])
    f.table("publication.api_client_project", 626, y2, 270, "호출자에게 허용한 프로젝트다. 회수해도 행은 남고 revoked_at이 찍힌다.", [
        ("PK FK", "client_id", "uuid"), ("PK FK", "project_id", "→ catalog.project"), ("", "granted_by", "text"),
        ("", "granted_at", "timestamptz"), ("", "grant_seq", "bigint"), ("", "revoked_at", "timestamptz"),
        ("", "revoked_by", "text")])
    y3 = 650
    f.table("catalog.source_override_event", 16, y3, 280, "출처 교정의 변경 이력이다. changes는 {필드: [전, 후]}이고 지우지 않는다.", [
        ("PK", "event_id", "bigint"), ("FK", "skey", "text"), ("", "action", "=import|set|clear"), ("", "actor_id", "uuid"),
        ("", "changes", "jsonb"), ("", "published_seq", "bigint"), ("", "occurred_at", "timestamptz")])
    f.table("catalog.source_override", 336, y3, 250, "관리자가 Admin › 인용 출처 분류에서 정한 출처 카테고리 교정이다.", [
        ("PK", "skey", "text"), ("", "category", "dim_category.slug"), ("", "note", "text"), ("", "status", "=active|cleared"),
        ("", "origin", "=gold_import|hub"), ("", "created_at", "timestamptz"), ("", "updated_at", "timestamptz"),
        ("", "updated_by", "uuid")], notes=["활성 행 → set source_override"])
    f.table("catalog.source_seed", 626, y3, 270, "HUB가 정본인 시드 도메인과 카테고리다. 처음 값은 seed.json이다.", [
        ("PK", "skey", "text"), ("", "category", "source_code.code"), ("", "note", "text"), ("", "status", "=active|removed"),
        ("", "origin", "=file_import|hub"), ("", "created_at", "timestamptz"), ("", "updated_at", "timestamptz"),
        ("", "updated_by", "uuid")], notes=["활성 행 → set source_seed"])
    f.table("catalog.source_social", 936, y3, 248, "HUB가 정본인 공식 HMG 소셜 계정과 URL 매칭 규칙이다.", [
        ("PK", "account_key", "text"), ("", "display_key", "text"), ("", "domain", "text"), ("", "matchers", "jsonb"),
        ("", "note", "text"), ("", "status", "=active|stopped"), ("", "origin", "=file_import|hub"),
        ("", "updated_at", "timestamptz"), ("", "updated_by", "uuid")], notes=["활성 행 → set source_social"])
    y4 = 960
    f.table("catalog.source_code", 16, y4, 280, "출처 분류 코드표다. category는 cit_c<k> 번호, layer는 분류 출처 1~6이다.", [
        ("PK", "kind", "=category|layer"), ("PK", "code", "text"), ("UK", "number", "smallint"), ("", "name_en", "text"),
        ("", "name_ko", "text"), ("UK", "ord", "smallint"), ("", "description", "text"), ("", "updated_at", "timestamptz"),
        ("", "updated_by", "uuid")], notes=["이름·설명·순서만 고침 → set source_code"])
    f.table("catalog.*_event", 336, y4, 250, "시드부터 역할까지 입력 여섯 종의 변경 이력(같은 모양)이다.", [
        ("PK", "event_id", "bigint"), ("FK", "(표마다 키)", "text"), ("", "action", "=import|add|set|…"),
        ("", "actor_id", "uuid"), ("", "changes", "jsonb"), ("", "published_seq", "bigint"), ("", "occurred_at", "timestamptz")])
    f.table("catalog.interest_keyword", 626, y4, 270, "HUB가 정본인 시드 키워드와 수집 조건이다. 처음 값은 Gold 시드 행이다.", [
        ("PK", "term_norm", "text"), ("", "term", "text"), ("", "conditions", "jsonb"), ("", "source_types", "text[]"),
        ("", "brands", "text[]"), ("", "note", "text"), ("", "status", "=active|stopped"), ("", "origin", "=gold_import|hub"),
        ("", "updated_by", "uuid")], notes=["활성 행 → set interest_keyword"])
    f.table("catalog.interest_source", 936, y4, 248, "HUB가 정본인 커뮤니티 수집 소스다. Gold에는 이 목록이 없다.", [
        ("PK", "source_key", "text"), ("", "url", "text"), ("", "channel", "=news|pr|social|community"), ("", "brands", "text[]"),
        ("", "note", "text"), ("", "status", "=active|stopped"), ("", "updated_at", "timestamptz"),
        ("", "updated_by", "uuid")], notes=["활성 행 → set interest_source"])
    y5 = 1250
    f.table("catalog.entity_role", 16, y5, 280, "HUB가 정본인 엔티티 역할이다. 경쟁사는 기본값이라 저장하지 않는다.", [
        ("PK", "entity_id", "uuid"), ("", "rep_name", "text"), ("", "role", "=own|excluded"), ("", "brand", "text"), ("", "note", "text"),
        ("", "status", "=active|cleared"), ("", "origin", "=gold_import|hub"), ("", "updated_at", "timestamptz"),
        ("", "updated_by", "uuid")], notes=["활성 행 → set entity_role"])
    # engine, country, language, taxon, brand and the code tables (input-002): first values from Gold once, then the store's own
    f.table("catalog.reference_source", 336, y5, 250, "관리 화면이 없는 기준정보 8종의 원본이다. Gold는 처음 값만 준다.", [
        ("PK", "family", "text"), ("PK", "item_key", "text"), ("", "definition", "jsonb"), ("", "status", "=active|stopped"),
        ("", "origin", "=gold_import|hub"), ("", "created_at", "timestamptz"), ("", "updated_at", "timestamptz"), ("", "updated_by", "uuid")],
        notes=["engine · country · language", "taxon · brand · 코드표 3종", "활성 행 → set(종류마다)"])
    # the versions of every list (data-013, input-002): same shape, written by their trigger only
    f.table("catalog.*_version", 626, y5, 270, "목록 여덟 표의 버전이다. 바뀔 때마다 행 전체를 한 버전으로 쌓는다.", [
        ("PK FK", "(표마다 키)", "text"), ("PK", "version", "integer"), ("", "(그 표의 값 컬럼 전부)", "…"),
        ("", "recorded_at", "timestamptz"), ("", "recorded_by", "uuid"), ("", "change_seq", "bigint")],
        notes=["트리거만 씀 · 최신 버전 = 현재 행", "고치거나 지우는 계정 없음"])
    f.table("publication.reference_family", 936, y5, 248, "API 계약의 15종과 읽는 쪽이다. 나머지 종류는 나가지 않는다.", [
        ("PK", "family", "text"), ("", "audience", "=collect|analyze")], notes=["수집 5종 · 분석 10종"])
    f.fk("source_override_event", "skey", "source_override", to="skey")
    f.fk("reference_item", "set_id", "reference_set")
    f.fk("api_key", "client_id", "api_client")
    f.fk("api_client_project", "client_id", "api_client")

    gx, gy, gh = 936, y2, 266
    access_y, grant_y = f["reference_access"].row("access_seq"), f["api_client_project"].row("grant_seq")
    g = [f'<rect class="vgrp" x="{gx}" y="{gy}" width="248" height="{gh}" rx="8"/>',
         f'<text class="m b" x="{gx + 16}" y="{gy + 26}">ext.*<tspan class="mu" dx="10">API 계약 · 뷰 7개</tspan></text>',
         f'<text class="mu sm" x="{gx + 16}" y="{gy + 46}">hmg_ext_api만 SELECT · security_barrier</text>']
    for i, name in enumerate(("caller", "meta", "codes", "projects", "prompts", "reference_sets", "reference_items")):
        g.append(f'<text class="m" x="{gx + 16 + 116 * (i % 2)}" y="{gy + 78 + 20 * (i // 2)}">{name}</text>')
    g += [f'<text class="mu sm" x="{gx + 16}" y="{gy + 160}">트랜잭션마다 hgh.key_hash =</text>',
          f'<text class="mu sm" x="{gx + 16}" y="{gy + 178}">키 원문의 sha256</text>',
          f'<text class="mu sm" x="{gx + 16}" y="{gy + 204}">키가 없거나 틀리면 모든 뷰 0행</text>',
          f'<text class="mu sm" x="{gx + 16}" y="{gy + 230}">읽는 곳: catalog.current_* ·</text>',
          f'<text class="mu sm" x="{gx + 16}" y="{gy + 248}">current_reference · publication.*</text>',
          f'<path class="e" d="M896,{grant_y}H{gx}" marker-end="url(#ext-a)"/>',
          f'<text class="mu sm" x="916" y="{grant_y - 8}" text-anchor="middle">허용분</text>',
          f'<path class="e" d="M896,{access_y}H916V{gy + 30}H{gx}" marker-end="url(#ext-a)"/>',
          f'<text class="mu sm" x="906" y="{access_y - 8}" text-anchor="middle">승인분</text>']
    f.raw("\n".join(g))
    return f


def ga4_registry_week() -> Figure:
    """geohub_bm_db: the GA4 properties and the service week, back/hub_storage/input-003.sql."""
    f = Figure("ga4reg", 660, "입력 DB의 GA4 속성과 서비스 기준 주. 관리자가 고치는 속성 등록부 ga4_registry와 그 변경 이력, 수집기가 속성마다 남기는 마지막 결과 ga4_collect_status, "
               "바뀔 때만 한 행을 쌓는 service_week다. 수집기가 등록부를 geohub_gold_db의 ga4_property로 복사한다.")
    f.table("catalog.ga4_registry_event", 70, 40, 300, "등록부의 변경 이력이다. changes는 {필드: [전, 후]}이고 지우지 않는다.", [
        ("PK", "event_id", "bigint"), ("FK", "property_id", "text"), ("", "action", "=create|update|stop|resume"),
        ("", "actor_id", "⇢ user_account"), ("", "changes", "jsonb"), ("", "occurred_at", "timestamptz")])
    f.table("catalog.ga4_registry", 420, 40, 330, "관리자가 Admin › GA4 연동에서 정하는 수집 대상 속성과 시장·전환 기준이다.", [
        ("PK", "property_id", "text (숫자)"), ("", "brand", "=Hyundai|Kia|Genesis"), ("", "country", "text (ISO-2)"),
        ("", "conv_basis", "=1|2"), ("", "conv_events", "text[] (2일 때 1~50개)"), ("", "enabled", "boolean"),
        ("", "account_id", "text null (숫자)"), ("", "account_name", "text null"),
        ("", "created_at", "timestamptz"), ("", "updated_at", "timestamptz")],
        notes=["UK (brand, country) WHERE enabled", "⇢ Gold DB ga4_property (수집기가 복사)"])
    f.table("catalog.ga4_collect_status", 800, 40, 300, "수집기가 속성마다 남기는 마지막 실행 결과이고, 실행마다 바뀐다.", [
        ("PK FK", "property_id", "text"), ("", "checked_at", "timestamptz"),
        ("", "status", "=collected|pending_grant|failed|stopped"), ("", "error", "text (≤500)"),
        ("", "collected_at", "timestamptz"), ("", "collected_to", "date")])
    f.fk("ga4_registry_event", "property_id", "ga4_registry", to="property_id")
    f.fk("ga4_collect_status", "property_id", "ga4_registry", to="property_id")
    f.table("catalog.service_week", 70, 370, 300, "화면이 Gold를 읽는 마지막 주와 회차다. 바뀔 때만 한 행을 쌓고, 지우지 않는다.", [
        ("PK", "seq", "bigint identity"), ("", "week_start", "date (월요일)"), ("", "global_cycles", "uuid[]"),
        ("", "website_cycles", "uuid[]"), ("", "gold_release", "jsonb"), ("", "gold_versions", "jsonb"),
        ("", "recorded_at", "timestamptz"), ("", "checked_at", "timestamptz")],
        notes=["최신 행 = current_service_week 뷰", "같은 주를 다시 확인하면 checked_at만"])
    return f


def metrics() -> Figure:
    """geohub_gold_db gold (the rollup job's tables): back/hub_storage/metrics-001.sql · 002 · 003; geohub_cache_db cache: cache-001.sql; SSOT service/cache-db.md."""
    f = Figure("metrics", 950, "geohub_cache_db의 cache 스키마와 geohub_gold_db의 사전 집계 테이블. 정본이 아니어서 지워져도 운영 스냅샷에서 다시 만든다.")
    f.table("cache.query_result", 16, 40, 320, "필터 조회 결과다. 조회 조건마다 한 행이고 UNLOGGED이며 백업하지 않는다.", [
        ("PK", "cache_key", "text sha256"), ("", "snapshot_id", "text"), ("", "definition_version", "text"), ("", "query", "jsonb"),
        ("", "result", "jsonb"), ("", "created_at", "timestamptz")],
        notes=["키 = 조회 조건 + 스냅샷 ID + 정의 버전", "TTL 없음 · 새 운영 스냅샷에 이전 행 삭제"])
    f.table("gold.schema_migration", 376, 40, 240, "이 DB에 적용한 마이그레이션 파일과 체크섬을 기록한다.", [
        ("PK", "version", "text"), ("", "sha256", "text"), ("", "installed_at", "timestamptz")])
    f.table("cache.schema_migration", 696, 240, 240, "캐시 DB에 적용한 마이그레이션 파일과 체크섬을 기록한다.", [
        ("PK", "version", "text"), ("", "sha256", "text"), ("", "installed_at", "timestamptz")], key="cache_schema_migration")
    f.table("gold.first_screen_read", 16, 320, 320, "지표가 아닌 첫 화면 목록(프롬프트 · 필터 옵션 등)의 /v1 응답 한 건. 스냅샷 ID와 정의 버전이 지금과 같을 때만 화면에 나간다.", [
        ("PK", "read_key", "text sha256"), ("", "surface", "text"), ("", "path", "text"), ("", "query", "text"), ("", "snapshot_id", "text"),
        ("", "definition_version", "text"), ("", "result", "jsonb null"), ("", "error", "text null"), ("", "computed_at", "timestamptz")],
        notes=["result · error 중 하나만 있다", "실패로 남으면 그 구역은 보이지 않는다"])
    f.table("gold.rollup_run", 376, 320, 300, "사전 집계 작업의 기록이다. 표면마다 어느 스냅샷 · 정의 버전으로 돌았는지 남긴다.", [
        ("PK", "run_id", "bigint"), ("", "surface", "text"), ("", "snapshot_id", "text"), ("", "definition_version", "text"), ("", "started_at", "timestamptz"),
        ("", "finished_at", "timestamptz null"), ("", "status", "text"), ("", "reads", "int null"), ("", "failed", "int null"), ("", "note", "text null")])
    f.table("gold.metric_row", 16, 620, 320, "회차의 차원 조합 한 건: 기본 집계값과 지표 값. 화면은 집계값을 읽어 지표 함수로 계산한다.", [
        ("PK", "surface", "text"), ("PK", "project_key", "int"), ("PK", "round_date", "date"), ("PK", "call", "text"), ("PK", "scope", "text"), ("PK", "ord", "int"),
        ("", "dims", "jsonb"), ("", "counts", "jsonb"), ("", "metrics", "jsonb"), ("", "snapshot_id", "text"), ("", "definition_version", "text"), ("", "computed_at", "timestamptz")])
    f.table("gold.metric_call", 376, 620, 300, "회차의 집계 호출이 어느 스냅샷 · 정의 버전으로 계산됐는지. 다르거나 실패면 그 회차 값은 보이지 않는다.", [
        ("PK", "surface", "text"), ("PK", "project_key", "int"), ("PK", "round_date", "date"), ("PK", "call", "text"), ("PK", "scope", "text"),
        ("", "snapshot_id", "text"), ("", "definition_version", "text"), ("", "row_count", "int"), ("", "error", "text null"), ("", "computed_at", "timestamptz")])
    gy = 40
    g = [f'<rect class="vgrp" x="696" y="{gy}" width="488" height="170" rx="8"/>',
         f'<text class="m b" x="712" y="{gy + 26}">계정<tspan class="mu" dx="10">다른 파트에 열지 않는다</tspan></text>',
         f'<text class="m" x="712" y="{gy + 58}">hmg_metrics_reader</text><text class="mu sm" x="882" y="{gy + 58}">BFF 읽기 · geohub_gold_db SELECT</text>',
         f'<text class="m" x="712" y="{gy + 82}">hmg_cache_writer</text><text class="mu sm" x="882" y="{gy + 82}">BFF 캐시 · geohub_cache_db 읽기 · 쓰기</text>',
         f'<text class="m" x="712" y="{gy + 106}">hmg_rollup_writer</text><text class="mu sm" x="882" y="{gy + 106}">사전 집계 작업 · 테이블 4개만 쓰기</text>',
         f'<text class="mu sm" x="712" y="{gy + 142}">API는 hmg_rollup_writer를 받지 않는다</text>']
    f.raw("\n".join(g))
    return f


def ga4() -> Figure:
    """geohub_gold_db GA4: back/hub_storage/metrics-004.sql (back/analytics/schema.sql, operations.sql)."""
    f = Figure("ga4", 510, "geohub_gold_db의 GA4 테이블 ERD. ga4_row와 ga4_users_window가 ga4_property를 가리키고, "
               "차원 키는 kind별로 ga4_value를 가리킨다. ga4_property는 수집기가 입력 DB의 등록부에서 복사한다.")
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
    """geohub_gold_db SEO and build bookkeeping: back/hub_storage/metrics-004.sql."""
    f = Figure("seo", 610, "geohub_gold_db의 SEO 테이블과 ops 스키마 ERD. page_* 표는 빌드별로 쌓이고, "
               "ops.seo_active_build가 프로젝트·날짜마다 보여 줄 빌드를 정한다.")
    f.table("ops.build", 16, 40, 250, "SEO 데이터 빌드 한 번당 한 행으로, 규칙 버전·상태·검증 결과를 담는다.", [
        ("PK", "build_id", "bigint"), ("", "family", "text"), ("", "slice_key", "text"),
        ("", "status", "=pending|running|validated|failed"),
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
    """geohub_gold_db ref dictionaries: back/hub_storage/metrics-004.sql."""
    f = Figure("ref", 672, "geohub_gold_db의 ref 사전 ERD. URL은 출처와 자사 기준 주소를, 출처는 분류와 경쟁 브랜드를, "
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


FIGURES = (operations, catalog, external, ga4_registry_week, ga4, seo, ref, metrics)


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
