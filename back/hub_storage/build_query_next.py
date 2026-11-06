"""The first load's isolated copy (T9.7): gold_next and cache_next on the metrics server, so the query tables can be filled and recounted while gold_db serves the screens. gold_db's
schema and the tables the load keeps are copied; the tables it fills from the Silver OBT start empty. Writes nothing to gold_db or cache_db. Native mode only, as build_virtual_obt.py.

    HGH_HUB_NATIVE=1 python back/hub_storage/build_query_next.py            # databases, schema, kept tables, the load's role and record table
    HGH_HUB_NATIVE=1 python back/hub_storage/build_query_next.py --replace  # drop gold_next and cache_next first
    HGH_HUB_NATIVE=1 python back/hub_storage/build_query_next.py --analyze  # statistics after a load
"""
from __future__ import annotations

import argparse
import hashlib
import os
import runpy
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
hub = runpy.run_path(str(HERE / "manage.py"), run_name="hub_manage")
analytics = hub["analytics"]
TOOLS = Path(sys.executable).parent
SOURCE, TARGET, CACHE_SOURCE, CACHE_TARGET = "gold_db", "gold_next", "cache_db", "cache_next"
OWNER = "hmg_metrics_owner"
SCHEMAS = ("gold", "analytics", "ref", "ops")
#: filled by the load job (query_load.py)
FILLED = ("answer_fact", "answer_brand_fact", "citation_fact", "answer_stance_fact", "answer_occurrence", "answer_stance_raw", "answer_body", "acr_cell_fact", "acr_entity_fact")
#: read by nothing (docs/handoff/query-tables-scope.md 1절), and the rollup's own, which starts empty
LEFT_OUT = ("kpi_cell", "citation_cell", "brand_cell", "kpi_rollup", "url_prompt_cell", "answer_citation_raw", "metric_row", "metric_call", "first_screen_read", "rollup_run")
READERS = ("hmg_metrics_reader", "hmg_rollup_writer", "hmg_analytics_reader", "hmg_analytics_writer", "hmg_query_loader", "hmg_silver_reader")


def log(message: str) -> None:
    print(f"{datetime.now():%H:%M:%S} {message}", flush=True)


def tool(name: str) -> str:
    return str(TOOLS / name) if (TOOLS / name).exists() else name


def parts(database: str) -> list[str]:
    s = hub["STORES"]["metrics"]
    return ["-h", str(analytics.NATIVE_ROOT / "metrics-socket"), "-p", str(hub["port_of"]("metrics")), "-U", s.admin, "-d", database]


def psql(database: str, query: str) -> str:
    done = subprocess.run([tool("psql"), "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", *parts(database)], input=query, env={**os.environ, "PGTZ": "UTC"}, capture_output=True, text=True)
    if done.returncode:
        raise RuntimeError(f"psql failed: {done.stderr.strip()[:800]}")
    return done.stdout.strip()


