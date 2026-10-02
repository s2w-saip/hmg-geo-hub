/**
 * 감사 — profiles의 brand × region × country가 RHQ 정본(lib/rhq)과 일치하는지 점검(read-only).
 *
 *   npx tsx --env-file=.env.local scripts/db/audit-rhq.ts
 *
 * 브랜드(현대/기아/제네시스)별로 각 프로필을 정본과 대조해 불일치를 보고한다:
 *   [E1] region 값이 유효한 RHQ 권역 id 가 아님.
 *   [E2] region id 가 프로필의 brand(들) 어디에도 속하지 않음(브랜드 불일치).
 *   [E3] 핀된 country 가 배정 권역 어디에도 없음(권역↔국가 모순).
 *   [E4] 배정 권역이 핀된 country 를 하나도 안 담음(과확장 — 예: kia-it 에 Eastern Europe).
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { isNotNull } from "drizzle-orm";
import { profiles } from "../../lib/db/schema";
import {
  isRhqRegionId,
  rhqRegionIdsForBrand,
  countriesForRhq,
  rhqForCountry,
} from "../../lib/rhq";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false });
const db = drizzle(sql);

const rows = await db
  .select({
    email: profiles.email,
    brands: profiles.brands,
    regions: profiles.regions,
    countries: profiles.countries,
    scopeAll: profiles.scopeAll,
  })
  .from(profiles)
  .where(isNotNull(profiles.regions));

let issues = 0;
for (const p of rows) {
  const regions = p.regions ?? [];
  if (p.scopeAll || regions.length === 0) continue;
  const brands = p.brands ?? [];
  const countries = (p.countries ?? []).map((c) => c.toUpperCase());
  const validBrandRegionIds = new Set(brands.flatMap((b) => rhqRegionIdsForBrand(b)));
  const errs: string[] = [];

  for (const r of regions) {
    if (!isRhqRegionId(r)) errs.push(`[E1] '${r}' 유효한 RHQ 권역 id 아님`);
    else if (brands.length && !validBrandRegionIds.has(r))
      errs.push(`[E2] '${r}' 가 brand(${brands.join(",")})에 없음`);
  }
  // [E4] 배정 권역이 핀 국가를 하나도 안 담음(과확장).
  if (countries.length) {
    for (const r of regions) {
      if (!isRhqRegionId(r)) continue;
      const rc = countriesForRhq(r);
      if (!countries.some((c) => rc.includes(c)))
        errs.push(`[E4] 권역 '${r}' 가 핀 국가(${countries.join(",")})를 안 담음(과확장)`);
    }
    // [E3] 핀 국가가 배정 권역 어디에도 없음.
    for (const c of countries) {
      const inAny = regions.some((r) => isRhqRegionId(r) && countriesForRhq(r).includes(c));
      if (!inAny) {
        const expect = brands.map((b) => rhqForCountry(b, c)).filter(Boolean).join("/") || "?";
        errs.push(`[E3] 국가 '${c}' 가 배정 권역에 없음(기대 권역: ${expect})`);
      }
    }
  }

  if (errs.length) {
    issues++;
    console.log(`\n✗ ${p.email}  brands=[${brands.join(",")}] regions=[${regions.join(",")}] countries=[${countries.join(",")}]`);
    for (const e of errs) console.log("    " + e);
  }
}

console.log(issues === 0 ? "\n✓ 모든 프로필이 RHQ 정본과 일치." : `\n총 ${issues} 프로필 불일치.`);
await sql.end();
