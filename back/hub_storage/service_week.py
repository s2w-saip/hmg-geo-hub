"""The service week (서비스 기준 주): the last ISO week (Monday..Sunday) of operating snapshots that every screen shows.
Invoked with a transient credential (manage.py sync-service-week); hourly on the VM (vm.sh service-week), by hand and at scripts/start-local.sh locally.

One week for the whole service (Global and Website; the project surface has none), moved by this job from the manifest (T7.6, SSOT shared/project-architecture.md 5: 운영 반영 is a snapshot
going public). Per cycle of surfaces global and website in the ISO week of its round:
- complete: its operating snapshot is public and in the query tables (gold.silver_load, the load job), so the screens can read it.
- blocking: a snapshot on its way (loading or ready, or public and not loaded yet). A cycle with only retired snapshots never blocks.
- a week is a candidate when it has ended (its Sunday < today KST), nothing in it blocks and at least one cycle in it is complete. A surface with no cycle that week holds it back until the
  manifest lists a later cycle of it (before that the week may only not be loaded yet); after that the week was skipped and its screens show '측정 없음'.
- the service week is the latest candidate, and it never moves back: an older latest candidate keeps the recorded week.
The screens' per-week notes judge each cycle by the same rule on dim_cycle, which the load job keeps to the manifest (data_server/gold_reader/week_notes.py NOTES_SQL, its twin): change the two
together (pinned clause by clause, data_server.tests.test_hub_service_week and test_gold_service_week.WeekNotes).

catalog.service_week (data-011) gets a row only when the week or its cycle sets change; otherwise the run moves the newest row's checked_at (the last check that confirmed it)."""
import asyncio  # noqa: F401  (manage.py appends asyncio.run(main(...)) to this script)
import contextlib
import json
import os
from collections import Counter
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import asyncpg

RUN_LOCK = 617427422      # one check at a time (session lock on the data connection)
SURFACES = {1: 'global', 2: 'website'}   # the project surface (3) is out of scope
KST = ZoneInfo('Asia/Seoul')             # the screens' day (gold_reader/context.py); Gold's sessions are UTC
# The job's own limits on Gold (review r2-2, 2026-11-03): a Gold that stops answering (frozen, a half-open connection)
# never sends its statement_timeout, and the run, vm.sh's lock and start-local.sh's API start would wait with it. A
# statement's limit is above that 60 s, so a live but slow Gold still reports its own timeout first.
READ_TIMEOUTS = {'timeout': 30, 'command_timeout': 90}
# And on the HUB data DB (review r4-6, 2026-11-03): after a statement timed out, asyncpg's next statement on that
# connection (a transaction's ROLLBACK) and a graceful close wait for the answer to its cancel request, with no end on a
# frozen server. So nothing more goes over a connection a statement failed on: on any failure main drops it (the server
# rolls back what is open; record() rolls a refusal back itself) and ends non-zero. Only a run that went through closes
# it, given DATA_CLOSE s for the server to see it off.
DATA_TIMEOUTS = {'timeout': 60, 'command_timeout': 60}
DATA_CLOSE = 10


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), default=str)


def loaded(value):
    return json.loads(value) if isinstance(value, str) else (value or {})


class Refused(Exception):
    """Nothing to record: the read is not one to trust, or Gold has no complete week yet."""


# ═══ weeks ═══════════════════════════════════════════════════════════════════════════════════════════════

def today_kst(now=None):
    return (now or datetime.now(KST)).astimezone(KST).date()


def week_of(day):
    """The Monday of the ISO week of a day."""
    return day - timedelta(days=day.weekday())


def label(week_start):
    """(month, nth): the month of the week's Thursday and which week of that month it is (10/5~10/11 = 10월 2주차)."""
    thursday = week_start + timedelta(days=3)
    return thursday.month, (thursday.day - 1) // 7 + 1


def name(week_start):
    month, nth = label(week_start)
    return f'{month}월 {nth}주차'


def delay_days(week_end, today):
    """Days since the week's Sunday; the screens show a delay notice past 10 (decision '기준 주 세부')."""
    return (today - week_end).days


