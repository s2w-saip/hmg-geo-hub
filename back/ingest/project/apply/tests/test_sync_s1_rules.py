"""동기화 S1 BE-A(hmg-geo 7639b9e..2670a16) 적재 규칙: 현행 규칙과 값 동치를 합성 데이터 경계로 확인한다.

  BE-1 한국어 비-KR 제외 = 태그 우선(#302 ③): 한국어 ∧ region ≠ 'KR' ∧ (태그 없음 ∨ measured_at < 2026-08-19T00:00Z ∨ measured_at NULL)
       일 때만 뺀다. 태그 있음 ∧ 태깅 이후는 태그 술어가 판정(hmg-geo@2670a16 scripts/summary/global-predicates.ts koreanNonKrPred :65·
       regionTagPred :89, lib/db/repositories/scope-aggregates.ts rootKoreanNonKrPred :1076-1110, 경계 lib/scope/region-tagging.ts:17).

  BE-2 표준 숨김 국가 비움(#302 ①, ID 숨김 해제): app.hidden_market('global','ID') 삭제 + judgment_change 'hidden_market'
       (hmg-geo@2670a16 lib/scope/hidden-regions.ts:31 = []). 1회 보정 SQL(back/migration/fix-sync-s1-rules.sql)과 같은 편집이다.

  BE-3 자사 base 접두 5건 국가 경로로 단축(#313): kia.com/au/en→kia.com/au, kia.com/it/it→kia.com/it, kia.com/tr/anasayfa→kia.com/tr,
       kia.com/my/en→kia.com/my, hyundai.com/cz/cz→hyundai.com/cz(hmg-geo@2670a16 lib/geo-catalog/owned.ts:83-91 OWNED_BASE_URL_FIXES).
       rd.dim_url.owner_key 가 app.owned_base 를 FK 로 참조하므로 prefix 제자리 UPDATE(키 보존) + judgment_change 'owned_base'.

경로는 운영과 같다: 앱·원천 편집(슈퍼유저 + 행위자 GUC) → app.judgment_change → run_queue(loader 롤) → rd. 기대값은 현행 술어를
3치 논리 그대로 옮긴 오라클(_elig)과 bulk 시드(seed-30·40) 둘 다와 대조한다. 커밋 경로라 일회 DB(fresh_db).
"""
from __future__ import annotations

import datetime as dt
import json
import re
import uuid
from pathlib import Path

import asyncpg

from ingest.common.db import LoaderDB, begin_load, finalize
from ingest.cycles.workers.service import run_queue
from ingest.project.apply.service import apply
from ingest.testkit import EQ_TABLES, bulk_equivalence
from tests.support import needs_db

SEED = Path(__file__).resolve().parents[4] / "migration" / "seed"

ACTOR = "5eed0000-0000-4000-8000-000000000001"
CUTOFF = dt.datetime(2026, 8, 19, tzinfo=dt.UTC)            # hmg-geo lib/scope/region-tagging.ts:17 REGION_TAGGING_CUTOFF_ISO
US_1 = dt.timedelta(microseconds=1)
RUN1 = "e0000000-0000-4000-8000-000000000001"               # 루트 프로젝트 completed run(회차 11, 09-14)
SP1 = "b0000000-0000-4000-8000-000000000001"                # 영어·카탈로그(Hyundai·Genesis)
SP3 = "b0000000-0000-4000-8000-000000000003"                # ACR·카탈로그
SP4 = "b0000000-0000-4000-8000-000000000004"                # 한국어·카탈로그(현대 SUV 추천)
HANGUL = re.compile(r"[가-힣]")


# ── 현행 술어(3치 논리) ─────────────────────────────────────────────────────────
def _and(*xs):
    if any(x is False for x in xs):
        return False
    return None if any(x is None for x in xs) else True


def _or(*xs):
    if any(x is True for x in xs):
        return True
    return None if any(x is None for x in xs) else False


def _not(x):
    return None if x is None else not x


def _ne(a, b):
    return None if a is None else a != b


def _in(a, arr):
    return None if a is None else a in arr


