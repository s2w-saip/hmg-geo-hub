"""Authenticate over TCP to verify real credentials and server separation."""
import asyncio
import json

import asyncpg


async def main(config):
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
        for view in ('caller', 'meta', 'codes', 'projects', 'prompts', 'reference_sets', 'reference_items'):
            assert await ext.fetchval(f'SELECT count(*) FROM ext.{view}') == 0, f'ext.{view} answers without a key'
        for query in ('SELECT 1 FROM catalog.prompt LIMIT 1', 'SELECT 1 FROM publication.api_key LIMIT 1'):
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
    # The input store's API reader and measurement editor; the metrics store's reader and cache role.
    reader = await asyncpg.connect(config['input_reader'], timeout=5)
    try:
        assert await reader.fetchval('SHOW transaction_read_only') == 'on'
        await reader.fetchval('SELECT count(*) FROM catalog.current_measurement')
        await reader.fetchval('SELECT count(*) FROM catalog.reference_source')
    finally:
        await reader.close()
    measurement = await asyncpg.connect(config['measurement'], timeout=5)
    try:
        await measurement.fetchval('SELECT count(*) FROM catalog.current_measurement')
        try:
            await measurement.execute('SELECT 1 FROM catalog.entity_role LIMIT 1')
        except asyncpg.InsufficientPrivilegeError:
            pass
        else:
            raise AssertionError('Measurement editor reads beyond its tables')
    finally:
        await measurement.close()
    try:
        forbidden = await asyncpg.connect(config['measurement_operations'], timeout=5)
    except asyncpg.InvalidAuthorizationSpecificationError:
        pass
    else:
        await forbidden.close()
        raise AssertionError('Measurement editor credentials can connect to the operations DB')
    metrics = await asyncpg.connect(config['metrics_reader'], timeout=5)
    try:
        assert await metrics.fetchval('SHOW transaction_read_only') == 'on'
        await metrics.fetchval('SELECT 1 FROM gold.metric_row LIMIT 1')
    finally:
        await metrics.close()
    cache = await asyncpg.connect(config['cache_writer'], timeout=5)
    try:
        await cache.fetchval('SELECT count(*) FROM cache.query_result')
    finally:
        await cache.close()
    try:
        forbidden = await asyncpg.connect(config['cache_writer_input'], timeout=5)
    except asyncpg.InvalidAuthorizationSpecificationError:
        pass
    else:
        await forbidden.close()
        raise AssertionError('Cache credentials can connect to the input store')
    # Gold and the cache DB share a server: each role reaches its own database only.
    for name, problem in (('cache_writer_gold', 'Cache credentials can connect to Gold'), ('metrics_reader_cache', 'The Gold reader can connect to the cache DB'),
                          ('rollup_cache', 'Rollup credentials can connect to the cache DB')):
        try:
            forbidden = await asyncpg.connect(config[name], timeout=5)
        except asyncpg.InsufficientPrivilegeError:
            pass
        else:
            await forbidden.close()
            raise AssertionError(problem)
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
    # GA4 registry role: the registry tables on the data server only.
    registry = await asyncpg.connect(config['ga4_registry'], timeout=5)
    try:
        await registry.fetchval('SELECT count(*) FROM catalog.ga4_registry')
        try:
            await registry.execute('SELECT 1 FROM catalog.prompt LIMIT 1')
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
        await override.fetchval('SELECT count(*) FROM catalog.source_seed')  # 008: the source lists, same role
        await override.fetchval('SELECT count(*) FROM catalog.source_seed_version')  # 013: their versions, read only
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
    # Customer-interest role: its two lists on the data server only.
    interest = await asyncpg.connect(config['interest'], timeout=5)
    try:
        await interest.fetchval('SELECT count(*) FROM catalog.interest_keyword')
        await interest.fetchval('SELECT count(*) FROM catalog.interest_source')
        try:
            await interest.execute('SELECT 1 FROM catalog.source_override LIMIT 1')
        except asyncpg.InsufficientPrivilegeError:
            pass
        else:
            raise AssertionError('Customer-interest role reads beyond its lists')
    finally:
        await interest.close()
    try:
        forbidden = await asyncpg.connect(config['interest_operations'], timeout=5)
    except asyncpg.InvalidAuthorizationSpecificationError:
        pass
    else:
        await forbidden.close()
        raise AssertionError('Customer-interest credentials can connect to the operations DB')
    # Entity role editor: its two tables on the data server only.
    entity_role = await asyncpg.connect(config['entity_role'], timeout=5)
    try:
        await entity_role.fetchval('SELECT count(*) FROM catalog.entity_role')
        try:
            await entity_role.execute('SELECT 1 FROM catalog.interest_keyword LIMIT 1')
        except asyncpg.InsufficientPrivilegeError:
            pass
        else:
            raise AssertionError('Entity role editor reads beyond its tables')
    finally:
        await entity_role.close()
    try:
        forbidden = await asyncpg.connect(config['entity_role_operations'], timeout=5)
    except asyncpg.InvalidAuthorizationSpecificationError:
        pass
    else:
        await forbidden.close()
        raise AssertionError('Entity role credentials can connect to the operations DB')
    # Project editor (Project › Prompt): the project catalog on the data server only.
    project_editor = await asyncpg.connect(config['project_editor'], timeout=5)
    try:
        await project_editor.fetchval('SELECT count(*) FROM catalog.current_prompt')
        try:
            await project_editor.execute('SELECT 1 FROM catalog.entity_role LIMIT 1')
        except asyncpg.InsufficientPrivilegeError:
            pass
        else:
            raise AssertionError('Project editor reads beyond the project catalog')
    finally:
        await project_editor.close()
    try:
        forbidden = await asyncpg.connect(config['project_editor_operations'], timeout=5)
    except asyncpg.InvalidAuthorizationSpecificationError:
        pass
    else:
        await forbidden.close()
        raise AssertionError('Project editor credentials can connect to the operations DB')
    # Service week job role (manage.py sync-service-week): its table on the data server only.
    week_writer = await asyncpg.connect(config['service_week'], timeout=5)
    try:
        await week_writer.fetchval('SELECT count(*) FROM catalog.current_service_week')
        try:
            await week_writer.execute('SELECT 1 FROM catalog.prompt LIMIT 1')
        except asyncpg.InsufficientPrivilegeError:
            pass
        else:
            raise AssertionError('Service week role reads beyond its table')
    finally:
        await week_writer.close()
    try:
        forbidden = await asyncpg.connect(config['service_week_operations'], timeout=5)
    except asyncpg.InvalidAuthorizationSpecificationError:
        pass
    else:
        await forbidden.close()
        raise AssertionError('Service week credentials can connect to the operations DB')
    print(json.dumps({'tcp_authentication':'passed','external_operations_access':'denied','api_operations_reader':'read_only',
                      'input_reader':'read_only','measurement':'its_tables','metrics_reader':'read_only','cache':'cache_table','cache_input_access':'denied','gold_cache_separation':'denied',
                      'ext_api':'scoped_read_only','ext_operations_access':'denied','saved_filter':'one_table',
                      'saved_filter_data_access':'denied','account':'account_tables','account_data_access':'denied',
                      'ga4_registry':'registry_tables','ga4_registry_operations_access':'denied',
                      'source_override':'correction_tables','source_override_operations_access':'denied',
                      'interest':'interest_lists','interest_operations_access':'denied',
                      'entity_role':'role_tables','entity_role_operations_access':'denied',
                      'project_editor':'project_catalog','project_editor_operations_access':'denied',
                      'service_week':'service_week_table','service_week_operations_access':'denied'}))
