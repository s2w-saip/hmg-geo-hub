"""Provision the HUB-owned GA4/SEO database. Requires Python 3.12 and Docker Compose, or a local PostgreSQL
with HGH_HUB_NATIVE=1 (native mode below)."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import secrets
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DB = "hmg_analytics"
CONTAINER = "hgh-analytics-db"
PROJECT = "hmg-geo-hub-analytics"
SECRET = ROOT / ".env.analytics-db.local"
COMPOSE = ROOT / "infra" / "analytics" / "compose.yml"
ADMIN = "hmg_analytics_admin"
OWNER = "hmg_analytics_owner"
READER = "hmg_analytics_reader"
WRITER = "hmg_analytics_writer"
MIGRATION = "001_gold_ga4_seo"
# Native mode (macOS without Docker, 2026-10-28): HGH_HUB_NATIVE=1 runs each store as a local PostgreSQL server
# in .local/pg/<store> instead of a container: TCP on 127.0.0.1 only (scram), and the admin tools on an
# owner-only Unix socket (trust there, as `docker exec psql` inside the container). Binaries: HGH_PG_BIN,
# else next to this Python (a micromamba env with postgresql), else PATH.
NATIVE = os.environ.get("HGH_HUB_NATIVE") == "1"
NATIVE_ROOT = ROOT / ".local" / "pg"
_BIN = Path(os.environ["HGH_PG_BIN"]) if os.environ.get("HGH_PG_BIN") else Path(sys.executable).parent


def env_file(path: Path) -> dict[str, str]:
    return dict(line.split("=", 1) for line in path.read_text(encoding="utf-8-sig").splitlines()
                if line and not line.startswith("#"))


def sanitized(message: str) -> str:
    if SECRET.exists():
        for key, value in env_file(SECRET).items():
            if "PASSWORD" in key and value:
                message = message.replace(value, "[redacted]")
    return message


def run(args: list[str], *, text: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
    raw = subprocess.run(args, input=text.encode("utf-8") if text is not None else None, capture_output=True)
    def decode(value: bytes) -> str:
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return value.decode("cp949", errors="replace")
    result = subprocess.CompletedProcess(args, raw.returncode, decode(raw.stdout), decode(raw.stderr))
    if check and result.returncode:
        raise RuntimeError(sanitized(result.stderr[-3500:] or result.stdout[-3500:]))
    return result


def secure_write(path: Path, content: str):
    # Files are ignored by git. On Windows restrict access to this user and SYSTEM.
    with path.open("w", encoding="utf-8", newline="\n") as out:
        out.write(content)
    if os.name == "nt":
        identity = next(csv.reader([run(["whoami", "/user", "/fo", "csv", "/nh"]).stdout.strip()]))
        run(["icacls", str(path), "/inheritance:r", "/grant:r", f"*{identity[1]}:(F)", "*S-1-5-18:(F)"])
    else:
        path.chmod(0o600)


def pg_tool(name: str) -> str:
    return str(_BIN / name) if (_BIN / name).exists() else name


def native_psql(store: str, port: int, role: str, database: str) -> list[str]:
    return [pg_tool("psql"), "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", str(NATIVE_ROOT / f"{store}-socket"),
            "-p", str(port), "-U", role, "-d", database]


def native_exists(store: str) -> bool:
    return (NATIVE_ROOT / store / "PG_VERSION").exists()


def native_start(store: str, port: int, admin: str, database: str, password: str):
    """Start the store's local server (initdb first when new) and create its database if missing."""
    data, socket = NATIVE_ROOT / store, NATIVE_ROOT / f"{store}-socket"
    for path in (NATIVE_ROOT, socket):
        path.mkdir(parents=True, exist_ok=True)
        path.chmod(0o700)
    if not native_exists(store):
        secret = NATIVE_ROOT / f".{store}-initdb"
        secure_write(secret, password + "\n")
        try:
            run([pg_tool("initdb"), "-D", str(data), "-U", admin, f"--pwfile={secret}", "--auth-local=trust",
                 "--auth-host=scram-sha-256", "-E", "UTF8", "--locale=C"])
        finally:
            secret.unlink(missing_ok=True)
    if run([pg_tool("pg_ctl"), "-D", str(data), "status"], check=False).returncode != 0:
        run([pg_tool("pg_ctl"), "-D", str(data), "-l", str(NATIVE_ROOT / f"{store}.log"), "-w", "-o",
             f"-p {port} -k '{socket}' -c listen_addresses=127.0.0.1 -c unix_socket_permissions=0700", "start"])
    found = run(native_psql(store, port, admin, "postgres"), text=f"SELECT 1 FROM pg_database WHERE datname={literal(database)};")
    if found.stdout.strip() != "1":
        run(native_psql(store, port, admin, "postgres"), text=f"CREATE DATABASE {database} OWNER {admin};")


def port_of(path: Path, key: str) -> int:
    return int(env_file(path)[key])