def _root_gate(r, hidden: set[str], measured: dt.datetime | None) -> bool | None:
    """글로벌 표면 게이트: 카탈로그 ∧ 숨김 국가 아님 ∧ 한국어 비-KR(태그 우선) ∧ 태그 시장 안. 입력 r = 원천 값."""
    region, tags = r["region"], r["regions"]
    untagged = tags is None or len(tags) == 0
    hidden_ok = (None if hidden else True) if region is None else (region not in hidden)      # rootHiddenRegionsExclusion(NOT IN)
    kor_ok = _not(_and(_ne(region, "KR"), r["korean"],                                         # koreanNonKrPred
                       _or(measured is None, measured is not None and measured < CUTOFF, untagged)))
    tag_ok = _or(untagged, _in(region, tags or []))                                            # regionTagPred
    return _and(r["in_cat"], hidden_ok, kor_ok, tag_ok)


def _elig(r, hidden: set[str]) -> bool:
    v = _and(r["run_status"] in ("completed", "partial_failed"), _or(r["surface"] != 1, _root_gate(r, hidden, r["measured_at"])))
    return v is True                                                                          # WHERE 문맥: NULL = 제외


def _acr_in(r, hidden: set[str]) -> bool:
    v = _and(r["run_status"] in ("completed", "partial_failed"), r["kind"] == "acr",
             _or(r["surface"] != 1, _root_gate(r, hidden, r["measured_at"])))
    return v is True


# ── DB 도우미 ─────────────────────────────────────────────────────────────────
async def _app(url: str, sql: str) -> None:
    """앱·원천 편집(행위자 GUC). 픽스처 적재 때 트리거가 남긴 대기 요청은 적용 완료로 치운다(test_queue 와 같은 규약)."""
    c = await asyncpg.connect(url)
    try:
        async with c.transaction():
            await c.execute("UPDATE app.judgment_change SET status = 'applied', applied_at = now() WHERE status = 'pending' AND requested_at < now()")
            await c.execute(f"SELECT set_config('app.actor_id', '{ACTOR}', true), set_config('app.actor_type', 'system', true)")
            await c.execute(sql)
    finally:
        await c.close()


async def _fetch(url: str, sql: str, *a):
    c = await asyncpg.connect(url)
    try:
        return await c.fetch(sql, *a)
    finally:
        await c.close()


async def _drain(url: str) -> None:
    out = await run_queue(LoaderDB(url, role="loader"))
    assert out and all(o.status == "applied" for o in out), out


async def _load(url: str, job_ids: list[uuid.UUID]) -> None:
    """새 답변 적재 경로(pull 과 같은 apply(바뀐 job) + finalize, loader 롤). 인용 URL 차원(dim_url·owner_key)은 이 경로가 발급한다."""
    db = LoaderDB(url, role="loader")
    async with db.session() as c, db.tx(c):
        keys = [r[0] for r in await c.fetch("SELECT answer_key FROM ing.answer_key_map WHERE job_id = ANY($1::uuid[])", job_ids)]
        ctx = await begin_load(c, "run", scope_ref={"test": "sync_s1"})
        await apply(c, ctx, keys)
        await finalize(c, ctx)


async def _assert_bulk_equal(url: str) -> None:
    strict, referenced = await bulk_equivalence(url, EQ_TABLES)
    assert not strict, {t: (v["len"], v["only_a"][:2], v["only_b"][:2]) for t, v in strict.items()}
    assert not referenced, referenced


ROOT_CAT = """EXISTS (SELECT 1 FROM app.prompt ap JOIN app.project pr ON pr.project_id = ap.project_id AND pr.kind = 'standard_root'
                      WHERE ap.deleted_at IS NULL AND ap.scope_prompt_id = {col})"""
