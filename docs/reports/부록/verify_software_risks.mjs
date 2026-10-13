// Source-level reproductions. No app server, real DB, GA4, or network is used.
// Run: node --disable-warning=ExperimentalWarning reports/부록/verify_software_risks.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const repo = path.join(workspace, 'hmg-geo-hub-share');
const sources = {};
function read(name) {
  const text = fs.readFileSync(path.join(repo, name), 'utf8');
  sources[name] = createHash('sha256').update(text).digest('hex');
  return text;
}
function lines(name, first, last) {
  return read(name).split(/\r?\n/).slice(first - 1, last).join('\n');
}
function context(code, globals = {}) {
  const sandbox = vm.createContext({ console, ...globals });
  const ts = code.replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
  vm.runInContext(stripTypeScriptTypes(ts, { mode: 'strip' }), sandbox);
  return sandbox;
}
const get = (ctx, name) => vm.runInContext(name, ctx);
class HghApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const errorGlobals = {
  HghApiError,
  LOCAL_CODES: { pageLimit: 'mock_local_page_limit' },
  isCursorStale: e => e.code === 'cursor_stale',
};
const pagination = read('front/lib/hgh/paginate.ts');
const catalog = 'front/lib/hgh/adapters/catalog.ts';
const admin = 'front/lib/hgh/adapters/admin.ts';
const projects = 'front/lib/hgh/adapters/projects.ts';
const qa = 'front/app/[locale]/raw-data-qa/answers/[jobId]/_components/detail-shell.tsx';
const ga4 = 'front/lib/ga4/conversion.ts';
const checks = [];
async function check(id, title, fn) {
  const evidence = await fn();
  checks.push({ id, title, status: 'PASS', evidence });
  console.log(`PASS ${id}: ${title}`);
}

await check('R01', '표준 카탈로그: 10,001건 전량 반환', async () => {
  const calls = [];
  const c = context(pagination + '\n' + lines(catalog, 84, 87) + '\n' + lines(catalog, 91, 132), {
    ...errorGlobals,
    hghGet: async (url, opts) => {
      calls.push({ url, ...opts });
      return { data: { items: Array.from({ length: 10001 }, (_, i) => ({ prompt_id: String(i), text: `row ${i}`, kind: 'tracked' })) }, meta: { page: { next_cursor: null, total: 10001, limit: 25000 } } };
    },
  });
  const r = await get(c, 'listStandardCatalogApi')();
  assert.equal(calls[0].query.all, true);
  assert.equal(r.rows.length, 10001);
  const ui = read('front/app/[locale]/(dash)/standard/prompts/_components/prompt-list-readonly.tsx');
  assert.match(ui, /DEFAULT_PAGE_SIZE = 50/);
  assert.match(ui, /sorted\.slice\(\(safePage - 1\) \* pageSize, safePage \* pageSize\)/);
  return { fixtureRows: 10001, returnedRows: r.rows.length, apiCalls: calls.length, allParameter: true, uiDefaultPageSizeSource: 50, uiRenderedInBrowser: false };
});

async function catalogLimit(total, size, maxPages) {
  let calls = 0;
  const c = context(pagination, errorGlobals);
  try {
    const result = await get(c, 'fetchAllPages')(async cursor => {
      calls += 1;
      const offset = Number(cursor || 0);
      const count = Math.min(size, total - offset);
      return { items: Array.from({ length: count }, (_, i) => offset + i), nextCursor: offset + count < total ? String(offset + count) : null, total };
    }, { maxPages });
    return { calls, returnedRows: result.items.length, error: null };
  } catch (e) {
    return { calls, returnedRows: null, error: e.message, status: e.status, code: e.code };
  }
}
await check('R02', '관리자 목록: 10,000건 성공 / 10,001건 실패', async () => {
  const c = context(lines(admin, 421, 422));
  const size = get(c, 'CATALOG_PAGE_LIMIT'), cap = get(c, 'CATALOG_MAX_PAGES');
  const atLimit = await catalogLimit(10000, size, cap);
  const overLimit = await catalogLimit(10001, size, cap);
  assert.equal(atLimit.returnedRows, 10000);
  assert.equal(overLimit.calls, 20);
  assert.equal(overLimit.error, 'more than 20 pages');
  assert.equal(overLimit.status, 500);
  return { atLimit, overLimit, transport: 'synthetic page fetcher; real pagination helper and caller constants' };
});
await check('R03', '프로젝트 프롬프트 목록: 20,001건에서 실패', async () => {
  const c = context(lines(projects, 187, 194));
  const { limit, maxPages } = get(c, 'PAGE.prompts');
  const r = await catalogLimit(20001, limit, maxPages);
  assert.equal(r.calls, 40);
  assert.equal(r.error, 'more than 40 pages');
  return { fixtureRows: 20001, ...r };
});