# ═══ the manifest ════════════════════════════════════════════════════════════════════════════════════════

MANIFEST_SQL = '''SELECT k.cycle_id,k.surface,max(m.round_date) AS round_date,
        (array_agg(m.snapshot_id::text) FILTER (WHERE m.status='public'))[1] AS public,bool_or(m.status IN ('loading','ready')) AS owed
    FROM ops.cycle k JOIN ops.snapshot_manifest m USING(cycle_id) WHERE k.surface IN ('global','website') AND m.round_date IS NOT NULL GROUP BY 1,2 ORDER BY 1'''
LOADED_SQL = 'SELECT cycle_id,snapshot_id::text AS snapshot_id FROM gold.silver_load'


def cycle_rows(manifest, loaded):
    """The manifest as rule A reads a cycle: public and loaded = complete, on its way (or public and not loaded yet) = blocking, only retired = neither."""
    rows = []
    for r in manifest:
        complete = bool(r['public']) and loaded.get(r['cycle_id']) == r['public']
        rows.append({'cycle_id': r['cycle_id'], 'cyc_key': r['cycle_id'], 'surface': {'global': 1, 'website': 2}[r['surface']], 'round_date': r['round_date'], 'project_key': None,
                     'status': 2 if complete else 0 if r['public'] or r['owed'] else 3, 'servable': complete, 'view_date': None, 'hidden_scope': None, 'fleet_visible': None,
                     'has_active_publication': complete, 'in_every_active_release': complete})
    return rows


async def read_snapshots(silver_dsn, gold_dsn):
    """The manifest and what the query tables hold. Any failure drops the connections at once: with a server silent, a rollback, the cancel request of a timed-out statement and a graceful
    close would each wait for it with no end."""
    silver = await asyncpg.connect(silver_dsn, **READ_TIMEOUTS, server_settings={'default_transaction_read_only': 'on', 'statement_timeout': '60000'})
    gold = None
    try:
        gold = await asyncpg.connect(gold_dsn, **READ_TIMEOUTS, server_settings={'default_transaction_read_only': 'on', 'statement_timeout': '60000'})
        manifest = await silver.fetch(MANIFEST_SQL)
        loaded = {r['cycle_id']: r['snapshot_id'] for r in await gold.fetch(LOADED_SQL)}
        await silver.close()
        await gold.close()
    except BaseException:
        silver.terminate()
        if gold is not None:
            gold.terminate()
        raise
    return {'versions': {}, 'releases': [], 'cycles': cycle_rows(manifest, loaded), 'orphan_publications': 0, 'orphan_items': 0}


def gold_release(g):
    """Recorded with the week (never used to pin a read): how many cycles it was judged over."""
    return {'cycles': len(g['cycles'])}


def check_read(g, previous_versions):
    """Refuse a read that shows a Gold reload in progress, or releases the screens could not pick either."""
    for scope, version in (previous_versions or {}).items():
        now = g['versions'].get(scope)
        if now is not None and version is not None and now < version:
            raise Refused(f'Gold data_version {scope} went back from {version} to {now}')
    for (scope, mode), n in sorted(Counter((r['scope'], r['read_mode']) for r in g['releases']).items()):
        if n > 1:
            raise Refused(f'{n} active {scope} {mode} releases; set HGH_GOLD_RULE_SIGNATURE')
    keys = [c['cyc_key'] for c in g['cycles']]
    ids = [c['cycle_id'] for c in g['cycles'] if c['cycle_id'] is not None]
    if len(set(keys)) != len(keys) or len(set(ids)) != len(ids):
        raise Refused('Gold cycle keys and ids must be unique')
    if any(c['round_date'] is None for c in g['cycles']):
        raise Refused('A Gold cycle has no round date')
    if g['orphan_publications']:
        raise Refused(f'{g["orphan_publications"]} active publications have no cycle (Gold mid-reload?)')
    if g['orphan_items']:
        raise Refused(f'{g["orphan_items"]} release items have no cycle (Gold mid-reload?)')