ANSWERS = f"""
SELECT a.job_id, a.region, a.measured_at, r.status AS run_status, j.surface, ip.text, ip.regions, ra.elig,
       {ROOT_CAT.format(col='a.prompt_id')} AS in_cat
  FROM ing.answer a JOIN ing.run r ON r.run_id = a.run_id
  JOIN rd.job j ON j.job_id = a.job_id
  JOIN rd.answer ra ON ra.surface = j.surface AND ra.round_date = j.round_date AND ra.answer_key = j.answer_key
  LEFT JOIN ing.prompt ip ON ip.scope_prompt_id = a.prompt_id
"""
ACR_CELLS = f"""
SELECT p.prompt_run_id, p.region, p.measured_at, r.status AS run_status, dp.surface, ip.text, ip.regions, d.kind, c.acr_in,
       {ROOT_CAT.format(col='p.prompt_id')} AS in_cat
  FROM ing.acr_prompt_run p JOIN ing.run r ON r.run_id = p.run_id
  JOIN rd.dim_project dp ON dp.scope_project_id = r.scope_project_id
  JOIN rd.acr_cell c ON c.acr_cell_key = p.acr_cell_key
  LEFT JOIN rd.dim_prompt d ON d.prompt_id = p.prompt_id
  LEFT JOIN ing.prompt ip ON ip.scope_prompt_id = p.prompt_id
"""


def _row(r) -> dict:
    d = dict(r)
    d["korean"] = bool(d["text"] and HANGUL.search(d["text"]))
    d["regions"] = list(d["regions"]) if d["regions"] is not None else None
    return d


async def _hidden(url: str) -> set[str]:
    return {r[0] for r in await _fetch(url, "SELECT country_code FROM app.hidden_market WHERE surface = 'global'")}


async def _assert_oracle(url: str) -> tuple[dict, dict]:
    """rd.answer.elig·rd.acr_cell.acr_in 전부 = 현행 술어. 반환 = (job_id → elig, prompt_run_id → acr_in)."""
    hidden = await _hidden(url)
    ans = [_row(r) for r in await _fetch(url, ANSWERS)]
    acr = [_row(r) for r in await _fetch(url, ACR_CELLS)]
    bad = [(str(r["job_id"]), r["region"], r["measured_at"], r["regions"], r["elig"], _elig(r, hidden)) for r in ans
           if r["elig"] is not _elig(r, hidden)]
    assert not bad, bad
    bad = [(str(r["prompt_run_id"]), r["region"], r["measured_at"], r["regions"], r["acr_in"], _acr_in(r, hidden)) for r in acr
           if r["acr_in"] is not _acr_in(r, hidden)]
    assert not bad, bad
    return {r["job_id"]: r["elig"] for r in ans}, {r["prompt_run_id"]: r["acr_in"] for r in acr}


# ── BE-1 ────────────────────────────────────────────────────────────────────
REGIONS = ("KR", "US", "DE", "kr", None, "ID")
MEASURED: tuple[dt.datetime | None, ...] = (None, CUTOFF - US_1, CUTOFF, CUTOFF + US_1, dt.datetime(2026, 9, 14, 1, tzinfo=dt.UTC))
ACR_REGIONS = ("KR", "US", None)
ACR_MEASURED: tuple[dt.datetime | None, ...] = (None, CUTOFF - US_1, CUTOFF)


def _jid(prefix: str, i: int) -> str:
    return f"{prefix}-0000-4000-8000-{i:012d}"


def _lit(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, dt.datetime):
        return f"TIMESTAMPTZ '{v.isoformat()}'"
    return "'" + str(v).replace("'", "''") + "'"


