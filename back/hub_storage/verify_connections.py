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
    # Saved filter role: system.saved_filter on the operations server only.
    saved = await asyncpg.connect(config['saved_filter'], timeout=5)
    try:
        await saved.fetchval('SELECT count(*) FROM system.saved_filter')
        try:
            await saved.execute('SELECT 1 FROM system.user_credential LIMIT 1')
        except asyncpg.InsufficientPrivilegeError:
            pass
        else:
            raise AssertionError('Saved filter role reads beyond system.saved_filter')
    finally:
        await saved.close()
    try:
        forbidden = await asyncpg.connect(config['saved_filter_data'], timeout=5)
    except asyncpg.InvalidAuthorizationSpecificationError:
        pass
    else:
        await forbidden.close()
        raise AssertionError('Saved filter credentials can connect to the data DB')
    # Account role: the account tables on the operations server only.
    account = await asyncpg.connect(config['account'], timeout=5)
    try:
        await account.fetchval('SELECT count(*) FROM system.global_role')
        try:
            await account.execute('SELECT 1 FROM system.saved_filter LIMIT 1')
        except asyncpg.InsufficientPrivilegeError:
            pass
        else:
            raise AssertionError('Account role reads beyond the account tables')
    finally:
        await account.close()
    try:
        forbidden = await asyncpg.connect(config['account_data'], timeout=5)
    except asyncpg.InvalidAuthorizationSpecificationError:
        pass
    else:
        await forbidden.close()
        raise AssertionError('Account credentials can connect to the data DB')
    # GA4 registry role: the registry tables on the data server only.
    registry = await asyncpg.connect(config['ga4_registry'], timeout=5)
    try:
        await registry.fetchval('SELECT count(*) FROM analytics.ga4_registry')
        try:
            await registry.execute('SELECT 1 FROM analytics.ga4_row LIMIT 1')
        except asyncpg.InsufficientPrivilegeError:
            pass
        else:
            raise AssertionError('GA4 registry role reads beyond the registry tables')
    finally:
        await registry.close()
    try:
        forbidden = await asyncpg.connect(config['ga4_registry_operations'], timeout=5)
    except asyncpg.InvalidAuthorizationSpecificationError:
        pass
    else:
        await forbidden.close()
        raise AssertionError('GA4 registry credentials can connect to the operations DB')
    # Source correction role: the correction tables on the data server only.
    override = await asyncpg.connect(config['source_override'], timeout=5)
    try:
        await override.fetchval('SELECT count(*) FROM catalog.source_override')
        try:
            await override.execute('SELECT 1 FROM catalog.prompt LIMIT 1')
        except asyncpg.InsufficientPrivilegeError:
            pass
        else:
            raise AssertionError('Source correction role reads beyond the correction tables')
    finally:
        await override.close()
    try:
        forbidden = await asyncpg.connect(config['source_override_operations'], timeout=5)
    except asyncpg.InvalidAuthorizationSpecificationError:
        pass
    else:
        await forbidden.close()
        raise AssertionError('Source correction credentials can connect to the operations DB')
    print(json.dumps({'tcp_authentication':'passed','external_operations_access':'denied','api_operations_reader':'read_only',
                      'ext_api':'scoped_read_only','ext_operations_access':'denied','saved_filter':'one_table',
                      'saved_filter_data_access':'denied','account':'account_tables','account_data_access':'denied',
                      'ga4_registry':'registry_tables','ga4_registry_operations_access':'denied',
                      'source_override':'correction_tables','source_override_operations_access':'denied'}))
