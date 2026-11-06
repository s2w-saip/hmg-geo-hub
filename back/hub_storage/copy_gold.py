"""Copy the upstream Gold database (schema gold, every table) into geohub_gold_db on the metrics server, and check the copy.

The BFF keeps its connection: nothing reads the copy until the switch (docs/handoff/architecture-rebuild.md D-19). The upstream is only read,
in one consistent snapshot, and the dump stays in .local/gold-copy: it is what the copy was restored from, so it is its backup too.
The database takes the upstream's sort order, time zone and date settings, because the readers' ORDER BY, lower() and date casts depend on them.

    HGH_HUB_NATIVE=1 python back/hub_storage/copy_gold.py            # dump, restore, grant, analyze, verify
    HGH_HUB_NATIVE=1 python back/hub_storage/copy_gold.py --dump .local/gold-copy/gold-….dump   # restore a kept dump, without reading the upstream's data
    HGH_HUB_NATIVE=1 python back/hub_storage/copy_gold.py --verify   # verify again

Native mode only so far: the Docker path is written with the switch."""
from __future__ import annotations

import argparse
import json
import os
import re
import runpy
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TARGET = "geohub_gold_db"
SCHEMA = "gold"
READER = "hmg_metrics_reader"
OWNER = "hmg_metrics_owner"
OUT = ROOT / ".local" / "gold-copy"
RESTORE_JOBS = 6
FINGERPRINT_MAX_ROWS = 200_000   # whole-row hashes on the smaller tables; the larger ones are counted and checked through the readers
SETTINGS = ("TimeZone", "DateStyle", "IntervalStyle", "default_text_search_config", "lc_monetary", "lc_numeric", "lc_time")
ICU_LOCALE = "en-US-u-ka-shifted"

hub = runpy.run_path(str(HERE / "manage.py"), run_name="hub_manage")
analytics = hub["analytics"]
TOOLS = Path(sys.executable).parent


def log(message: str) -> None:
    print(f"{datetime.now():%H:%M:%S} {message}", flush=True)


def source_parts() -> tuple[list[str], dict[str, str]]:
    """Connection arguments and environment for the upstream. The password travels in the environment, never in argv or a log."""
    url = None
    for line in (ROOT / ".env.gold.local").read_text(encoding="utf-8").splitlines():
        found = re.match(r"\s*(?:export\s+)?HGH_GOLD_DB_URL=['\"]?([^'\"\s]+)", line)
        if found:
            url = found.group(1)
    if not url:
        raise SystemExit("HGH_GOLD_DB_URL is not in .env.gold.local")
    u = urlparse(url)
    env = {**os.environ, "PGPASSWORD": unquote(u.password or ""), "PGCONNECT_TIMEOUT": "10", "PGAPPNAME": "hmg-geo-hub-copy", "PGTZ": "UTC"}
    if "sslmode" in parse_qs(u.query):
        env["PGSSLMODE"] = parse_qs(u.query)["sslmode"][0]
    return ["-h", u.hostname, "-p", str(u.port), "-U", unquote(u.username), "-d", u.path.lstrip("/")], env


def target_parts(database: str = TARGET) -> list[str]:
    s = hub["STORES"]["metrics"]
    return ["-h", str(analytics.NATIVE_ROOT / "metrics-socket"), "-p", str(hub["port_of"]("metrics")), "-U", s.admin, "-d", database]


def tool(name: str) -> str:
    return str(TOOLS / name) if (TOOLS / name).exists() else name


def psql(parts: list[str], query: str, env: dict[str, str] | None = None) -> list[list[str]]:
    done = subprocess.run([tool("psql"), "-X", "-q", "-A", "-t", "-F", "\x1f", "-v", "ON_ERROR_STOP=1", *parts, "-c", query],
                          env=env or {**os.environ, "PGTZ": "UTC"}, capture_output=True, text=True)
    if done.returncode:
        raise RuntimeError(f"psql failed: {done.stderr.strip()[:400]}")
    return [line.split("\x1f") for line in done.stdout.splitlines() if line]


