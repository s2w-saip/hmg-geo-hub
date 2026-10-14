#!/usr/bin/env python3
"""미러 스냅샷 추출(프로덕션 읽기 전용) → snap/<table>/<chunk>.csv.gz, 완료 마커 .done, 재개 가능.
- 조각마다 새 커넥션 + BEGIN READ ONLY + transaction_read_only=on 단언(set_session 금지: 풀러 누출 전례).
- 큰 표는 ctid 페이지 범위로 조각(TID Range Scan: 조각이 자기 페이지만 읽음). 마지막 조각은 상한 없음(추출 중 증가분 포함).
- 접속 URL 은 파일에서 읽고 출력하지 않는다.
사용: nohup python3 export.py > export.log 2>&1 &
동결 층 이관 입력(결정 32, DB-v2.21): nohup python3 export.py --frz > export-frz.log 2>&1 &
  → snap/frz_ops_*/NNNNN.csv.gz(mig_src_frz.sql 표와 같은 열 순서). 운영 summary 활성 세대만, 질의마다 새 읽기 전용 트랜잭션.
  시작 마커(회차별 활성 세대)를 맨 먼저, 끝 마커를 맨 나중에 뽑고 두 값이 다른 회차(추출 중 재생성)를 _frz_manifest.json 에 적는다
  (이관기는 마커가 다른 회차를 건너뛴다). 세부층 전체가 아니라 셀 집합·프롬프트 축·판정 입력 + 바뀐 답변 세부층 + 집계층 회차 합만.
QA 검수 기록 이관 입력(2026-10-14): python3 export.py --qa > export-qa.log 2>&1
  → snap/qa/<표>/00000.csv.gz(질의 정본 export-qa.sql, 열 순서 = mig_src_qa.sql) + snap/qa/_qa_manifest.json(표별 행 수·최대 시각·sha256).
  리뷰·노트와 인용·멘션·ACR 참조가 같은 시점이어야 하므로 한 커넥션·한 트랜잭션(REPEATABLE READ READ ONLY)에서 전부 뽑는다(재개 없음).
  snap/qa 는 s9-load 의 snap/*/*.csv.gz 글롭 밖(qa-load.tpl.sh 가 따로 적재). 레거시 콘솔 차단(RAW_DATA_QA_ENABLED≠1) + 락 TTL 180초 뒤 실행한다.
"""
import gzip
import hashlib
import json
import os
import re
import sys
import time

import psycopg2

URL = open("/path/to/private/source-db-url.txt").read().strip()
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "snap")
PAGES_PER_CHUNK = 20000  # 8KB × 2만 = 약 160MB 힙

BIG = ["scope_mention_occurrences", "scope_citations", "scope_answers", "scope_mentions",
       "scope_acr_rollups", "scope_answer_cycle_anchors"]
SMALL = ["scope_answer_stances", "scope_answer_anchors", "scope_runs", "scope_prompts", "scope_answer_drops",
         "scope_sync_cursors", "scope_cycle_rounds", "scope_cycle_anchor_state", "scope_cycle_registry_runs",
         "scope_mirror_progress", "scope_context_evidence", "scope_context_domains", "scope_context_combinations",
         "scope_context_entities", "scope_context_drives", "scope_context_prompt_cache",
         "summary_cycles", "summary_cycle_runs", "summary_settings",
         "report_publications", "report_site_facts", "report_site_engine_facts",
         "projects", "project_members", "project_engine_history", "project_owned_bases", "project_tracked_urls",
         "project_custom_fields", "prompt_custom_field_values", "prompts", "prompt_candidates", "prompt_audit_logs",
         "member_audit_logs", "tracked_keywords", "tracked_competitors", "tracked_brands", "tracked_vehicles",
         "website_sites", "website_prompts", "standard_keywords", "standard_sources", "standard_prompts",
         "citation_domain_overrides", "entity_registry", "ga4_properties", "ga4_tracked_events",
         "keyword_cache", "keyword_volume_cache", "qa_review_notes", "qa_answer_reviews", "qa_answer_locks"]


