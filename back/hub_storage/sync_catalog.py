"""Idempotent Gold definition import. Invoked inside the API image with transient credentials."""
import asyncio
import hashlib
import json
import os

import asyncpg


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), default=str)


def revision(previous, identity, definition, text=None):
    payload = encoded(definition)
    digest = hashlib.sha256(encoded({'definition': definition, 'text': text}).encode()).hexdigest()
    if previous and previous['sha256'] == digest:
        return None
    number = previous['version'] + 1 if previous else 1
    return (identity,number,text,payload,digest) if text is not None else (identity,number,payload,digest)


async def main(config):
    source = data = operations = None
    try:
        source = await asyncpg.connect(os.environ['HGH_GOLD_DB_URL'], server_settings={'default_transaction_read_only':'on','statement_timeout':'15000'})
        async with source.transaction(isolation='repeatable_read', readonly=True):
            projects = [dict(r) for r in await source.fetch('''SELECT coalesce(p.project_id,p.scope_project_id,p.site_id) AS id,
                p.scope_project_id,p.project_id AS source_project_id,p.site_id,p.surface,p.is_root,p.site_brand_bit,c.code AS country,p.regions
                FROM gold.dim_project p LEFT JOIN gold.dim_country c ON c.geo_key=p.site_geo_key ORDER BY p.project_key''')]
            prompts = [dict(r) for r in await source.fetch('''SELECT p.prompt_id AS id,
                coalesce(d.project_id,d.scope_project_id,d.site_id) AS project_id,p.text,p.surface,p.kind,l.code AS language,
                p.regions,p.targets,p.in_root_catalog,p.in_project_catalog,p.web_reg,p.rule_ver,
                f.code AS funnel,pr.code AS brand_presence,lt.code AS list_type,
                d1.code AS depth1,d2.code AS depth2,d3.code AS depth3,d4.code AS depth4
                FROM gold.dim_prompt p JOIN gold.dim_project d USING(project_key)
                LEFT JOIN gold.dim_lang l USING(lang_key)
                LEFT JOIN gold.dim_taxon f ON f.taxon_key=p.funnel_key
                LEFT JOIN gold.dim_taxon pr ON pr.taxon_key=p.presence_key
                LEFT JOIN gold.dim_taxon lt ON lt.taxon_key=p.list_type_key
                LEFT JOIN gold.dim_taxon d1 ON d1.taxon_key=p.depth1_key
                LEFT JOIN gold.dim_taxon d2 ON d2.taxon_key=p.depth2_key
                LEFT JOIN gold.dim_taxon d3 ON d3.taxon_key=p.depth3_key
                LEFT JOIN gold.dim_taxon d4 ON d4.taxon_key=p.depth4_key ORDER BY p.prompt_key''')]
        ids = {row['id'] for row in projects}
        if None in ids or any(p['id'] is None for p in prompts) or len(ids) != len(projects) or len({p['id'] for p in prompts}) != len(prompts):
            raise ValueError('Gold project/prompt UUIDs must be present and unique; import cancelled')
        if any(p['project_id'] not in ids or p['text'] is None for p in prompts):
            raise ValueError('Gold prompt reference/text is missing; import cancelled')
        data = await asyncpg.connect(config['data'], command_timeout=60)
        async with data.transaction():
            await data.execute('SELECT pg_advisory_xact_lock(617427413)')
            # Batch reads/writes keep a 28k prompt catalog from making 80k round trips.
            old_projects = {r['project_id']:r for r in await data.fetch('''SELECT p.*,v.version,v.sha256
                FROM catalog.project p LEFT JOIN LATERAL (SELECT version,sha256 FROM catalog.project_version
                WHERE project_id=p.project_id ORDER BY version DESC LIMIT 1) v ON true''')}
            old_prompts = {r['prompt_id']:r for r in await data.fetch('''SELECT p.*,v.version,v.sha256
                FROM catalog.prompt p LEFT JOIN LATERAL (SELECT version,sha256 FROM catalog.prompt_version
                WHERE prompt_id=p.prompt_id ORDER BY version DESC LIMIT 1) v ON true''')}
            new_projects, new_prompts, project_versions, prompt_versions = [], [], [], []
            for row in projects:
                identity = row.pop('id')
                row['name'] = None  # Gold does not supply a project display name.
                existing = old_projects.get(identity)
                if existing and (existing['origin'] != 'gold' or existing['source_id'] != identity):
                    raise ValueError('Catalog identity collision; HUB-owned definitions were not overwritten')
                if existing is None:
                    new_projects.append((identity,))
                pending = revision(existing if existing and existing['version'] else None,identity,row)
                if pending:
                    project_versions.append(pending)
            for row in prompts:
                identity, project_id, text = row.pop('id'), row.pop('project_id'), row.pop('text')
                existing = old_prompts.get(identity)
                if existing and (existing['origin'] != 'gold' or existing['source_id'] != identity or existing['project_id'] != project_id):
                    raise ValueError('Prompt identity/ownership changed; import cancelled')
                if existing is None:
                    new_prompts.append((identity,project_id))
                pending = revision(existing if existing and existing['version'] else None,identity,row,text)
                if pending:
                    prompt_versions.append(pending)
            await data.executemany("INSERT INTO catalog.project(project_id,origin,source_id) VALUES($1,'gold',$1)", new_projects)
            await data.executemany('INSERT INTO catalog.project_version(project_id,version,definition,sha256) VALUES($1,$2,$3::jsonb,$4)', project_versions)
            await data.executemany("INSERT INTO catalog.prompt(prompt_id,project_id,origin,source_id) VALUES($1,$2,'gold',$1)", new_prompts)
            await data.executemany('INSERT INTO catalog.prompt_version(prompt_id,version,text,definition,sha256) VALUES($1,$2,$3,$4::jsonb,$5)', prompt_versions)
        # Data transaction commits first. A retry repairs an interrupted operations registration.
        # Only IDs actually present in the data catalog may be registered; no cross-DB integer keys.
        registered = await data.fetch('SELECT project_id FROM catalog.project')
        operations = await asyncpg.connect(config['operations'])
        async with operations.transaction():
            await operations.executemany('INSERT INTO system.project_reference(project_id) VALUES($1) ON CONFLICT DO NOTHING', [(r['project_id'],) for r in registered])
        print(encoded({'source':'gold','projects':len(projects),'prompts':len(prompts),
                       'new_project_versions':len(project_versions),'new_prompt_versions':len(prompt_versions),'operations_project_references':len(registered)}))
    finally:
        for conn in (source, data, operations):
            if conn is not None:
                await conn.close()
