"""The service week (서비스 기준 주): the last ISO week (Monday..Sunday) of Gold rounds that every screen shows.
Invoked inside the API image with a transient credential (manage.py sync-service-week); hourly on the VM (vm.sh
service-week), by hand and at scripts/start-local.sh locally.

Decisions '발행 시점 판정' and '기준 주 세부' (2026-11-02, docs/handoff/admin-todo.md): one week for the whole service
(Global and Website; the project surface has none), moved by this job from Gold's own status. Gold is trusted (no
'unchanged for n hours' wait), and nothing is pinned to what is recorded here: the screens read Gold's live release up to
the week's Sunday, so a Gold re-publication of an older week is followed.

Rule A, per cycle of surfaces 1 and 2 in the ISO week of its round_date (checked on live Gold, 2026-11-02):
- complete: published (status 2), servable, an active gold.publication, visible today (view_date NULL or <= today KST)
  and a ready, validated 'fact' release item cyc:<cyc_key> in the live release of its scope, the one snapshot the screens read
  (until Silver's manifest, T9: going live is Gold's live release taking the round; 2026-11-06, the card and grid releases are not read).
- blocking: not hidden (hidden_scope <> 1), not complete, and open (status 0), closed as its site's week representative
  (status 1 and fleet-visible; Global always is) or published and servable. Hidden cycles, superseded duplicates
  (status 2, not servable), other closed cycles of a site (status 1, not fleet-visible) and stale ones (3) never block.
- a week is a candidate when it has ended (its Sunday < today KST), nothing in it blocks and at least one cycle in it is
  complete and not hidden. A surface with no cycle that week holds it back until Gold lists a later cycle of it (before
  that the week may only not be loaded yet); after that the week was skipped and its screens show '측정 없음'.
- the service week is the latest candidate, and it never moves back: an older latest candidate keeps the recorded week.
The screens' per-week notes judge each cycle by the same rule in SQL (bff/gold_reader/week_notes.py NOTES_SQL, its
twin): change the two together (each pinned clause by clause, bff.tests.test_hub_service_week.GoldReads and
test_gold_service_week.WeekNotes).

catalog.service_week (data-011) gets a row only when the week or its cycle sets change; otherwise the run moves the
newest row's checked_at (the last check that confirmed it). Gold reloads its tables one by one, so a read that shows a
reload in progress (data_version going back, a publication or release item whose cycle is missing) or releases the
screens could not pick either is refused, and nothing is written."""
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
GOLD_TIMEOUTS = {'timeout': 30, 'command_timeout': 90}
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


# ═══ Gold reads ══════════════════════════════════════════════════════════════════════════════════════════

# The active releases the screens pick from, one per scope and read mode (HGH_GOLD_RULE_SIGNATURE as the BFF).
RELEASES_SQL = '''SELECT scope,read_mode,release_id,version,rule_signature,last_build_id,as_of FROM gold.active_release
    WHERE scope IN ('global','website') AND read_mode='live' AND ($1::text IS NULL OR rule_signature=$1)
    ORDER BY scope,read_mode'''
# One row per cycle of surfaces 1 and 2, with the facts rule A needs; fleet_visible is NULL without a pick row.
CYCLES_SQL = '''WITH rel AS (SELECT scope,release_id FROM gold.active_release
        WHERE scope IN ('global','website') AND read_mode='live' AND ($1::text IS NULL OR rule_signature=$1))
    SELECT d.cycle_id,d.cyc_key,d.surface,d.project_key,d.round_date,d.status,d.servable,d.view_date,d.hidden_scope,b.fleet_visible,
        EXISTS(SELECT 1 FROM gold.publication p WHERE p.cyc_key=d.cyc_key AND p.state='active') AS has_active_publication,
        (EXISTS(SELECT 1 FROM rel r WHERE r.scope=s.scope) AND NOT EXISTS(SELECT 1 FROM rel r WHERE r.scope=s.scope AND NOT EXISTS(
            SELECT 1 FROM gold.release_item i JOIN gold.build bu ON bu.build_id=i.build_id AND bu.status='validated'
            WHERE i.release_id=r.release_id AND i.family='fact' AND i.state='ready' AND i.slice_key='cyc:'||d.cyc_key::text))
        ) AS in_every_active_release
    FROM gold.dim_cycle d LEFT JOIN gold.cycle_pick_basis b ON b.cyc_key=d.cyc_key
    CROSS JOIN LATERAL (SELECT CASE d.surface WHEN 1 THEN 'global' ELSE 'website' END AS scope) s
    WHERE d.surface IN (1,2) ORDER BY d.cyc_key'''
