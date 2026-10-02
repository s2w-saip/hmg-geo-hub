/**
 * Citation-categorizer seed curation helper (review queue).
 *
 *   npx tsx --env-file=.env.local scripts/citations/seed-curation.ts [limit]
 *
 * Lists the top cited domains (from the scope_* mirror) that today resolve to
 * the "Other" fallback — i.e. not covered by an operator override, the
 * geo-catalog owned set, the curated seed, or the generic rules — plus
 * cumulative-coverage stats. Curate the output into
 * lib/citation-categorizer/seed.json, re-run to verify coverage. Read-only.
 *
 * The domain-weight query and the per-row verdict come from the shared
 * curation module (lib/citation-categorizer/curation.ts), which the admin
 * screen's repository uses too — script and screen see the same population and
 * the same classification. Direct postgres here (no repository): repositories
 * import `server-only`, which only Next/vitest resolve — tsx cannot.
 */
import postgres from "postgres";
import { FALLBACK_CATEGORY, isCitationCategory } from "@/lib/citation-categorizer";
import {
  CITATION_DOMAIN_WEIGHT_SQL,
  buildCurationRows,
  type CurationOverrideMeta,
} from "@/lib/citation-categorizer/curation";

async function main() {
  const limit = Number(process.argv[2] ?? 400);
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const rows = await sql.unsafe<{ domain: string; citations: number }[]>(
    CITATION_DOMAIN_WEIGHT_SQL,
  );
  // 오버라이드 테이블은 마이그레이션 0043 이후에만 존재한다 — 없으면 오버라이드
  // 없음으로 접고 계속(스크립트가 스키마 적용 순서에 인질이 되지 않게).
  let overrideRows: { domain: string; category: string; updated_at: string }[] = [];
  try {
    overrideRows = await sql.unsafe(
      `SELECT domain, category, updated_at::text AS updated_at FROM citation_domain_overrides`,
    );
  } catch {
    overrideRows = [];
  }
  await sql.end();

  const meta = new Map<string, CurationOverrideMeta>();
  for (const r of overrideRows) {
    if (!isCitationCategory(r.category)) continue;
    meta.set(r.domain, {
      category: r.category,
      note: null,
      updatedBy: null,
      updatedAt: r.updated_at,
    });
  }
  const counts = new Map(rows.map((r) => [r.domain, Number(r.citations) || 0] as const));
  const curated = buildCurationRows(counts, meta);

  const total = curated.reduce((s, r) => s + r.citations, 0);
  let covered = 0;
  const uncovered: { domain: string; citations: number }[] = [];
  const byCategory = new Map<string, number>();
  for (const r of curated) {
    byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.citations);
    if (r.category === FALLBACK_CATEGORY) uncovered.push(r);
    else covered += r.citations;
  }

  console.log(`domains=${curated.length} citations=${total} overrides=${meta.size}`);
  console.log(`covered(non-Other)=${covered} (${((100 * covered) / total).toFixed(1)}%)`);
  console.log("category weights:");
  for (const [c, n] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c}: ${n} (${((100 * n) / total).toFixed(1)}%)`);
  }
  console.log(`\ntop ${limit} uncovered (of ${uncovered.length}):`);
  for (const r of uncovered.slice(0, limit)) console.log(`${r.citations}\t${r.domain}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