def pipe(database_from: str, database_to: str, *dump_options: str) -> None:
    dump = subprocess.Popen([tool("pg_dump"), "--no-publications", "--no-subscriptions", *dump_options, *parts(database_from)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={**os.environ, "PGTZ": "UTC"})
    load = subprocess.Popen([tool("psql"), "-X", "-q", "-v", "ON_ERROR_STOP=1", *parts(database_to)], stdin=dump.stdout, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                            env={**os.environ, "PGTZ": "UTC", "PGOPTIONS": "-c synchronous_commit=off"})
    dump.stdout.close()
    dump_err = dump.stderr.read().decode("utf-8", "replace")
    dump_code = dump.wait()
    _, load_err = load.communicate()
    if dump_code or load.returncode:
        raise RuntimeError(f"copy failed: {dump_err[:600]} {load_err.decode('utf-8', 'replace')[:800]}")


def create(database: str, locale: str) -> None:
    psql("postgres", f"CREATE DATABASE {database} OWNER {OWNER} TEMPLATE template0 ENCODING 'UTF8' {locale}")
    psql("postgres", f"""REVOKE ALL ON DATABASE {database} FROM PUBLIC;
ALTER DATABASE {database} SET "TimeZone" TO 'UTC';
ALTER DATABASE {database} SET "DateStyle" TO 'ISO, MDY';
ALTER DATABASE {database} SET default_text_search_config TO 'pg_catalog.english';
ALTER DATABASE {database} SET "IntervalStyle" TO 'postgres';
ALTER DATABASE {database} SET lc_monetary TO 'en_US.UTF-8';
ALTER DATABASE {database} SET lc_numeric TO 'en_US.UTF-8';
ALTER DATABASE {database} SET lc_time TO 'en_US.UTF-8';""")


def loader_role() -> None:
    values = hub["create_secret"](hub["QUERY_LOADER_SECRET"], {"QUERY_LOADER_PASSWORD": None})
    psql("postgres", hub["login_role"]("hmg_query_loader", values["QUERY_LOADER_PASSWORD"], "SET statement_timeout='30min'", "CONNECTION LIMIT 4"))


def build(replace: bool) -> None:
    exists = psql("postgres", f"SELECT 1 FROM pg_database WHERE datname='{TARGET}'")
    if exists and not replace:
        raise SystemExit(f"{TARGET} exists: load into it, or start again with --replace")
    psql("postgres", f"DROP DATABASE IF EXISTS {TARGET} WITH (FORCE); DROP DATABASE IF EXISTS {CACHE_TARGET} WITH (FORCE);")
    loader_role()
    create(TARGET, f"LOCALE_PROVIDER icu ICU_LOCALE '{hub['GOLD_ICU_LOCALE']}' LOCALE 'C'")
    create(CACHE_TARGET, "")
    psql("postgres", f"GRANT CONNECT ON DATABASE {TARGET} TO {','.join(READERS)}; GRANT CONNECT ON DATABASE {CACHE_TARGET} TO hmg_cache_writer,hmg_metrics_reader,hmg_rollup_writer;")
    started = time.time()
    schemas = [f"--schema={s}" for s in SCHEMAS]
    pipe(SOURCE, TARGET, "--schema-only", *schemas)
    log(f"{TARGET}: schema ({time.time() - started:.0f} s)")
    skipped = [f"--exclude-table-data=gold.{t}" for t in (*FILLED, *LEFT_OUT)]
    pipe(SOURCE, TARGET, "--data-only", "--disable-triggers", *schemas, *skipped)
    log(f"{TARGET}: kept tables ({(time.time() - started) / 60:.1f} min)")
    pipe(CACHE_SOURCE, CACHE_TARGET, "--schema-only")
    pipe(CACHE_SOURCE, CACHE_TARGET, "--data-only", "--table=cache.schema_migration")
    log(f"{CACHE_TARGET}: schema")
    migrations()
    analyze()
    log(f"done, {psql('postgres', f'''SELECT pg_size_pretty(pg_database_size('{TARGET}'))''')}")


def migrations() -> None:
    """The migrations gold_db does not have yet, recorded as manage.py records them, so its init finds them done after the rename."""
    for name, version in (("metrics-005a.sql", "005a_query_tables"), ("metrics-006.sql", "006_query_load"), ("metrics-007.sql", "007_load_projects")):
        if psql(TARGET, f"SELECT 1 FROM gold.schema_migration WHERE version='{version}'"):
            continue
        text = (HERE / name).read_text(encoding="utf-8")
        checksum = hashlib.sha256(text.encode()).hexdigest()
        psql(TARGET, f"SET ROLE {OWNER};\nBEGIN;\n{text}\nINSERT INTO gold.schema_migration(version,sha256) VALUES('{version}','{checksum}');\nCOMMIT;")


def analyze() -> None:
    done = subprocess.run([tool("vacuumdb"), *parts(TARGET), "--analyze-only", "--jobs=4"], capture_output=True, text=True)
    if done.returncode:
        raise RuntimeError(f"analyze failed: {done.stderr[:400]}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replace", action="store_true")
    parser.add_argument("--analyze", action="store_true")
    parser.add_argument("--migrations", action="store_true", help="apply what gold_next lacks")
    args = parser.parse_args()
    if not analytics.NATIVE:
        raise SystemExit("Native mode only (HGH_HUB_NATIVE=1)")
    if args.analyze:
        analyze()
        return 0
    if args.migrations:
        migrations()
        return 0
    build(args.replace)
    return 0


if __name__ == "__main__":
    sys.exit(main())
