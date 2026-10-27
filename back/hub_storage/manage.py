"""Manage separate HUB operations/data stores without recreating the analytics volume."""
from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / 'back' / 'analytics'))
import manage as analytics

OPS_SECRET = ROOT / '.env.operations-db.local'
DATA_SECRET = ROOT / '.env.data-access.local'
OPS_CONTAINER = 'hgh-operations-db'
OPS_DB = 'hmg_operations'


def sanitize(message):
    for path in (OPS_SECRET, DATA_SECRET, analytics.SECRET):
        if path.exists():
            for key, value in analytics.env_file(path).items():
                if 'PASSWORD' in key and value:
                    message = message.replace(value, '[redacted]')
    return message


def run(args, text=None, check=True):
    result = analytics.run(args, text=text, check=False)
    if check and result.returncode:
        raise RuntimeError(sanitize(result.stderr[-2500:] or result.stdout[-2500:]))
    return result


def sql(query, operations=False, role=None, check=True):
    container, database, admin = (OPS_CONTAINER, OPS_DB, 'hmg_operations_admin') if operations else (
        analytics.CONTAINER, analytics.DB, analytics.ADMIN)
    return run(['docker', 'exec', '-i', container, 'psql', '-X', '-q', '-A', '-t', '-v',
                'ON_ERROR_STOP=1', '-U', role or admin, '-d', database], text=query, check=check)


def create_secret(path, fields, volume=None):
    if not path.exists():
        if volume and run(['docker', 'volume', 'inspect', volume], check=False).returncode == 0:
            raise RuntimeError(f'{volume} exists; restore {path.name}. No existing credentials/data were changed.')
        analytics.secure_write(path, '# Server-only. Never commit.\n' + '\n'.join(
            f'{key}={value if value is not None else secrets.token_hex(32)}' for key, value in fields.items()) + '\n')
    values = analytics.env_file(path)
    if any(not values.get(key) for key in fields):
        raise RuntimeError(f'{path.name} is incomplete; refusing to replace credentials')
    return values


def migrate(filename, version, operations=False):
    namespace = 'system' if operations else 'ops'
    query = (HERE / filename).read_text(encoding='utf8')
    checksum = hashlib.sha256(query.encode()).hexdigest()
    exists = sql(f"SELECT to_regclass('{namespace}.schema_migration') IS NOT NULL;", operations).stdout.strip() == 't'
    installed = sql(f"SELECT sha256 FROM {namespace}.schema_migration WHERE version={analytics.literal(version)};", operations).stdout.strip() if exists else ''
    if installed:
        if installed != checksum:
            raise RuntimeError(f'Installed {version} checksum differs; add a new migration instead')
        print(f'{version}: already installed; rows preserved')
        return
    owner = 'hmg_operations_owner' if operations else analytics.OWNER
    sql(f'BEGIN; SELECT pg_advisory_xact_lock(617427412); SET LOCAL ROLE {owner};\n' + query +
        f"\nINSERT INTO {namespace}.schema_migration(version,sha256) VALUES({analytics.literal(version)},{analytics.literal(checksum)}); COMMIT;", operations)
    print(f'{version}: installed')


