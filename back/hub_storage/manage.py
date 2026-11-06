"""Manage the separate HUB stores (operations, data, input, metrics) without recreating the analytics volume."""
from __future__ import annotations

import argparse
import hashlib
import getpass
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import NamedTuple

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / 'back' / 'analytics'))
import manage as analytics

OPS_SECRET = ROOT / '.env.operations-db.local'
DATA_SECRET = ROOT / '.env.data-access.local'
EDIT_SECRET = ROOT / '.env.hub-edit-db.local'      # editor role password + login token secret
INTERNAL_SECRET = ROOT / '.env.internal-token.local'   # the key of the hub server's token to the data server; both servers read this file
EXT_SECRET = ROOT / '.env.ext-api-db.local'        # external API role password
FILTER_SECRET = ROOT / '.env.saved-filter-db.local'  # saved filter role password (operations DB)
ACCOUNT_SECRET = ROOT / '.env.account-db.local'    # account editor role password (operations DB)
GA4_REGISTRY_SECRET = ROOT / '.env.ga4-registry-db.local'  # GA4 registry editor role password (data DB)
SOURCE_OVERRIDE_SECRET = ROOT / '.env.source-override-db.local'  # source correction editor role password (data DB)
INTEREST_SECRET = ROOT / '.env.interest-db.local'  # customer-interest editor role password (data DB)
ENTITY_ROLE_SECRET = ROOT / '.env.entity-role-db.local'  # entity role editor role password (data DB)
PROJECT_EDITOR_SECRET = ROOT / '.env.project-editor-db.local'  # project prompt editor role password (data DB)
SERVICE_WEEK_SECRET = ROOT / '.env.service-week-db.local'  # service week job role password (data DB; manage.py only, never the API)
INPUT_SECRET = ROOT / '.env.input-db.local'        # input store (2026-11-06): admin, API reader and measurement editor passwords
QUERY_LOADER_SECRET = ROOT / '.env.query-loader-db.local'  # the query tables' load job (T9.7): manage.py only, never the API
METRICS_SECRET = ROOT / '.env.metrics-db.local'    # metrics store (2026-11-06): admin, API reader, cache and rollup passwords
OPS_CONTAINER = 'hgh-operations-db'
OPS_DB = 'operations_db'


class Store(NamedTuple):
    container: str
    database: str
    admin: str
    owner: str
    secret: Path
    port_key: str
    migrations: str  # the schema of its schema_migration table
    server: str | None = None  # the store whose server it shares, when it is a second database there


STORES = {
    'analytics': Store(analytics.CONTAINER, analytics.DB, analytics.ADMIN, analytics.OWNER, analytics.SECRET, 'HGH_ANALYTICS_DB_PORT', 'ops'),
    'operations': Store(OPS_CONTAINER, OPS_DB, 'hmg_operations_admin', 'hmg_operations_owner', OPS_SECRET, 'HGH_OPERATIONS_DB_PORT', 'system'),
    'input': Store('hgh-input-db', 'input_db', 'hmg_input_admin', 'hmg_input_owner', INPUT_SECRET, 'HGH_INPUT_DB_PORT', 'catalog'),
    'metrics': Store('hgh-metrics-db', 'gold_db', 'hmg_metrics_admin', 'hmg_metrics_owner', METRICS_SECRET, 'HGH_METRICS_DB_PORT', 'gold'),
    'cache': Store('hgh-metrics-db', 'cache_db', 'hmg_metrics_admin', 'hmg_metrics_owner', METRICS_SECRET, 'HGH_METRICS_DB_PORT', 'cache', 'metrics'),
}
GOLD_ICU_LOCALE = 'en-US-u-ka-shifted'  # macOS libc sorts UTF-8 byte by byte; the readers' ORDER BY passes over punctuation (back/hub_storage/copy_gold.py)
# External API (2026-10-28): what a project approval covers, the Gold reference families an approval can
# open (the HUB-owned surface/brand_bit/mention_type are always part of the contract), key lifetimes.
PROJECT_FLAGS = ('projects', 'prompts')
# source_override, source_seed, source_social and source_code (2026-10-30) are the HUB's own source classification
# inputs, interest_keyword and interest_source (2026-11-02) its customer-interest collection inputs, entity_role
# (2026-11-02) its entity roles (source hub_edit), approved like the Gold families.
# Since 2026-11-06 only the families of the contract (SSOT service/prompt-reference-api.md) can be opened.
REFERENCE_FAMILIES = ('engine', 'country', 'language', 'interest_keyword', 'interest_source', 'taxon', 'brand', 'source_override',
                      'source_seed', 'source_social', 'source_code', 'entity_role')
AUDIENCES = ('collect', 'analyze')  # 수집 reads prompts, settings and the collecting values; 분석 reads the analysis values
KEY_DAYS, KEY_DAYS_MAX, KEYS_PER_CLIENT = 180, 365, 2
RETIRED_DATA_STORE = ROOT / '.local' / 'analytics-retired'  # a container host: the old store's volume stays until removed by hand
KEY_LOCK = 617427414     # one key issue at a time, so the per-client limit holds
CATALOG_LOCK = 617427413  # every catalog writer (sync_catalog.py, the HUB editors): change_seq order = commit order


def sanitize(message):
    for path in (OPS_SECRET, DATA_SECRET, EDIT_SECRET, EXT_SECRET, FILTER_SECRET, ACCOUNT_SECRET, GA4_REGISTRY_SECRET,
                 SOURCE_OVERRIDE_SECRET, INTEREST_SECRET, ENTITY_ROLE_SECRET, SERVICE_WEEK_SECRET, PROJECT_EDITOR_SECRET,
                 INPUT_SECRET, METRICS_SECRET, INTERNAL_SECRET, analytics.SECRET):
        if path.exists():
            for key, value in analytics.env_file(path).items():
                if ('PASSWORD' in key or 'SECRET' in key) and value:
                    message = message.replace(value, '[redacted]')
    return message


def run(args, text=None, check=True):
    result = analytics.run(args, text=text, check=False)
    if check and result.returncode:
        raise RuntimeError(sanitize(result.stderr[-2500:] or result.stdout[-2500:]))
    return result


def port_of(store):
    return analytics.port_of(STORES[store].secret, STORES[store].port_key)