def _be1_grid() -> tuple[str, dict[tuple, uuid.UUID], dict[tuple, uuid.UUID]]:
    """SP4(한국어) 답변 격자 region × measured_at, SP3(한국어로 바꾼 ACR) prompt-run 격자. 합성(고객 데이터 아님)."""
    rows, acr, jobs, runs = [], [], {}, {}
    for i, (reg, mat) in enumerate(((r, m) for r in REGIONS for m in MEASURED), 1):
        jid = _jid("9a000000", i)
        jobs[(reg, mat)] = uuid.UUID(jid)
        rows.append(f"('{jid}', {_lit(reg)}, {_lit(mat)})")
    for i, (reg, mat) in enumerate(((r, m) for r in ACR_REGIONS for m in ACR_MEASURED), 1):
        pid = _jid("9a100000", i)
        runs[(reg, mat)] = uuid.UUID(pid)
        acr.append(f"('{pid}', {_lit(reg)}, {_lit(mat)})")
    sql = f"""
UPDATE ing.prompt SET text = 'ACR 추천 질문' WHERE scope_prompt_id = '{SP3}';
CREATE TEMP TABLE _g (job_id uuid, region text, measured_at timestamptz) ON COMMIT DROP;
INSERT INTO _g VALUES {", ".join(rows)};
INSERT INTO ing.answer_key_map (job_id, run_month) SELECT job_id, '2026-09-01' FROM _g;
INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, analysis_status,
                        n_mentions, n_citations, content_hash, load_id)
SELECT '2026-09-01', g.job_id, k.answer_key, '{RUN1}', '{SP4}', 'chatgpt', g.region, 'completed', g.measured_at, 'completed', 0, 0, '\\x0a', 1
  FROM _g g JOIN ing.answer_key_map k ON k.job_id = g.job_id;
INSERT INTO ing.acr_prompt_run (prompt_run_id, run_id, prompt_id, target, region, measured_at, planned_iterations, valid_turn1_iterations,
                                valid_acr_iterations, acr_summary, load_id)
SELECT v.p::uuid, '{RUN1}', '{SP3}', 'gemini', v.r, v.m::timestamptz, 1, 1, 1, '{{}}', 1
  FROM (VALUES {", ".join(acr)}) v(p, r, m);
"""
    return sql, jobs, runs


def _tag_sql(tags: list[str] | None) -> str:
    lit = "NULL" if tags is None else "ARRAY[" + ", ".join(f"'{t}'" for t in tags) + "]::text[]"
    return f"""
UPDATE ing.prompt SET regions = {lit} WHERE scope_prompt_id IN ('{SP3}', '{SP4}');
INSERT INTO app.judgment_change (kind, subject_uuids, requested_by) VALUES ('scope_prompt', ARRAY['{SP3}', '{SP4}']::uuid[], app.actor());"""


@needs_db
async def test_be1_korean_non_kr_tag_priority(fresh_db):
    """태그 상태 5종(NULL·[]·[KR]·[US]·[KR,US]) × region 6종 × measured_at 5종(NULL·경계 직전·경계·직후·09-14) 답변과 ACR prompt-run 을
    Scope 태그 변경과 같은 경로(scope_prompt 재판정)로 다시 투영할 때마다 rd = 현행 술어 = bulk 시드."""
    grid, jobs, runs = _be1_grid()
    seen: dict[str, tuple[dict, dict]] = {}
    for i, tags in enumerate((None, [], ["KR"], ["US"], ["KR", "US"])):
        await _app(fresh_db, (grid if i == 0 else "") + _tag_sql(tags))
        await _drain(fresh_db)
        seen[str(tags)] = await _assert_oracle(fresh_db)
        await _assert_bulk_equal(fresh_db)

    def e(tags, reg, mat):
        return seen[str(tags)][0][jobs[(reg, mat)]]

    after, sept = CUTOFF + US_1, MEASURED[-1]
    # 태그 없음: 한국어 비-KR 은 측정 시각과 무관하게 제외(종전과 같음), KR 은 서빙
    assert [e(None, "US", m) for m in MEASURED] == [False] * 5 and [e([], "US", m) for m in MEASURED] == [False] * 5
    assert e(None, "KR", sept) is True
    # 태그 [US]: 경계 이후 US 셀이 보인다(종전 규칙은 영구 제외). 경계 직전·NULL 은 여전히 제외, KR 은 태그 밖이라 제외
    assert [e(["US"], "US", m) for m in MEASURED] == [False, False, True, True, True]
    assert e(["US"], "KR", sept) is False and e(["US"], "DE", after) is False
    # 태그 [KR, US]: KR·US(경계 이후) 둘 다, 소문자 'kr' 은 비-KR 이고 태그 밖(현행 대소문자 비교 그대로)
    assert e(["KR", "US"], "KR", MEASURED[1]) is True and e(["KR", "US"], "US", CUTOFF) is True
    assert all(e(t, "kr", m) is False for t in (None, ["KR"], ["KR", "US"]) for m in MEASURED)
    # region NULL: 숨김 국가(ID)가 있는 동안 제외(NOT IN 3치), 숨김 ID 셀은 태그와 무관하게 제외
    assert all(e(t, None, m) is False for t in (None, ["US"]) for m in MEASURED)
    assert all(e(t, "ID", m) is False for t in (None, ["US"]) for m in MEASURED)
    # ACR: prompt-run measured_at 으로 같은 경계
    assert [seen[str(["US"])][1][runs[("US", m)]] for m in ACR_MEASURED] == [False, False, True]
    assert [seen[str(None)][1][runs[("US", m)]] for m in ACR_MEASURED] == [False, False, False]
    assert all(seen[str(["KR", "US"])][1][runs[("KR", m)]] for m in ACR_MEASURED)