await check('R04', 'QA 저장: 401·422·500을 무시하고 이전 savedAt 유지', async () => {
  let responseStatus = 200, networkError = false;
  const code = lines(qa, 115, 137).replace('useCallback(', '').replace(/, \[flags, jobId, readOnly, saving, router\]\);$/, ';') + '\n' + lines(qa, 175, 177);
  let c;
  c = context(code, {
    readOnly: false, saving: false, savedAt: null, flags: {}, jobId: 'fixture', lockLost: false, refreshes: 0,
    fetch: async () => { if (networkError) throw new Error('network down'); return { status: responseStatus, ok: responseStatus === 200 }; },
    setSaving: v => { c.saving = v; }, setSavedAt: v => { c.savedAt = v; },
    setReadOnly: v => { c.readOnly = v; }, setLockLost: v => { c.lockLost = v; },
    setFlags: fn => { c.flags = fn(c.flags); }, router: { refresh: () => { c.refreshes += 1; } },
  });
  await get(c, 'save')();
  const savedAt = c.savedAt;
  get(c, 'setFlag')('mentions', 'issue');
  assert.equal(c.savedAt, savedAt);
  const ignored = [];
  for (const status of [401, 422, 500]) {
    responseStatus = status;
    await get(c, 'save')();
    assert.equal(c.savedAt, savedAt);
    assert.equal(c.saving, false);
    assert.equal(c.readOnly, false);
    assert.equal(c.lockLost, false);
    ignored.push(status);
  }
  assert.equal(c.refreshes, 1);
  networkError = true;
  await assert.rejects(get(c, 'save')(), /network down/);
  const bar = read('front/app/[locale]/raw-data-qa/answers/[jobId]/_components/verdict-bar.tsx');
  assert.match(bar, /savedAt \? \(/);
  return { ignoredStatuses: ignored, savedIndicatorConditionStillTrue: Boolean(c.savedAt), refreshes: c.refreshes, networkErrorPropagatedWithoutLocalHandler: true, reactRenderingTested: false };
});

await check('R05', 'QA 잠금: 서버 500 응답 후에도 편집 가능 상태 유지', async () => {
  let c;
  c = vm.createContext({
    alive: true, jobId: 'fixture', readOnly: false, lockHolder: null,
    fetch: async () => ({ status: 500, json: async () => ({ error: 'database unavailable' }) }),
    setReadOnly: v => { c.readOnly = v; }, setLockHolder: v => { c.lockHolder = v; },
  });
  await vm.runInContext(stripTypeScriptTypes(lines(qa, 58, 74)), c);
  assert.equal(c.readOnly, false);
  return { lockHttpStatus: 500, readOnlyAfterResponse: c.readOnly, backendSaveLockProtection: 'separate; this test does not claim concurrent writes bypass the lock' };
});

await check('R06', '일괄 태깅: 1,001건 중 첫 1,000건 성공 후 두 번째 청크 실패', async () => {
  let calls = 0;
  const persisted = [];
  const code = lines(projects, 197, 197) + '\n' + lines(projects, 763, 770) + '\n' + lines(projects, 1521, 1546);
  const c = context(code, {
    hghPost: async (url, options) => {
      calls += 1;
      if (calls === 2) throw new Error('second chunk rejected');
      persisted.push(...options.body.prompt_ids);
      return { data: { count: options.body.prompt_ids.length } };
    },
    run: async fn => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e.message }; } },
  });
  const r = await get(c, 'setPromptCustomFieldValueBulk')('project', Array.from({ length: 1001 }, (_, i) => String(i)), 'field', 'EV');
  assert.equal(calls, 2);
  assert.equal(persisted.length, 1000);
  assert.equal(r.ok, false);
  assert.equal(r.value, undefined);
  const actions = read('front/app/[locale]/(dash)/projects/[id]/prompt/_actions.ts');
  assert.match(actions, /if \(r\.ok\) revalidatePath\(`\/projects\/\$\{projectId\}\/prompt`\)/);
  return { selectedRows: 1001, mockCommittedRows: persisted.length, apiCalls: calls, returned: r, realDatabaseUsed: false };
});