# ── 동결 층 이관 입력(--frz). 열 순서 = migration/mig_src_frz.sql ──
_ACT = "act AS (SELECT c.cycle_id, c.active_generation_id AS gid FROM public.summary_cycles c WHERE c.active_generation_id IS NOT NULL)"
# 생성 뒤 바뀐 답변 후보: 동기화 지문(run synced_at)이 생성 때 본 값과 다른 run 의 셀(2026-10-01 실측 1,066 = 0.23%)
_DRIFT = ("drift AS (SELECT j.cycle_week, j.cycle_id, j.generation_id, j.job_id, j.run_id, cr.synced_at_seen, r.synced_at "
          "FROM public.summary_cycle_jobs j JOIN act ON act.cycle_id = j.cycle_id AND act.gid = j.generation_id "
          "JOIN public.summary_cycle_runs cr ON cr.cycle_id = j.cycle_id AND cr.run_id = j.run_id "
          "LEFT JOIN public.scope_runs r ON r.run_id = cr.run_id WHERE r.synced_at IS DISTINCT FROM cr.synced_at_seen)")
_MARKER = ("SELECT '{phase}', c.cycle_id, c.surface, c.project_id, c.active_generation_id, now() FROM public.summary_cycles c "
           "WHERE c.active_generation_id IS NOT NULL")