# ── BE-2 ────────────────────────────────────────────────────────────────────
K7 = uuid.UUID("90000000-0000-4000-8000-000000000007")      # 픽스처: SP1 × chatgpt × ID(09-14), 숨김 국가라 모수 밖


@needs_db
async def test_be2_id_hidden_market_lifted(fresh_db):
    """숨김 해제 편집 → ID 답변과 region NULL 답변(숨김 국가가 하나라도 있으면 NOT IN 3치로 빠지던 답변)이 모수에 들어온다.
    rd.dim_country.hidden_standard 도 풀린다(/v1/filters/options 의 global 숨김 = hidden_standard). 나머지 답변 불변, rd = 현행 술어 = bulk."""
    nul = uuid.UUID(_jid("9b000000", 1))
    await _app(fresh_db, f"""
INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ('{nul}', '2026-09-01');
INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, analysis_status,
                        n_mentions, n_citations, content_hash, load_id)
SELECT '2026-09-01', k.job_id, k.answer_key, '{RUN1}', '{SP1}', 'gemini', NULL, 'completed', TIMESTAMPTZ '2026-09-14 04:00+00', 'completed',
       0, 0, '\\x0b', 1
  FROM ing.answer_key_map k WHERE k.job_id = '{nul}';
INSERT INTO app.judgment_change (kind, subject_uuids, requested_by) VALUES ('scope_prompt', ARRAY['{SP1}']::uuid[], app.actor());""")
    await _drain(fresh_db)
    before, _ = await _assert_oracle(fresh_db)
    assert before[K7] is False and before[nul] is False
    await _app(fresh_db, """
DELETE FROM app.hidden_market WHERE surface = 'global' AND upper(country_code) = 'ID';
INSERT INTO app.judgment_change (kind, subject_texts, requested_by) VALUES ('hidden_market', ARRAY['ID'], app.actor());""")
    await _drain(fresh_db)
    after, _ = await _assert_oracle(fresh_db)
    assert {j: v for j, v in after.items() if v != before.get(j)} == {K7: True, nul: True}
    hid = await _fetch(fresh_db, "SELECT code, hidden_standard FROM rd.dim_country WHERE hidden_standard OR upper(code) = 'ID'")
    assert [(r[0], r[1]) for r in hid] == [("ID", False)]
    await _assert_bulk_equal(fresh_db)


def test_be2_seed_has_no_hidden_market():
    """시드(재생성본)도 같은 상태: ts-dump hidden_regions = [] 이고 seed-10 은 app.hidden_market 을 비운 채 두며 0행을 단언한다."""
    assert json.loads((SEED / "ts-dump.json").read_text(encoding="utf-8"))["hidden_regions"] == []
    s10 = (SEED / "seed-10-app.sql").read_text(encoding="utf-8")
    assert "INSERT INTO app.hidden_market" not in s10
    assert "FROM app.hidden_market;       IF v <> 0 THEN" in s10


# ── BE-3 ────────────────────────────────────────────────────────────────────
OWNED_FIXES = (("kia.com/au/en", "kia.com/au"), ("kia.com/it/it", "kia.com/it"), ("kia.com/tr/anasayfa", "kia.com/tr"),
               ("kia.com/my/en", "kia.com/my"), ("hyundai.com/cz/cz", "hyundai.com/cz"))
