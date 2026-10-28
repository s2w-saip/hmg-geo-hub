"""Idempotent Gold import of the current prompts and of the values collecting and processing them needs.
Invoked inside the API image with transient credentials (manage.py sync-gold-catalog).

What it records (external API, 2026-10-28; docs/architecture/hmg-geo-hub-architecture.html):
- catalog.project_version / prompt_version: a new revision only when a definition changed. Definitions keep
  Gold's own encoding (surface 1/2/3, brand bitmasks); the API decodes them with the HUB code tables.
- catalog.reference_set / reference_item: one set per family, recorded again only when the family changed.
  Only inputs: values people set or registered. Values Gold derived from answers or rules are left out.
- catalog.sync_run: one row per run with what was read and recorded, or why the run refused.

Gold reloads its tables one by one, each in its own transaction, so a read during a reload can mix
generations. Every run therefore checks the read before writing anything, and refuses (records nothing)
when a check fails: see guards(). A Gold-origin item missing from Gold becomes `removed` only when two runs
at least CONFIRM_MINUTES apart both miss it. HUB-origin items are never touched."""
import asyncio  # noqa: F401  (manage.py appends asyncio.run(main(...)) to this script)
import hashlib
import json
import os
import uuid
from collections import defaultdict
from datetime import timedelta

import asyncpg

RUN_LOCK = 617427415      # one import at a time (session lock on the data connection)
CATALOG_LOCK = 617427413  # every catalog writer (this import, the HUB editor): change_seq order = commit order
# HUB-owned code tables. Tests check them against bff.gold_reader (context.BRANDS/BRAND_NAMES, metrics.TYPES).
SURFACES = {1: 'global', 2: 'website', 3: 'project'}
BRAND_BITS = {1: 'hyundai', 2: 'kia', 4: 'genesis', 16: 'hyundai-n'}
MENTION_TYPES = ('mention', 'recommendation', 'comparison', 'definition', 'final_choice')
# dim_source.category_src set by people: 1 override, 2 social, 4 seed. 3 owned, 5 rule, 6 fallback are derived.
SOURCE_INPUTS = {1: 'override', 2: 'social', 4: 'seed'}
# Guards: removals above max(REMOVAL_MIN, REMOVAL_SHARE of Gold-origin items), or above PROJECT_REMOVAL_SHARE
# of a project with at least PROJECT_REMOVAL_MIN prompts, or new revisions above CHANGE_SHARE refuse the run.
REMOVAL_MIN, REMOVAL_SHARE, PROJECT_REMOVAL_MIN, PROJECT_REMOVAL_SHARE, CHANGE_SHARE = 20, 0.01, 5, 0.10, 0.05
CONFIRM_MINUTES = 30


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), default=str)


def digest(definition, text=None):
    return hashlib.sha256(encoded({'definition': definition, 'text': text}).encode()).hexdigest()


class Refused(Exception):
    """A check failed; nothing is recorded and the previous catalog stays current."""


# ═══ Gold reads ══════════════════════════════════════════════════════════════════════════════════════════

IDENTITY = 'coalesce(d.project_id,d.scope_project_id,d.site_id)'
PROJECTS_SQL = f'''SELECT {IDENTITY} AS id,d.scope_project_id,d.project_id AS source_project_id,d.site_id,d.surface,d.is_root,
    d.site_brand_bit,d.site_geo_key,c.code AS country,d.regions
    FROM gold.dim_project d LEFT JOIN gold.dim_country c ON c.geo_key=d.site_geo_key ORDER BY d.project_key'''
TAXON_COLUMNS = (('funnel', 'funnel_key'), ('brand_presence', 'presence_key'), ('list_type', 'list_type_key'),
                 ('depth1', 'depth1_key'), ('depth2', 'depth2_key'), ('depth3', 'depth3_key'), ('depth4', 'depth4_key'))


def taxon_joins(alias):
    return ' '.join(f'LEFT JOIN gold.dim_taxon t_{name} ON t_{name}.taxon_key={alias}.{key}' for name, key in TAXON_COLUMNS)