FRZ = [
    ("frz_ops_marker", "00000", _MARKER.format(phase="start")),
    ("frz_ops_generation", "00000",
     f"WITH {_ACT} SELECT g.generation_id, g.cycle_id, g.generator_version, g.status, g.started_at, g.finished_at, g.row_counts, g.checksum, "
     "g.roster_snapshot, g.base_universe, g.target_universe, g.noise_snapshot FROM public.summary_generations g JOIN act ON act.gid = g.generation_id"),
    ("frz_ops_cell", "00000",
     f"WITH {_ACT} SELECT j.cycle_id, j.generation_id, j.cycle_week, j.job_id, j.run_id, j.prompt_id, j.engine, j.country, j.measured_at "
     "FROM public.summary_cycle_jobs j JOIN act ON act.cycle_id = j.cycle_id AND act.gid = j.generation_id"),
    ("frz_ops_prompt", "00000",
     f"WITH {_ACT} SELECT p.cycle_id, p.generation_id, p.prompt_id, p.project_id, p.lang, p.catalog_brands, p.funnel_catalog, p.funnel_scope, "
     "p.brand_presence_resolved, p.presence_set, p.list_type, p.depth1, p.depth2, p.depth3, p.regions, p.is_korean, p.in_root_catalog, "
     "p.catalog_status, p.catalog_deleted, p.in_full_cycle, p.expected_cells, p.window_cells, p.report_fs, p.unit_base, p.site_country, p.site_lang "
     "FROM public.summary_prompt_dim p JOIN act ON act.cycle_id = p.cycle_id AND act.gid = p.generation_id"),
    ("frz_ops_changed", "00000",
     f"WITH {_ACT}, {_DRIFT}, "
     "sb AS (SELECT b.job_id, sum(b.mentions)::bigint AS m, sum(b.positive + 2 * b.neutral + 3 * b.negative + 5 * b.mixed)::bigint AS s, "
     "sum(b.type_mention + 2 * b.type_recommendation + 3 * b.type_comparison + 5 * b.type_definition + 7 * b.type_final_choice)::bigint AS t, "
     "min(b.first_rank) AS fr FROM public.summary_brand_mentions b JOIN drift d ON d.cycle_week = b.cycle_week AND d.cycle_id = b.cycle_id "
     "AND d.generation_id = b.generation_id AND d.job_id = b.job_id GROUP BY 1), "
     "cm AS (SELECT m.job_id, sum(m.mention_count)::bigint AS m, "
     "sum(m.sentiment_positive + 2 * m.sentiment_neutral + 3 * m.sentiment_negative + 5 * m.sentiment_mixed)::bigint AS s, "
     "sum(m.type_mention + 2 * m.type_recommendation + 3 * m.type_comparison + 5 * m.type_definition + 7 * m.type_final_choice)::bigint AS t, "
     "min(m.avg_position) AS fr FROM public.scope_mentions m WHERE m.brand_rollup_entity_id IS NOT NULL AND m.job_id IN (SELECT job_id FROM drift) GROUP BY 1), "
     "cc AS (SELECT c.job_id, count(*)::int AS n FROM public.scope_citations c WHERE c.job_id IN (SELECT job_id FROM drift) GROUP BY 1) "
     "SELECT d.cycle_id, d.generation_id, d.job_id, d.run_id, d.synced_at_seen, d.synced_at, "
     "(coalesce(sb.m, 0) <> coalesce(cm.m, 0) OR coalesce(sb.s, 0) <> coalesce(cm.s, 0) OR coalesce(sb.t, 0) <> coalesce(cm.t, 0) "
     "OR sb.fr IS DISTINCT FROM cm.fr), "
     "(sa.all_citations <> coalesce(cc.n, 0)) "
     "FROM drift d JOIN public.summary_answers sa ON sa.cycle_week = d.cycle_week AND sa.cycle_id = d.cycle_id AND sa.generation_id = d.generation_id "
     "AND sa.job_id = d.job_id "
     "LEFT JOIN sb ON sb.job_id = d.job_id LEFT JOIN cm ON cm.job_id = d.job_id LEFT JOIN cc ON cc.job_id = d.job_id"),
    ("frz_ops_answer", "00000",
     f"WITH {_ACT}, {_DRIFT} SELECT s.cycle_id, s.generation_id, s.job_id, s.prompt_id, s.engine, s.country, s.run_status, s.in_root_catalog, "
     "s.in_tagged_region, s.in_full_cycle, s.monitored, s.all_mentions, s.all_citations, s.has_any_brand, s.report_fs, s.unit_owned, s.unit_target "
     "FROM public.summary_answers s JOIN drift d ON d.cycle_week = s.cycle_week AND d.cycle_id = s.cycle_id AND d.generation_id = s.generation_id "
     "AND d.job_id = s.job_id"),
    ("frz_ops_brand", "00000",
     f"WITH {_ACT}, {_DRIFT} SELECT b.cycle_id, b.generation_id, b.job_id, b.brand_id, b.brand_name, b.is_competitor, b.mentions, b.first_rank, "
     "b.positive, b.neutral, b.negative, b.mixed, b.type_mention, b.type_recommendation, b.type_comparison, b.type_definition, b.type_final_choice "
     "FROM public.summary_brand_mentions b JOIN drift d ON d.cycle_week = b.cycle_week AND d.cycle_id = b.cycle_id AND d.generation_id = b.generation_id "
     "AND d.job_id = b.job_id"),
    ("frz_ops_sum_cycle", "00000",
     f"WITH {_ACT}, ta AS (SELECT t.cycle_id, t.generation_id, sum(t.monitored)::bigint AS cells, "
     "coalesce(sum(t.monitored) FILTER (WHERE t.in_full_cycle = 1), 0)::bigint AS cells_ifc, sum(t.all_mentions)::bigint AS all_mentions, "
     "sum(t.all_citations)::bigint AS all_citations, sum(t.has_any_brand)::bigint AS has_any_brand "
     "FROM public.summary_trend_answers t JOIN act ON act.cycle_id = t.cycle_id AND act.gid = t.generation_id GROUP BY 1, 2), "
     "td AS (SELECT t.cycle_id, t.generation_id, sum(t.citations)::bigint AS domain_citations "
     "FROM public.summary_trend_domains t JOIN act ON act.cycle_id = t.cycle_id AND act.gid = t.generation_id GROUP BY 1, 2) "
     "SELECT ta.cycle_id, ta.generation_id, ta.cells, ta.cells_ifc, ta.all_mentions, ta.all_citations, ta.has_any_brand, "
     "coalesce(td.domain_citations, 0) FROM ta LEFT JOIN td USING (cycle_id, generation_id)"),
    ("frz_ops_sum_brand", "00000",
     f"WITH {_ACT} SELECT t.cycle_id, t.generation_id, t.brand_name, sum(t.mentions)::bigint, sum(t.answers)::bigint, "
     "coalesce(sum(t.comp_rank_sum), 0)::float8, sum(t.comp_ranked_answers)::bigint "
     "FROM public.summary_trend_brands t JOIN act ON act.cycle_id = t.cycle_id AND act.gid = t.generation_id GROUP BY 1, 2, 3"),
    ("frz_ops_sum_own", "00000",
     f"WITH {_ACT} SELECT t.cycle_id, t.generation_id, t.own_variant, sum(t.tracked_answers)::bigint, sum(t.own_mentions)::bigint, "
     "sum(t.own_positive)::bigint, sum(t.own_negative)::bigint, sum(t.own_signals)::bigint "
     "FROM public.summary_trend_own t JOIN act ON act.cycle_id = t.cycle_id AND act.gid = t.generation_id GROUP BY 1, 2, 3"),
    # S4(DB-v2.24): 웹 셀 생성 시점 판정 = summary_answers(report_fs·unit_owned·unit_target) + summary_url_hits(0081, 없으면 NULL).
    # 2026-10-01 운영 미러 읽기 전용 실측: 웹 활성 세대 셀 189,502 = 행 189,502(키 유일), url_hits 있는 세대 94/902
    ("frz_ops_web", "00000",
     "WITH actw AS (SELECT c.cycle_id, c.active_generation_id AS gid, c.cycle_week FROM public.summary_cycles c "
     "WHERE c.active_generation_id IS NOT NULL AND c.surface = 'website') "
     "SELECT s.cycle_id, s.generation_id, s.job_id, s.report_fs, s.unit_owned, s.unit_target, h.registered, h.owned_hit, h.target_hit "
     "FROM public.summary_answers s JOIN actw ON actw.cycle_week = s.cycle_week AND actw.cycle_id = s.cycle_id AND actw.gid = s.generation_id "
     "LEFT JOIN public.summary_url_hits h ON h.generation_id = s.generation_id AND h.job_id = s.job_id"),
    # S4b 단언 보강(실행은 승인 뒤): 운영 집계층의 같은 정의 합. 브랜드 축 감정·유형(summary_trend_brands), 당사 축 순위·복수 언급
    # (summary_trend_own: fold.ts:731-804 ob·rj = 당사 표시명 최소 경쟁 순위 tp, mc = 당사 언급 합)
    ("frz_ops_sum_brand_x", "00000",
     f"WITH {_ACT} SELECT t.cycle_id, t.generation_id, t.brand_name, sum(t.positive)::bigint, sum(t.neutral)::bigint, sum(t.negative)::bigint, "
     "sum(t.mixed)::bigint, sum(t.type_mention)::bigint, sum(t.type_recommendation)::bigint, sum(t.type_comparison)::bigint, "
     "sum(t.type_definition)::bigint, sum(t.type_final_choice)::bigint "
     "FROM public.summary_trend_brands t JOIN act ON act.cycle_id = t.cycle_id AND act.gid = t.generation_id GROUP BY 1, 2, 3"),
    ("frz_ops_sum_own_x", "00000",
     f"WITH {_ACT} SELECT t.cycle_id, t.generation_id, t.own_variant, sum(t.rank_sum)::bigint, sum(t.ranked_answers)::bigint, "
     "sum(t.top1_answers)::bigint, sum(t.top3_answers)::bigint, sum(t.multi_answers)::bigint "
     "FROM public.summary_trend_own t JOIN act ON act.cycle_id = t.cycle_id AND act.gid = t.generation_id GROUP BY 1, 2, 3"),
    # DB-v2.27 brand_card_fold: 운영 카드 점유율 분모 = summary_trend_own.comp_mentions(접힌 경쟁 행 언급 합, fold.ts:752-765). 변형마다 같은 값이라
    # (2026-10-02 운영 미러 924 회차 실측 변형 4종 모두 동일) ALL 만. all_mentions 와 다른 회차 = 접기가 바꾼 회차(실측 글로벌 3, 차 6·1·3)
    ("frz_ops_sum_comp", "00000",
     f"WITH {_ACT} SELECT t.cycle_id, t.generation_id, sum(t.comp_mentions)::bigint "
     "FROM public.summary_trend_own t JOIN act ON act.cycle_id = t.cycle_id AND act.gid = t.generation_id WHERE t.own_variant = 'ALL' GROUP BY 1, 2"),
    # S4b: URL 인용률 사실표 커버리지(summary_url_hit_generations, 2026-10-01 실측 활성 웹 세대 902 중 94)
    ("frz_ops_url_cov", "00000",
     f"WITH {_ACT} SELECT h.generation_id FROM public.summary_url_hit_generations h JOIN act ON act.gid = h.generation_id"),
    ("frz_ops_marker", "00001", _MARKER.format(phase="end")),
]

