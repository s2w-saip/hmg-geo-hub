"""Build the virtual OBT: geohub_silver_db on the metrics server, the pipeline's silver.answer_analysis and silver.acr_rollup filled from the copy of
the old upstream database (gold_db). Writes nothing to the copy; the load's temporary tables live in its own session. See silver-001.sql.

    HGH_HUB_NATIVE=1 python back/hub_storage/build_virtual_obt.py            # database, tables, load, analyze, check
    HGH_HUB_NATIVE=1 python back/hub_storage/build_virtual_obt.py --replace  # empty the tables and load again
    HGH_HUB_NATIVE=1 python back/hub_storage/build_virtual_obt.py --verify   # check again

Native mode only so far."""
from __future__ import annotations

import argparse
import json
import os
import re
import runpy
import secrets
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SOURCE = "gold_db"
TARGET = "geohub_silver_db"
OWNER = "hmg_metrics_owner"
READER = "hmg_silver_reader"
ICU_LOCALE = "en-US-u-ka-shifted"   # as the copy, so a text order means the same in both
SECRET = ROOT / ".env.silver.local"

hub = runpy.run_path(str(HERE / "manage.py"), run_name="hub_manage")
analytics = hub["analytics"]
TOOLS = Path(sys.executable).parent


def manifest_status(ext: str) -> str:
    """A cycle the source store did not serve (not servable, hidden from every read, not visible yet) is no operating snapshot: readers see public ones only."""
    v = json.loads(ext)["v_gold"]
    served = v.get("servable") and (v.get("hidden_scope") or 0) != 1 and (not v.get("view_date") or v["view_date"] <= datetime.now().date().isoformat())
    return "public" if served else "ready"


def log(message: str) -> None:
    print(f"{datetime.now():%H:%M:%S} {message}", flush=True)


def tool(name: str) -> str:
    return str(TOOLS / name) if (TOOLS / name).exists() else name


def parts(database: str) -> list[str]:
    s = hub["STORES"]["metrics"]
    return ["-h", str(analytics.NATIVE_ROOT / "metrics-socket"), "-p", str(hub["port_of"]("metrics")), "-U", s.admin, "-d", database]


def psql(database: str, query: str, options: str = "") -> list[list[str]]:
    env = {**os.environ, "PGTZ": "UTC", **({"PGOPTIONS": options} if options else {})}
    done = subprocess.run([tool("psql"), "-X", "-q", "-A", "-t", "-F", "\x1f", "-v", "ON_ERROR_STOP=1", *parts(database)], input=query, env=env, capture_output=True, text=True)
    if done.returncode:
        raise RuntimeError(f"psql failed: {done.stderr.strip()[:800]}")
    return [line.split("\x1f") for line in done.stdout.splitlines() if line]


def reader_password() -> str:
    """The BFF's read role here: one password, kept in the git-ignored env file with the connection the adapter will use."""
    if SECRET.exists():
        return re.search(r"hmg_silver_reader:([^@]+)@", SECRET.read_text(encoding="utf-8")).group(1)
    password = secrets.token_urlsafe(32)
    port = hub["port_of"]("metrics")
    analytics.secure_write(SECRET, "# The virtual OBT, read only: operating snapshots and the manifest. Never commit.\n"
                                   f"HGH_SILVER_DB_URL=postgresql://{READER}:{password}@127.0.0.1:{port}/{TARGET}\nHGH_METRIC_SOURCE=silver\n")
    return password


def create_database() -> None:
    password = reader_password()
    psql("postgres", f"""DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{READER}') THEN CREATE ROLE {READER} LOGIN; END IF; END $$;
ALTER ROLE {READER} WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {analytics.literal(password)};
ALTER ROLE {READER} SET default_transaction_read_only=on;
ALTER ROLE {READER} SET statement_timeout='15s';""")
    if not psql("postgres", f"SELECT 1 FROM pg_database WHERE datname='{TARGET}'"):
        psql("postgres", f"CREATE DATABASE {TARGET} OWNER {OWNER} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE '{ICU_LOCALE}' LOCALE 'C'")
    psql("postgres", f"""REVOKE ALL ON DATABASE {TARGET} FROM PUBLIC;
GRANT CONNECT ON DATABASE {TARGET} TO {READER};
ALTER DATABASE {TARGET} SET "TimeZone" TO 'UTC';
ALTER DATABASE {TARGET} SET "DateStyle" TO 'ISO, MDY';""")
    if not psql(TARGET, "SELECT 1 FROM pg_namespace WHERE nspname='silver'"):
        psql(TARGET, f"SET ROLE {OWNER};\n" + (HERE / "silver-001.sql").read_text(encoding="utf-8"))
        log("tables created")