def read_source(parts: list[str], env: dict[str, str], query: str) -> list[list[str]]:
    return psql(parts, query, {**env, "PGOPTIONS": "-c default_transaction_read_only=on -c statement_timeout=0"})


def create_database(parts: list[str], env: dict[str, str]) -> None:
    collate, ctype, provider = read_source(parts, env, "SELECT datcollate,datctype,datlocprovider FROM pg_database WHERE datname=current_database()")[0]
    log(f"upstream sort order: collate={collate} ctype={ctype} provider={provider}")
    settings = dict(read_source(parts, env, "SELECT name,setting FROM pg_settings WHERE name=ANY(ARRAY" + repr(list(SETTINGS)) + ")"))
    # macOS libc sorts UTF-8 byte by byte, so a libc en_US here would not sort as the upstream's does. ICU with punctuation shifted is the
    # nearest: glibc passes over punctuation too, so domains and hosts sort the same (dim_source.domain 0 of 75,336 places differ, plain en-US 70,711).
    plain = collate in ("C", "POSIX")
    locale = "LOCALE 'C'" if plain else f"LOCALE_PROVIDER icu ICU_LOCALE '{ICU_LOCALE}' LOCALE 'C'"
    if not psql(target_parts("postgres"), f"SELECT 1 FROM pg_database WHERE datname='{TARGET}'"):
        psql(target_parts("postgres"), f"CREATE DATABASE {TARGET} OWNER {OWNER} TEMPLATE template0 ENCODING 'UTF8' {locale}")
    psql(target_parts("postgres"), f"REVOKE ALL ON DATABASE {TARGET} FROM PUBLIC")
    psql(target_parts("postgres"), f"GRANT CONNECT ON DATABASE {TARGET} TO {READER}")
    for name, value in settings.items():
        # the same locale is spelled en_US.utf8 on Linux and en_US.UTF-8 on macOS
        value = re.sub(r"\.utf8$", ".UTF-8", value) if name.startswith("lc_") else value
        psql(target_parts("postgres"), f"ALTER DATABASE {TARGET} SET \"{name}\" TO {analytics.literal(value)}")
    log(f"database {TARGET} ready; settings as upstream: {settings}")


def dump(parts: list[str], env: dict[str, str]) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    OUT.chmod(0o700)
    final = OUT / f"gold-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.dump"
    partial = final.with_suffix(".partial")
    started = time.time()
    # The read-only role may not read a sequence's position. Nothing draws from them in a copy; restore() sets each from its column.
    sequences = [f"--exclude-table-data={r[0]}" for r in read_source(parts, env, f"SELECT schemaname||'.'||sequencename FROM pg_sequences WHERE schemaname='{SCHEMA}'")]
    # lz4 when this pg_dump has it: the dump is read back once, and the time goes on the network anyway
    for method in ("lz4", "gzip:1"):
        done = subprocess.run([tool("pg_dump"), *parts, f"--schema={SCHEMA}", *sequences, "--no-owner", "--no-acl", "--format=custom", f"--compress={method}", "-f", str(partial)],
                              env=env, capture_output=True, text=True)
        if done.returncode == 0 or "support" not in done.stderr:
            break
    if done.returncode:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"pg_dump failed: {done.stderr.strip()[:600]}")
    partial.chmod(0o600)
    partial.rename(final)
    log(f"dump {final.name}: {final.stat().st_size / 2**30:.1f} GB, compress {method}, {(time.time() - started) / 60:.1f} min")
    return final