def psql(sql: str, role: str = ADMIN, *, check: bool = True) -> subprocess.CompletedProcess:
    if NATIVE:
        return run(native_psql("analytics", port_of(SECRET, "HGH_ANALYTICS_DB_PORT"), role, DB), text=sql, check=check)
    return run(["docker", "exec", "-i", CONTAINER, "psql", "-X", "-q", "-A", "-t",
                "-v", "ON_ERROR_STOP=1", "-U", role, "-d", DB], text=sql, check=check)


def literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def credentials(port: int) -> dict[str, str]:
    if not SECRET.exists():
        stored = native_exists("analytics") if NATIVE else run(["docker", "volume", "inspect", "hgh-analytics-pgdata"], check=False).returncode == 0
        if stored:
            raise RuntimeError("An analytics volume already exists. Restore .env.analytics-db.local; no data was changed.")
        secure_write(SECRET, "\n".join((
            "# Server-only; never commit or expose through the frontend.",
            f"HGH_ANALYTICS_DB_PORT={port}", f"POSTGRES_PASSWORD={secrets.token_hex(32)}",
            f"ANALYTICS_READER_PASSWORD={secrets.token_hex(32)}",
            f"ANALYTICS_WRITER_PASSWORD={secrets.token_hex(32)}", "",
        )))
    values = env_file(SECRET)
    if any(not values.get(k) for k in ("POSTGRES_PASSWORD", "ANALYTICS_READER_PASSWORD", "ANALYTICS_WRITER_PASSWORD")):
        raise RuntimeError("Analytics credentials are incomplete; refusing to generate replacements.")
    selected_port = int(values.get("HGH_ANALYTICS_DB_PORT", str(port)))
    if not 1024 <= selected_port <= 65535:
        raise RuntimeError("Invalid analytics DB port")
    host = f"127.0.0.1:{selected_port}" if NATIVE else f"{CONTAINER}:5432"
    secure_write(ROOT / ".env.analytics.local", "# Reader connection for a service on hgh-analytics-network (native mode: this host).\n"
                 f"HGH_ANALYTICS_DB_URL=postgresql://{READER}:{values['ANALYTICS_READER_PASSWORD']}@{host}/{DB}\n")
    secure_write(ROOT / ".env.analytics-ingest.local", "# Writer connection for a collector on this HUB host.\n"
                 f"HGH_ANALYTICS_WRITER_DB_URL=postgresql://{WRITER}:{values['ANALYTICS_WRITER_PASSWORD']}@127.0.0.1:{selected_port}/{DB}\n")
    return values


def initialize(port: int):
    values = credentials(port)
    if NATIVE:
        native_start("analytics", int(values["HGH_ANALYTICS_DB_PORT"]), ADMIN, DB, values["POSTGRES_PASSWORD"])
    else:
        start_container()
    install(values)


def start_container():
    existing = run(["docker", "inspect", CONTAINER], check=False)
    if existing.returncode == 0:
        labels = json.loads(existing.stdout)[0]["Config"].get("Labels") or {}
        if labels.get("com.docker.compose.project") != PROJECT:
            raise RuntimeError("The analytics container name is already used by another project")
    started = run(["docker", "compose", "--env-file", str(SECRET), "-f", str(COMPOSE), "up", "-d"])
    print(sanitized(started.stdout.strip() or "Analytics PostgreSQL started"))
    for _ in range(90):
        ready = run(["docker", "inspect", CONTAINER, "--format", "{{.State.Health.Status}}"], check=False)
        if ready.returncode == 0 and ready.stdout.strip() == "healthy":
            break
        time.sleep(0.5)
    else:
        raise RuntimeError("Analytics PostgreSQL did not become ready")


def install(values: dict[str, str]):
    # No credentials are placed on process arguments or emitted to logs.
    roles = f"""
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{OWNER}') THEN CREATE ROLE {OWNER} NOLOGIN; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{READER}') THEN CREATE ROLE {READER} LOGIN; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{WRITER}') THEN CREATE ROLE {WRITER} LOGIN; END IF;
END $$;
ALTER ROLE {READER} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {literal(values['ANALYTICS_READER_PASSWORD'])};
ALTER ROLE {WRITER} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {literal(values['ANALYTICS_WRITER_PASSWORD'])};
ALTER ROLE {READER} SET default_transaction_read_only=on;
ALTER ROLE {READER} SET statement_timeout='30s';
ALTER ROLE {WRITER} SET statement_timeout='120s';
ALTER ROLE {READER} SET search_path=analytics,ref,ops;
ALTER ROLE {WRITER} SET search_path=analytics,ref,ops;
ALTER DATABASE {DB} OWNER TO {OWNER};
REVOKE ALL ON DATABASE {DB} FROM PUBLIC;
GRANT CONNECT ON DATABASE {DB} TO {READER},{WRITER};
COMMIT;
"""
    psql(roles)
    schema = (HERE / "schema.sql").read_text(encoding="utf-8")
    digest = hashlib.sha256(schema.encode()).hexdigest()
    has_ledger = psql("SELECT to_regclass('ops.schema_migration') IS NOT NULL;").stdout.strip() == "t"
    installed = psql(f"SELECT sha256 FROM ops.schema_migration WHERE version={literal(MIGRATION)};").stdout.strip() if has_ledger else ""
    if installed:
        if installed != digest:
            raise RuntimeError("Installed migration differs from schema.sql. Create a new migration; no tables were changed.")
        print("Schema already current; existing rows preserved")
    else:
        psql(f"BEGIN; SELECT pg_advisory_xact_lock(617427411); SET LOCAL ROLE {OWNER};\n" + schema +
             f"\nINSERT INTO ops.schema_migration(version,sha256) VALUES({literal(MIGRATION)},{literal(digest)}); COMMIT;")
        print("GA4/SEO schema installed")
    status()