def taxon_select(alias):
    return ','.join(f't_{name}.code AS {name},{alias}.{key} AS {name}_key' for name, key in TAXON_COLUMNS)


PROMPTS_SQL = f'''SELECT p.prompt_id AS id,{IDENTITY} AS project_id,p.text,p.surface,p.kind,p.lang_key,l.code AS language,
    p.regions,p.targets,p.in_root_catalog,p.in_project_catalog,p.web_reg,u.file_seq AS unit_file_seq,p.unit_key,{taxon_select('p')}
    FROM gold.dim_prompt p JOIN gold.dim_project d USING(project_key) LEFT JOIN gold.dim_lang l USING(lang_key)
    LEFT JOIN gold.web_unit u USING(unit_key) {taxon_joins('p')} ORDER BY p.prompt_key'''
# The Global catalog of the active global live release: its newest validated fact build. Every fact build
# repeats the same catalog (catalog_row_id is stable across builds), so the newest one is the current one.
RELEASE_SQL = '''SELECT release_id,version,rule_signature,last_build_id,as_of FROM gold.active_release
    WHERE scope='global' AND read_mode='live' AND ($1::text IS NULL OR rule_signature=$1)'''
BUILDS_SQL = '''SELECT b.build_id,b.finished_at,b.ecat_ver,b.row_counts FROM gold.release_item i JOIN gold.build b USING(build_id)
    WHERE i.release_id=$1 AND i.family='fact' AND i.state='ready' AND b.status='validated'
    ORDER BY b.finished_at DESC NULLS LAST,b.build_id DESC'''
CATALOG_SQL = f'''SELECT ce.catalog_row_id,p.prompt_id,ce.brand_bit,ce.kind,{taxon_select('ce')}
    FROM gold.catalog_entry ce JOIN gold.dim_prompt p USING(prompt_key) {taxon_joins('ce')}
    WHERE ce.build_id=$1 ORDER BY ce.catalog_row_id'''
CUSTOM_FIELDS_SQL = f'''SELECT f.field_id,{IDENTITY} AS project_id,f.label,f.archived,f.created_at
    FROM gold.dim_custom_field f LEFT JOIN gold.dim_project d USING(project_key) ORDER BY f.field_id'''
CUSTOM_VALUES_SQL = '''SELECT p.prompt_id,v.field_id,v.value FROM gold.prompt_custom_value v
    JOIN gold.dim_prompt p USING(prompt_key) ORDER BY p.prompt_id,v.field_id'''
UNITS_SQL = f'''SELECT {IDENTITY} AS project_id,u.file_seq,u.lang_codes,u.base,u.base_src
    FROM gold.web_unit u JOIN gold.dim_project d USING(project_key) ORDER BY 1,2'''
# Registered target URLs as entered (dim_url.url), keyed the way dim_prompt.targets spells them (url_norm).
TARGETS_SQL = f'''SELECT {IDENTITY} AS project_id,w.lang_key,u.url_norm,u.url
    FROM gold.web_target_url w JOIN gold.dim_url u USING(url_key) JOIN gold.dim_project d USING(project_key)'''