def restore(path: Path) -> None:
    started = time.time()
    psql(target_parts("postgres"), "ALTER SYSTEM SET max_wal_size='8GB'")
    psql(target_parts("postgres"), "SELECT pg_reload_conf()")
    try:
        done = subprocess.run([tool("pg_restore"), *target_parts(), f"--role={OWNER}", "--no-owner", "--no-acl", f"--jobs={RESTORE_JOBS}", "--exit-on-error", str(path)],
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
    psql(target_parts(), f"REVOKE ALL ON SCHEMA {SCHEMA} FROM PUBLIC")
    psql(target_parts(), f"GRANT USAGE ON SCHEMA {SCHEMA} TO {READER}")
    psql(target_parts(), f"GRANT SELECT ON ALL TABLES IN SCHEMA {SCHEMA} TO {READER}")
    started = time.time()
    done = subprocess.run([tool("vacuumdb"), *target_parts(), "--analyze-only", "--jobs=4"], capture_output=True, text=True)
    if done.returncode:
        raise RuntimeError(f"analyze failed: {done.stderr.strip()[:400]}")
    log(f"analyzed in {(time.time() - started) / 60:.1f} min")


def tables_of(read) -> dict[str, str]:
    """table -> a digest of its columns and types."""
    return dict(read(f"""SELECT table_name,md5(string_agg(column_name||':'||data_type||':'||is_nullable,',' ORDER BY ordinal_position))
        FROM information_schema.columns WHERE table_schema='{SCHEMA}' GROUP BY 1"""))


def verify(parts: list[str], env: dict[str, str]) -> dict:
    started = time.time()
    source = lambda q: read_source(parts, env, q)   # noqa: E731
    target = lambda q: psql(target_parts(), q)      # noqa: E731
    copied = {t: c for t, c in tables_of(target).items() if t not in ("first_screen_read", "rollup_run", "schema_migration")}
    upstream = tables_of(source)
    report = {"tables": len(upstream), "missing": sorted(set(upstream) - set(copied)), "extra": sorted(set(copied) - set(upstream)),
              "columns_differ": sorted(t for t in upstream if t in copied and upstream[t] != copied[t]), "counts_differ": {}, "fingerprints_differ": [],
              "rows": 0, "fingerprinted": 0}
    for table in sorted(upstream):
        if table not in copied:
            continue
        there = int(source(f"SELECT count(*) FROM {SCHEMA}.{table}")[0][0])
        here = int(target(f"SELECT count(*) FROM {SCHEMA}.{table}")[0][0])
        report["rows"] += here
        if there != here:
            report["counts_differ"][table] = [there, here]
        elif here <= FINGERPRINT_MAX_ROWS:
            digest = f"""SELECT coalesce(md5(string_agg(h,'' ORDER BY h COLLATE "C")),'') FROM (SELECT md5(t::text) AS h FROM {SCHEMA}.{table} t) x"""
            if source(digest) != target(digest):
                report["fingerprints_differ"].append(table)
            report["fingerprinted"] += 1
    report["seconds"] = round(time.time() - started)
    report["ok"] = not (report["missing"] or report["extra"] or report["columns_differ"] or report["counts_differ"] or report["fingerprints_differ"])
    (OUT / "verify.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    log("verify: " + json.dumps(report, ensure_ascii=False))
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="only check the copy against the upstream")
    parser.add_argument("--dump", type=Path, help="restore this kept dump instead of dumping the upstream")
    args = parser.parse_args()
    if not analytics.NATIVE:
        raise SystemExit("Native mode only (HGH_HUB_NATIVE=1) so far")
    parts, env = source_parts()
    if args.verify:
        return 0 if verify(parts, env)["ok"] else 1
    exists = psql(target_parts("postgres"), f"SELECT 1 FROM pg_database WHERE datname='{TARGET}'")
    if exists and psql(target_parts(), f"SELECT 1 FROM pg_namespace WHERE nspname='{SCHEMA}'"):
        raise SystemExit(f"{TARGET} already holds {SCHEMA}: check it with --verify, or drop the database by hand to copy again")
    started = time.time()
    create_database(parts, env)
    path = args.dump or dump(parts, env)
    restore(path)
    ok = verify(parts, env)["ok"]
    log(f"done in {(time.time() - started) / 60:.1f} min, {'OK' if ok else 'DIFFERENCES FOUND'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
