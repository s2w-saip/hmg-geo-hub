"""WU-5 인용 판정 투영 스위치(현행 프로필 cit_hostless_per_row·web_owned_target_base) 전환용 재투영(이미 적재된 DB: stg·prod).

투영 스위치는 적재기 활성 프로필(HGH_LEGACY_PROFILE)로 새 적재에만 걸린다. 켜거나 끌 때 이미 적재된 답변 중 두 규칙의 결과가 **갈리는** 답변만
apply.reproject(적재기와 같은 경로·같은 트랜잭션 단언)로 다시 투영한다. 대상은 매번 ing·rd 에서 고르므로 멱등이다(같은 프로필로 두 번째 실행 =
대상은 같지만 값 변화 0). 규칙 방향과 무관하게 같은 대상(켬 → 끔 되돌림도 같은 도구).

  G21A cit_hostless_per_row  인용 행 자신의 도메인(ing.citation.domain_label)이 NULL·빈 값인데 URL 출처(rd.dim_url.source_key)는 있는 행을 가진 답변
                             (stg hmg_r2 2026-10-01: 'https://...' 3행 = 답변 3개)
  OWN4 web_owned_target_base 웹사이트 인용 중 '인용 base NORM ∈ 유닛 타겟 base NORM' 과 'tracked NORM ∈ rd.web_unit.turls' 가 다른 행을 가진 답변
                             (stg 2026-10-01: 자사 판정이 실제로 바뀌는 행 31, 타겟 항이 갈리는 답변 전체는 수천 = 보수적 대상)

**작성·로컬 시험만, stg·prod 실행은 제품 책임자 승인 배치**(DB 쓰기: 대상 답변의 rd 사실 행 삭제·재삽입). 드라이런이 기본(대상 수만 출력, 쓰기 없음).
사용(적재 워커와 같은 env, HGH_LEGACY_PROFILE 에 켤 스위치 포함, 적재 워커 정지 권장):
    python -m ingest.project.apply.wu5_reproject            # 드라이런: 스위치별 대상 답변 수
    python -m ingest.project.apply.wu5_reproject --commit   # 한 트랜잭션으로 재투영(loader 롤) → 결과 캐시는 적재 경로가 무효화 대상 표면을 올린다
뒤처리: 적재 경로와 같다(finalize: 바뀐 표면 세대 +1 → 결과 캐시 새 키). 규약대로 migrator 로 SELECT app.result_cache_invalidate(); 도 한다.
출력 = 개수만(답변 키·URL 없음). --commit 이면 재투영 전후를 job_id·ord 로 대조한 실제 변경 수도 낸다:
  citations_changed(인용 행 판정 열 중 하나라도 바뀐 행), citations_source_changed(출처 키), citations_hostless_flipped(호스트 있음 ↔ 없음 = G21A),
  citations_loc_owned_changed(자사 판정 = OWN4, stg 기대 31), citations_added_or_removed(0 이어야 한다), answers_changed(답변 인용 수 열).
  같은 프로필로 다시 돌리면 전부 0(멱등 확인).
진입점은 ingest.cli 와 같이 install_worker_settings() 로 워커 설정을 설치한다(없으면 API 설정 검증이 HGH_JWKS_URL 을 요구해 stg 에서 멈춘다).
"""
from __future__ import annotations

import argparse
import asyncio
import json
from typing import Any

import asyncpg