# ── QA 검수 기록 이관 입력(--qa). 질의 정본 = migration/export-qa.sql("-- name:" 블록), 열 순서 = migration/mig_src_qa.sql ──
QA_SQL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "export-qa.sql")
QA_OUT = os.path.join(OUT, "qa")
QA_TABLES = ("qa_answer_reviews", "qa_review_notes", "qa_ref_job", "qa_ref_citation", "qa_ref_mention", "qa_ref_acr")


def ro_conn():
    c = psycopg2.connect(URL, connect_timeout=20)
    c.autocommit = True
    cur = c.cursor()
    cur.execute("BEGIN READ ONLY")
    cur.execute("SHOW transaction_read_only")
    assert cur.fetchone()[0] == "on", "read-only 아님"
    cur.execute("SET LOCAL statement_timeout = '20min'")
    return c, cur


def copy(table, where, path, query=None):
    tmp = path + ".part"
    c, cur = ro_conn()
    t0 = time.time()
    with gzip.open(tmp, "wb", compresslevel=5) as f:
        cur.copy_expert(f"COPY ({query or f'SELECT * FROM public.{table} {where}'}) TO STDOUT WITH (FORMAT csv, HEADER false)", f)
    cur.execute("COMMIT")
    c.close()
    os.replace(tmp, path)
    open(path + ".done", "w").write(json.dumps({"where": where, "sec": round(time.time() - t0, 1),
                                               "bytes": os.path.getsize(path)}))
    return time.time() - t0