VERSIONS_SQL = 'SELECT scope,version FROM gold.data_version ORDER BY scope'
REFERENCE_SQL = {
    'engine': "SELECT code,is_default FROM gold.dim_engine WHERE coalesce(code,'')<>''",
    'region': "SELECT code FROM gold.dim_region WHERE coalesce(code,'')<>''",
    'country': '''SELECT c.code,r.code AS region,c.kind,c.hidden_standard,c.virtual_brand_bit FROM gold.dim_country c
        LEFT JOIN gold.dim_region r USING(region_key) WHERE coalesce(c.code,'')<>'' ''',
    'language': "SELECT code FROM gold.dim_lang WHERE coalesce(code,'')<>''",
    'taxon': "SELECT taxon_key,axis,code,parent_key FROM gold.dim_taxon WHERE coalesce(code,'')<>''",
    'brand': 'SELECT name,bare,own_bit FROM gold.dim_brand WHERE kind=1',
    'entity': '''SELECT e.entity_id,e.entity_type,e.registry_role,e.rep_name,CASE WHEN b.kind=1 THEN b.bare END AS brand
        FROM gold.dim_entity e LEFT JOIN gold.dim_brand b USING(brand_key) WHERE e.registry_role IS NOT NULL''',
    'source_category': "SELECT slug,name,ord FROM gold.dim_category WHERE coalesce(slug,'')<>''",
    'source': f'''SELECT s.skey,s.domain,s.is_social,c.slug AS category,s.category_src FROM gold.dim_source s
        LEFT JOIN gold.dim_category c USING(category_key) WHERE s.category_src IN ({','.join(map(str, SOURCE_INPUTS))})''',
    'owned_base': '''SELECT kind,prefix,host,brand_code,brand_bit,geo_code,language FROM gold.dim_owned_base
        WHERE coalesce(kind,'')<>'' AND coalesce(prefix,'')<>'' ''',
    'crawl_bot': 'SELECT b.code,e.code AS engine FROM gold.dim_crawl_bot b LEFT JOIN gold.dim_engine e USING(engine_key)',
    'keyword': '''SELECT k.term,k.term_norm,s.location_code,s.language_code FROM gold.kw_suggestion s
        JOIN gold.dim_keyword k ON k.kw_key=s.kw_key WHERE s.is_seed''',
    'perspective': 'SELECT own_bits,label FROM gold.dim_perspective',
    'population': 'SELECT code,gate,rep_mode FROM gold.dim_population',
}


async def read_gold(conn, rule_signature):
    """Everything in one repeatable-read snapshot."""
    g = {'versions': {r['scope']: r['version'] for r in await conn.fetch(VERSIONS_SQL)}}
    for name, query in (('projects', PROJECTS_SQL), ('prompts', PROMPTS_SQL), ('custom_fields', CUSTOM_FIELDS_SQL),
                        ('custom_values', CUSTOM_VALUES_SQL), ('units', UNITS_SQL), ('targets', TARGETS_SQL)):
        g[name] = [dict(r) for r in await conn.fetch(query)]
    releases = [dict(r) for r in await conn.fetch(RELEASE_SQL, rule_signature)]
    if len(releases) != 1:
        raise Refused(f'{len(releases)} active global live releases; set HGH_GOLD_RULE_SIGNATURE')
    builds = [dict(r) for r in await conn.fetch(BUILDS_SQL, releases[0]['release_id'])]
    if not builds:
        raise Refused('The active global live release has no validated fact build')
    if len({b['ecat_ver'] for b in builds}) != 1:
        raise Refused('The release mixes fact builds of different ecat_ver')
    g['release'] = {'release_id': releases[0]['release_id'], 'version': releases[0]['version'],
                    'rule_signature': releases[0]['rule_signature'], 'build_id': builds[0]['build_id'],
                    'ecat_ver': str(builds[0]['ecat_ver'])}
    g['catalog'] = [dict(r) for r in await conn.fetch(CATALOG_SQL, builds[0]['build_id'])]
    counts = builds[0]['row_counts']
    counts = json.loads(counts) if isinstance(counts, str) else (counts or {})
    g['catalog_expected'] = counts.get('catalog_entry')
    g['reference'] = {family: [dict(r) for r in await conn.fetch(query)] for family, query in REFERENCE_SQL.items()}
    return g


# ═══ checks ══════════════════════════════════════════════════════════════════════════════════════════════

def bits_known(value):
    rest = value or 0
    for bit in BRAND_BITS:
        rest &= ~bit
    return rest == 0