def psql_args(store, role=None):
    """The psql command for a store: its local server's socket in native mode, inside its container otherwise."""
    s = STORES[store]
    if analytics.NATIVE:
        return analytics.native_psql(s.server or store, port_of(store), role or s.admin, s.database)
    return ['docker', 'exec', '-i', s.container, 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', role or s.admin, '-d', s.database]


def sql(query, operations=False, role=None, check=True, store=None):
    return run(psql_args(store or ('operations' if operations else 'analytics'), role), text=query, check=check)


def isql(query, **options):
    """The input store: prompts, settings, reference values, API policy (2026-11-06)."""
    return sql(query, store='input', **options)


def ops_port():
    return port_of('operations')


def data_port():
    return port_of('analytics')


def service_host(store):
    """Where the API reaches a store: the container on its Docker network, or this host in native mode."""
    return f'127.0.0.1:{port_of(store)}' if analytics.NATIVE else f'{STORES[store].container}:5432'


def api_python(script, api_env=False):
    """Run a helper script where the API runs: inside its container, or this Python in native mode (BFF env; with `api_env` the API's
    stores too and the back folder as the working directory, for a script that imports data_server)."""
    if analytics.NATIVE:
        files = ['.env.gold.local', *(['.env.analytics.local', '.env.operations.local', '.env.input.local', '.env.metrics.local', '.env.hub-edit.local', '.env.silver.local'] if api_env else [])]
        env = dict(os.environ)
        for name in files:
            if (ROOT / name).exists():
                env.update(analytics.env_file(ROOT / name))
        out = subprocess.run([sys.executable, '-X', 'utf8', '-'], input=script.encode(), capture_output=True, env=env, cwd=ROOT / 'back' if api_env else None)
        if out.returncode:
            raise RuntimeError(sanitize(out.stderr.decode(errors='replace')[-2500:]))
        return out.stdout.decode()
    return run(['docker', 'exec', '-i', 'hgh-gold-api', 'python', '-'], text=script).stdout


def create_secret(path, fields, volume=None, store='operations'):
    if not path.exists():
        stored = volume and (analytics.native_exists(store) if analytics.NATIVE
                             else run(['docker', 'volume', 'inspect', volume], check=False).returncode == 0)
        if stored:
            raise RuntimeError(f'{volume} exists; restore {path.name}. No existing credentials/data were changed.')
        analytics.secure_write(path, '# Server-only. Never commit.\n' + '\n'.join(
            f'{key}={value if value is not None else secrets.token_hex(32)}' for key, value in fields.items()) + '\n')
    values = analytics.env_file(path)
    if any(not values.get(key) for key in fields):
        raise RuntimeError(f'{path.name} is incomplete; refusing to replace credentials')
    return values


def migrate(filename, version, operations=False, store=None):
    name = store or ('operations' if operations else 'analytics')
    namespace, owner = STORES[name].migrations, STORES[name].owner
    query = (HERE / filename).read_text(encoding='utf8')
    checksum = hashlib.sha256(query.encode()).hexdigest()
    exists = sql(f"SELECT to_regclass('{namespace}.schema_migration') IS NOT NULL;", store=name).stdout.strip() == 't'
    installed = sql(f"SELECT sha256 FROM {namespace}.schema_migration WHERE version={analytics.literal(version)};", store=name).stdout.strip() if exists else ''
    if installed:
        if installed != checksum:
            raise RuntimeError(f'Installed {version} checksum differs; add a new migration instead')
        print(f'{version}: already installed; rows preserved')
        return
    sql(f'BEGIN; SELECT pg_advisory_xact_lock(617427412); SET LOCAL ROLE {owner};\n' + query +
        f"\nINSERT INTO {namespace}.schema_migration(version,sha256) VALUES({analytics.literal(version)},{analytics.literal(checksum)}); COMMIT;", store=name)
    print(f'{version}: installed')


def old_data_store():
    """hmg_analytics is still on this machine. It is only read to move what it holds (retire_data_store); a new machine never has one."""
    if RETIRED_DATA_STORE.exists():
        return False
    if analytics.NATIVE:
        return analytics.native_exists('analytics')
    return run(['docker', 'volume', 'inspect', 'hgh-analytics-pgdata'], check=False).returncode == 0


def initialize():
    # The existing initializer verifies its original migration checksum, without resetting data.
    if old_data_store():
        analytics.initialize(55436)
    values = create_secret(OPS_SECRET, {'HGH_OPERATIONS_DB_PORT': '55437', 'POSTGRES_PASSWORD': None,
                           'OPERATIONS_READER_PASSWORD': None, 'OPERATIONS_WRITER_PASSWORD': None}, 'hgh-operations-pgdata')
    port = int(values['HGH_OPERATIONS_DB_PORT'])
    if not 1024 <= port <= 65535:
        raise RuntimeError('Invalid operations DB port')
    if analytics.NATIVE:
        analytics.native_start('operations', port, 'hmg_operations_admin', OPS_DB, values['POSTGRES_PASSWORD'])
    else:
        start_operations_container()
    install(values)
    install_input()
    install_metrics()
    move_input()
    retire_data_store()
    write_env_files()
    status()


def start_operations_container():
    existing = run(['docker', 'inspect', OPS_CONTAINER], check=False)
    if existing.returncode == 0:
        labels = json.loads(existing.stdout)[0]['Config'].get('Labels') or {}
        if labels.get('com.docker.compose.project') != 'hmg-geo-hub-operations':
            raise RuntimeError('Operations container name belongs to another project')
    run(['docker', 'compose', '--env-file', str(OPS_SECRET), '-f', str(ROOT / 'infra/operations/compose.yml'), 'up', '-d'])
    for _ in range(90):
        ready = run(['docker', 'inspect', OPS_CONTAINER, '--format', '{{.State.Health.Status}}'], check=False)
        if ready.returncode == 0 and ready.stdout.strip() == 'healthy':
            rename_previous(STORES['operations'])
            break
        time.sleep(.5)
    else:
        raise RuntimeError('Operations DB did not become ready')


def install(values):
    sql(f"""BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_operations_owner') THEN CREATE ROLE hmg_operations_owner NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_operations_reader') THEN CREATE ROLE hmg_operations_reader LOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_operations_writer') THEN CREATE ROLE hmg_operations_writer LOGIN; END IF;
END $$;
ALTER ROLE hmg_operations_reader WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {analytics.literal(values['OPERATIONS_READER_PASSWORD'])};
ALTER ROLE hmg_operations_writer WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {analytics.literal(values['OPERATIONS_WRITER_PASSWORD'])};
ALTER ROLE hmg_operations_reader SET default_transaction_read_only=on;
ALTER ROLE hmg_operations_reader SET statement_timeout='15s';
ALTER ROLE hmg_operations_writer SET statement_timeout='30s';
ALTER DATABASE operations_db OWNER TO hmg_operations_owner;
REVOKE ALL ON DATABASE operations_db FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
GRANT CONNECT ON DATABASE operations_db TO hmg_operations_reader,hmg_operations_writer;
COMMIT;""", True)
    migrate('operations-001.sql', '001_operations', True)
    migrate('operations-002.sql', '002_hub_login', True)
    # Saved filters (2026-10-28): the API's role for system.saved_filter and nothing else.
    if not FILTER_SECRET.exists() and sql("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_saved_filter_editor');", True).stdout.strip() == 't':
        raise RuntimeError('The saved filter role already exists; restore .env.saved-filter-db.local rather than replacing credentials')
    saved = create_secret(FILTER_SECRET, {'SAVED_FILTER_EDITOR_PASSWORD': None})
    sql(f"""BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_saved_filter_editor') THEN CREATE ROLE hmg_saved_filter_editor LOGIN; END IF;
END $$;
ALTER ROLE hmg_saved_filter_editor WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {analytics.literal(saved['SAVED_FILTER_EDITOR_PASSWORD'])};
ALTER ROLE hmg_saved_filter_editor SET statement_timeout='15s';
ALTER ROLE hmg_saved_filter_editor CONNECTION LIMIT 4;
GRANT CONNECT ON DATABASE operations_db TO hmg_saved_filter_editor;
COMMIT;""", True)
    migrate('operations-003.sql', '003_saved_filters', True)
    # HUB accounts (2026-10-29): the API's role for the account tables (Admin › 사용자 관리) and nothing else.
    if not ACCOUNT_SECRET.exists() and sql("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_account_editor');", True).stdout.strip() == 't':
        raise RuntimeError('The account editor role already exists; restore .env.account-db.local rather than replacing credentials')
    account = create_secret(ACCOUNT_SECRET, {'ACCOUNT_EDITOR_PASSWORD': None})
    sql(f"""BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_account_editor') THEN CREATE ROLE hmg_account_editor LOGIN; END IF;
END $$;
ALTER ROLE hmg_account_editor WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {analytics.literal(account['ACCOUNT_EDITOR_PASSWORD'])};
ALTER ROLE hmg_account_editor SET statement_timeout='15s';
ALTER ROLE hmg_account_editor CONNECTION LIMIT 4;
GRANT CONNECT ON DATABASE operations_db TO hmg_account_editor;
COMMIT;""", True)
    migrate('operations-004.sql', '004_hub_accounts', True)
    migrate('operations-005.sql', '005_account_one_brand', True)
    migrate('operations-006.sql', '006_account_editor_columns', True)
    if not old_data_store():
        # A machine without the old data DB: the roles' passwords are made here and the roles on the stores that use them.
        for path, fields in ((DATA_SECRET, {'CATALOG_WRITER_PASSWORD': None}), (EDIT_SECRET, {'CATALOG_EDITOR_PASSWORD': None, 'HGH_AUTH_SECRET': None}),
                             (EXT_SECRET, {'EXT_API_PASSWORD': None}), (GA4_REGISTRY_SECRET, {'GA4_REGISTRY_EDITOR_PASSWORD': None}),
                             (SOURCE_OVERRIDE_SECRET, {'SOURCE_OVERRIDE_EDITOR_PASSWORD': None}), (INTEREST_SECRET, {'INTEREST_EDITOR_PASSWORD': None}),
                             (ENTITY_ROLE_SECRET, {'ENTITY_ROLE_EDITOR_PASSWORD': None}), (SERVICE_WEEK_SECRET, {'SERVICE_WEEK_WRITER_PASSWORD': None}),
                             (PROJECT_EDITOR_SECRET, {'PROJECT_EDITOR_PASSWORD': None})):
            create_secret(path, fields)
        return
    if not DATA_SECRET.exists() and sql("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('hmg_catalog_writer','hmg_data_external'));").stdout.strip() == 't':
        raise RuntimeError('Data access roles already exist; restore .env.data-access.local rather than replacing credentials')
    data = create_secret(DATA_SECRET, {'CATALOG_WRITER_PASSWORD': None, 'DATA_EXTERNAL_PASSWORD': None})
    sql(f"""BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_catalog_writer') THEN CREATE ROLE hmg_catalog_writer LOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_data_external') THEN CREATE ROLE hmg_data_external LOGIN; END IF;
END $$;
ALTER ROLE hmg_catalog_writer WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {analytics.literal(data['CATALOG_WRITER_PASSWORD'])};
ALTER ROLE hmg_data_external WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {analytics.literal(data['DATA_EXTERNAL_PASSWORD'])};
ALTER ROLE hmg_catalog_writer SET statement_timeout='60s';
ALTER ROLE hmg_data_external SET default_transaction_read_only=on;
ALTER ROLE hmg_data_external SET statement_timeout='15s';
ALTER ROLE hmg_data_external SET idle_in_transaction_session_timeout='30s';
ALTER ROLE hmg_data_external CONNECTION LIMIT 4;
ALTER ROLE hmg_data_external SET search_path=published;
GRANT CONNECT ON DATABASE hmg_analytics TO hmg_catalog_writer,hmg_data_external;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
COMMIT;""")
    migrate('data-002.sql', '002_data_catalog_publication')
    migrate('data-003.sql', '003_published_dimensions')
    # Global prompt editing (2026-10-27): the API's INSERT-only catalog role and the login token secret.
    if not EDIT_SECRET.exists() and sql("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_catalog_editor');").stdout.strip() == 't':
        raise RuntimeError('The catalog editor role already exists; restore .env.hub-edit-db.local rather than replacing credentials')
    edit = create_secret(EDIT_SECRET, {'CATALOG_EDITOR_PASSWORD': None, 'HGH_AUTH_SECRET': None})
    sql(f"""BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_catalog_editor') THEN CREATE ROLE hmg_catalog_editor LOGIN; END IF;
END $$;
ALTER ROLE hmg_catalog_editor WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {analytics.literal(edit['CATALOG_EDITOR_PASSWORD'])};
ALTER ROLE hmg_catalog_editor SET statement_timeout='15s';
ALTER ROLE hmg_catalog_editor CONNECTION LIMIT 4;
GRANT CONNECT ON DATABASE hmg_analytics TO hmg_catalog_editor;
COMMIT;""")
    migrate('data-004.sql', '004_hub_prompt_editing')
    # External API (2026-10-28): a read-only role that sees the ext schema and nothing else.
    if not EXT_SECRET.exists() and sql("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_ext_api');").stdout.strip() == 't':
        raise RuntimeError('The external API role already exists; restore .env.ext-api-db.local rather than replacing credentials')
    ext = create_secret(EXT_SECRET, {'EXT_API_PASSWORD': None})
    sql(f"""BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_ext_api') THEN CREATE ROLE hmg_ext_api LOGIN; END IF;
END $$;
ALTER ROLE hmg_ext_api WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {analytics.literal(ext['EXT_API_PASSWORD'])};
ALTER ROLE hmg_ext_api SET default_transaction_read_only=on;
ALTER ROLE hmg_ext_api SET statement_timeout='10s';
ALTER ROLE hmg_ext_api SET idle_in_transaction_session_timeout='15s';
ALTER ROLE hmg_ext_api SET search_path=ext;
ALTER ROLE hmg_ext_api CONNECTION LIMIT 8;
GRANT CONNECT ON DATABASE hmg_analytics TO hmg_ext_api;
COMMIT;""")
    migrate('data-005.sql', '005_external_api')
    # GA4 registry (2026-10-29): the API's role for the registry and its history (Admin › GA4 연동) and nothing else.
    if not GA4_REGISTRY_SECRET.exists() and sql("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_ga4_registry_editor');").stdout.strip() == 't':
        raise RuntimeError('The GA4 registry role already exists; restore .env.ga4-registry-db.local rather than replacing credentials')
    registry = create_secret(GA4_REGISTRY_SECRET, {'GA4_REGISTRY_EDITOR_PASSWORD': None})
    sql(f"""BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_ga4_registry_editor') THEN CREATE ROLE hmg_ga4_registry_editor LOGIN; END IF;
END $$;
ALTER ROLE hmg_ga4_registry_editor WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {analytics.literal(registry['GA4_REGISTRY_EDITOR_PASSWORD'])};
ALTER ROLE hmg_ga4_registry_editor SET statement_timeout='15s';
ALTER ROLE hmg_ga4_registry_editor CONNECTION LIMIT 4;
GRANT CONNECT ON DATABASE hmg_analytics TO hmg_ga4_registry_editor;
COMMIT;""")
    migrate('data-006.sql', '006_ga4_registry')
    # Source category corrections (2026-10-30): the API's role for the corrections, their history and their
    # publishing function (Admin › 인용 출처 분류) and nothing else.
    if not SOURCE_OVERRIDE_SECRET.exists() and sql("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_source_override_editor');").stdout.strip() == 't':
        raise RuntimeError('The source correction role already exists; restore .env.source-override-db.local rather than replacing credentials')
    override = create_secret(SOURCE_OVERRIDE_SECRET, {'SOURCE_OVERRIDE_EDITOR_PASSWORD': None})
    sql(f"""BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_source_override_editor') THEN CREATE ROLE hmg_source_override_editor LOGIN; END IF;
END $$;
ALTER ROLE hmg_source_override_editor WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {analytics.literal(override['SOURCE_OVERRIDE_EDITOR_PASSWORD'])};
ALTER ROLE hmg_source_override_editor SET statement_timeout='15s';
ALTER ROLE hmg_source_override_editor CONNECTION LIMIT 4;
GRANT CONNECT ON DATABASE hmg_analytics TO hmg_source_override_editor;
COMMIT;""")
    migrate('data-007.sql', '007_source_overrides')
    # The rest of the source classification inputs (2026-10-30): seeds, official social accounts and the code table,
    # kept by the same role (Admin › 인용 출처 분류).
    migrate('data-008.sql', '008_source_lists')
    # Customer-interest inputs (2026-11-02): the API's role for the seed keywords, the community sources, their history
    # and their publishing functions (Admin › 고객 관심 데이터 관리) and nothing else.
    if not INTEREST_SECRET.exists() and sql("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_interest_editor');").stdout.strip() == 't':
        raise RuntimeError('The customer-interest role already exists; restore .env.interest-db.local rather than replacing credentials')
    interest = create_secret(INTEREST_SECRET, {'INTEREST_EDITOR_PASSWORD': None})
    sql(f"""BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_interest_editor') THEN CREATE ROLE hmg_interest_editor LOGIN; END IF;
END $$;
ALTER ROLE hmg_interest_editor WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {analytics.literal(interest['INTEREST_EDITOR_PASSWORD'])};
ALTER ROLE hmg_interest_editor SET statement_timeout='15s';
ALTER ROLE hmg_interest_editor CONNECTION LIMIT 4;
GRANT CONNECT ON DATABASE hmg_analytics TO hmg_interest_editor;
COMMIT;""")
    migrate('data-009.sql', '009_interest_inputs')
    # Entity roles (2026-11-02): the API's role for the roles, their history and their publishing function
    # (Admin › 엔티티 카탈로그) and nothing else.
    if not ENTITY_ROLE_SECRET.exists() and sql("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_entity_role_editor');").stdout.strip() == 't':
        raise RuntimeError('The entity role editor already exists; restore .env.entity-role-db.local rather than replacing credentials')
    entity_role = create_secret(ENTITY_ROLE_SECRET, {'ENTITY_ROLE_EDITOR_PASSWORD': None})
    sql(f"""BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_entity_role_editor') THEN CREATE ROLE hmg_entity_role_editor LOGIN; END IF;
END $$;
ALTER ROLE hmg_entity_role_editor WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {analytics.literal(entity_role['ENTITY_ROLE_EDITOR_PASSWORD'])};
ALTER ROLE hmg_entity_role_editor SET statement_timeout='15s';
ALTER ROLE hmg_entity_role_editor CONNECTION LIMIT 4;
GRANT CONNECT ON DATABASE hmg_analytics TO hmg_entity_role_editor;
COMMIT;""")
    migrate('data-010.sql', '010_entity_roles')
    # Service week (2026-11-02): the job's role for catalog.service_week and nothing else. Transient like the catalog
    # writer: manage.py sync-service-week uses it, the API never gets it (no line in .env.hub-edit.local).
    if not SERVICE_WEEK_SECRET.exists() and sql("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_service_week_writer');").stdout.strip() == 't':
        raise RuntimeError('The service week role already exists; restore .env.service-week-db.local rather than replacing credentials')
    week_writer = create_secret(SERVICE_WEEK_SECRET, {'SERVICE_WEEK_WRITER_PASSWORD': None})
    sql(f"""BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_service_week_writer') THEN CREATE ROLE hmg_service_week_writer LOGIN; END IF;
END $$;
ALTER ROLE hmg_service_week_writer WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {analytics.literal(week_writer['SERVICE_WEEK_WRITER_PASSWORD'])};
ALTER ROLE hmg_service_week_writer SET statement_timeout='15s';
ALTER ROLE hmg_service_week_writer CONNECTION LIMIT 2;
GRANT CONNECT ON DATABASE hmg_analytics TO hmg_service_week_writer;
COMMIT;""")
    migrate('data-011.sql', '011_service_week')
    # Project prompts (2026-11-03): the API's role for the project catalogs (Project › Prompt: prompts, their tags and the
    # project's tag columns) and nothing else.
    if not PROJECT_EDITOR_SECRET.exists() and sql("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_project_editor');").stdout.strip() == 't':
        raise RuntimeError('The project editor already exists; restore .env.project-editor-db.local rather than replacing credentials')
    project_editor = create_secret(PROJECT_EDITOR_SECRET, {'PROJECT_EDITOR_PASSWORD': None})
    sql(f"""BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hmg_project_editor') THEN CREATE ROLE hmg_project_editor LOGIN; END IF;
END $$;
ALTER ROLE hmg_project_editor WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {analytics.literal(project_editor['PROJECT_EDITOR_PASSWORD'])};
ALTER ROLE hmg_project_editor SET statement_timeout='15s';
ALTER ROLE hmg_project_editor CONNECTION LIMIT 4;
GRANT CONNECT ON DATABASE hmg_analytics TO hmg_project_editor;
COMMIT;""")
    migrate('data-012.sql', '012_project_prompts')
    # Source list versions (2026-11-03): every change of the 인용 출처 분류 inputs is one whole-row version (a trigger;
    # no new role, the screen's role only reads them).
    migrate('data-013.sql', '013_source_versions')


# ═══ the input and metrics stores (2026-11-06) ═══════════════════════════════════════════════════════════════════════════════

def startup_database(store):
    """The database a server's start makes when missing. The metrics server's two are install_metrics', with their sort order."""
    return 'postgres' if store == 'metrics' else STORES[store].database


def rename_previous(s):
    """An existing container keeps its database under the old name: POSTGRES_DB only applies to a new volume."""
    query = analytics.rename_sql(s.database)
    if query:
        run(['docker', 'exec', '-i', s.container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', s.admin, '-d', 'postgres'], text=query)


def start_store(store):
    """The store's server: a local one in native mode, its own container otherwise."""
    s = STORES[store]
    values = analytics.env_file(s.secret)
    if analytics.NATIVE:
        analytics.native_start(store, int(values[s.port_key]), s.admin, startup_database(store), values['POSTGRES_PASSWORD'])
        return
    run(['docker', 'compose', '--env-file', str(s.secret), '-f', str(ROOT / f'infra/{store}/compose.yml'), 'up', '-d'])
    for _ in range(90):
        ready = run(['docker', 'inspect', s.container, '--format', '{{.State.Health.Status}}'], check=False)
        if ready.returncode == 0 and ready.stdout.strip() == 'healthy':
            rename_previous(s)
            return
        time.sleep(.5)
    raise RuntimeError(f'The {store} DB did not become ready')


def login_role(name, password, *settings):
    """Create the role if missing and (re)set its limits. Passwords travel over psql stdin, never argv."""
    return (f"DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{name}') THEN CREATE ROLE {name} LOGIN; END IF; END $$;\n"
            f"ALTER ROLE {name} WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {analytics.literal(password)};\n"
            + ''.join(f'ALTER ROLE {name} {setting};\n' for setting in settings))


def store_database(store, logins):
    """The database belongs to the store's owner role and only the named roles may connect to it."""
    s = STORES[store]
    return f"""DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{s.owner}') THEN CREATE ROLE {s.owner} NOLOGIN; END IF; END $$;
ALTER DATABASE {s.database} OWNER TO {s.owner};
REVOKE ALL ON DATABASE {s.database} FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
GRANT CONNECT ON DATABASE {s.database} TO {','.join(logins)};
"""


def ga4_roles():
    """The GA4 reader's and the collector's passwords. The file keeps the name it had with the old data DB."""
    return create_secret(analytics.SECRET, {'ANALYTICS_READER_PASSWORD': None, 'ANALYTICS_WRITER_PASSWORD': None})


def install_input():
    """The input store. The roles keep the names they have on the data server, with the passwords already in their secret files, so
    only the host in their connections changes."""
    values = create_secret(INPUT_SECRET, {'HGH_INPUT_DB_PORT': '55438', 'POSTGRES_PASSWORD': None, 'INPUT_READER_PASSWORD': None,
                                          'MEASUREMENT_EDITOR_PASSWORD': None}, 'hgh-input-pgdata', 'input')
    start_store('input')
    env = analytics.env_file
    editor = ("SET statement_timeout='15s'", 'CONNECTION LIMIT 4')
    roles = [login_role('hmg_input_reader', values['INPUT_READER_PASSWORD'], 'SET default_transaction_read_only=on', "SET statement_timeout='15s'"),
             login_role('hmg_measurement_editor', values['MEASUREMENT_EDITOR_PASSWORD'], *editor),
             login_role('hmg_catalog_writer', env(DATA_SECRET)['CATALOG_WRITER_PASSWORD'], "SET statement_timeout='60s'"),
             login_role('hmg_catalog_editor', env(EDIT_SECRET)['CATALOG_EDITOR_PASSWORD'], *editor),
             login_role('hmg_project_editor', env(PROJECT_EDITOR_SECRET)['PROJECT_EDITOR_PASSWORD'], *editor),
             login_role('hmg_source_override_editor', env(SOURCE_OVERRIDE_SECRET)['SOURCE_OVERRIDE_EDITOR_PASSWORD'], *editor),
             login_role('hmg_interest_editor', env(INTEREST_SECRET)['INTEREST_EDITOR_PASSWORD'], *editor),
             login_role('hmg_entity_role_editor', env(ENTITY_ROLE_SECRET)['ENTITY_ROLE_EDITOR_PASSWORD'], *editor),
             login_role('hmg_ga4_registry_editor', env(GA4_REGISTRY_SECRET)['GA4_REGISTRY_EDITOR_PASSWORD'], *editor),
             login_role('hmg_service_week_writer', env(SERVICE_WEEK_SECRET)['SERVICE_WEEK_WRITER_PASSWORD'], "SET statement_timeout='15s'", 'CONNECTION LIMIT 2'),
             login_role('hmg_analytics_writer', ga4_roles()['ANALYTICS_WRITER_PASSWORD'], "SET statement_timeout='5min'"),
             login_role('hmg_ext_api', env(EXT_SECRET)['EXT_API_PASSWORD'], 'SET default_transaction_read_only=on', "SET statement_timeout='10s'",
                        "SET idle_in_transaction_session_timeout='15s'", 'SET search_path=ext', 'CONNECTION LIMIT 8')]
    logins = ['hmg_input_reader', 'hmg_measurement_editor', 'hmg_catalog_writer', 'hmg_catalog_editor', 'hmg_project_editor',
              'hmg_source_override_editor', 'hmg_interest_editor', 'hmg_entity_role_editor', 'hmg_ga4_registry_editor', 'hmg_service_week_writer',
              'hmg_analytics_writer', 'hmg_ext_api']
    isql('BEGIN;\n' + ''.join(roles) + store_database('input', logins) + 'COMMIT;')
    migrate('input-001.sql', '001_input_store', store='input')
    migrate('input-002.sql', '002_measurement_reference_contract', store='input')
    migrate('input-003.sql', '003_ga4_properties_service_week', store='input')


def metrics_server_sql(query):
    """On the metrics server's own database: what has to run before its two databases exist."""
    s = STORES['metrics']
    if analytics.NATIVE:
        return run(analytics.native_psql('metrics', port_of('metrics'), s.admin, 'postgres'), text=query)
    return run(['docker', 'exec', '-i', s.container, 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', s.admin, '-d', 'postgres'], text=query)


def install_metrics():
    """The metrics server's two databases, both the BFF's own (2026-11-06, D-17): Gold, the pre-computed values (gold_db), and the
    cache DB (cache_db)."""
    values = create_secret(METRICS_SECRET, {'HGH_METRICS_DB_PORT': '55439', 'POSTGRES_PASSWORD': None, 'METRICS_READER_PASSWORD': None,
                                            'CACHE_WRITER_PASSWORD': None, 'ROLLUP_WRITER_PASSWORD': None}, 'hgh-metrics-pgdata', 'metrics')
    start_store('metrics')
    owner = STORES['metrics'].owner
    metrics_server_sql('BEGIN;\n' + login_role('hmg_metrics_reader', values['METRICS_READER_PASSWORD'], 'SET default_transaction_read_only=on', "SET statement_timeout='15s'")
        + login_role('hmg_cache_writer', values['CACHE_WRITER_PASSWORD'], "SET statement_timeout='30s'", 'CONNECTION LIMIT 4')
        + login_role('hmg_rollup_writer', values['ROLLUP_WRITER_PASSWORD'], "SET statement_timeout='10min'", 'CONNECTION LIMIT 2')
        + login_role('hmg_analytics_reader', ga4_roles()['ANALYTICS_READER_PASSWORD'], 'SET default_transaction_read_only=on', "SET statement_timeout='15s'")
        + login_role('hmg_analytics_writer', ga4_roles()['ANALYTICS_WRITER_PASSWORD'], "SET statement_timeout='5min'")
        + login_role('hmg_query_loader', create_secret(QUERY_LOADER_SECRET, {'QUERY_LOADER_PASSWORD': None})['QUERY_LOADER_PASSWORD'], "SET statement_timeout='30min'", 'CONNECTION LIMIT 4')
        + f"DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{owner}') THEN CREATE ROLE {owner} NOLOGIN; END IF; END $$;\nCOMMIT;")
    # Gold's sort order is the readers': set when the database is made, and it cannot change after.
    gold_locale = f"LOCALE_PROVIDER icu ICU_LOCALE '{GOLD_ICU_LOCALE}' LOCALE 'C'" if analytics.NATIVE else ''
    for store, locale in (('metrics', gold_locale), ('cache', '')):
        database = STORES[store].database
        if analytics.rename_sql(database):
            metrics_server_sql(analytics.rename_sql(database))
        if metrics_server_sql(f"SELECT 1 FROM pg_database WHERE datname={analytics.literal(database)};").stdout.strip() != '1':
            metrics_server_sql(f"CREATE DATABASE {database} OWNER {owner} TEMPLATE template0 ENCODING 'UTF8' {locale};")
    sql('BEGIN;\n' + store_database('metrics', ['hmg_metrics_reader', 'hmg_rollup_writer', 'hmg_analytics_reader', 'hmg_analytics_writer', 'hmg_query_loader']) + 'COMMIT;', store='metrics')
    sql('BEGIN;\n' + store_database('cache', ['hmg_cache_writer']) + 'COMMIT;', store='cache')
    migrate('metrics-001.sql', '001_gold', store='metrics')
    migrate('metrics-002.sql', '002_first_screen', store='metrics')
    migrate('metrics-003.sql', '003_metric_rows', store='metrics')
    migrate('metrics-004.sql', '004_ga4_seo', store='metrics')
    migrate('metrics-005.sql', '005_keyword_social', store='metrics')
    migrate('metrics-006.sql', '006_query_load', store='metrics')
    migrate('cache-001.sql', '001_cache', store='cache')


# Everything the inputs were in the data DB. catalog.service_week, catalog.project_ga4_property and published.* stay there.
MOVED_TABLES = ('catalog.project', 'catalog.project_version', 'catalog.prompt', 'catalog.prompt_version', 'catalog.reference_set',
                'catalog.reference_item', 'catalog.sync_run', 'catalog.source_override', 'catalog.source_override_event',
                'catalog.source_override_version', 'catalog.source_seed', 'catalog.source_seed_event', 'catalog.source_seed_version',
                'catalog.source_social', 'catalog.source_social_event', 'catalog.source_social_version', 'catalog.source_code',
                'catalog.source_code_event', 'catalog.source_code_version', 'catalog.interest_keyword', 'catalog.interest_keyword_event',
                'catalog.interest_source', 'catalog.interest_source_event', 'catalog.entity_role', 'catalog.entity_role_event',
                'publication.project_access', 'publication.reference_access', 'publication.api_client', 'publication.api_key',
                'publication.api_client_project')
MOVE_FINGERPRINTS = ("SELECT md5(string_agg(prompt_id::text||version||sha256||change_seq,'' ORDER BY prompt_id,version)) FROM catalog.prompt_version",
                     "SELECT md5(string_agg(project_id::text||version||sha256||change_seq,'' ORDER BY project_id,version)) FROM catalog.project_version",
                     "SELECT md5(string_agg(set_id::text||item_key||definition::text,'' ORDER BY set_id,item_key)) FROM catalog.reference_item",
                     "SELECT md5(string_agg(key_hash,'' ORDER BY key_hash)) FROM publication.api_key")


def columns_of(table, store):
    schema, name = table.split('.')
    out = sql(f"""SELECT column_name FROM information_schema.columns WHERE table_schema={analytics.literal(schema)}
AND table_name={analytics.literal(name)} ORDER BY ordinal_position;""", store=store).stdout.split()
    return [str(c) for c in out]


def move_input():
    """Once: the inputs written so far move from the data DB to the input store, with their ids, versions and change_seq, in one
    transaction, and the data DB copy stops taking writes first. Runs before the API restarts, so until then the old API's writes fail
    rather than get lost. Nothing is deleted here; retire_data_store removes the old store after it has moved the rest."""
    if not old_data_store():
        return
    migrate('data-014.sql', '014_inputs_moved')
    # install() grants these for a new data DB; on the data DB they stay out for good.
    sql('REVOKE CONNECT ON DATABASE hmg_analytics FROM hmg_catalog_writer,hmg_catalog_editor,hmg_project_editor,hmg_source_override_editor,'
        'hmg_interest_editor,hmg_entity_role_editor,hmg_ext_api;')
    if isql('SELECT EXISTS(SELECT 1 FROM catalog.project);').stdout.strip() == 't':
        print('Inputs: already in the input store')
        return
    if sql('SELECT NOT EXISTS(SELECT 1 FROM catalog.project);').stdout.strip() == 't':
        print('Inputs: nothing to move yet')
        return
    with tempfile.TemporaryFile() as errors:
        target = subprocess.Popen(psql_args('input'), stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errors)
        try:
            target.stdin.write(b'BEGIN;\nSET LOCAL session_replication_role=replica;\n')
            for table in MOVED_TABLES:
                wanted = columns_of(table, 'input')
                present = set(columns_of(table, 'analytics'))
                cols = ','.join(c for c in wanted if c in present)  # a column the store added later takes its default
                target.stdin.write(f'COPY {table}({cols}) FROM STDIN;\n'.encode())
                source = subprocess.Popen(psql_args('analytics') + ['-c', f'COPY (SELECT {cols} FROM {table}) TO STDOUT'],
                                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                shutil.copyfileobj(source.stdout, target.stdin)
                failed = source.stderr.read()
                if source.wait():
                    raise RuntimeError(sanitize(failed.decode(errors='replace')[-1500:]))
                target.stdin.write(b'\\.\n')
            last = sql('SELECT last_value FROM catalog.change_seq;').stdout.strip()
            target.stdin.write(f"SELECT setval('catalog.change_seq',{int(last)});\n".encode())
            identities = isql("""SELECT table_schema||'.'||table_name||' '||column_name FROM information_schema.columns
WHERE is_identity='YES' AND table_schema IN ('catalog','publication');""").stdout.split('\n')
            for line in filter(None, identities):
                table, column = line.split(' ')
                target.stdin.write(f"SELECT setval(pg_get_serial_sequence('{table}','{column}'),greatest(coalesce(max({column}),0),1)) FROM {table};\n".encode())
            # The lists that had no versions start theirs at the moved value (their history stays in the event tables).
            target.stdin.write(b"""INSERT INTO catalog.interest_keyword_version(term_norm,version,term,conditions,source_types,brands,note,status,origin,recorded_at,recorded_by,change_seq)
SELECT term_norm,1,term,conditions,source_types,brands,note,status,origin,updated_at,updated_by,nextval('catalog.change_seq') FROM catalog.interest_keyword;
INSERT INTO catalog.interest_source_version(source_key,version,url,channel,brands,note,status,recorded_at,recorded_by,change_seq)
SELECT source_key,1,url,channel,brands,note,status,updated_at,updated_by,nextval('catalog.change_seq') FROM catalog.interest_source;
INSERT INTO catalog.entity_role_version(entity_id,version,rep_name,role,brand,note,status,origin,recorded_at,recorded_by,change_seq)
SELECT entity_id,1,rep_name,role,brand,note,status,origin,updated_at,updated_by,nextval('catalog.change_seq') FROM catalog.entity_role;
COMMIT;
""")
            target.stdin.close()
        except BrokenPipeError:
            pass
        if target.wait():
            errors.seek(0)
            raise RuntimeError(sanitize(errors.read().decode(errors='replace')[-2500:]))
    for table in MOVED_TABLES:
        count = f'SELECT count(*) FROM {table};'
        if sql(count).stdout != isql(count).stdout:
            raise RuntimeError(f'{table}: the moved row count differs; compare both stores before going on')
    for query in MOVE_FINGERPRINTS:
        if sql(query + ';').stdout != isql(query + ';').stdout:
            raise RuntimeError(f'The moved rows differ: {query}')
    print(f'Inputs: moved {len(MOVED_TABLES)} tables to the input store')


# What the old data DB still holds, and where it goes: (table there, table here, store here).
RETIRED_TABLES = (('catalog.service_week', 'catalog.service_week', 'input'), ('analytics.ga4_registry', 'catalog.ga4_registry', 'input'),
                  ('analytics.ga4_registry_event', 'catalog.ga4_registry_event', 'input'), ('analytics.ga4_collect_status', 'catalog.ga4_collect_status', 'input'),
                  ('ops.build', 'ops.build', 'metrics'), ('ops.data_version', 'ops.data_version', 'metrics'),
                  ('ref.dim_region', 'ref.dim_region', 'metrics'), ('ref.dim_country', 'ref.dim_country', 'metrics'), ('ref.dim_engine', 'ref.dim_engine', 'metrics'),
                  ('ref.dim_brand', 'ref.dim_brand', 'metrics'), ('ref.dim_category', 'ref.dim_category', 'metrics'), ('ref.dim_source', 'ref.dim_source', 'metrics'),
                  ('ref.dim_owned_base', 'ref.dim_owned_base', 'metrics'), ('ref.dim_url', 'ref.dim_url', 'metrics'), ('ref.dim_project', 'ref.dim_project', 'metrics'),
                  ('ops.seo_active_build', 'ops.seo_active_build', 'metrics'), ('analytics.dim_crawl_bot', 'analytics.dim_crawl_bot', 'metrics'),
                  ('analytics.ga4_property', 'analytics.ga4_property', 'metrics'), ('analytics.ga4_value', 'analytics.ga4_value', 'metrics'),
                  ('analytics.ga4_row', 'analytics.ga4_row', 'metrics'), ('analytics.ga4_users_window', 'analytics.ga4_users_window', 'metrics'),
                  ('analytics.page_visibility_daily', 'analytics.page_visibility_daily', 'metrics'), ('analytics.page_crawl_daily', 'analytics.page_crawl_daily', 'metrics'),
                  ('analytics.page_seo_device_daily', 'analytics.page_seo_device_daily', 'metrics'), ('analytics.page_priority', 'analytics.page_priority', 'metrics'))


def retire_data_store():
    """Once (D-17): GA4 properties and the service week go to input_db, GA4 data, SEO, ref and ops to gold_db, with their keys, in one transaction per store and
    counted. A dump stays in .local/analytics-backups; then the old store stops. Its frozen inputs and its published views are not moved: nothing reads them."""
    if not old_data_store():
        return
    for store in ('input', 'metrics'):
        moved = [t for t in RETIRED_TABLES if t[2] == store and sql(f'SELECT EXISTS(SELECT 1 FROM {t[0]});').stdout.strip() == 't']
        already = [t for t in moved if sql(f'SELECT EXISTS(SELECT 1 FROM {t[1]});', store=store).stdout.strip() == 't']
        if already:
            raise RuntimeError(f'{already[0][1]} already has rows: compare both stores before going on')
        if not moved:
            continue
        with tempfile.TemporaryFile() as errors:
            target = subprocess.Popen(psql_args(store), stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errors)
            target.stdin.write(b'BEGIN;\nSET LOCAL session_replication_role=replica;\n')
            for old, new, _ in moved:
                cols = ','.join(c for c in columns_of(new, store) if c in set(columns_of(old, 'analytics')))
                target.stdin.write(f'COPY {new}({cols}) FROM STDIN;\n'.encode())
                source = subprocess.Popen(psql_args('analytics') + ['-c', f'COPY (SELECT {cols} FROM {old}) TO STDOUT'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                shutil.copyfileobj(source.stdout, target.stdin)
                failed = source.stderr.read()
                if source.wait():
                    raise RuntimeError(sanitize(failed.decode(errors='replace')[-1500:]))
                target.stdin.write(b'\\.\n')
            identities = sql("""SELECT table_schema||'.'||table_name||' '||column_name FROM information_schema.columns
WHERE (is_identity='YES' OR column_default LIKE 'nextval%') AND table_schema IN ('catalog','analytics','ref','ops');""", store=store).stdout.split('\n')
            names = {t[1] for t in moved}
            for line in filter(None, identities):
                table, column = line.split(' ')
                if table in names:
                    target.stdin.write(f"SELECT setval(pg_get_serial_sequence('{table}','{column}'),greatest(coalesce(max({column}),0),1)) FROM {table};\n".encode())
            target.stdin.write(b'COMMIT;\n')
            target.stdin.close()
            if target.wait():
                errors.seek(0)
                raise RuntimeError(sanitize(errors.read().decode(errors='replace')[-2500:]))
        for old, new, _ in moved:
            if sql(f'SELECT count(*) FROM {old};').stdout != sql(f'SELECT count(*) FROM {new};', store=store).stdout:
                raise RuntimeError(f'{new}: the moved row count differs; compare both stores before going on')
        print(f'Old data DB: moved {len(moved)} tables with rows to {STORES[store].database}')
    dump_store('analytics')
    if analytics.NATIVE:
        run([analytics.pg_tool('pg_ctl'), '-D', str(analytics.NATIVE_ROOT / 'analytics'), '-m', 'fast', '-w', 'stop'])
        shutil.rmtree(analytics.NATIVE_ROOT / 'analytics')
    else:
        run(['docker', 'compose', '--env-file', str(analytics.SECRET), '-f', str(ROOT / 'infra/analytics/compose.yml'), 'down'])
        RETIRED_DATA_STORE.parent.mkdir(parents=True, exist_ok=True)
        RETIRED_DATA_STORE.write_text('hmg_analytics retired; its volume is kept until someone removes it by hand\n', encoding='utf8')
    print('Old data DB: stopped and removed; its dump is in .local/analytics-backups')


def internal_token():
    """The hub server's key for its token to the data server: made once, kept after that."""
    create_secret(INTERNAL_SECRET, {'HGH_INTERNAL_TOKEN_SECRET': None})


def write_env_files():
    internal_token()
    """The connections the API and the external API get. The editors and the external API reach the input store."""
    env = analytics.env_file
    def url(role, password, store):
        return f"postgresql://{role}:{password}@{service_host(store)}/{STORES[store].database}"
    values = env(OPS_SECRET)
    edit, inputs, metrics = env(EDIT_SECRET), env(INPUT_SECRET), env(METRICS_SECRET)
    analytics.secure_write(ROOT / '.env.ext-api.local', '# External API: the caller-scoped ext views only.\n'
        f"HGH_EXT_DB_URL={url('hmg_ext_api', env(EXT_SECRET)['EXT_API_PASSWORD'], 'input')}\n")
    analytics.secure_write(ROOT / '.env.operations.local', '# FastAPI read-only operations connection.\n'
        f"HGH_OPERATIONS_DB_URL={url('hmg_operations_reader', values['OPERATIONS_READER_PASSWORD'], 'operations')}\n")
    analytics.secure_write(ROOT / '.env.input.local', '# FastAPI read-only input store connection.\n'
        f"HGH_INPUT_DB_URL={url('hmg_input_reader', inputs['INPUT_READER_PASSWORD'], 'input')}\n")
    analytics.secure_write(ROOT / '.env.metrics.local', '# FastAPI: read Gold, read and write the cache DB. The rollup role stays with the job.\n'
        f"HGH_METRICS_DB_URL={url('hmg_metrics_reader', metrics['METRICS_READER_PASSWORD'], 'metrics')}\n"
        f"HGH_CACHE_DB_URL={url('hmg_cache_writer', metrics['CACHE_WRITER_PASSWORD'], 'cache')}\n")
    analytics.secure_write(ROOT / '.env.hub-edit.local', '# FastAPI HUB writes, each role for one screen: Global prompts, Project prompts, measurement settings, '
        'source classification, customer interest, entity roles, the GA4 registry (input store), saved filters, accounts (operations store), '
        'and the login token secret.\n'
        f"HGH_CATALOG_EDITOR_DB_URL={url('hmg_catalog_editor', edit['CATALOG_EDITOR_PASSWORD'], 'input')}\n"
        f"HGH_SAVED_FILTER_EDITOR_DB_URL={url('hmg_saved_filter_editor', env(FILTER_SECRET)['SAVED_FILTER_EDITOR_PASSWORD'], 'operations')}\n"
        f"HGH_ACCOUNT_EDITOR_DB_URL={url('hmg_account_editor', env(ACCOUNT_SECRET)['ACCOUNT_EDITOR_PASSWORD'], 'operations')}\n"
        f"HGH_GA4_REGISTRY_EDITOR_DB_URL={url('hmg_ga4_registry_editor', env(GA4_REGISTRY_SECRET)['GA4_REGISTRY_EDITOR_PASSWORD'], 'input')}\n"
        f"HGH_SOURCE_OVERRIDE_EDITOR_DB_URL={url('hmg_source_override_editor', env(SOURCE_OVERRIDE_SECRET)['SOURCE_OVERRIDE_EDITOR_PASSWORD'], 'input')}\n"
        f"HGH_INTEREST_EDITOR_DB_URL={url('hmg_interest_editor', env(INTEREST_SECRET)['INTEREST_EDITOR_PASSWORD'], 'input')}\n"
        f"HGH_ENTITY_ROLE_EDITOR_DB_URL={url('hmg_entity_role_editor', env(ENTITY_ROLE_SECRET)['ENTITY_ROLE_EDITOR_PASSWORD'], 'input')}\n"
        f"HGH_PROJECT_EDITOR_DB_URL={url('hmg_project_editor', env(PROJECT_EDITOR_SECRET)['PROJECT_EDITOR_PASSWORD'], 'input')}\n"
        f"HGH_MEASUREMENT_EDITOR_DB_URL={url('hmg_measurement_editor', inputs['MEASUREMENT_EDITOR_PASSWORD'], 'input')}\n"
        f"HGH_AUTH_SECRET={edit['HGH_AUTH_SECRET']}\n")
    roles = ga4_roles()
    analytics.secure_write(ROOT / '.env.analytics.local', '# FastAPI read-only GA4 and SEO connection (gold_db).\n'
        f"HGH_ANALYTICS_DB_URL={url('hmg_analytics_reader', roles['ANALYTICS_READER_PASSWORD'], 'metrics')}\n")
    analytics.secure_write(ROOT / '.env.analytics-ingest.local', '# The GA4 collector: its rows in gold_db, the properties and its results in input_db.\n'
        f"HGH_ANALYTICS_WRITER_DB_URL={url('hmg_analytics_writer', roles['ANALYTICS_WRITER_PASSWORD'], 'metrics')}\n"
        f"HGH_GA4_REGISTRY_DB_URL={url('hmg_analytics_writer', roles['ANALYTICS_WRITER_PASSWORD'], 'input')}\n")


def status():
    for store, namespace, migrations in (('operations', 'system', 'system'), ('input', 'catalog', 'catalog'), ('metrics', 'gold', 'gold'), ('cache', 'cache', 'cache')):
        print(sql(f"""SELECT json_build_object('database',current_database(),
            'tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='{namespace}' AND table_type='BASE TABLE'),
            'migrations',(SELECT json_agg(version ORDER BY version) FROM {migrations}.schema_migration));""", store=store).stdout.strip())


def sync(args):
    """Import actual Gold catalog definitions only, using transient writer connections. Stopped since T10.1 (2026-11-07): the service owns its inputs,
    and the import read gold.dim_*, which become Silver's processed results. The code goes in T12.2."""
    raise SystemExit('The Gold import stopped (T10.1, 2026-11-07). Inputs are edited in the service; nothing is imported.')
    data = analytics.env_file(DATA_SECRET)
    config = {
        'data': f"postgresql://hmg_catalog_writer:{data['CATALOG_WRITER_PASSWORD']}@{service_host('input')}/input_db",
        'allow_removals': args.allow_removals, 'expect_mass_change': args.expect_mass_change,
    }
    # Secrets travel over stdin, never argv, image layers, logs or the frontend.
    script = (HERE / 'sync_catalog.py').read_text(encoding='utf8') + '\nasyncio.run(main(' + repr(config) + '))\n'
    print(api_python(script).strip())


def service_week(args):
    """sync-service-week: record the service week from Gold's status (service_week.py) with the transient writer.
    --dry-run decides and prints without writing; before init has made the writer it decides as if nothing were recorded."""
    config = {'dry_run': args.dry_run}
    if SERVICE_WEEK_SECRET.exists():
        config['data'] = (f"postgresql://hmg_service_week_writer:{analytics.env_file(SERVICE_WEEK_SECRET)['SERVICE_WEEK_WRITER_PASSWORD']}"
                          f"@{service_host('input')}/{STORES['input'].database}")
    elif not args.dry_run:
        raise RuntimeError(f'{SERVICE_WEEK_SECRET.name} is missing: run manage.py init first')
    # Secrets travel over stdin, never argv, image layers, logs or the frontend.
    script = (HERE / 'service_week.py').read_text(encoding='utf8') + '\nasyncio.run(main(' + repr(config) + '))\n'
    print(api_python(script).strip())


def rollup(args):
    """rollup: compute the unfiltered first screens' values into Gold for the surfaces whose live snapshot or definition version moved
    (data_server/metrics/rollup.py). --force runs them although nothing moved; params name surfaces (global · website · project), default all."""
    metrics = analytics.env_file(METRICS_SECRET)
    config = {'dsn': f"postgresql://hmg_rollup_writer:{metrics['ROLLUP_WRITER_PASSWORD']}@{service_host('metrics')}/{STORES['metrics'].database}",
              'surfaces': args.params or None, 'force': args.force}
    # Secrets travel over stdin, never argv, image layers, logs or the frontend.
    print(api_python('from data_server.metrics.rollup import run\nrun(' + repr(config) + ')\n', api_env=True).strip())


def load_query_tables(args):
    """load-query-tables: put the Silver OBT's operating snapshots not yet here into gold_db's query tables (data_server/metrics/query_load.py); params name surfaces, default all."""
    secret = analytics.env_file(QUERY_LOADER_SECRET)
    database = os.environ.get('HGH_QUERY_LOAD_DATABASE') or STORES['metrics'].database
    config = {'dsn': f"postgresql://hmg_query_loader:{secret['QUERY_LOADER_PASSWORD']}@{service_host('metrics')}/{database}", 'surfaces': args.params or None}
    # Secrets travel over stdin, never argv, image layers, logs or the frontend.
    print(api_python('from data_server.metrics.query_load import run\nrun(' + repr(config) + ')\n', api_env=True).strip())


def verify():
    sql((HERE / 'verify-operations.sql').read_text(encoding='utf8'), True)
    isql((HERE / 'verify-input.sql').read_text(encoding='utf8'))
    sql((HERE / 'verify-metrics.sql').read_text(encoding='utf8'), store='metrics')
    sql((ROOT / 'back/analytics/verify.sql').read_text(encoding='utf8'), store='metrics', role='hmg_analytics_writer')  # GA4 and SEO: the collector's role, keys, builds
    sql((HERE / 'verify-cache.sql').read_text(encoding='utf8'), store='cache')
    for store, role in (('input', 'hmg_ext_api'), ('input', 'hmg_input_reader'), ('metrics', 'hmg_analytics_reader'),
                        ('operations', 'hmg_operations_reader'), ('metrics', 'hmg_metrics_reader')):
        print(sql("SELECT json_build_object('database',current_database(),'role',current_user,'read_only',current_setting('transaction_read_only'));", store=store, role=role).stdout.strip())
    # Connection checks cannot assume the database has no intentionally approved exports.
    env = analytics.env_file
    values, ext = env(OPS_SECRET), env(EXT_SECRET)
    def url(role, password, store):
        return f"postgresql://{role}:{password}@{service_host(store)}/{STORES[store].database}"
    def both(name, role, password, store='input', other='operations'):
        return {name: url(role, password, store), f'{name}_operations': url(role, password, other)}
    inputs, metrics = env(INPUT_SECRET), env(METRICS_SECRET)
    config = {**both('ext', 'hmg_ext_api', ext['EXT_API_PASSWORD']),
              'operations_reader': url('hmg_operations_reader', values['OPERATIONS_READER_PASSWORD'], 'operations'),
              'saved_filter': url('hmg_saved_filter_editor', env(FILTER_SECRET)['SAVED_FILTER_EDITOR_PASSWORD'], 'operations'),
              'account': url('hmg_account_editor', env(ACCOUNT_SECRET)['ACCOUNT_EDITOR_PASSWORD'], 'operations'),
              **both('ga4_registry', 'hmg_ga4_registry_editor', env(GA4_REGISTRY_SECRET)['GA4_REGISTRY_EDITOR_PASSWORD']),
              **both('source_override', 'hmg_source_override_editor', env(SOURCE_OVERRIDE_SECRET)['SOURCE_OVERRIDE_EDITOR_PASSWORD']),
              **both('interest', 'hmg_interest_editor', env(INTEREST_SECRET)['INTEREST_EDITOR_PASSWORD']),
              **both('entity_role', 'hmg_entity_role_editor', env(ENTITY_ROLE_SECRET)['ENTITY_ROLE_EDITOR_PASSWORD']),
              **both('project_editor', 'hmg_project_editor', env(PROJECT_EDITOR_SECRET)['PROJECT_EDITOR_PASSWORD']),
              **both('service_week', 'hmg_service_week_writer', env(SERVICE_WEEK_SECRET)['SERVICE_WEEK_WRITER_PASSWORD']),
              **both('measurement', 'hmg_measurement_editor', inputs['MEASUREMENT_EDITOR_PASSWORD']),
              'input_reader': url('hmg_input_reader', inputs['INPUT_READER_PASSWORD'], 'input'),
              'metrics_reader': url('hmg_metrics_reader', metrics['METRICS_READER_PASSWORD'], 'metrics'),
              'metrics_reader_cache': url('hmg_metrics_reader', metrics['METRICS_READER_PASSWORD'], 'cache'),
              'rollup_cache': url('hmg_rollup_writer', metrics['ROLLUP_WRITER_PASSWORD'], 'cache'),
              'cache_writer': url('hmg_cache_writer', metrics['CACHE_WRITER_PASSWORD'], 'cache'),
              'cache_writer_gold': url('hmg_cache_writer', metrics['CACHE_WRITER_PASSWORD'], 'metrics'),
              'cache_writer_input': url('hmg_cache_writer', metrics['CACHE_WRITER_PASSWORD'], 'input')}
    script = (HERE / 'verify_connections.py').read_text(encoding='utf8') + '\nasyncio.run(main(' + repr(config) + '))\n'
    print(api_python(script).strip())
    print('Verified opt-in exports, grants, immutable versions, operations isolation; all fixture transactions rolled back')


def set_admin():
    """Register the top-level administrator, or reset its password (its open sessions end). An account of another
    role becomes an administrator; the password is the one typed here, so no change is asked at sign-in."""
    sys.path.insert(0, str(ROOT / 'back'))
    from hub_server.passwords import hash_password
    login = input('Login ID: ').strip()
    if not re.fullmatch(r'[A-Za-z0-9._@-]{3,200}', login):
        raise ValueError('Login ID: 3-200 characters of letters, digits and . _ @ -')
    password = getpass.getpass('Password (12+ characters): ')
    if len(password) < 12:
        raise ValueError('The password must have at least 12 characters')
    if getpass.getpass('Repeat the password: ') != password:
        raise ValueError('The passwords differ')
    email = input('Email (optional): ').strip()
    who = f"(SELECT user_id FROM system.user_account WHERE subject={analytics.literal(login)})"
    # The hash travels over psql stdin, never argv. Re-running activates the account and replaces the password.
    sql(f"""BEGIN;
INSERT INTO system.user_account(user_id,subject,email) VALUES(gen_random_uuid(),{analytics.literal(login)},{analytics.literal(email) if email else 'NULL'})
 ON CONFLICT(subject) DO UPDATE SET status='active'{",email=EXCLUDED.email" if email else ""};
INSERT INTO system.user_credential(user_id,password_hash) VALUES({who},{analytics.literal(hash_password(password))})
 ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,changed_at=now(),must_change=false;
INSERT INTO system.global_role(user_id,role) VALUES({who},'admin')
 ON CONFLICT(user_id) DO UPDATE SET role='admin',brands='{{}}',regions='{{}}',countries='{{}}',updated_at=now();
INSERT INTO system.audit_event(actor_id,action,details) VALUES(NULL,'hub_login.set_admin',json_build_object('login',{analytics.literal(login)})::jsonb);
COMMIT;""", True)
    print(f'{login}: top-level administrator registered; earlier sessions of this account have ended')


def revoke_admin():
    login = input('Login ID to revoke: ').strip()
    who = f"(SELECT user_id FROM system.user_account WHERE subject={analytics.literal(login)})"
    out = sql(f"""BEGIN;
WITH gone AS (DELETE FROM system.global_role WHERE user_id={who} RETURNING 1) SELECT count(*) FROM gone;
INSERT INTO system.audit_event(actor_id,action,details) VALUES(NULL,'hub_login.revoke_admin',json_build_object('login',{analytics.literal(login)})::jsonb);
COMMIT;""", True).stdout.strip()
    print(f'{login}: ' + ('top-level role revoked; its sessions have ended' if out == '1' else 'no top-level role to revoke'))


# ═══ source category corrections: the first values (2026-10-30) ═══════════════════════════════════════════

# Read inside the API image (the Gold credentials stay there): the corrections Gold applies (dim_source.category_src 1).
GOLD_OVERRIDES_SCRIPT = '''import asyncio, json, os
import asyncpg
async def main():
    conn = await asyncpg.connect(os.environ['HGH_GOLD_DB_URL'], server_settings={'default_transaction_read_only': 'on', 'statement_timeout': '30000'})
    try:
        rows = await conn.fetch("SELECT s.skey,c.slug FROM gold.dim_source s JOIN gold.dim_category c USING(category_key) WHERE s.category_src=1 ORDER BY s.skey")
    finally:
        await conn.close()
    print(json.dumps([[r['skey'], r['slug']] for r in rows]))
asyncio.run(main())
'''


def source_key(value):
    """The key the HUB and the pipeline compare: lower case, trimmed, no leading www. (catalog.source_override)."""
    return re.sub(r'^www\.', '', value.strip().lower())


def import_source_overrides(args):
    """import-source-overrides: the HUB's first source corrections are the ones Gold applies now. Runs once: refused
    when the HUB already has a correction. Records them (origin gold_import), their history and the first
    `source_override` list for the external API, in one transaction under the catalog lock."""
    rows = json.loads(api_python(GOLD_OVERRIDES_SCRIPT).strip().splitlines()[-1])
    found = {}
    for skey, slug in rows:
        key = source_key(skey)
        if found.get(key, slug) != slug:
            raise RuntimeError(f'Gold has two categories for {key}; nothing imported')
        found[key] = slug
    if not found:
        print('Gold applies no source correction; nothing imported')
        return
    values = ','.join(f"({analytics.literal(k)},{analytics.literal(v)},'gold_import')" for k, v in sorted(found.items()))
    isql(f"""BEGIN;
SELECT pg_advisory_xact_lock({CATALOG_LOCK});
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM catalog.source_override) THEN RAISE EXCEPTION 'The HUB already has source corrections; the first import runs once'; END IF;
END $$;
INSERT INTO catalog.source_override(skey,category,origin) VALUES{values};
SELECT count(*) FROM catalog.publish_source_overrides();
INSERT INTO catalog.source_override_event(skey,action,changes,published_seq)
SELECT skey,'import',jsonb_build_object('category',jsonb_build_array(NULL,category)),
       (SELECT change_seq FROM catalog.current_reference_set WHERE family='source_override')
FROM catalog.source_override;
COMMIT;""")
    print(json.dumps({'imported': len(found), 'corrections': dict(sorted(found.items()))}, ensure_ascii=False))


# ═══ external API: approvals, callers, keys (data DB; the API itself only reads them) ═══════════════════

def actor():
    return f'{getpass.getuser()}@manage.py'


def uuid_of(value, what):
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError):
        raise ValueError(f'{what} must be a UUID') from None


def params(args, minimum, usage):
    if len(args.params) < minimum:
        raise ValueError(f'Usage: manage.py {args.command} {usage}')
    return args.params


def set_project_access(args, enabled):
    """publish-project / unpublish-project <project_id> [projects] [prompts] (default: both)."""
    project, *flags = params(args, 1, '<project_id> [projects] [prompts]')
    project, flags = uuid_of(project, 'project_id'), flags or list(PROJECT_FLAGS)
    if any(f not in PROJECT_FLAGS for f in flags):
        raise ValueError(f'Flags: {", ".join(PROJECT_FLAGS)}')
    if isql(f"SELECT count(*) FROM catalog.project WHERE project_id={analytics.literal(project)};").stdout.strip() != '1':
        raise ValueError('No such project in the HUB catalog')
    value = 'true' if enabled else 'false'
    isql(f"""INSERT INTO publication.project_access(project_id,{','.join(flags)},approved_by)
VALUES({analytics.literal(project)},{','.join(value for _ in flags)},{analytics.literal(actor())})
ON CONFLICT(project_id) DO UPDATE SET {','.join(f'{f}={value}' for f in flags)},approved_by=EXCLUDED.approved_by,approved_at=now();""")
    print(f'{project}: {", ".join(flags)} {"published" if enabled else "withdrawn"}')


def set_reference_access(args, enabled):
    """publish-reference / unpublish-reference <family ...|all>."""
    families = params(args, 1, '<family ...|all>')
    families = list(REFERENCE_FAMILIES) if families == ['all'] else families
    if any(f not in REFERENCE_FAMILIES for f in families):
        raise ValueError(f'Families: {", ".join(REFERENCE_FAMILIES)} or all')
    rows = ','.join(f"({analytics.literal(f)},{'true' if enabled else 'false'},{analytics.literal(actor())})" for f in families)
    isql(f"""INSERT INTO publication.reference_access(family,enabled,approved_by) VALUES{rows}
ON CONFLICT(family) DO UPDATE SET enabled=EXCLUDED.enabled,approved_by=EXCLUDED.approved_by,approved_at=now();""")
    print(f'{", ".join(families)}: {"published" if enabled else "withdrawn"}')


def client_add(args):
    """ext-client-add <name> --audience collect|analyze: 수집 reads prompts, settings and the collecting values, 분석 the analysis values."""
    name = ' '.join(params(args, 1, '<name> --audience collect|analyze')).strip()
    if args.audience not in AUDIENCES:
        raise ValueError(f'--audience must be one of: {", ".join(AUDIENCES)}')
    out = isql(f"""INSERT INTO publication.api_client(client_id,name,created_by,audience)
VALUES(gen_random_uuid(),{analytics.literal(name)},{analytics.literal(actor())},{analytics.literal(args.audience)}) RETURNING client_id;""").stdout.strip()
    print(f'{name}: {args.audience} client {out.splitlines()[0]}')


def client_status(args, status):
    client = uuid_of(params(args, 1, '<client_id>')[0], 'client_id')
    out = isql(f"UPDATE publication.api_client SET status={analytics.literal(status)} WHERE client_id={analytics.literal(client)} RETURNING 1;").stdout.strip()
    print(f'{client}: ' + (status if out else 'no such client'))


def key_issue(args):
    """A new key, printed once. At most KEYS_PER_CLIENT unexpired, unrevoked keys per client (rotation overlap)."""
    client = uuid_of(params(args, 1, '<client_id> [--days N]')[0], 'client_id')
    days = args.days or KEY_DAYS
    if not 1 <= days <= KEY_DAYS_MAX:
        raise ValueError(f'--days must be 1..{KEY_DAYS_MAX}')
    key_id = uuid.uuid4()
    key = f'hgh_{key_id.hex}_{secrets.token_urlsafe(32)}'
    digest = hashlib.sha256(key.encode()).hexdigest()
    out = isql(f"""BEGIN;
SELECT pg_advisory_xact_lock({KEY_LOCK});
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM publication.api_client WHERE client_id={analytics.literal(client)} AND status='active') THEN
   RAISE EXCEPTION 'No active client %', {analytics.literal(client)}; END IF;
 IF (SELECT count(*) FROM publication.api_key WHERE client_id={analytics.literal(client)} AND revoked_at IS NULL AND expires_at>now())>={KEYS_PER_CLIENT} THEN
   RAISE EXCEPTION 'The client already has {KEYS_PER_CLIENT} valid keys; revoke one first'; END IF;
END $$;
INSERT INTO publication.api_key(key_id,client_id,key_hash,created_by,expires_at)
VALUES({analytics.literal(str(key_id))},{analytics.literal(client)},{analytics.literal(digest)},{analytics.literal(actor())},now()+interval '{days} days')
RETURNING expires_at;
COMMIT;""", check=False)
    if out.returncode:
        errors = [line for line in out.stderr.splitlines() if line.startswith('ERROR:')]
        raise RuntimeError(sanitize(errors[0].removeprefix('ERROR:').strip() if errors else 'Key issue failed'))
    expires = [line for line in out.stdout.splitlines() if line.strip()][-1]
    # The secret is shown here once and stored nowhere; only its sha256 is in the database.
    print(f'key_id {key_id} expires {expires}\n{key}')


def key_revoke(args):
    key, *reason = params(args, 2, '<key_id> <reason>')
    key = uuid_of(key, 'key_id')
    out = isql(f"""UPDATE publication.api_key SET revoked_at=now(),revoked_by={analytics.literal(actor())},
revoke_reason={analytics.literal(' '.join(reason))} WHERE key_id={analytics.literal(key)} AND revoked_at IS NULL RETURNING 1;""").stdout.strip()
    print(f'{key}: ' + ('revoked' if out else 'no such unrevoked key'))


def grant(args, granted):
    """grant-project / withdraw-project <client_id> <project_id ...>. A withdrawal keeps the row (revoked_at)."""
    client, *projects = params(args, 2, '<client_id> <project_id ...>')
    client, projects = uuid_of(client, 'client_id'), [uuid_of(p, 'project_id') for p in projects]
    who = analytics.literal(actor())
    if granted:
        rows = ','.join(f'({analytics.literal(client)},{analytics.literal(p)},{who})' for p in projects)
        isql(f"""INSERT INTO publication.api_client_project(client_id,project_id,granted_by) VALUES{rows}
ON CONFLICT(client_id,project_id) DO UPDATE SET granted_by=EXCLUDED.granted_by,granted_at=now(),revoked_at=NULL,revoked_by=NULL;""")
    else:
        isql(f"""UPDATE publication.api_client_project SET revoked_at=now(),revoked_by={who}
WHERE client_id={analytics.literal(client)} AND project_id IN ({','.join(analytics.literal(p) for p in projects)}) AND revoked_at IS NULL;""")
    print(f'{client}: {len(projects)} project(s) {"granted" if granted else "withdrawn"}')


def ext_list(args):
    print(isql("""SELECT json_build_object(
 'clients',(SELECT coalesce(json_agg(json_build_object('client_id',client_id,'name',name,'status',status,'audience',audience) ORDER BY name),'[]') FROM publication.api_client),
 'keys',(SELECT coalesce(json_agg(json_build_object('key_id',key_id,'client_id',client_id,'expires_at',expires_at,'revoked_at',revoked_at) ORDER BY created_at),'[]') FROM publication.api_key),
 'grants',(SELECT coalesce(json_agg(json_build_object('client_id',client_id,'project_id',project_id,'revoked_at',revoked_at)),'[]') FROM publication.api_client_project),
 'projects',(SELECT coalesce(json_agg(json_build_object('project_id',project_id,'projects',projects,'prompts',prompts)),'[]') FROM publication.project_access),
 'reference',(SELECT coalesce(json_agg(json_build_object('family',family,'enabled',enabled) ORDER BY family),'[]') FROM publication.reference_access));""").stdout.strip())


def start():
    """Native mode: start the local servers after a reboot (no migrations; `init` does those). The input and metrics stores start when
    `init` has made them; without them the API serves Gold and leaves the input screens at 503."""
    if not analytics.NATIVE:
        raise RuntimeError('start is for native mode (HGH_HUB_NATIVE=1); with Docker the containers restart themselves')
    running = []
    for store, s in STORES.items():
        if s.server:
            continue
        if not (s.secret.exists() and analytics.native_exists(store)):
            if store == 'analytics':
                continue
            if store == 'operations':
                raise RuntimeError(f'No native {store} store yet; run init first')
            print(f'No native {store} store yet; run init to create it')
            continue
        values = analytics.env_file(s.secret)
        analytics.native_start(store, int(values[s.port_key]), s.admin, startup_database(store), values['POSTGRES_PASSWORD'])
        running.append(str(values[s.port_key]))
    print('HUB stores running on 127.0.0.1:' + ', :'.join(running))


def backup():
    output = ROOT / '.local/operations-backups' / f"operations_db-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.dump"
    output.parent.mkdir(parents=True, exist_ok=True)
    # Use secure_write to establish file ACLs before writing the binary archive.
    analytics.secure_write(output, '')
    if analytics.NATIVE:
        dump = [analytics.pg_tool('pg_dump'), '-h', str(analytics.NATIVE_ROOT / 'operations-socket'), '-p', str(ops_port())]
    else:
        dump = ['docker', 'exec', OPS_CONTAINER, 'pg_dump']
    with output.open('wb') as handle:
        result = subprocess.run(dump + ['-U', 'hmg_operations_admin', '-d', OPS_DB, '--format=custom', '--no-owner', '--no-acl'],
                                stdout=handle, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError('Operations backup failed')
    print(f'Backup created: {output}')
    # The input store is a source of truth. The metrics store is not: Gold is computed again, and SSOT keeps the cache out of backups.
    dump_store('input')


def dump_store(store):
    s = STORES[store]
    output = ROOT / f'.local/{store}-backups' / f"{s.database}-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.dump"
    output.parent.mkdir(parents=True, exist_ok=True)
    analytics.secure_write(output, '')
    if analytics.NATIVE:
        dump = [analytics.pg_tool('pg_dump'), '-h', str(analytics.NATIVE_ROOT / f'{store}-socket'), '-p', str(port_of(store))]
    else:
        dump = ['docker', 'exec', s.container, 'pg_dump']
    with output.open('wb') as handle:
        result = subprocess.run(dump + ['-U', s.admin, '-d', s.database, '--format=custom', '--no-owner', '--no-acl'], stdout=handle, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(f'{store} backup failed')
    print(f'Backup created: {output}')


# Source classification lists (2026-10-30, admin-todo decisions 코드표 and G): the first values come from where the HUB
# kept them before the DB, the original app's categorizer files and the category labels of front/messages. Gold gives
# the category numbers (dim_category.category_key, tied to answer_fact.cit_c<k>), English names and order.
CATEGORIZER = ROOT / 'front' / 'lib' / 'citation-categorizer'
LAYER_CODES = ('override', 'social', 'owned', 'seed', 'rule', 'fallback')  # dim_source.category_src 1..6, in priority order
GOLD_CATEGORIES_SCRIPT = '''import asyncio, json, os
import asyncpg
async def main():
    conn = await asyncpg.connect(os.environ['HGH_GOLD_DB_URL'], server_settings={'default_transaction_read_only': 'on', 'statement_timeout': '30000'})
    try:
        rows = await conn.fetch("SELECT category_key,slug,name,ord FROM gold.dim_category WHERE coalesce(slug,'')<>'' ORDER BY category_key")
    finally:
        await conn.close()
    print(json.dumps([[r['category_key'], r['slug'], r['name'], r['ord']] for r in rows]))
asyncio.run(main())
'''
SOCIAL_ENTRY = re.compile(r'\{\s*(?://[^\n]*\n\s*)*key:\s*"([^"]+)",\s*domain:\s*"([^"]+)",\s*matchers:\s*\[(.*?)\]\s*,?\s*\}', re.S)
SOCIAL_MATCHER = re.compile(r'\{\s*prefix:\s*"([^"]+)",\s*boundary:\s*(true|false)\s*\}')


def official_social_accounts():
    """The accounts of official-social.ts, in file order: [{key, domain, matchers: [{prefix, boundary}]}]."""
    text = (CATEGORIZER / 'official-social.ts').read_text(encoding='utf8')
    accounts = []
    for key, domain, body in SOCIAL_ENTRY.findall(text):
        matchers = [{'prefix': p, 'boundary': b == 'true'} for p, b in SOCIAL_MATCHER.findall(body)]
        if not matchers or not key.lower().startswith(domain + '/') or any(not m['prefix'].startswith(domain + '/') for m in matchers):
            raise RuntimeError(f'official-social.ts: cannot read the account {key}; nothing imported')
        accounts.append({'key': key, 'domain': domain, 'matchers': matchers})
    if not accounts:
        raise RuntimeError('official-social.ts: no account found; nothing imported')
    return accounts


def import_source_lists(args):
    """import-source-lists: the HUB's first code table, seeds and official social accounts (Admin › 인용 출처 분류).
    Each list is imported once; a list the HUB already has stays as it is. Records the rows (origin file_import),
    their history and the first source_code / source_seed / source_social sets, in one transaction under the catalog
    lock."""
    counts = {name: int(isql(f"SELECT count(*) FROM catalog.{table};").stdout.strip() or 0)
              for name, table in (('code', 'source_code'), ('seed', 'source_seed'), ('social', 'source_social'))}
    gold = json.loads(api_python(GOLD_CATEGORIES_SCRIPT).strip().splitlines()[-1])
    labels = {lang: json.loads((ROOT / 'front' / 'messages' / f'{lang}.json').read_text(encoding='utf8')) for lang in ('ko', 'en')}
    name_to_slug = {name: slug for _, slug, name, _ in gold}
    statements, done = [], {}
    if not counts['code']:
        rows = [('category', slug, key, name, labels['ko']['citationCategories'][slug], ord) for key, slug, name, ord in gold]
        rows += [('layer', code, i, labels['en']['hubSourceOverrides']['source'][code], labels['ko']['hubSourceOverrides']['source'][code], i)
                 for i, code in enumerate(LAYER_CODES, 1)]
        values = ','.join(f"({analytics.literal(k)},{analytics.literal(c)},{n},{analytics.literal(en)},{analytics.literal(ko)},{o})"
                          for k, c, n, en, ko, o in rows)
        statements.append(f"""INSERT INTO catalog.source_code(kind,code,number,name_en,name_ko,ord) VALUES{values};
SELECT count(*) FROM catalog.publish_source_codes();
INSERT INTO catalog.source_code_event(kind,code,action,changes,published_seq)
SELECT kind,code,'import',jsonb_build_object('name_en',jsonb_build_array(NULL,name_en),'name_ko',jsonb_build_array(NULL,name_ko),
       'ord',jsonb_build_array(NULL,ord)),(SELECT change_seq FROM catalog.current_reference_set WHERE family='source_code')
FROM catalog.source_code;""")
        done['code'] = len(rows)
    if not counts['seed']:
        seeds = {}
        for domain, name in json.loads((CATEGORIZER / 'seed.json').read_text(encoding='utf8')).items():
            key, slug = source_key(domain), name_to_slug.get(name)
            if slug is None or '/' in key or seeds.get(key, slug) != slug:
                raise RuntimeError(f'seed.json: {domain} → {name} has no single Gold category; nothing imported')
            seeds[key] = slug
        values = ','.join(f"({analytics.literal(k)},{analytics.literal(v)},'file_import')" for k, v in sorted(seeds.items()))
        statements.append(f"""INSERT INTO catalog.source_seed(skey,category,origin) VALUES{values};
SELECT count(*) FROM catalog.publish_source_seeds();
INSERT INTO catalog.source_seed_event(skey,action,changes,published_seq)
SELECT skey,'import',jsonb_build_object('category',jsonb_build_array(NULL,category)),
       (SELECT change_seq FROM catalog.current_reference_set WHERE family='source_seed')
FROM catalog.source_seed;""")
        done['seed'] = len(seeds)
    if not counts['social']:
        accounts = official_social_accounts()
        values = ','.join(f"({analytics.literal(a['key'].lower())},{analytics.literal(a['key'])},{analytics.literal(a['domain'])},"
                          f"{analytics.literal(json.dumps(a['matchers']))}::jsonb,'file_import')" for a in accounts)
        statements.append(f"""INSERT INTO catalog.source_social(account_key,display_key,domain,matchers,origin) VALUES{values};
SELECT count(*) FROM catalog.publish_source_socials();
INSERT INTO catalog.source_social_event(account_key,action,changes,published_seq)
SELECT account_key,'import',jsonb_build_object('matchers',jsonb_build_array(NULL,matchers)),
       (SELECT change_seq FROM catalog.current_reference_set WHERE family='source_social')
FROM catalog.source_social;""")
        done['social'] = len(accounts)
    if statements:
        isql(f"BEGIN;\nSELECT pg_advisory_xact_lock({CATALOG_LOCK});\n" + '\n'.join(statements) + '\nCOMMIT;')
    print(json.dumps({'imported': done, 'already_present': {k: v for k, v in counts.items() if v}}, ensure_ascii=False))


GOLD_KEYWORDS_SCRIPT = '''import asyncio, json, os
import asyncpg
async def main():
    conn = await asyncpg.connect(os.environ['HGH_GOLD_DB_URL'], server_settings={'default_transaction_read_only': 'on', 'statement_timeout': '30000'})
    try:
        rows = await conn.fetch("""SELECT DISTINCT k.term,k.term_norm,s.location_code,s.language_code FROM gold.kw_suggestion s
            JOIN gold.dim_keyword k ON k.kw_key=s.kw_key WHERE s.is_seed ORDER BY k.term_norm,k.term,s.location_code,s.language_code""")
    finally:
        await conn.close()
    print(json.dumps([[r['term'], r['term_norm'], r['location_code'], r['language_code']] for r in rows]))
asyncio.run(main())
'''


def import_interest_keywords(args):
    """import-interest-keywords: the HUB's first seed keywords are Gold's seed rows (the reference family `keyword`). Runs
    once: refused when the HUB already has a keyword. Records them (origin gold_import, Google keyword, common to every
    brand), their history and the first `interest_keyword` list for the external API, in one transaction under the
    catalog lock."""
    rows = json.loads(api_python(GOLD_KEYWORDS_SCRIPT).strip().splitlines()[-1])
    found = {}
    for term, term_norm, location, language in rows:
        item = found.setdefault(term_norm, {'term': term, 'conditions': []})
        item['conditions'].append({'location_code': location, 'language_code': language})
    if not found:
        print('Gold has no seed keyword; nothing imported')
        return
    values = ','.join(f"({analytics.literal(k)},{analytics.literal(v['term'])},{analytics.literal(json.dumps(v['conditions'], ensure_ascii=False))}::jsonb,"
                      "ARRAY['google_keyword'],'gold_import')" for k, v in sorted(found.items()))
    isql(f"""BEGIN;
SELECT pg_advisory_xact_lock({CATALOG_LOCK});
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM catalog.interest_keyword) THEN RAISE EXCEPTION 'The HUB already has seed keywords; the first import runs once'; END IF;
END $$;
INSERT INTO catalog.interest_keyword(term_norm,term,conditions,source_types,origin) VALUES{values};
SELECT count(*) FROM catalog.publish_interest_keywords();
INSERT INTO catalog.interest_keyword_event(term_norm,action,changes,published_seq)
SELECT term_norm,'import',jsonb_build_object('conditions',jsonb_build_array(NULL,conditions)),
       (SELECT change_seq FROM catalog.current_reference_set WHERE family='interest_keyword')
FROM catalog.interest_keyword;
COMMIT;""")
    print(json.dumps({'imported': len(found)}))


GOLD_ROLES_SCRIPT = '''import asyncio, json, os
import asyncpg
async def main():
    conn = await asyncpg.connect(os.environ['HGH_GOLD_DB_URL'], server_settings={'default_transaction_read_only': 'on', 'statement_timeout': '30000'})
    try:
        rows = await conn.fetch("""SELECT e.entity_id::text AS entity_id,coalesce(e.rep_name,b.name) AS rep_name,e.registry_role,
            CASE WHEN b.kind=1 THEN b.name END AS brand FROM gold.dim_entity e LEFT JOIN gold.dim_brand b USING(brand_key)
            WHERE e.registry_role IS NOT NULL ORDER BY e.entity_id""")
    finally:
        await conn.close()
    print(json.dumps([[r['entity_id'], r['rep_name'], r['registry_role'], r['brand']] for r in rows], ensure_ascii=False))
asyncio.run(main())
'''


def import_entity_roles(args):
    """import-entity-roles: the HUB's first entity roles are Gold's registry_role rows (the reference family `entity`).
    Runs once: refused when the HUB already has a role. Records them (origin gold_import), their history and the first
    `entity_role` list for the external API, in one transaction under the catalog lock."""
    rows = json.loads(api_python(GOLD_ROLES_SCRIPT).strip().splitlines()[-1])
    if not rows:
        print('Gold has no entity role; nothing imported')
        return
    for entity_id, name, role, brand in rows:
        if role not in ('own', 'excluded') or not name or (role == 'own' and brand is None):
            raise RuntimeError(f'Gold entity {entity_id}: role {role} with brand {brand}; nothing imported')
    values = ','.join(f"({analytics.literal(e)}::uuid,{analytics.literal(n)},{analytics.literal(r)},"
                      f"{analytics.literal(b) if r == 'own' else 'NULL'},'gold_import')" for e, n, r, b in rows)
    isql(f"""BEGIN;
SELECT pg_advisory_xact_lock({CATALOG_LOCK});
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM catalog.entity_role) THEN RAISE EXCEPTION 'The HUB already has entity roles; the first import runs once'; END IF;
END $$;
INSERT INTO catalog.entity_role(entity_id,rep_name,role,brand,origin) VALUES{values};
SELECT count(*) FROM catalog.publish_entity_roles();
INSERT INTO catalog.entity_role_event(entity_id,action,changes,published_seq)
SELECT entity_id,'import',jsonb_build_object('role',jsonb_build_array(NULL,role),'brand',jsonb_build_array(NULL,brand)),
       (SELECT change_seq FROM catalog.current_reference_set WHERE family='entity_role')
FROM catalog.entity_role;
COMMIT;""")
    print(json.dumps({'imported': len(rows), 'own': sum(r[2] == 'own' for r in rows), 'excluded': sum(r[2] == 'excluded' for r in rows)}))


COMMANDS = {
    'init': lambda a: initialize(), 'start': lambda a: start(), 'sync-gold-catalog': sync, 'status': lambda a: status(),
    'verify': lambda a: verify(), 'backup': lambda a: backup(), 'set-admin': lambda a: set_admin(), 'revoke-admin': lambda a: revoke_admin(),
    'publish-project': lambda a: set_project_access(a, True), 'unpublish-project': lambda a: set_project_access(a, False),
    'publish-reference': lambda a: set_reference_access(a, True), 'unpublish-reference': lambda a: set_reference_access(a, False),
    'ext-client-add': client_add, 'ext-client-disable': lambda a: client_status(a, 'disabled'),
    'ext-client-enable': lambda a: client_status(a, 'active'), 'ext-key-issue': key_issue, 'ext-key-revoke': key_revoke,
    'grant-project': lambda a: grant(a, True), 'withdraw-project': lambda a: grant(a, False), 'ext-list': ext_list,
    'import-source-overrides': import_source_overrides,
    'import-source-lists': import_source_lists,
    'import-interest-keywords': import_interest_keywords,
    'import-entity-roles': import_entity_roles,
    'sync-service-week': service_week,
    'internal-token': lambda a: internal_token(),
    'load-query-tables': load_query_tables,
    'rollup': rollup,
}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=list(COMMANDS))
    parser.add_argument('params', nargs='*', help='ids, flags or families for the external API commands')
    parser.add_argument('--allow-removals', type=int, default=0, help='sync: accept up to N Gold removals above the guard')
    parser.add_argument('--expect-mass-change', action='store_true', help='sync: accept more than the guard share of new revisions')
    parser.add_argument('--days', type=int, help='ext-key-issue: lifetime in days')
    parser.add_argument('--audience', default='collect', help='ext-client-add: collect (수집) or analyze (분석)')
    parser.add_argument('--dry-run', action='store_true', help='sync-service-week: decide and print, write nothing')
    parser.add_argument('--force', action='store_true', help='rollup: compute although the snapshot and the definition version did not move')
    args = parser.parse_args()
    try:
        COMMANDS[args.command](args)
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(sanitize(str(error)), file=sys.stderr)
        sys.exit(1)