# (url, 전 base, 후 base): 접두 경계(/·.html·정확히 같음·비슷한 이름): base = 그 URL 을 소유하는 app.owned_base 의 옛 prefix(None = 자사 아님)
CITES = (
    ("https://www.kia.com/au/cars/ev9", None, "kia.com/au/en"),
    ("https://www.kia.com/au/en/owners", "kia.com/au/en", "kia.com/au/en"),
    ("https://www.kia.com/au", None, "kia.com/au/en"),
    ("https://www.kia.com/au.html", None, "kia.com/au/en"),
    ("https://www.kia.com/aux/foo", None, None),
    ("https://www.kia.com/tr/anasayfa.html", "kia.com/tr/anasayfa", "kia.com/tr/anasayfa"),
    ("https://www.kia.com/tr/modeller/sportage", None, "kia.com/tr/anasayfa"),
    ("https://www.hyundai.com/cz/prodej", None, "hyundai.com/cz/cz"),
    ("https://www.kia.com/it/it/modelli", "kia.com/it/it", "kia.com/it/it"),
    ("https://www.kia.com/my/showroom", None, "kia.com/my/en"),
    ("https://www.hyundai.com/cz/cz.html", "hyundai.com/cz/cz", "hyundai.com/cz/cz"),
    ("https://www.hyundai.com/czech", None, None),
)
OWNED_UPDATE = """
UPDATE app.owned_base o SET prefix = f.new FROM (VALUES {vals}) f(old, new) WHERE o.kind = 'base' AND o.prefix = f.old;
INSERT INTO app.judgment_change (kind, subject_texts, requested_by) VALUES ('owned_base', ARRAY[{news}], app.actor());"""


async def _owners(url: str, job: uuid.UUID) -> list[int]:
    return [r[0] for r in await _fetch(url, """SELECT c.owner_key FROM rd.job j JOIN rd.citation c ON c.surface = j.surface
                                                 AND c.round_date = j.round_date AND c.answer_key = j.answer_key
                                                WHERE j.job_id = $1 ORDER BY c.ord""", job)]


async def _own_cols(url: str, job: uuid.UUID) -> tuple:
    r = (await _fetch(url, """SELECT a.cit_n, a.cit_own_h, a.cit_own_k, a.cit_own_kc, a.cit_own_hc, a.cit_own_x FROM rd.job j
                               JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
                              WHERE j.job_id = $1""", job))[0]
    return tuple(r)


@needs_db
async def test_be3_owned_base_prefixes_in_place(fresh_db):
    """글로벌 Kia AU 답변의 인용 12건: 접두 제자리 UPDATE + 'owned_base' 재판정 뒤 섹션 URL(/cars·/modeller·/prodej)·국가 루트·'.html' 동치가
    자사로 들어오고 비슷한 이름(/aux·/czech)은 밖에 남는다. owner_key 는 보존(FK 안전)되고 답변의 자사 인용 수 열이 같이 움직인다. rd = bulk."""
    job = uuid.UUID(_jid("9c000000", 1))
    cites = ", ".join(f"({i}, '{u}', '{u.split('/')[2].removeprefix('www.')}')" for i, (u, _, _) in enumerate(CITES, 1))
    await _app(fresh_db, f"""
INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ('{job}', '2026-09-01');
INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, analysis_status,
                        n_mentions, n_citations, content_hash, load_id)
SELECT '2026-09-01', k.job_id, k.answer_key, '{RUN1}', '{SP1}', 'chatgpt', 'AU', 'completed', TIMESTAMPTZ '2026-09-14 04:00+00', 'completed',
       0, {len(CITES)}, '\\x0c', 1
  FROM ing.answer_key_map k WHERE k.job_id = '{job}';
INSERT INTO ing.citation (run_month, job_id, ord, url, host, domain_label)
SELECT '2026-09-01', '{job}', v.o, v.u, v.h, v.h FROM (VALUES {cites}) v(o, u, h);""")
    await _load(fresh_db, [job])
    keys = {r[0]: r[1] for r in await _fetch(fresh_db, "SELECT prefix, owner_key FROM app.owned_base WHERE kind = 'base'")}
    n_ob = len(await _fetch(fresh_db, "SELECT 1 FROM app.owned_base"))
    assert await _owners(fresh_db, job) == [keys[b] if b else 0 for _, b, _ in CITES]
    assert await _own_cols(fresh_db, job) == (12, 1, 3, 1, 0, 3)

    vals = ", ".join(f"('{o}', '{n}')" for o, n in OWNED_FIXES)
    await _app(fresh_db, OWNED_UPDATE.format(vals=vals, news=", ".join(f"'{n}'" for _, n in OWNED_FIXES)))
    await _drain(fresh_db)
    after = {r[0]: r[1] for r in await _fetch(fresh_db, "SELECT prefix, owner_key FROM app.owned_base WHERE kind = 'base'")}
    assert all(after[n] == keys[o] and o not in after for o, n in OWNED_FIXES)          # 키 보존, 옛 접두 행 없음
    assert len(await _fetch(fresh_db, "SELECT 1 FROM app.owned_base")) == n_ob
    assert await _owners(fresh_db, job) == [keys[b] if b else 0 for _, _, b in CITES]
    # 자사 인용 수: Kia 3→8(AU 1→4), Hyundai 1→2, 답변 국가(AU) 밖 자사 3→6
    assert await _own_cols(fresh_db, job) == (12, 2, 8, 4, 0, 6)
    await _assert_bulk_equal(fresh_db)