def check_read(g, previous_versions):
    """Refuse a read that is internally inconsistent: the signs of a Gold reload in progress or of a code
    the HUB cannot decode."""
    for scope, version in (previous_versions or {}).items():
        if scope in g['versions'] and g['versions'][scope] < version:
            raise Refused(f'Gold data_version {scope} went back from {version} to {g["versions"][scope]}')
    ids = [p['id'] for p in g['projects']]
    if None in ids or len(set(ids)) != len(ids):
        raise Refused('Gold project UUIDs must be present and unique')
    prompt_ids = [p['id'] for p in g['prompts']]
    if None in prompt_ids or len(set(prompt_ids)) != len(prompt_ids):
        raise Refused('Gold prompt UUIDs must be present and unique')
    if any(p['project_id'] not in set(ids) or p['text'] is None for p in g['prompts']):
        raise Refused('A Gold prompt has no project or no text')
    # A key with no code: a table read from another generation than the one it points to.
    for row in (*g['prompts'], *g['catalog']):
        for name, _ in TAXON_COLUMNS:
            if row[f'{name}_key'] is not None and row[name] is None:
                raise Refused(f'Taxonomy key {row[f"{name}_key"]} has no code (Gold mid-reload?)')
    if any(p['lang_key'] is not None and p['language'] is None for p in g['prompts']):
        raise Refused('Language key without a code (Gold mid-reload?)')
    if any(p['site_geo_key'] is not None and p['country'] is None for p in g['projects']):
        raise Refused('Country key without a code (Gold mid-reload?)')
    if any(p['unit_key'] is not None and p['unit_file_seq'] is None for p in g['prompts']):
        raise Refused('Website unit key without a unit (Gold mid-reload?)')
    if g['catalog_expected'] is not None and len(g['catalog']) != g['catalog_expected']:
        raise Refused(f'catalog_entry has {len(g["catalog"])} rows, the build recorded {g["catalog_expected"]}')
    # Every surface and brand bit must decode with the HUB code tables.
    if any(p['surface'] not in SURFACES for p in (*g['projects'], *g['prompts'])):
        raise Refused('Unknown surface code; extend SURFACES')
    bitmasks = ([p['site_brand_bit'] for p in g['projects']] + [c['brand_bit'] for c in g['catalog']]
                + [c['virtual_brand_bit'] for c in g['reference']['country']] + [b['own_bit'] for b in g['reference']['brand']]
                + [o['brand_bit'] for o in g['reference']['owned_base']] + [p['own_bits'] for p in g['reference']['perspective']])
    if not all(bits_known(b) for b in bitmasks):
        raise Refused('Unknown brand bit; extend BRAND_BITS')


# ═══ definitions ═════════════════════════════════════════════════════════════════════════════════════════

def sorted_list(values):
    return sorted(values) if isinstance(values, list) else values


def project_definitions(g):
    """Project id -> definition: Gold's project row, its custom fields and its website units."""
    fields, units = defaultdict(list), defaultdict(list)
    for f in g['custom_fields']:
        if f['project_id'] is not None:   # a field without a project is a leftover, never used
            fields[f['project_id']].append({'field_id': str(f['field_id']), 'label': f['label'],
                                            'archived': bool(f['archived']), 'created_at': f['created_at']})
    for u in g['units']:
        # A declared base is an input; a heuristic one was inferred from the target URLs, so it is left out.
        units[u['project_id']].append({'file_seq': u['file_seq'], 'lang_codes': sorted(u['lang_codes'] or []),
                                       'base': u['base'] if u['base_src'] == 'decl' else None, 'base_src': u['base_src']})
    out = {}
    for p in g['projects']:
        definition = {'scope_project_id': p['scope_project_id'], 'source_project_id': p['source_project_id'], 'site_id': p['site_id'],
                      'surface': p['surface'], 'is_root': p['is_root'], 'site_brand_bit': p['site_brand_bit'],
                      'country': p['country'] or None,   # '' is Gold's placeholder country
                      'regions': sorted_list(p['regions']), 'name': None, 'brands': None, 'domain': None, 'status': 'active'}
        if fields[p['id']]:
            definition['custom_fields'] = sorted(fields[p['id']], key=lambda f: f['field_id'])
        if units[p['id']]:
            definition['web'] = {'units': sorted(units[p['id']], key=lambda u: u['file_seq'])}
        out[p['id']] = definition
    return out