# ═══ rule A (pure: which week, and whether it is a change) ══════════════════════════════════════════════

def hidden(c):
    return (c['hidden_scope'] or 0) == 1   # 1 = hidden everywhere; 2 citations and 3 mentions still show the rest


def fleet_visible(c):
    """The site's week representative (gold.cycle_pick_basis, website only); Global, and a cycle with no pick row, are."""
    return c['surface'] == 1 or c['fleet_visible'] is not False


def complete(c, today):
    return (c['status'] == 2 and bool(c['servable']) and bool(c['has_active_publication'])
            and (c['view_date'] is None or c['view_date'] <= today) and bool(c['in_every_active_release']))


def blocking(c, today):
    if hidden(c) or complete(c, today):
        return False
    return c['status'] == 0 or (c['status'] == 1 and fleet_visible(c)) or (c['status'] == 2 and bool(c['servable']))


def judge(cycles, today):
    """week start -> the cycle ids it shows per surface, the cyc_keys still owed in it and the surfaces with a cycle in it."""
    weeks = {}
    for c in cycles:
        if c['surface'] not in SURFACES:
            continue
        week = weeks.setdefault(week_of(c['round_date']), {'global': [], 'website': [], 'blocking': [], 'surfaces': set()})
        week['surfaces'].add(c['surface'])
        if blocking(c, today):
            week['blocking'].append(c['cyc_key'])
        elif complete(c, today) and not hidden(c):
            week[SURFACES[c['surface']]].append(c['cycle_id'])
    return weeks


def listed_to(cycles):
    """surface -> the latest round_date Gold lists a cycle of it on, in any state: how far Gold has loaded it."""
    last = {}
    for c in cycles:
        if c['surface'] in SURFACES and (c['surface'] not in last or c['round_date'] > last[c['surface']]):
            last[c['surface']] = c['round_date']
    return last


def candidate(start, week, today, last):
    end = start + timedelta(days=6)
    # A surface with no cycle that week holds it back while Gold lists no later cycle of it: the week may only not be
    # loaded yet (decision '미적재 표면', 2026-11-03: 'A 10/5, B 10/12 → 10/5'). With a later one the week was skipped and
    # its screens show '측정 없음'; a surface Gold lists nothing for never holds a week back.
    unloaded = any(s not in week['surfaces'] and s in last and last[s] <= end for s in SURFACES)
    return end < today and not week['blocking'] and not unloaded and bool(week['global'] or week['website'])


def decide(cycles, today, recorded=None):
    """The service week: {week_start, global, website (sorted cycle ids), held, latest}, or None when Gold has no
    candidate and nothing is recorded. `recorded` is the newest catalog.current_service_week row (or None); held =
    the recorded week kept because the latest candidate (`latest`) is older or missing."""
    weeks = judge(cycles, today)
    last = listed_to(cycles)
    latest = max((start for start, week in weeks.items() if candidate(start, week, today, last)), default=None)
    if recorded is not None and (latest is None or latest < recorded['week_start']):
        return {'week_start': recorded['week_start'], 'global': sorted(recorded['global_cycles']),
                'website': sorted(recorded['website_cycles']), 'held': True, 'latest': latest}
    if latest is None:
        return None
    week = weeks[latest]
    if None in week['global'] or None in week['website']:
        raise Refused(f'A complete Gold cycle of the week {latest} has no cycle_id')
    return {'week_start': latest, 'global': sorted(week['global']), 'website': sorted(week['website']), 'held': False, 'latest': latest}


def changed(decision, recorded):
    """A new row is due when the week or either surface's cycle set differs from the newest recorded row."""
    return recorded is None or (decision['week_start'], decision['global'], decision['website']) != (
        recorded['week_start'], sorted(recorded['global_cycles']), sorted(recorded['website_cycles']))


