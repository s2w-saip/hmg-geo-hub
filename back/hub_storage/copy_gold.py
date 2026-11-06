"""Restore the Gold copy (geohub_gold_db, schema gold) from its kept dump in .local/gold-copy, the only place that data is kept besides the database.

The readers' ORDER BY, lower() and date casts depend on the database's sort order and settings: manage.py init creates the database with that
sort order and this script sets the rest. The copied tables are read-only for every role; the rollup job's tables in the same schema
(metrics-001 ~ 003.sql) are that job's, and they stay.

    HGH_HUB_NATIVE=1 python back/hub_storage/copy_gold.py                               # the newest dump in .local/gold-copy
    HGH_HUB_NATIVE=1 python back/hub_storage/copy_gold.py --dump .local/gold-copy/gold-….dump

Native mode only so far."""
from __future__ import annotations

import argparse
import json
import os
import re
import runpy
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TARGET = "geohub_gold_db"
SCHEMA = "gold"
READER = "hmg_metrics_reader"
OWNER = "hmg_metrics_owner"
OUT = ROOT / ".local" / "gold-copy"
RESTORE_JOBS = 6
# What the data was written under: the readers' date casts and text search depend on these.
SETTINGS = {"DateStyle": "ISO, MDY", "default_text_search_config": "pg_catalog.english", "IntervalStyle": "postgres",
            "lc_monetary": "en_US.UTF-8", "lc_numeric": "en_US.UTF-8", "lc_time": "en_US.UTF-8", "TimeZone": "UTC"}

hub = runpy.run_path(str(HERE / "manage.py"), run_name="hub_manage")
analytics = hub["analytics"]
TOOLS = Path(sys.executable).parent


def log(message: str) -> None:
    print(f"{datetime.now():%H:%M:%S} {message}", flush=True)


def target_parts(database: str = TARGET) -> list[str]:
    s = hub["STORES"]["metrics"]
    return ["-h", str(analytics.NATIVE_ROOT / "metrics-socket"), "-p", str(hub["port_of"]("metrics")), "-U", s.admin, "-d", database]


def tool(name: str) -> str:
    return str(TOOLS / name) if (TOOLS / name).exists() else name


def psql(parts: list[str], query: str) -> list[list[str]]:
    done = subprocess.run([tool("psql"), "-X", "-q", "-A", "-t", "-F", "\x1f", "-v", "ON_ERROR_STOP=1", *parts, "-c", query],
                          env={**os.environ, "PGTZ": "UTC"}, capture_output=True, text=True)
    if done.returncode:
        raise RuntimeError(f"psql failed: {done.stderr.strip()[:400]}")
    return [line.split("\x1f") for line in done.stdout.splitlines() if line]


def toc(path: Path) -> list[str]:
    done = subprocess.run([tool("pg_restore"), "-l", str(path)], capture_output=True, text=True)
    if done.returncode:
        raise RuntimeError(f"pg_restore -l failed: {done.stderr.strip()[:400]}")
    return done.stdout.splitlines()


def restore_list(entries: list[str]) -> list[str]:
    """Everything but the schema itself, which manage.py init has made: the rollup job's tables live in it."""
    return [e for e in entries if f"SCHEMA - {SCHEMA} " not in e and f"COMMENT - SCHEMA {SCHEMA} " not in e]


def dump_tables(entries: list[str]) -> list[str]:
    return [m.group(1) for m in (re.search(rf"\d+ TABLE {SCHEMA} (\S+) ", e) for e in entries) if m]


def restore(path: Path, entries: list[str]) -> None:
    started = time.time()
    psql(target_parts("postgres"), "ALTER SYSTEM SET max_wal_size='8GB'")
    psql(target_parts("postgres"), "SELECT pg_reload_conf()")
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".list", dir=OUT) as listing:
            listing.write("\n".join(restore_list(entries)) + "\n")
            listing.flush()
            done = subprocess.run([tool("pg_restore"), *target_parts(), f"--role={OWNER}", "--no-owner", "--no-acl", f"--jobs={RESTORE_JOBS}", "--exit-on-error",
                                   "-L", listing.name, str(path)],
                                  env={**os.environ, "PGOPTIONS": "-c maintenance_work_mem=1GB -c synchronous_commit=off"}, capture_output=True, text=True)
        if done.returncode:
            raise RuntimeError(f"pg_restore failed: {done.stderr.strip()[-800:]}")
    finally:
        psql(target_parts("postgres"), "ALTER SYSTEM RESET max_wal_size")
        psql(target_parts("postgres"), "SELECT pg_reload_conf()")
    log(f"restored in {(time.time() - started) / 60:.1f} min")
    for seq, table, column in psql(target_parts(), f"""SELECT s.relname,t.relname,a.attname FROM pg_class s
        JOIN pg_namespace n ON n.oid=s.relnamespace AND n.nspname='{SCHEMA}' JOIN pg_depend d ON d.objid=s.oid AND d.deptype IN ('a','i')
        JOIN pg_class t ON t.oid=d.refobjid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid WHERE s.relkind='S'"""):
        psql(target_parts(), f"SELECT setval('{SCHEMA}.{seq}',max({column})) FROM {SCHEMA}.{table} HAVING max({column}) IS NOT NULL")
    psql(target_parts(), f"GRANT SELECT ON ALL TABLES IN SCHEMA {SCHEMA} TO {READER}")
    started = time.time()
    done = subprocess.run([tool("vacuumdb"), *target_parts(), "--analyze-only", "--jobs=4"], capture_output=True, text=True)
    if done.returncode:
        raise RuntimeError(f"analyze failed: {done.stderr.strip()[:400]}")
    log(f"analyzed in {(time.time() - started) / 60:.1f} min")


def check(tables: list[str]) -> bool:
    """Every table of the dump is there, and the rows add up to what the copy was first checked at (verify.json, when it is kept)."""
    missing = [t for t in tables if psql(target_parts(), f"SELECT to_regclass('{SCHEMA}.{t}')")[0][0] == ""]
    rows = sum(int(psql(target_parts(), f"SELECT count(*) FROM {SCHEMA}.{t}")[0][0]) for t in tables if t not in missing)
    kept = OUT / "verify.json"
    expected = json.loads(kept.read_text(encoding="utf-8"))["rows"] if kept.exists() else None
    log(f"tables {len(tables)}, missing {missing}, rows {rows}, expected {expected}")
    return not missing and (expected is None or rows == expected)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dump", type=Path, help="restore this dump instead of the newest in .local/gold-copy")
    args = parser.parse_args()
    if not analytics.NATIVE:
        raise SystemExit("Native mode only (HGH_HUB_NATIVE=1) so far")
    if not psql(target_parts("postgres"), f"SELECT 1 FROM pg_database WHERE datname='{TARGET}'"):
        raise SystemExit(f"{TARGET} does not exist: run manage.py init first")
    if psql(target_parts(), "SELECT to_regclass('gold.active_release')")[0][0]:
        raise SystemExit(f"{TARGET} already holds the copy")
    path = args.dump or max(OUT.glob("gold-*.dump"))
    log(f"restoring {path.name}")
    for name, value in SETTINGS.items():
        psql(target_parts("postgres"), f"ALTER DATABASE {TARGET} SET \"{name}\" TO {analytics.literal(value)}")
    entries = toc(path)
    restore(path, entries)
    ok = check(dump_tables(entries))
    log("done, OK" if ok else "done, DIFFERENCES FOUND")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