def prompt_definitions(g):
    """Prompt id -> (text, definition): Gold's prompt row, its Global catalog entries, its custom values
    and, for a website prompt, its unit and its target URL as registered."""
    catalogs, values = defaultdict(list), defaultdict(dict)
    for c in g['catalog']:
        catalogs[c['prompt_id']].append({'catalog_row_id': c['catalog_row_id'], 'brand_bit': c['brand_bit'], 'kind': c['kind'],
                                         **{name: c[name] for name, _ in TAXON_COLUMNS}})
    for v in g['custom_values']:
        values[v['prompt_id']][str(v['field_id'])] = v['value']
    targets = {}
    for t in g['targets']:
        key = (t['project_id'], t['lang_key'], t['url_norm'])
        if key in targets and targets[key] != t['url']:
            raise Refused(f'Two registered URLs normalize to {t["url_norm"]}')
        targets[key] = t['url']
    out = {}
    for p in g['prompts']:
        definition = {'surface': p['surface'], 'kind': p['kind'], 'language': p['language'], 'regions': sorted_list(p['regions']),
                      'in_root_catalog': p['in_root_catalog'], 'in_project_catalog': p['in_project_catalog'], 'web_reg': p['web_reg'],
                      **{name: p[name] for name, _ in TAXON_COLUMNS}, 'status': 'active'}
        if p['surface'] == 1:
            definition['catalogs'] = sorted(catalogs[p['id']], key=lambda c: c['catalog_row_id'])
        if p['unit_file_seq'] is not None:
            definition['unit_file_seq'] = p['unit_file_seq']
        if p['targets']:
            urls = [targets.get((p['project_id'], p['lang_key'], t)) for t in p['targets']]
            if None in urls or len(urls) != 1:
                raise Refused(f'Website prompt {p["id"]}: its target is not one registered URL')
            definition['target_url'] = urls[0]
        if values[p['id']]:
            definition['custom_values'] = values[p['id']]
        out[p['id']] = (p['text'], definition)
    return out


def taxon_items(rows):
    """item key = [axis, ancestor codes..., code]: codes repeat under different parents (RAV4 under 9)."""
    by_key = {r['taxon_key']: r for r in rows}

    def path(r):
        chain, seen = [], set()
        while r['parent_key'] is not None and r['parent_key'] in by_key and r['parent_key'] not in seen:
            seen.add(r['parent_key'])
            r = by_key[r['parent_key']]
            chain.append(r['code'])
        return chain[::-1]

    return {encoded([r['axis'], *path(r), r['code']]): {'axis': r['axis'], 'code': r['code'], 'path': path(r)} for r in rows}


def reference_items(g):
    """family -> {item_key: definition}, sorted by key when hashed."""
    ref = g['reference']
    keywords = defaultdict(lambda: {'conditions': set()})
    for k in ref['keyword']:
        item = keywords[k['term_norm']]
        item.update(term=k['term'], term_norm=k['term_norm'])
        item['conditions'].add((k['location_code'], k['language_code']))
    return {
        'surface': {str(v): {'value': v, 'code': c} for v, c in SURFACES.items()},
        'brand_bit': {str(b): {'bit': b, 'code': c} for b, c in BRAND_BITS.items()},
        'mention_type': {t: {'code': t} for t in MENTION_TYPES},
        'engine': {r['code']: r for r in ref['engine']},
        'region': {r['code']: r for r in ref['region']},
        'country': {r['code']: r for r in ref['country']},
        'language': {r['code']: r for r in ref['language']},
        'taxon': taxon_items(ref['taxon']),
        'brand': {r['bare']: r for r in ref['brand']},
        'entity': {str(r['entity_id']): {**r, 'entity_id': str(r['entity_id'])} for r in ref['entity']},
        'source_category': {r['slug']: r for r in ref['source_category']},
        'source': {r['skey']: {**r, 'category_src': SOURCE_INPUTS[r['category_src']]} for r in ref['source']},
        'owned_base': {encoded([r['kind'], r['prefix']]): r for r in ref['owned_base']},
        'crawl_bot': {r['code']: r for r in ref['crawl_bot']},
        'keyword': {k: {'term': v['term'], 'term_norm': v['term_norm'],
                        'conditions': [{'location_code': loc, 'language_code': lang} for loc, lang in sorted(v['conditions'], key=encoded)]}
                    for k, v in keywords.items()},
        'perspective': {str(r['own_bits']): r for r in ref['perspective']},
        'population': {encoded([r['code'], r['gate'], r['rep_mode']]): r for r in ref['population']},
    }