await check('R07', 'GA4 설정 DB 장애: 선택 이벤트 2건 → 기본 keyEvents 12건', async () => {
  let failDb = false, calls = 0;
  const c = context(lines(ga4, 243, 325), {
    ga4TrackedEventRepository: { listForProperty: async () => { if (failDb) throw new Error('DB down'); return ['test_drive']; } },
    toFilter: expressions => expressions.length ? { andGroup: { expressions } } : undefined,
    num: value => Number(value ?? 0),
    runReport: async (id, query) => {
      calls += 1;
      return { rows: [{ dimensionValues: [], metricValues: query.metrics[0].name === 'eventCount' ? [{ value: '2' }] : [{ value: '20' }, { value: '12' }] }] };
    },
  });
  const readCount = async () => {
    const spec = await get(c, 'resolveConvSpec')('fixture');
    const map = await get(c, 'fetchCohortMap')('fixture', { start: '2026-09-01', end: '2026-09-28' }, [], [], undefined, spec);
    return { spec, ...map.get('') };
  };
  const healthy = await readCount();
  failDb = true;
  const failedConfig = await readCount();
  assert.equal(healthy.keyEvents, 2);
  assert.equal(failedConfig.keyEvents, 12);
  assert.equal(failedConfig.spec, null);
  return { healthy, failedConfig, reportCalls: calls, note: 'Counts are synthetic. This verifies switching the numerator, not production GA4 values.' };
});

await check('R08', 'GA4 지역 집계: 일부·전부 실패해도 정상 반환, 캐시 TTL 86,400초', async () => {
  let failAll = false;
  const warnings = [], cacheOptions = [];
  const c = context(lines(ga4, 11, 12) + '\n' + lines(ga4, 539, 645), {
    ga4TrackedEventRepository: { listForProperties: async () => new Map() },
    dateNDaysAgo: () => ({ start: '2026-09-01', end: '2026-09-28' }),
    fetchCohorts: async id => {
      if (id === 'B' || failAll) throw new Error('GA4 timeout');
      return { ai: { users: 10, keyEvents: 2 }, total: { users: 30, keyEvents: 4 } };
    },
    pct: (n, d) => d ? Math.round(n / d * 1000) / 10 : 0,
    filterKey: () => '',
    console: { warn: (...args) => warnings.push(args.join(' ')) },
    // Observe the callback result/options; deliberately do NOT simulate Next's cache lifecycle.
    unstable_cache: (fn, keys, options) => { cacheOptions.push(options); return fn; },
  });
  const markets = [{ brand: 'brand', country: 'AA', propertyId: 'A' }, { brand: 'brand', country: 'BB', propertyId: 'B' }];
  const partial = await get(c, 'getAiTrafficConversionRollup')(markets);
  failAll = true;
  const failedAll = await get(c, 'getAiTrafficConversionRollup')(markets);
  assert.equal(partial.measuredMarkets, 1);
  assert.equal(partial.totalMarkets, 2);
  assert.equal(failedAll.measuredMarkets, 0);
  assert.equal(failedAll.totalAiUsers, 0);
  assert.equal(cacheOptions[0].revalidate, 86400);
  return { partial, failedAll, cacheRevalidateSeconds: cacheOptions[0].revalidate, warningCount: warnings.length, actualNextCacheLifecycleTested: false };
});