# 행 단위 도메인이 비었는데 URL 출처가 있는 인용을 가진 답변(두 규칙이 갈리는 행만)
G21A_KEYS = """
SELECT DISTINCT j.answer_key
  FROM ing.citation ic
  JOIN ing.answer_key_map m ON m.run_month = ic.run_month AND m.job_id = ic.job_id
  JOIN rd.job j ON j.job_id = ic.job_id
  JOIN rd.dim_url u ON ic.url IS NOT NULL AND u.url_hash = sha256(convert_to(ic.url, 'UTF8'))
 WHERE coalesce(ic.domain_label, '') = '' AND coalesce(u.source_key, 0) <> 0
"""
# 웹사이트 인용 중 타겟 항(base 규칙 대 tracked 규칙)이 갈리는 행을 가진 답변(유닛 = rd.web_unit, 타겟 base = turls 에서 쿼리·끝 '/' 제거 =
# queries.WEB_TGT_ON 과 같은 식). base·홈 항으로 이미 자사여서 최종 loc_owned 가 같은 행도 넣는다(방향 무관하게 되돌림까지 덮는 보수적 집합,
# 값이 같은 답변은 재투영해도 불변)
OWN4_KEYS = """
SELECT DISTINCT c.answer_key
  FROM rd.citation c
  JOIN rd.web_unit w ON w.unit_key = c.scope_key AND w.base IS NOT NULL
  JOIN rd.dim_url u ON u.url_key = c.url_key
 WHERE c.surface = 2
   AND (coalesce(u.url_base_norm, '') <> '' AND u.url_base_norm = ANY (ARRAY(SELECT rtrim(split_part(t, '?', 1), '/') FROM unnest(w.turls) t)))
       IS DISTINCT FROM (coalesce(u.url_norm, '') <> '' AND u.url_norm = ANY (w.turls))
"""


# 재투영 전후 대조(값이 실제로 바뀐 행 수 보고: stg 2026-10-01 실행에서 기대 31행을 확인할 수단이 없었다). 키 = job_id(자연 키) + ord,
# 재투영은 같은 job 의 행을 지우고 다시 넣으므로 정수 answer_key 도 같지만 job_id 로 잇는다.
KEYS_STAGE = """
DROP TABLE IF EXISTS _wu5_keys;
CREATE TEMP TABLE _wu5_keys (answer_key int4 PRIMARY KEY) ON COMMIT DROP;
"""
KEYS_FILL = "INSERT INTO _wu5_keys SELECT DISTINCT k FROM unnest($1::int4[]) k WHERE k IS NOT NULL"
BEFORE_CIT = """
DROP TABLE IF EXISTS _wu5_cit;
CREATE TEMP TABLE _wu5_cit ON COMMIT DROP AS
SELECT j.job_id, c.ord, c.source_key, c.loc_owned, c.tgt_hit, c.src_first, c.owner_key, c.url_key
  FROM rd.job j JOIN rd.citation c ON c.surface = j.surface AND c.round_date = j.round_date AND c.answer_key = j.answer_key
 WHERE j.answer_key IN (SELECT answer_key FROM _wu5_keys);
DROP TABLE IF EXISTS _wu5_ans;
CREATE TEMP TABLE _wu5_ans ON COMMIT DROP AS
SELECT j.job_id, a.cit_n, a.cit_n_all, a.cit_loc, a.cit_tgt, a.cit_loc_tgt, a.has_cit, a.tgt_cited, a.own_url_cited, a.cit_off,
       a.cit_c1, a.cit_c2, a.cit_c3, a.cit_c4, a.cit_c5, a.cit_c6, a.cit_c7, a.cit_c8, a.cit_c9, a.cit_c10, a.cit_c11, a.cit_c12, a.cit_c13
  FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
 WHERE j.answer_key IN (SELECT answer_key FROM _wu5_keys);
"""
CHANGED = """
WITH now_c AS (
  SELECT j.job_id, c.ord, c.source_key, c.loc_owned, c.tgt_hit, c.src_first, c.owner_key, c.url_key
    FROM rd.job j JOIN rd.citation c ON c.surface = j.surface AND c.round_date = j.round_date AND c.answer_key = j.answer_key
   WHERE j.answer_key IN (SELECT answer_key FROM _wu5_keys)),
cc AS (SELECT b.job_id AS bj, n.job_id AS nj, b.source_key AS bs, n.source_key AS ns, b.loc_owned AS bl, n.loc_owned AS nl,
              (b.source_key, b.loc_owned, b.tgt_hit, b.src_first, b.owner_key, b.url_key)
                IS DISTINCT FROM (n.source_key, n.loc_owned, n.tgt_hit, n.src_first, n.owner_key, n.url_key) AS any_diff
         FROM _wu5_cit b FULL JOIN now_c n ON n.job_id = b.job_id AND n.ord = b.ord),
now_a AS (
  SELECT j.job_id, a.cit_n, a.cit_n_all, a.cit_loc, a.cit_tgt, a.cit_loc_tgt, a.has_cit, a.tgt_cited, a.own_url_cited, a.cit_off,
         a.cit_c1, a.cit_c2, a.cit_c3, a.cit_c4, a.cit_c5, a.cit_c6, a.cit_c7, a.cit_c8, a.cit_c9, a.cit_c10, a.cit_c11, a.cit_c12, a.cit_c13
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key IN (SELECT answer_key FROM _wu5_keys))
SELECT (SELECT count(*) FROM cc WHERE any_diff) AS citations_changed,
       (SELECT count(*) FROM cc WHERE bj IS NOT NULL AND nj IS NOT NULL AND bs IS DISTINCT FROM ns) AS citations_source_changed,
       (SELECT count(*) FROM cc WHERE bj IS NOT NULL AND nj IS NOT NULL AND (bs <> 0) IS DISTINCT FROM (ns <> 0)) AS citations_hostless_flipped,
       (SELECT count(*) FROM cc WHERE bj IS NOT NULL AND nj IS NOT NULL AND bl IS DISTINCT FROM nl) AS citations_loc_owned_changed,
       (SELECT count(*) FROM cc WHERE bj IS NULL OR nj IS NULL) AS citations_added_or_removed,
       (SELECT count(*) FROM _wu5_ans b FULL JOIN now_a n ON n.job_id = b.job_id
         WHERE b.job_id IS NULL OR n.job_id IS NULL OR ROW(b.*) IS DISTINCT FROM ROW(n.*)) AS answers_changed
"""