def family_digest(items):
    return hashlib.sha256(encoded(sorted(items.items())).encode()).hexdigest()


# ═══ planning (pure: what to record, or why to refuse) ══════════════════════════════════════════════════

def removals(current, present, earlier, earlier_at, now):
    """Gold-origin, not yet removed, missing from Gold: (this run's candidates, those to remove now).
    Only ids that the previous successful run, at least CONFIRM_MINUTES ago, also missed are removed."""
    candidates = sorted(str(i) for i, row in current.items()
                        if row['origin'] == 'gold' and row['status'] != 'removed' and i not in present)
    if earlier_at is None or earlier_at > now - timedelta(minutes=CONFIRM_MINUTES):
        return candidates, []
    earlier = set(earlier or [])
    return candidates, [i for i in candidates if i in earlier]


def guard(counts, prompt_candidates, prompt_project, totals, allow_removals, expect_mass_change):
    """Refuse a run that would remove or rewrite far more than a normal day does."""
    gold_items = max(totals['gold_items'], 1)
    removing = counts['project_candidates'] + counts['prompt_candidates']
    if removing > max(REMOVAL_MIN, REMOVAL_SHARE * gold_items) and removing > allow_removals:
        raise Refused(f'{removing} Gold items are missing from Gold; rerun with --allow-removals {removing} if that is right')
    per_project = defaultdict(int)
    for i in prompt_candidates:
        per_project[prompt_project[i]] += 1
    for project, n in per_project.items():
        size = totals['project_prompts'].get(project, 0)
        if n >= PROJECT_REMOVAL_MIN and n > PROJECT_REMOVAL_SHARE * size and removing > allow_removals:
            raise Refused(f'{n} of {size} prompts of project {project} are missing from Gold; rerun with --allow-removals {removing}')
    changing = counts['new_project_versions'] + counts['new_prompt_versions']
    if changing > CHANGE_SHARE * gold_items and changing > REMOVAL_MIN and not expect_mass_change:
        raise Refused(f'{changing} new revisions for {gold_items} items; rerun with --expect-mass-change if that is right')


# ═══ the run ═════════════════════════════════════════════════════════════════════════════════════════════

CURRENT_PROJECTS_SQL = '''SELECT p.project_id AS id,p.origin,p.source_id,v.version,v.sha256,v.definition
    FROM catalog.project p LEFT JOIN LATERAL (SELECT version,sha256,definition FROM catalog.project_version
    WHERE project_id=p.project_id ORDER BY version DESC LIMIT 1) v ON true'''
CURRENT_PROMPTS_SQL = '''SELECT p.prompt_id AS id,p.project_id,p.origin,p.source_id,v.version,v.sha256,v.text,v.definition
    FROM catalog.prompt p LEFT JOIN LATERAL (SELECT version,sha256,text,definition FROM catalog.prompt_version
    WHERE prompt_id=p.prompt_id ORDER BY version DESC LIMIT 1) v ON true'''
CURRENT_SETS_SQL = 'SELECT family,version,sha256 FROM catalog.current_reference_set'
PREVIOUS_RUN_SQL = '''SELECT finished_at,gold_versions,removal_candidates FROM catalog.sync_run
    WHERE result='ok' ORDER BY finished_at DESC LIMIT 1'''


def loaded(value):
    return json.loads(value) if isinstance(value, str) else (value or {})


def current_rows(rows):
    out = {}
    for r in rows:
        r = dict(r)
        r['definition'] = loaded(r['definition'])
        r['status'] = r['definition'].get('status') or 'active'
        out[r['id']] = r
    return out


