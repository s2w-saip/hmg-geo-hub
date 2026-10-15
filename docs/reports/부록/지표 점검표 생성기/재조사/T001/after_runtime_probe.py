"""Read-only observation of the existing local After backend; never prints credentials.

Run via stdin inside geo-hub-preserve-browser, whose PID 1 is browser-back.py.
This inspects that preview's database, not the Before deployment's database.
"""
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

import psycopg2

assert b'/test/browser-back.py' in Path('/proc/1/cmdline').read_bytes().split(b'\0')
environment = dict(part.split('=', 1) for part in Path('/proc/1/environ').read_bytes().decode().split('\0') if '=' in part)
os.environ.update(environment)
sys.path.insert(0, '/work/back')
from app.core.config import get_settings

settings = get_settings()
result = {
    'observed_at': datetime.now(timezone.utc).isoformat(),
    'target': '3130 preview -> geo-hub-preserve-browser:18080 -> configured local DB',
    'read_only': True,
    'result_cache': settings.result_cache,
    'legacy_profile': settings.legacy_profile,
    'queries': {},
    'limits': 'Local preview only. Aggregate row counts do not establish Before/After dataset equivalence or KPI denominators.',
}
queries = {
    'all_answer_count': 'SELECT count(*) FROM rd.answer',
    'answer_groups': '''SELECT a.round_date, c.code AS country, a.surface, count(*)
FROM rd.answer a JOIN rd.dim_country c USING (geo_key)
GROUP BY a.round_date, c.code, a.surface ORDER BY 1,2,3''',
}
url = urlsplit(environment['HGH_DB_URL'])._replace(scheme='postgresql')
connection = psycopg2.connect(urlunsplit(url))
try:
    connection.set_session(readonly=True)
    with connection.cursor() as cursor:
        cursor.execute('SHOW transaction_read_only')
        assert cursor.fetchone()[0] == 'on'
        for name, sql in queries.items():
            cursor.execute(sql)
            result['queries'][name] = {'sql': sql, 'columns': [column.name for column in cursor.description], 'rows': cursor.fetchall()}
finally:
    connection.rollback()
    connection.close()
print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