async def affected_keys(conn: asyncpg.Connection) -> dict[str, list[int]]:
    return {"cit_hostless_per_row": sorted(int(r[0]) for r in await conn.fetch(G21A_KEYS)),
            "web_owned_target_base": sorted(int(r[0]) for r in await conn.fetch(OWN4_KEYS))}


async def run(conn: asyncpg.Connection, *, commit: bool) -> dict[str, Any]:
    """대상 계산(항상) + commit 이면 한 트랜잭션으로 apply.reproject. 호출자가 트랜잭션을 열지 않는다(이 함수가 연다)."""
    from ingest.common.db import begin_load, finalize
    from ingest.project.apply.service import reproject

    keys = await affected_keys(conn)
    out: dict[str, Any] = {k: len(v) for k, v in keys.items()}
    allk = sorted(set(keys["cit_hostless_per_row"]) | set(keys["web_owned_target_base"]))
    out["answers"] = len(allk)
    if not commit or not allk:
        return out
    async with conn.transaction():
        ctx = await begin_load(conn, "rebuild", scope_ref={"tool": "wu5_reproject"})
        await conn.execute(KEYS_STAGE)
        await conn.execute(KEYS_FILL, allk)
        await conn.execute(BEFORE_CIT)
        res = await reproject(conn, ctx, allk)
        out.update({k: int(v) for k, v in dict(await conn.fetchrow(CHANGED)).items()})
        ctx.rd_changed = True                          # 적재 경로와 같은 끝: 바뀐 표면 세대 +1(결과 캐시 키), ing.load committed
        ctx.surfaces |= set(res.surfaces) or {1, 2, 3}
        out["reprojected"] = int(res.answers)
        out["generations"] = await finalize(conn, ctx)
    return out


async def _main(commit: bool) -> dict[str, Any]:
    from app.core.profile import active_profile
    from ingest.common.db import LoaderDB

    db = LoaderDB.from_settings()
    conn = await db.connect()
    try:
        prof = active_profile()
        out = {"profile": {"cit_hostless_per_row": prof.cit_hostless_per_row, "web_owned_target_base": prof.web_owned_target_base}}
        out.update(await run(conn, commit=commit))
        return out
    finally:
        await conn.close()


def main() -> None:
    from ingest.common.config import install_worker_settings

    ap = argparse.ArgumentParser(prog="python -m ingest.project.apply.wu5_reproject")
    ap.add_argument("--commit", action="store_true", help="재투영 실행(기본 = 드라이런)")
    commit = ap.parse_args().commit
    install_worker_settings()                  # ingest.cli 와 같은 설정 경로(stg·prod: API 인증 키 없이 워커 용도, loader URL 필수)
    print(json.dumps(asyncio.run(_main(commit)), ensure_ascii=False))


if __name__ == "__main__":
    main()