async def record(data, g, previous, options, now):
    """Under the catalog lock: compare with the HUB catalog, apply the guards, insert. `previous` is the last
    successful run (finished_at, removal_candidates) or None. Returns the counts and this run's candidates."""
    await data.execute("SET LOCAL lock_timeout='10s'")
    await data.execute('SELECT pg_advisory_xact_lock($1)', CATALOG_LOCK)
    projects, prompts = project_definitions(g), prompt_definitions(g)
    old_projects = current_rows(await data.fetch(CURRENT_PROJECTS_SQL))
    old_prompts = current_rows(await data.fetch(CURRENT_PROMPTS_SQL))
    prompt_project = {p['id']: p['project_id'] for p in g['prompts']}
    new_projects, project_versions, new_prompts, prompt_versions = [], [], [], []
    for identity, definition in projects.items():
        old = old_projects.get(identity)
        if old and (old['origin'] != 'gold' or old['source_id'] != identity):
            raise Refused('Catalog identity collision; HUB-owned definitions were not overwritten')
        if old is None:
            new_projects.append((identity,))
        sha = digest(definition)
        if not old or old['sha256'] != sha:
            project_versions.append((identity, (old['version'] or 0) + 1 if old else 1, encoded(definition), sha))
    for identity, (text, definition) in prompts.items():
        old = old_prompts.get(identity)
        if old and (old['origin'] != 'gold' or old['source_id'] != identity or old['project_id'] != prompt_project[identity]):
            raise Refused('Prompt identity/ownership changed; import cancelled')
        if old is None:
            new_prompts.append((identity, prompt_project[identity]))
        sha = digest(definition, text)
        if not old or old['sha256'] != sha:
            prompt_versions.append((identity, (old['version'] or 0) + 1 if old else 1, text, encoded(definition), sha))
    earlier = loaded(previous['removal_candidates']) if previous else {}
    earlier_at = previous['finished_at'] if previous else None
    project_candidates, project_removed = removals(old_projects, set(projects), earlier.get('projects'), earlier_at, now)
    prompt_candidates, prompt_removed = removals(old_prompts, set(prompts), earlier.get('prompts'), earlier_at, now)
    counts = {'projects': len(projects), 'prompts': len(prompts), 'new_project_versions': len(project_versions),
              'new_prompt_versions': len(prompt_versions), 'project_candidates': len(project_candidates),
              'prompt_candidates': len(prompt_candidates), 'removed_projects': len(project_removed),
              'removed_prompts': len(prompt_removed)}
    project_prompts = defaultdict(int)
    for r in old_prompts.values():
        if r['origin'] == 'gold':
            project_prompts[r['project_id']] += 1
    totals = {'gold_items': sum(r['origin'] == 'gold' for r in (*old_projects.values(), *old_prompts.values())),
              'project_prompts': project_prompts}
    guard(counts, prompt_candidates, {i: old_prompts[uuid.UUID(i)]['project_id'] for i in prompt_candidates}, totals,
          options.get('allow_removals') or 0, options.get('expect_mass_change'))
    for i in project_removed:
        old = old_projects[uuid.UUID(i)]
        definition = {**old['definition'], 'status': 'removed'}
        project_versions.append((uuid.UUID(i), old['version'] + 1, encoded(definition), digest(definition)))
    for i in prompt_removed:
        old = old_prompts[uuid.UUID(i)]
        definition = {**old['definition'], 'status': 'removed'}
        prompt_versions.append((uuid.UUID(i), old['version'] + 1, old['text'], encoded(definition), digest(definition, old['text'])))
    # Reference families: a whole family again only when it changed.
    sets = {r['family']: r for r in await data.fetch(CURRENT_SETS_SQL)}
    release = encoded(g['release'])
    new_sets, new_items = [], []
    for family, items in reference_items(g).items():
        sha = family_digest(items)
        if family in sets and sets[family]['sha256'] == sha:
            continue
        set_id = uuid.uuid4()
        source = 'hub' if family in ('surface', 'brand_bit', 'mention_type') else 'gold'
        new_sets.append((set_id, family, sets[family]['version'] + 1 if family in sets else 1, len(items), sha, source,
                         release if source == 'gold' else None))
        new_items += [(set_id, key, encoded(items[key])) for key in sorted(items)]
    counts['new_reference_sets'] = len(new_sets)
    # Batch writes keep a 28k prompt catalog from making 80k round trips.
    await data.executemany("INSERT INTO catalog.project(project_id,origin,source_id) VALUES($1,'gold',$1)", new_projects)
    await data.executemany('INSERT INTO catalog.project_version(project_id,version,definition,sha256) VALUES($1,$2,$3::jsonb,$4)', project_versions)
    await data.executemany("INSERT INTO catalog.prompt(prompt_id,project_id,origin,source_id) VALUES($1,$2,'gold',$1)", new_prompts)
    await data.executemany('INSERT INTO catalog.prompt_version(prompt_id,version,text,definition,sha256) VALUES($1,$2,$3,$4::jsonb,$5)', prompt_versions)
    await data.executemany('''INSERT INTO catalog.reference_set(set_id,family,version,item_count,sha256,source,source_release)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)''', new_sets)
    await data.executemany('INSERT INTO catalog.reference_item(set_id,item_key,definition) VALUES($1,$2,$3::jsonb)', new_items)
    return counts, {'projects': project_candidates, 'prompts': prompt_candidates}