def status():
    data = psql("""SELECT json_build_object('database',current_database(),'postgres',current_setting('server_version'),
        'base_tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema IN ('analytics','ref','ops') AND table_type='BASE TABLE'),
        'analytics_tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='analytics' AND table_type='BASE TABLE'),
        'foreign_servers',(SELECT count(*) FROM pg_foreign_server));""").stdout.strip()
    print(data)


def verify():
    from generate_schema import GA4, SEO, TABLES
    source = json.loads((HERE / "gold-source-schema.json").read_text(encoding="utf-8"))
    local = json.loads(psql("""SELECT coalesce(json_agg(c),'[]') FROM (
        SELECT table_schema,table_name,column_name,udt_name,is_nullable FROM information_schema.columns
        WHERE table_schema IN ('ref','analytics')) c;""").stdout)
    by_key = {(c["table_schema"], c["table_name"], c["column_name"]): c for c in local}
    checked = 0
    for col in source["columns"]:
        if col["table_name"] not in GA4 + SEO:
            continue
        actual = by_key[(TABLES[col["table_name"]], col["table_name"], col["column_name"])]
        if (actual["udt_name"], actual["is_nullable"]) != (col["udt_name"], col["is_nullable"]):
            raise RuntimeError(f"Column contract mismatch: {col['table_name']}.{col['column_name']}")
        checked += 1
    local_keys = json.loads(psql("""SELECT json_object_agg(t.relname,pg_get_constraintdef(c.oid))
        FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname='analytics' AND c.contype='p';""").stdout)
    for key in source["constraints"]:
        if key["table_name"] in GA4 + SEO and key["contype"] == "p":
            if local_keys.get(key["table_name"]) != key["definition"]:
                raise RuntimeError(f"Primary key contract mismatch: {key['table_name']}")
    reader = psql("SELECT json_build_object('role',current_user,'read_only',current_setting('transaction_read_only'));", READER).stdout.strip()
    print(reader)
    psql("""BEGIN READ WRITE; DO $$ BEGIN
      BEGIN INSERT INTO ops.data_version VALUES('ga4',1,now()); RAISE EXCEPTION 'Reader was able to write';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END;
      BEGIN CREATE TABLE analytics.forbidden_reader_write(id integer); RAISE EXCEPTION 'Reader was able to create a table';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    END $$; ROLLBACK;""", READER)
    psql((HERE / "verify.sql").read_text(encoding="utf-8"), WRITER)
    print(f"Verified {checked} source columns and 9 primary keys, reader grants, GA4 typed keys, SEO validation/publication and rollback")
    counts = json.loads(psql("SELECT coalesce(json_object_agg(relname,n_live_tup),'{}') FROM pg_stat_user_tables WHERE schemaname='analytics';").stdout)
    print("Analytics base tables: " + str(len(counts)))


def backup(output: Path | None):
    if output is None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        output = ROOT / ".local" / "analytics-backups" / f"hmg_analytics-{stamp}.dump"
    output.parent.mkdir(parents=True, exist_ok=True)
    if NATIVE:
        dump = [pg_tool("pg_dump"), "-h", str(NATIVE_ROOT / "analytics-socket"), "-p", str(port_of(SECRET, "HGH_ANALYTICS_DB_PORT"))]
    else:
        dump = ["docker", "exec", CONTAINER, "pg_dump"]
    with output.open("xb") as out:
        result = subprocess.run(dump + ["-U", ADMIN, "-d", DB, "--format=custom", "--no-owner", "--no-acl"],
                                stdout=out, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(sanitized(result.stderr.decode("utf-8", errors="replace")))
    if os.name != "nt":
        output.chmod(0o600)
    print(f"Backup created: {output}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("init", "status", "verify", "backup"))
    parser.add_argument("--port", type=int, default=55436)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.command == "init":
        if not 1024 <= args.port <= 65535:
            parser.error("port must be 1024..65535")
        initialize(args.port)
    elif args.command == "verify":
        verify()
    elif args.command == "backup":
        backup(args.output)
    else:
        status()


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(sanitized(str(error)), file=sys.stderr)
        sys.exit(1)
