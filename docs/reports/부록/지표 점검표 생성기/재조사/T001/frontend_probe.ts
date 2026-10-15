// Run a temporary copy under front/test with Vitest. GEO_TOPIC_AUDIT_OUT points here.
// These probes document the inspected revision; they do not prescribe desired behavior.
import { it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { PGlite } from '@electric-sql/pglite';
import { buildTrendStatements } from '@/lib/db/repositories/summary-trend-aggregates';
import { S1_STATEMENT_KEYS, S1_TREND_AXES, S1_TREND_LIMITS } from '@/lib/db/repositories/summary-global-aggregates';
import { OWN_VARIANT_ALL } from '@/lib/summary/generate/fold';
import { marketMetrics } from '@/app/[locale]/(dash)/dashboard/_data/overview-metrics';
import { toLiveGeo } from '@/lib/hgh/adapters/dashboard';

const out = process.env.GEO_TOPIC_AUDIT_OUT!;
const save = (name: string, data: unknown) => writeFileSync(join(out, name), JSON.stringify(data, null, 2) + '\n');

it('T001: capture expanded legacy S1 SQL shared with GEO', () => {
  const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;
  const set = { surface: 'global' as const, mode: 'snapshot' as const,
    cycles: [{ cycleId: uuid(1), generationId: uuid(2), projectId: uuid(3),
      cycleAnchorAt: '2026-08-31T00:00:00.000Z', cycleWeek: '2026-08-31' }],
    cycleKey: `${uuid(1)}:${uuid(2)}`, projectIds: [uuid(3)], missingProjectIds: [], weeks: ['2026-08-31'], anchorCount: 1 };
  const dialect = new PgDialect();
  const statements = buildTrendStatements({ set, filters: {}, ownVariant: OWN_VARIANT_ALL,
    ownedBasePrefixes: ['https://www.kia.com/'], limits: S1_TREND_LIMITS, axes: S1_TREND_AXES },
    { only: S1_STATEMENT_KEYS }).map(s => ({ key: s.key, table: s.table, ...dialect.sqlToQuery(s.sql) }));
  expect(statements.map(s => s.key)).toEqual(['own', 'brands', 'domains']);
  save('legacy_sql.json', { assumptions: 'S1 summary path; synthetic snapshot; no user filters; NOT a deployed-path observation', statements });
});

it('T001: distinguish original textual position from renewed competitive rank', async () => {
  const db = new PGlite();
  try {
    // One synthetic answer: Toyota occurs at textual position 3; Kia at position 7.
    await db.exec(`CREATE TEMP TABLE _ig_ab(answer_key int, brand_key int, competitive boolean,
      own_bit int, tp real, rk int DEFAULT 0);
      INSERT INTO _ig_ab VALUES (1, 1, true, 0, 3, 0), (1, 2, true, 2, 7, 0);`);
    const ingest = readFileSync(resolve('../back/ingest/project/apply/queries.py'), 'utf8');
    const update = ingest.slice(ingest.indexOf('UPDATE _ig_ab a SET rk = x.rk'), ingest.indexOf('CREATE UNIQUE INDEX ON _ig_ab'));
    expect(update).toContain('rank() OVER');
    await db.exec(update);
    const ownRankExpression = ingest.match(/coalesce\(min\(rk\) FILTER \(WHERE own_bit = 2 AND rk > 0\), 0\)::int2 AS own_rk_k/)![0];
    const rank = Number((await db.query(`SELECT ${ownRankExpression} FROM _ig_ab`)).rows[0].own_rk_k);

    const captured = JSON.parse(readFileSync(join(out, 'backend_sql.json'), 'utf8'));
    const q = captured.queries.find((x: any) => x.profile === 'off' && x.mode === 'brand' && x.statement === 'main');
    const cols = [...new Set<string>(q.sql.match(/\ba\.[a-z_]+\b/g).map((s: string) => s.slice(2)))];
    const bools = new Set(['std_in', 'cit_in', 'dflt']);
    await db.exec(`CREATE SCHEMA rd; CREATE TABLE rd.answer (${cols.map(c => `${c} ${c === 'round_date' ? 'date' : bools.has(c) ? 'boolean' : 'int'}`).join(', ')});`);
    const values = cols.map(c => c === 'round_date' ? "'2026-09-14'" : bools.has(c) ? 'true' :
      String(({ own_rk_k: rank, cyc_key: 11, bgrp: 2, own_mask: 2 } as Record<string, number>)[c] ?? 1));
    await db.exec(`INSERT INTO rd.answer (${cols.join(',')}) VALUES (${values.join(',')});`);
    const params: unknown[] = [];
    const sql = q.sql.replace(/(?<!:):([a-zA-Z_]\w*)/g, (_: string, k: string) => { params.push(q.params[k]); return `$${params.length}`; });
    const counts: any = (await db.query(sql, params)).rows[0];
    const legacy = marketMetrics([
      { code: 'DE', brand: 'Kia', isTracked: true, mentions: 1, answers: 1, posSum: 7, posCnt: 1, sentPositive: 1, sentTotal: 1 },
      { code: 'DE', brand: 'Toyota', isTracked: false, mentions: 1, answers: 1, posSum: 3, posCnt: 1, sentPositive: 1, sentTotal: 1 },
    ], { answers: 1, ownAnswers: 1, citTotal: 1, citOwned: 1 }, new Set(['Kia']));
    const row = { answers: 1, own: { visibility: null, share_of_voice: null, sentiment: null, citation_share: null,
      position: { sum: Number(counts.rank_sum), count: Number(counts.ranked) } },
      rank: { our: 1, field_size: 1 }, top_own_brand: null, top_rival: null };
    const renewed = toLiveGeo({ active_brand: 'Kia', own_label: 'Kia', pending: [],
      markets: [{ ...row, region_id: 'kia-western-europe', region_label: 'Europe', country_count: 1,
        countries: [{ ...row, code: 'DE' }] }] });
    const current = renewed.markets[0].countries[0].metrics!.position.ours;
    expect(legacy.position.ours).toBe(7);
    expect(rank).toBe(2);
    expect(current).toBe(2);
    save('position_counterexample.json', {
      kind: 'synthetic counterexample, not production observation',
      input: { answerCount: 1, textualPositions: { Toyota: 3, Kia: 7 }, perspective: 'Kia', country: 'DE' },
      executed: ['actual ingestion rank UPDATE', 'actual generated core.measure plan_counts main SQL', 'actual frontend marketMetrics and toLiveGeo'],
      before: legacy.position.ours, after: current,
      limitations: 'No production data, full ingestion pipeline, frozen-view execution, or HTTP endpoint was used.'
    });
  } finally { await db.close(); }
}, 30000);