VERSIONS_SQL = 'SELECT scope,version FROM gold.data_version ORDER BY scope'
# Keys that point at a cycle row the read does not have: a table read from another generation than dim_cycle.
ORPHANS_SQL = '''SELECT (SELECT count(*) FROM gold.publication p WHERE p.state='active'
        AND NOT EXISTS(SELECT 1 FROM gold.dim_cycle d WHERE d.cyc_key=p.cyc_key)) AS publications,
    (SELECT count(*) FROM gold.release_item i WHERE i.release_id=ANY($1::bigint[]) AND i.family='fact' AND i.state='ready'
        AND i.slice_key LIKE 'cyc:%' AND NOT EXISTS(SELECT 1 FROM gold.dim_cycle d WHERE 'cyc:'||d.cyc_key::text=i.slice_key)) AS items'''


async def read_gold(conn, rule_signature):
    """Everything rule A and the checks need, read on one connection (gold_snapshot: one repeatable-read snapshot)."""
    g = {'versions': {r['scope']: r['version'] for r in await conn.fetch(VERSIONS_SQL)},
         'releases': [dict(r) for r in await conn.fetch(RELEASES_SQL, rule_signature)],
         'cycles': [dict(r) for r in await conn.fetch(CYCLES_SQL, rule_signature)]}
    orphans = await conn.fetchrow(ORPHANS_SQL, [r['release_id'] for r in g['releases']])
    g['orphan_publications'], g['orphan_items'] = orphans['publications'], orphans['items']
    return g


async def gold_snapshot(dsn, rule_signature):
    """read_gold in one read-only repeatable-read transaction on a connection of its own, closed before anything is
    written. Any failure drops the connection at once: with Gold silent, a rollback, the cancel request of a timed-out
    statement and a graceful close would each wait for it with no end."""
    conn = await asyncpg.connect(dsn, **GOLD_TIMEOUTS, server_settings={'default_transaction_read_only': 'on',
                                                                        'statement_timeout': '60000'})
    try:
        read = conn.transaction(isolation='repeatable_read', readonly=True)
        await read.start()
        g = await read_gold(conn, rule_signature)
        await read.commit()
        await conn.close()
    except BaseException:
        conn.terminate()
        raise
    return g


def gold_release(g):
    """The active releases, {scope: {read_mode: row}}, recorded with the week (never used to pin a read)."""
    out = {}
    for r in g['releases']:
        out.setdefault(r['scope'], {})[r['read_mode']] = {k: r[k] for k in ('release_id', 'version', 'rule_signature', 'last_build_id', 'as_of')}
    return out


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
            g = await gold_snapshot(os.environ['HGH_GOLD_DB_URL'], os.environ.get('HGH_GOLD_RULE_SIGNATURE') or None)
        except TimeoutError:
            raise RuntimeError('Service week not recorded: Gold did not answer (limits: connect {timeout} s, '
                               'a statement {command_timeout} s)'.format(**GOLD_TIMEOUTS)) from None
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
        if isinstance(failure, TimeoutError):   # Gold's is reported above, so this one is the HUB data DB's
            raise RuntimeError('Service week check stopped: the HUB data DB did not answer (limits: connect {timeout} s, '
                               'a statement {command_timeout} s)'.format(**DATA_TIMEOUTS)) from None
        raise
    if data is not None:
        with contextlib.suppress(TimeoutError):   # asyncpg has dropped it; the run's work stands
            await data.close(timeout=DATA_CLOSE)