async def finish(data, run_id, result, reason=None, **columns):
    sets = ','.join(f'{k}=${i + 4}::jsonb' for i, k in enumerate(columns))
    await data.execute(f'UPDATE catalog.sync_run SET finished_at=now(),result=$2,reason=$3{"," + sets if sets else ""} WHERE run_id=$1',
                       run_id, result, reason, *(encoded(v) for v in columns.values()))


async def main(config):
    source = data = operations = g = None
    run_id = uuid.uuid4()
    try:
        data = await asyncpg.connect(config['data'], command_timeout=120)
        if not await data.fetchval('SELECT pg_try_advisory_lock($1)', RUN_LOCK):
            raise RuntimeError('Another Gold import is running')
        previous = await data.fetchrow(PREVIOUS_RUN_SQL)
        await data.execute('INSERT INTO catalog.sync_run(run_id) VALUES($1)', run_id)
        try:
            source = await asyncpg.connect(os.environ['HGH_GOLD_DB_URL'], server_settings={'default_transaction_read_only': 'on',
                                                                                          'statement_timeout': '60000'})
            async with source.transaction(isolation='repeatable_read', readonly=True):
                g = await read_gold(source, os.environ.get('HGH_GOLD_RULE_SIGNATURE') or None)
            check_read(g, loaded(previous['gold_versions']) if previous else None)
            async with data.transaction():
                now = await data.fetchval('SELECT now()')
                counts, candidates = await record(data, g, previous, config, now)
        except Refused as refusal:
            await finish(data, run_id, 'refused', str(refusal), gold_versions=g and g['versions'])
            raise RuntimeError(f'Gold import refused, nothing recorded: {refusal}') from None
        except Exception as error:
            await finish(data, run_id, 'failed', type(error).__name__)
            raise
        # Data transaction commits first. A retry repairs an interrupted operations registration.
        # Only IDs actually present in the data catalog may be registered; no cross-DB integer keys.
        registered = await data.fetch('SELECT project_id FROM catalog.project')
        operations = await asyncpg.connect(config['operations'])
        async with operations.transaction():
            await operations.executemany('INSERT INTO system.project_reference(project_id) VALUES($1) ON CONFLICT DO NOTHING',
                                         [(r['project_id'],) for r in registered])
        counts['operations_project_references'] = len(registered)
        await finish(data, run_id, 'ok', gold_versions=g['versions'], gold_release=g['release'], counts=counts,
                     removal_candidates=candidates)
        print(encoded({'source': 'gold', 'run_id': run_id, 'release': g['release'], **counts}))
    finally:
        for conn in (source, data, operations):
            if conn is not None:
                await conn.close()