await check('R09', '관리자 조회: 500 응답을 빈 배열로 축소, 인증 오류는 다시 throw', async () => {
  const warnings = [];
  const c = context(lines(admin, 193, 198), {
    isHghApiError: e => e instanceof HghApiError,
    LOCAL_FAULTS: new Set(['mock_local_page_limit']),
    describeHghError: e => `${e.status} ${e.message}`,
    console: { warn: message => warnings.push(message) },
  });
  const result = get(c, 'degradeRead')(new HghApiError(500, 'upstream_error', 'database unavailable'), []);
  assert.equal(result.length, 0);
  assert.equal(warnings.length, 1);
  assert.throws(() => get(c, 'degradeRead')(new HghApiError(401, 'unauthorized', 'unauthorized'), []));
  return { backendStatus: 500, returnedRows: result.length, serverWarnings: warnings.length, authErrorsRethrown: true, note: 'Silent to the page user; API path does retain a server warning.' };
});

await check('R10', '키워드 캐시: 일시적 DB 오류 후 복구되어도 캐시 재사용 중단', async () => {
  const evidence = [];
  for (const failedOperation of ['get', 'set']) {
    let unavailable = true, reads = 0, writes = 0, computes = 0;
    const warnings = [];
    const c = context(lines('front/lib/keyword/cache.ts', 8, 44) + '\n' + lines('front/lib/keyword/insight.ts', 120, 135), {
      keywordCacheRepository: {
        get: async () => { reads++; if (unavailable && failedOperation === 'get') throw new Error('temporary DB failure'); return unavailable ? null : { recoveredCachedValue: true }; },
        set: async () => { writes++; if (unavailable && failedOperation === 'set') throw new Error('temporary DB failure'); },
      },
      cacheKey: (...args) => args.join('|'),
      computeKeywordInsight: async () => ({ computation: ++computes }),
      console: { warn: (...args) => warnings.push(args.join(' ')) },
    });
    await get(c, 'getKeywordInsight')('fixture', 2840, 'en');
    unavailable = false;
    await get(c, 'getKeywordInsight')('fixture', 2840, 'en');
    await get(c, 'getKeywordInsight')('fixture', 2840, 'en');
    assert.equal(reads, 1);
    assert.equal(writes, failedOperation === 'set' ? 1 : 0);
    assert.equal(computes, 3);
    assert.equal(warnings.length, 1);
    evidence.push({ failedOperation, repositoryReads: reads, repositoryWrites: writes, repeatedComputations: computes, databaseRecoveredAfterFirstRequest: true });
  }
  return evidence;
});

await check('R11', 'GA4 runReport: 응답 지연 시 자체 timeout·취소 signal 없음', async () => {
  let release, options;
  const pending = new Promise(resolve => { release = resolve; });
  const c = context(lines('front/lib/ga4/client.ts', 19, 48), {
    getGa4AccessToken: async () => 'synthetic-token',
    fetch: async (url, opts) => { options = opts; return pending; },
    setTimeout,
  });
  const request = get(c, 'runReport')('fixture', {});
  const outcome = await Promise.race([
    request.then(() => 'completed'),
    new Promise(resolve => setTimeout(() => resolve('still-pending-at-test-watchdog'), 20)),
  ]);
  assert.equal(options.signal, undefined);
  assert.equal(outcome, 'still-pending-at-test-watchdog');
  release({ ok: true, json: async () => ({ rows: [] }) });
  await request;
  return { fetchSignalProvided: false, testWatchdogMs: 20, outcome, releasedAndCompletedAfterObservation: true, note: 'Synthetic pending fetch. This does not measure real provider latency or override platform/network timeouts.' };
});

const output = {
  createdAt: new Date().toISOString(), nodeVersion: process.version,
  method: 'Unmodified source fragments executed after Node TypeScript type stripping; external dependencies are mocks. Static checks connect handlers to UI. Not E2E, load, production DB, or live network testing.',
  scope: 'hmg-geo-hub-share, local source snapshot',
  summary: { total: checks.length, passed: checks.length },
  checks, sourceSha256: sources,
};
fs.writeFileSync(path.join(workspace, 'reports/부록/GEO 소프트웨어 점검 재현.json'), JSON.stringify(output, null, 2) + '\n', 'utf8');
console.log(`Wrote ${checks.length} passing reproductions.`);
