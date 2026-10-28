"""Authenticate over TCP to verify real credentials and server separation."""
import asyncio
import json

import asyncpg


async def main(config):
    external = await asyncpg.connect(config['external'], timeout=5)
    try:
        assert await external.fetchval('SHOW transaction_read_only') == 'on'
        for view in ('projects','prompts','ga4_daily','ga4_users_window','ga4_values','ga4_properties',
                     'seo_visibility_daily','seo_crawl_daily','seo_device_daily','seo_priority',
                     'urls','countries','engines','crawl_bots'):
            await external.fetchval(f'SELECT count(*) FROM published.{view}')
        # Even overriding the default read-only transaction cannot bypass grants.
        async with external.transaction(readonly=False):
            await external.execute('SET TRANSACTION READ WRITE')
            for query in ('SELECT * FROM catalog.project', 'SELECT * FROM analytics.ga4_row',
                          'CREATE TABLE published.forbidden_tcp(id int)'):
                try:
                    async with external.transaction():
                        await external.execute(query)
                except asyncpg.InsufficientPrivilegeError:
                    pass
                else:
                    raise AssertionError('External access boundary failed')
    finally:
        await external.close()
    try:
        forbidden = await asyncpg.connect(config['external_operations'], timeout=5)
    except asyncpg.InvalidAuthorizationSpecificationError:
        pass
    else:
        await forbidden.close()
        raise AssertionError('Data external credentials can connect to operations DB')
    reader = await asyncpg.connect(config['operations_reader'], timeout=5)
    try:
        assert await reader.fetchval('SHOW transaction_read_only') == 'on'
        await reader.fetchval('SELECT count(*) FROM system.project_reference')
    finally:
        await reader.close()
    # External API role: read-only, the ext views and nothing else; without a key they are empty.
    ext = await asyncpg.connect(config['ext'], timeout=5)
    try:
        assert await ext.fetchval('SHOW transaction_read_only') == 'on'
        for view in ('caller', 'meta', 'projects', 'prompts', 'reference_sets', 'reference_items'):
            assert await ext.fetchval(f'SELECT count(*) FROM ext.{view}') == 0, f'ext.{view} answers without a key'
        for query in ('SELECT 1 FROM catalog.prompt LIMIT 1', 'SELECT 1 FROM publication.api_key LIMIT 1',
                      'SELECT 1 FROM published.projects LIMIT 1'):
            try:
                await ext.execute(query)
            except asyncpg.InsufficientPrivilegeError:
                pass
            else:
                raise AssertionError('External API role reads beyond ext')
    finally:
        await ext.close()
    try:
        forbidden = await asyncpg.connect(config['ext_operations'], timeout=5)
    except asyncpg.InvalidAuthorizationSpecificationError:
        pass
    else:
        await forbidden.close()
        raise AssertionError('External API credentials can connect to operations DB')
    print(json.dumps({'tcp_authentication':'passed','external_operations_access':'denied','api_operations_reader':'read_only',
                      'ext_api':'scoped_read_only','ext_operations_access':'denied'}))