def initialize():
    # The existing initializer verifies its original migration checksum, without resetting data.
    analytics.initialize(55436)
    values = create_secret(OPS_SECRET, {'HGH_OPERATIONS_DB_PORT': '55437', 'POSTGRES_PASSWORD': None,
                           'OPERATIONS_READER_PASSWORD': None, 'OPERATIONS_WRITER_PASSWORD': None}, 'hgh-operations-pgdata')
    port = int(values['HGH_OPERATIONS_DB_PORT'])
    if not 1024 <= port <= 65535:
        raise RuntimeError('Invalid operations DB port')
    existing = run(['docker', 'inspect', OPS_CONTAINER], check=False)
    if existing.returncode == 0:
        labels = json.loads(existing.stdout)[0]['Config'].get('Labels') or {}
        if labels.get('com.docker.compose.project') != 'hmg-geo-hub-operations':
            raise RuntimeError('Operations container name belongs to another project')
    run(['docker', 'compose', '--env-file', str(OPS_SECRET), '-f', str(ROOT / 'infra/operations/compose.yml'), 'up', '-d'])
    for _ in range(90):
        ready = run(['docker', 'inspect', OPS_CONTAINER, '--format', '{{.State.Health.Status}}'], check=False)
        if ready.returncode == 0 and ready.stdout.strip() == 'healthy':
            break
        time.sleep(.5)
    else:
        raise RuntimeError('Operations DB did not become ready')
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
ALTER DATABASE hmg_operations OWNER TO hmg_operations_owner;
REVOKE ALL ON DATABASE hmg_operations FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
GRANT CONNECT ON DATABASE hmg_operations TO hmg_operations_reader,hmg_operations_writer;
COMMIT;""", True)
    migrate('operations-001.sql', '001_operations', True)
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
    analytics.secure_write(ROOT / '.env.operations.local', '# FastAPI read-only operations connection.\n'
        f"HGH_OPERATIONS_DB_URL=postgresql://hmg_operations_reader:{values['OPERATIONS_READER_PASSWORD']}@{OPS_CONTAINER}:5432/{OPS_DB}\n")
    data_port = analytics.env_file(analytics.SECRET)['HGH_ANALYTICS_DB_PORT']
    analytics.secure_write(ROOT / '.env.data-external.local', '# Local connection only. Empty exports until per-project approval.\n'
        f"HGH_DATA_EXTERNAL_DB_URL=postgresql://hmg_data_external:{data['DATA_EXTERNAL_PASSWORD']}@127.0.0.1:{data_port}/hmg_analytics\n")
    status()


def status():
    for ops, namespace in ((False, 'catalog'), (True, 'system')):
        print(sql(f"""SELECT json_build_object('database',current_database(),
            'tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='{namespace}' AND table_type='BASE TABLE'),
            'migrations',(SELECT json_agg(version ORDER BY version) FROM {'system' if ops else 'ops'}.schema_migration));""", ops).stdout.strip())


def sync():
    """Import actual Gold catalog definitions only, using transient writer connections."""
    values, data = analytics.env_file(OPS_SECRET), analytics.env_file(DATA_SECRET)
    config = {
        'data': f"postgresql://hmg_catalog_writer:{data['CATALOG_WRITER_PASSWORD']}@hgh-analytics-db:5432/hmg_analytics",
        'operations': f"postgresql://hmg_operations_writer:{values['OPERATIONS_WRITER_PASSWORD']}@{OPS_CONTAINER}:5432/{OPS_DB}",
    }
    # Secrets travel over stdin, never argv, image layers, logs or the frontend.
    script = (HERE / 'sync_catalog.py').read_text(encoding='utf8') + '\nasyncio.run(main(' + repr(config) + '))\n'
    result = run(['docker', 'exec', '-i', 'hgh-gold-api', 'python', '-'], text=script)
    print(result.stdout.strip())


def verify():
    sql((HERE / 'verify-data.sql').read_text(encoding='utf8'))
    sql((HERE / 'verify-operations.sql').read_text(encoding='utf8'), True)
    for ops, role in ((False, 'hmg_data_external'), (False, 'hmg_analytics_reader'), (True, 'hmg_operations_reader')):
        print(sql("SELECT json_build_object('database',current_database(),'role',current_user,'read_only',current_setting('transaction_read_only'));", ops, role).stdout.strip())
    # Connection checks cannot assume the database has no intentionally approved exports.
    data, values = analytics.env_file(DATA_SECRET), analytics.env_file(OPS_SECRET)
    external = f"postgresql://hmg_data_external:{data['DATA_EXTERNAL_PASSWORD']}"
    config = {'external':external+'@hgh-analytics-db:5432/hmg_analytics',
              'external_operations':external+f'@{OPS_CONTAINER}:5432/{OPS_DB}',
              'operations_reader':f"postgresql://hmg_operations_reader:{values['OPERATIONS_READER_PASSWORD']}@{OPS_CONTAINER}:5432/{OPS_DB}"}
    script = (HERE / 'verify_connections.py').read_text(encoding='utf8') + '\nasyncio.run(main(' + repr(config) + '))\n'
    print(run(['docker','exec','-i','hgh-gold-api','python','-'], text=script).stdout.strip())
    print('Verified opt-in exports, grants, immutable versions, operations isolation; all fixture transactions rolled back')


def backup():
    analytics.backup(None)
    output = ROOT / '.local/operations-backups' / f"hmg_operations-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.dump"
    output.parent.mkdir(parents=True, exist_ok=True)
    # Use secure_write to establish file ACLs before writing the binary archive.
    analytics.secure_write(output, '')
    import subprocess
    with output.open('wb') as handle:
        result = subprocess.run(['docker', 'exec', OPS_CONTAINER, 'pg_dump', '-U', 'hmg_operations_admin',
                                 '-d', OPS_DB, '--format=custom', '--no-owner', '--no-acl'], stdout=handle, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError('Operations backup failed')
    print(f'Backup created: {output}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['init', 'sync-gold-catalog', 'status', 'verify', 'backup'])
    args = parser.parse_args()
    try:
        {'init': initialize, 'sync-gold-catalog': sync, 'status': status, 'verify': verify, 'backup': backup}[args.command]()
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(sanitize(str(error)), file=sys.stderr)
        sys.exit(1)