def sections() -> dict[str, str]:
    found = re.split(r"^-- @section (\w+)\n", (HERE / "silver-load.sql").read_text(encoding="utf-8"), flags=re.M)
    return dict(zip(found[1::2], found[2::2]))


def load() -> None:
    """One session on the copy (the temporary tables span its sections), its COPY output piped to the virtual Silver table by table."""
    s = sections()
    copies = {"cycle": "ops.cycle(cycle_id,surface)",
              "run": "ops.run(run_key,cycle_id,input_run_key,layer,status,contract_version,git_commit,config,started_at,finished_at)",
              "answers": "silver.answer_analysis", "acr": "silver.acr_rollup"}
    setup = s["setup"]
    # The temporary tables must exist in each piped session; only the answers and ACR sections are heavy, and each builds what it needs after setup.
    for name, table in copies.items():
        started = time.time()
        source = subprocess.Popen([tool("psql"), "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", *parts(SOURCE)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  env={**os.environ, "PGTZ": "UTC"})
        sink = subprocess.Popen([tool("psql"), "-X", "-q", "-v", "ON_ERROR_STOP=1", *parts(TARGET), "-c", f"COPY {table} FROM STDIN"], stdin=source.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env={**os.environ, "PGTZ": "UTC", "PGOPTIONS": "-c synchronous_commit=off -c default_toast_compression=lz4"})
        source.stdout.close()
        source.stdin.write((setup + s[name]).encode("utf-8"))
        source.stdin.close()
        source_err = source.stderr.read().decode("utf-8", "replace")
        source_code = source.wait()
        _, sink_err = sink.communicate()
        if source_code or sink.returncode:
            raise RuntimeError(f"load {name} failed: {source_err[:800]} {sink_err.decode('utf-8', 'replace')[:800]}")
        count = psql(TARGET, f"SELECT count(*) FROM {table.split('(')[0]}")[0][0]
        log(f"{table.split('(')[0]}: {int(count):,} rows, {(time.time() - started) / 60:.1f} min")
    # The manifest takes its row counts from what arrived.
    manifest = subprocess.run([tool("psql"), "-X", "-q", "-A", "-t", "-F", "\x1f", "-v", "ON_ERROR_STOP=1", *parts(SOURCE)], input=setup + s["manifest"].replace("TO STDOUT", "TO STDOUT WITH (FORMAT csv, DELIMITER E'\\x1f', QUOTE E'\\x01')"),
                              env={**os.environ, "PGTZ": "UTC"}, capture_output=True, text=True)
    if manifest.returncode:
        raise RuntimeError(f"manifest failed: {manifest.stderr[:800]}")
    rows = [line.split("\x1f") for line in manifest.stdout.splitlines() if line]
    answers = dict(psql(TARGET, "SELECT run_key,count(*) FROM silver.answer_analysis GROUP BY 1"))
    cells = dict(psql(TARGET, "SELECT run_key,count(*) FROM silver.acr_rollup GROUP BY 1"))
    values = ",\n".join(f"('{run}','{cycle}',{analytics.literal(day) if day else 'NULL'},{answers.get(run, 0)},{cells.get(run, 0)},{analytics.literal(rule)},'silver.v1','{manifest_status(ext)}',{analytics.literal(ext)}::jsonb)"
                        for cycle, day, ext, run, rule in rows)
    psql(TARGET, f"INSERT INTO ops.snapshot_manifest(snapshot_id,cycle_id,round_date,row_count,acr_row_count,rule_version,contract_version,status,ext) VALUES\n{values};")
    log(f"ops.snapshot_manifest: {len(rows):,} snapshots")
    done = subprocess.run([tool("vacuumdb"), *parts(TARGET), "--analyze-only", "--jobs=4"], capture_output=True, text=True)
    if done.returncode:
        raise RuntimeError(f"analyze failed: {done.stderr[:400]}")
    log("analyzed")


def verify() -> dict:
    """What the virtual OBT holds against the tables it came from, surface by surface."""
    live = "(SELECT DISTINCT i.build_id FROM gold.active_release a JOIN gold.release_item i USING(release_id) WHERE a.read_mode='live' AND i.family='{}')"
    obt = {r[0]: list(map(int, r[1:])) for r in psql(TARGET, """SELECT c.surface,count(*),count(a.answer_text),
        coalesce(sum(jsonb_array_length(a.s1_normalize_citations)),0),coalesce(sum(jsonb_array_length(a.s2_citation_judgments)),0),coalesce(sum(jsonb_array_length(a.s2_mention_rollups)),0),
        coalesce(sum(jsonb_array_length(a.s2_mention_occurrences)),0),coalesce(sum(jsonb_array_length(a.s3_stance_stances)),0),
        count(*) FILTER (WHERE a.ext ? 's1_normalize_v_gold' AND a.ext->'s1_normalize_v_gold' ? 'std_in') FROM silver.answer_analysis a JOIN ops.run r USING(run_key) JOIN ops.cycle c USING(cycle_id) GROUP BY 1""")}
    names = {"1": "global", "2": "website", "3": "project"}
    old = {names[r[0]]: list(map(int, r[1:])) for r in psql(SOURCE, f"""SELECT j.surface,count(*),count(b.answer_text),
        coalesce(sum(x.c),0)::bigint,coalesce(sum(y.c),0)::bigint,coalesce(sum(m.c),0)::bigint,coalesce(sum(o.c),0)::bigint,coalesce(sum(t.c),0)::bigint,count(f.answer_key)
        FROM gold.job_index j LEFT JOIN gold.answer_body b USING(answer_key)
        LEFT JOIN (SELECT answer_key,count(*) c FROM gold.answer_citation_raw GROUP BY 1) x USING(answer_key)
        LEFT JOIN (SELECT answer_key,count(*) c FROM gold.citation_fact WHERE build_id IN {live.format('fact')} GROUP BY 1) y USING(answer_key)
        LEFT JOIN (SELECT answer_key,count(*) c FROM gold.answer_mention_raw GROUP BY 1) m USING(answer_key)
        LEFT JOIN (SELECT answer_key,count(*) c FROM gold.answer_occurrence GROUP BY 1) o USING(answer_key)
        LEFT JOIN (SELECT answer_key,count(*) c FROM gold.answer_stance_raw GROUP BY 1) t USING(answer_key)
        LEFT JOIN (SELECT answer_key FROM gold.answer_fact WHERE build_id IN {live.format('fact')}) f USING(answer_key)
        GROUP BY 1""")}
    fields = ["rows", "answer_text", "citations", "judgments", "mention_rollups", "occurrences", "stances", "gates"]
    report = {"answers": {s: dict(zip(fields, obt.get(s, []))) for s in obt}, "differences": []}
    for surface in old:
        for field, here, there in zip(fields, obt.get(surface, []), old[surface]):
            if here != there:
                report["differences"].append([surface, field, here, there])
    report["acr"] = {"obt": list(map(int, psql(TARGET, """SELECT count(*),coalesce(sum(jsonb_array_length(s3_acr_entities)),0),coalesce(sum(s3_acr_valid_acr_iterations),0) FROM silver.acr_rollup""")[0])),
                     "old": list(map(int, psql(SOURCE, f"""SELECT (SELECT count(*) FROM gold.acr_cell_fact WHERE build_id IN {live.format('acr')}),
                         (SELECT count(*) FROM gold.acr_entity_fact WHERE build_id IN {live.format('acr')}),
                         (SELECT coalesce(sum(valid_acr),0) FROM gold.acr_cell_fact WHERE build_id IN {live.format('acr')})""")[0]))}
    if report["acr"]["obt"] != report["acr"]["old"]:
        report["differences"].append(["acr", "cells,entities,valid", report["acr"]["obt"], report["acr"]["old"]])
    report["manifest"] = psql(TARGET, "SELECT count(*),count(*) FILTER (WHERE status='public'),sum(row_count),sum(acr_row_count) FROM ops.snapshot_manifest")[0]
    report["size"] = psql(TARGET, f"SELECT pg_size_pretty(pg_database_size('{TARGET}'))")[0][0]
    report["ok"] = not report["differences"]
    log("verify: " + json.dumps(report, ensure_ascii=False))
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replace", action="store_true", help="empty the virtual tables and load again")
    parser.add_argument("--verify", action="store_true", help="only check what is there")
    args = parser.parse_args()
    if not analytics.NATIVE:
        raise SystemExit("Native mode only (HGH_HUB_NATIVE=1) so far")
    if args.verify:
        return 0 if verify()["ok"] else 1
    started = time.time()
    create_database()
    if psql(TARGET, "SELECT 1 FROM ops.run LIMIT 1"):
        if not args.replace:
            raise SystemExit(f"{TARGET} already holds rows: check it with --verify, or load again with --replace")
        psql(TARGET, "TRUNCATE ops.snapshot_manifest,silver.acr_rollup,silver.answer_analysis,ops.run,ops.cycle")
    load()
    ok = verify()["ok"]
    log(f"done in {(time.time() - started) / 60:.1f} min, {'OK' if ok else 'DIFFERENCES FOUND'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