def plan(g, today, recorded):
    """(decision, changed) for this read against the newest recorded row, or Refused."""
    check_read(g, loaded(recorded['gold_versions']) if recorded else None)
    decision = decide(g['cycles'], today, recorded)
    if decision is None:
        raise Refused('Gold has no complete week yet (ended, nothing owed in it, something to show)')
    return decision, changed(decision, recorded)


def summary(decision, is_changed, seq, today):
    start = decision['week_start']
    end = start + timedelta(days=6)
    return {'week_start': start.isoformat(), 'week_end': end.isoformat(), 'label': name(start), 'changed': is_changed,
            'held': decision['held'], 'latest': decision['latest'] and decision['latest'].isoformat(),
            'global_cycles': len(decision['global']), 'website_cycles': len(decision['website']),
            'delay_days': delay_days(end, today), 'seq': seq, 'today': today.isoformat()}


# ═══ the run ═════════════════════════════════════════════════════════════════════════════════════════════

CURRENT_SQL = 'SELECT seq,week_start,global_cycles,website_cycles,gold_versions FROM catalog.current_service_week'
INSERT_SQL = '''INSERT INTO catalog.service_week(week_start,global_cycles,website_cycles,gold_release,gold_versions)
    VALUES($1,$2::uuid[],$3::uuid[],$4::jsonb,$5::jsonb) RETURNING seq'''
CONFIRM_SQL = 'UPDATE catalog.service_week SET checked_at=now() WHERE seq=$1'


async def record(data, g, today):
    """In one transaction: decide against the newest row, then a new row when it changed, else its checked_at. A refusal
    rolls it back; any other failure leaves it to main, which drops the connection (DATA_TIMEOUTS)."""
    write = data.transaction()
    await write.start()
    recorded = await data.fetchrow(CURRENT_SQL)
    try:
        decision, is_changed = plan(g, today, recorded)
    except Refused:
        await write.rollback()
        raise
    if is_changed:
        seq = await data.fetchval(INSERT_SQL, decision['week_start'], decision['global'], decision['website'],
                                  encoded(gold_release(g)), encoded(g['versions']))
    else:
        seq = recorded['seq']
        await data.execute(CONFIRM_SQL, seq)
    await write.commit()
    return summary(decision, is_changed, seq, today)


async def main(config):
    """config: data (the writer DSN; a dry run without it decides as if nothing were recorded), dry_run."""
    data = None
    dry_run = bool(config.get('dry_run'))
    try:
        if config.get('data'):
            data = await asyncpg.connect(config['data'], **DATA_TIMEOUTS)
            if not dry_run and not await data.fetchval('SELECT pg_try_advisory_lock($1)', RUN_LOCK):
                raise RuntimeError('Another service week check is running')
        elif not dry_run:
            raise RuntimeError('No HUB data DB connection to record the service week in')
        try:
            g = await read_snapshots(os.environ['HGH_SILVER_DB_URL'], os.environ['HGH_GOLD_DB_URL'])
        except TimeoutError:
            raise RuntimeError('Service week not recorded: the manifest did not answer (limits: connect {timeout} s, '
                               'a statement {command_timeout} s)'.format(**READ_TIMEOUTS)) from None
        today = today_kst()
        try:
            if dry_run:
                recorded = await data.fetchrow(CURRENT_SQL) if data else None
                decision, is_changed = plan(g, today, recorded)
                out = {**summary(decision, is_changed, recorded and recorded['seq'], today), 'dry_run': True}
            else:
                out = await record(data, g, today)
        except Refused as refusal:
            raise RuntimeError(f'Service week not recorded: {refusal}') from None
        print(encoded(out))
    except BaseException as failure:
        if data is not None:
            data.terminate()
        if isinstance(failure, TimeoutError):   # the manifest's is reported above, so this one is the HUB data DB's
            raise RuntimeError('Service week check stopped: the HUB data DB did not answer (limits: connect {timeout} s, '
                               'a statement {command_timeout} s)'.format(**DATA_TIMEOUTS)) from None
        raise
    if data is not None:
        with contextlib.suppress(TimeoutError):   # asyncpg has dropped it; the run's work stands
            await data.close(timeout=DATA_CLOSE)