def main():
    os.makedirs(OUT, exist_ok=True)
    c, cur = ro_conn()
    cur.execute("SELECT max(synced_at) FROM public.scope_runs")
    wm = cur.fetchone()[0]
    meta = {}
    for t in BIG:
        cur.execute("SELECT relpages FROM pg_class WHERE oid = %s::regclass", (f"public.{t}",))
        meta[t] = cur.fetchone()[0]
    cur.execute("COMMIT")
    c.close()
    json.dump({"started": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "scope_runs_max_synced_at": str(wm), "relpages": meta},
              open(os.path.join(OUT, "_manifest.json"), "w"), indent=1)
    print("watermark", wm, "relpages", meta, flush=True)
    jobs = []
    for t in SMALL:
        jobs.append((t, "", os.path.join(OUT, t, "00000.csv.gz")))
    for t in BIG:
        n = max(1, -(-meta[t] // PAGES_PER_CHUNK))
        for k in range(n):
            lo, hi = k * PAGES_PER_CHUNK, (k + 1) * PAGES_PER_CHUNK
            where = f"WHERE ctid >= '({lo},0)'::tid" + ("" if k == n - 1 else f" AND ctid < '({hi},0)'::tid")
            jobs.append((t, where, os.path.join(OUT, t, f"{k:05d}.csv.gz")))
    done = 0
    for t, where, path in jobs:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.exists(path + ".done"):
            done += 1
            continue
        for attempt in range(1, 4):
            try:
                sec = copy(t, where, path)
                done += 1
                print(f"{done}/{len(jobs)} {t} {os.path.basename(path)} {sec:.1f}s {os.path.getsize(path)//1024}KB", flush=True)
                break
            except Exception as e:  # noqa: BLE001
                print(f"retry {attempt} {t} {os.path.basename(path)}: {type(e).__name__}: {str(e)[:200]}", flush=True)
                time.sleep(5 * attempt)
        else:
            print(f"FAILED {t} {path}", flush=True)
            sys.exit(1)
    print("EXPORT_COMPLETE", flush=True)


def _markers(path):
    out = {}
    with gzip.open(path, "rt") as f:
        for line in f:
            p = line.rstrip("\n").split(",")
            out[p[1]] = p[4]
    return out


def main_frz():
    """동결 층 이관 입력만(--frz). 조각 단위 .done 으로 재개(시작 마커는 처음 값 유지, 끝 마커는 마지막에 다시)."""
    os.makedirs(OUT, exist_ok=True)
    done = 0
    for t, name, query in FRZ:
        path = os.path.join(OUT, t, f"{name}.csv.gz")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.exists(path + ".done") and not (t == "frz_ops_marker" and name == "00001"):
            done += 1
            continue
        for attempt in range(1, 4):
            try:
                sec = copy(t, "", path, query=query)
                done += 1
                print(f"{done}/{len(FRZ)} {t} {name} {sec:.1f}s {os.path.getsize(path)//1024}KB", flush=True)
                break
            except Exception as e:  # noqa: BLE001
                print(f"retry {attempt} {t} {name}: {type(e).__name__}: {str(e)[:200]}", flush=True)
                time.sleep(5 * attempt)
        else:
            print(f"FAILED {t} {name}", flush=True)
            sys.exit(1)
    start = _markers(os.path.join(OUT, "frz_ops_marker", "00000.csv.gz"))
    end = _markers(os.path.join(OUT, "frz_ops_marker", "00001.csv.gz"))
    regen = sorted(k for k in start if end.get(k) != start[k])
    with open(os.path.join(OUT, "_frz_manifest.json"), "w") as f:
        json.dump({"finished": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "cycles": len(start), "regenerated_during_export": len(regen),
                   "regenerated_cycle_prefixes": [k[:8] for k in regen]}, f, indent=1)
    print("FRZ_EXPORT_COMPLETE cycles", len(start), "regenerated", len(regen), flush=True)


def named_sql(path):
    """'-- name: x' 로 나뉜 SQL 파일 → {이름: 문장}("--" 로 시작하는 줄은 버림). back/tests/support.load_named_sql 과 같은 규칙."""
    out, cur = {}, None
    with open(path, encoding="utf-8") as f:
        for line in f.read().splitlines():
            m = re.match(r"^--\s*name:\s*(\S+)", line)
            if m:
                cur = out.setdefault(m.group(1), [])
            elif cur is not None and not line.lstrip().startswith("--"):
                cur.append(line)
    return {k: "\n".join(v).strip() for k, v in out.items()}


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def main_qa():
    """QA 검수 기록 이관 입력만(--qa). 조각마다 새 커넥션을 여는 ro_conn 은 쓰지 않는다: 노트와 인용 참조가 같은 스냅샷이어야 한다.
    파일은 .part 로 쓰고 COMMIT 뒤에 한꺼번에 이름을 바꾼다(중간 실패면 이전 산출을 그대로 두고 처음부터 다시)."""
    q = named_sql(QA_SQL)
    missing = [t for t in QA_TABLES if t not in q]
    assert not missing, f"export-qa.sql 에 블록 없음: {missing}"
    rows, parts = {}, []
    c = psycopg2.connect(URL, connect_timeout=20)
    c.autocommit = True
    try:
        cur = c.cursor()
        cur.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        cur.execute("SHOW transaction_read_only")
        assert cur.fetchone()[0] == "on", "read-only 아님"
        cur.execute("SHOW transaction_isolation")
        assert cur.fetchone()[0] == "repeatable read", "repeatable read 아님"
        cur.execute("SET LOCAL statement_timeout = '20min'")
        cur.execute("SELECT now(), (SELECT max(updated_at) FROM public.qa_answer_reviews), (SELECT max(created_at) FROM public.qa_review_notes), "
                    "(SELECT max(resolved_at) FROM public.qa_review_notes), "
                    "(SELECT count(*) FROM public.qa_answer_locks WHERE heartbeat_at > now() - interval '180 seconds')")   # 살아 있는 락(TTL 180초)
        snap_at, max_upd, max_cre, max_res, locks = cur.fetchone()
        for t in QA_TABLES:
            path = os.path.join(QA_OUT, t, "00000.csv.gz")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            t0 = time.time()
            with gzip.open(path + ".part", "wb", compresslevel=5) as f:
                cur.copy_expert(f"COPY ({q[t]}) TO STDOUT WITH (FORMAT csv, HEADER false)", f)
            parts.append((path + ".part", path))
            cur.execute(f"SELECT count(*) FROM ({q[t]}) x")        # 본문에 줄바꿈이 있을 수 있어 CSV 줄 수가 아니라 같은 스냅샷에서 센다
            rows[t] = cur.fetchone()[0]
            print(f"{t} rows={rows[t]} {time.time() - t0:.1f}s", flush=True)
        cur.execute("COMMIT")
    finally:
        c.close()
    for tmp, path in parts:
        os.replace(tmp, path)
    ts = lambda v: None if v is None else str(v)  # noqa: E731
    manifest = {"snapshot_at": ts(snap_at), "finished": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "rows": rows,
                "max_review_updated_at": ts(max_upd), "max_note_created_at": ts(max_cre), "max_note_resolved_at": ts(max_res),
                "legacy_live_locks_at_snapshot": locks,
                "sha256": {t: _sha256(os.path.join(QA_OUT, t, "00000.csv.gz")) for t in QA_TABLES}}
    with open(os.path.join(QA_OUT, "_qa_manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    # 살아 있는 레거시 락이 있으면 콘솔 차단 전 추출(진행 중 판정이 빠질 수 있다): 산출은 남기되 크게 알린다
    print("QA_EXPORT_COMPLETE", json.dumps(rows), "locks", locks, "(WARN: 레거시 콘솔이 아직 열려 있다)" if locks else "", flush=True)


if __name__ == "__main__":
    if "--frz" in sys.argv[1:]:
        main_frz()
    elif "--qa" in sys.argv[1:]:
        main_qa()
    else:
        main()