def test_be3_seed_owned_prefixes():
    """시드(재생성본): 5건은 국가 경로 접두, 옛 접두 없음. 나머지 owned·root_home 행 수 그대로(170·40)."""
    d = json.loads((SEED / "ts-dump.json").read_text(encoding="utf-8"))
    prefixes = {e["prefix"] for e in d["owned"]}
    assert len(d["owned"]) == 170 and len(d["root_home"]) == 40
    assert all(n in prefixes and o not in prefixes for o, n in OWNED_FIXES)
    s10 = (SEED / "seed-10-app.sql").read_text(encoding="utf-8")
    assert all(f"('base', '{n}', " in s10 and f"('base', '{o}', " not in s10 for o, n in OWNED_FIXES)


# ── 1회 보정 SQL(back/migration/fix-sync-s1-rules.sql) 정적 정합 ───────────────
FIX = SEED.parent / "fix-sync-s1-rules.sql"
_FP_BLOCK = re.compile(r"CREATE TEMP TABLE _fp ON COMMIT DROP AS SELECT jsonb_build_object\(.*?\n\) AS fp;", re.S)


def test_fix_sql_matches_seed_and_rules():
    """보정 SQL 의 규칙 세트 지문 식 = seed-10 §6 블록(같으면 2670a16 시드를 다시 돌려도 같은 rule_set 행을 재사용한다),
    접두 5쌍 = 시험·시드와 같은 값, 태깅 경계 리터럴 = 적재 식(queries.py·seed-40)과 같은 값."""
    fix = FIX.read_text(encoding="utf-8")
    s10 = (SEED / "seed-10-app.sql").read_text(encoding="utf-8")
    fp_fix, fp_seed = _FP_BLOCK.findall(fix), _FP_BLOCK.findall(s10)
    assert len(fp_fix) == 1 and fp_fix == fp_seed
    pairs = re.search(r"INSERT INTO _fix VALUES (.*?);", fix, re.S)
    assert pairs is not None and tuple(re.findall(r"\('([^']+)', '([^']+)'\)", pairs.group(1))) == OWNED_FIXES
    lit = "TIMESTAMPTZ '2026-08-19 00:00:00+00'"
    q = (Path(__file__).resolve().parents[1] / "queries.py").read_text(encoding="utf-8")
    s40 = (SEED / "seed-40-facts.sql").read_text(encoding="utf-8")
    # 적재 식 = elig·acr_in(2) + elig_nc(DB-v2.15 P89, WU-4: 같은 식에서 카탈로그 항만 뺀 것) 1, 재계산 함수 rd.answer_elig_nc 1
    patch = (Path(__file__).resolve().parents[4] / "db" / "DB-v2.15-patch.sql").read_text(encoding="utf-8")
    assert (q.count(lit), s40.count(lit), fix.count(lit), patch.count(lit)) == (3, 3, 2, 1)
