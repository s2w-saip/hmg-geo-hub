/**
 * 3-F 백필 — profiles.regions[] 레거시 값 → RHQ 권역 id.
 *
 *   npx tsx --env-file=.env.local scripts/db/migrate-rhq-regions.ts          # dry-run (리포트만)
 *   npx tsx --env-file=.env.local scripts/db/migrate-rhq-regions.ts --apply  # 실제 UPDATE
 *
 * 배경: 임시 권역 테이블(lib/scope/dimensions.ts) 시절 profiles.regions에는 어휘가
 * 섞여 들어갔다 — 임시 bucket("EU"), 대륙명("Europe"), 대륙약어("APAC"/"NA"),
 * 심지어 국가코드("KR"). RHQ 정본(lib/rhq) 단일화 후엔 권역 id(브랜드 프리픽스,
 * 예: "hyundai-europe")만 유효하다. 이 스크립트는 프로필의 brands를 단서로 레거시
 * 토큰을 RHQ id로 정규화한다.
 *
 * 규칙:
 *   - 이미 유효한 RHQ id → 그대로.
 *   - 레거시 대륙/버킷 토큰 → profile의 각 brand별 해당 RHQ id로 확장(Kia "Europe"은
 *     서/동유럽 둘 다). brand가 없으면 매핑 불가 → 보류(수동 검토).
 *   - 2글자 대문자(국가코드, C4) → regions에서 제거(권역 아님). countries로는 옮기지
 *     않는다(스코프 의도치 않은 확대 방지) — 경고만.
 *   - 매핑 불가 토큰 → 보류 + 경고. regions가 통째로 비면 그 행은 건드리지 않고 경고.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, isNotNull } from "drizzle-orm";
import { profiles } from "../../lib/db/schema";
import {
  RHQ_BRANDS,
  isRhqRegionId,
  rhqForCountry,
  rhqRegionsForBrand,
  countriesForRhq,
} from "../../lib/rhq";

const DATABASE_URL = process.env.DATABASE_URL!;
const APPLY = process.argv.includes("--apply");

// 레거시 대륙/버킷 토큰 → RHQ 권역의 영문 라벨(en)으로 매칭하기 위한 정규화 키.
// 각 브랜드의 권역 라벨(en)과 대조해 id를 찾는다. 한 레거시 토큰이 여러 권역에
// 걸리면(Kia "Europe" → Western/Eastern) 모두 반환.
const LEGACY_ALIASES: Record<string, string[]> = {
  // legacy token (upper) → RHQ en-label 후보(부분일치 키워드)
  EU: ["europe"],
  EUROPE: ["europe"],
  APAC: ["asia"],
  ASIA: ["asia"],
  OCEANIA: ["asia"], // 구 Oceania → Asia & Pacific 병합
  NA: ["north america"],
  "NORTH AMERICA": ["north america"],
  LATAM: ["latin", "central"],
  "LATIN AMERICA": ["latin", "central"],
  "MIDDLE EAST": ["middle east"],
  ME: ["middle east"],
  AFRICA: ["africa"],
};

const isCountryCode = (t: string) => /^[A-Z]{2}$/.test(t);

// 한 브랜드에서 레거시 토큰 → RHQ id 목록(부분일치).
function idsForLegacy(brand: string, token: string): string[] {
  const keys = LEGACY_ALIASES[token.toUpperCase()];
  if (!keys) return [];
  const out: string[] = [];
  for (const r of rhqRegionsForBrand(brand)) {
    const en = r.labels.en.toLowerCase();
    if (keys.some((k) => en.includes(k))) out.push(r.id);
  }
  return out;
}

async function main() {
  const sql = postgres(DATABASE_URL, { prepare: false });
  const db = drizzle(sql);
  const rows = await db
    .select({ id: profiles.id, email: profiles.email, brands: profiles.brands, regions: profiles.regions, countries: profiles.countries })
    .from(profiles)
    .where(isNotNull(profiles.regions));

  let changed = 0;
  const warnings: string[] = [];

  for (const p of rows) {
    const regions = p.regions ?? [];
    if (regions.length === 0) continue;
    const brands = p.brands ?? [];
    const next = new Set<string>();

    // brand 없는(HMG 우산) 계정은 전 브랜드 기준으로 매핑.
    const mapBrands = brands.length ? brands : RHQ_BRANDS;

    for (const tok of regions) {
      if (isRhqRegionId(tok)) {
        next.add(tok);
        continue;
      }
      // 레거시 대륙/버킷 토큰(EU/NA/ME/APAC/LATAM…) — 국가코드 형태여도 우선 매핑.
      if (tok.toUpperCase() in LEGACY_ALIASES) {
        const mapped = mapBrands.flatMap((b) => idsForLegacy(b, tok));
        if (mapped.length) mapped.forEach((id) => next.add(id));
        else {
          warnings.push(`${p.email}: '${tok}' 매핑 규칙 없음(보류)`);
          next.add(tok);
        }
        continue;
      }
      // 진짜 국가코드가 region에 잘못 든 경우(C4) → 그 브랜드에서 해당 국가의 RHQ 권역으로.
      if (isCountryCode(tok)) {
        const mapped = mapBrands
          .map((b) => rhqForCountry(b, tok))
          .filter((x): x is string => !!x);
        if (mapped.length) {
          mapped.forEach((id) => next.add(id));
          warnings.push(`${p.email}: region의 국가코드 '${tok}' → 해당 국가의 RHQ 권역으로 매핑`);
        } else {
          warnings.push(`${p.email}: '${tok}' 국가코드지만 RHQ 권역 없음 — 제거`);
        }
        continue;
      }
      warnings.push(`${p.email}: '${tok}' 매핑 규칙 없음(보류)`);
      next.add(tok);
    }

    // 국가가 핀된 계정: 핀 국가를 하나도 담지 않는 권역 제거. 레거시 "Europe"이 Kia
    // 서/동유럽 둘 다로 과확장된 것 보정(country=IT면 Western Europe만 남김). 결과가
    // 비면 보정 생략.
    let nextArr = [...next];
    const pinned = (p.countries ?? []).map((c) => c.toUpperCase());
    if (pinned.length && nextArr.length > 1) {
      const containing = nextArr.filter((id) =>
        countriesForRhq(id).some((c) => pinned.includes(c)),
      );
      if (containing.length) nextArr = containing;
    }

    // 원본 집합과 동일하면 변경 없음(이미 정규화됨).
    const sameSet =
      nextArr.length === regions.length &&
      [...nextArr].sort().join("|") === [...regions].sort().join("|");
    if (sameSet) continue;
    if (nextArr.length === 0) {
      warnings.push(`${p.email}: 매핑 결과 빈 권역 → 건너뜀(원본 유지)`);
      continue;
    }
    changed++;
    console.log(`${p.email}: [${regions.join(", ")}] → [${nextArr.join(", ")}]`);
    if (APPLY) {
      await db.update(profiles).set({ regions: nextArr }).where(eq(profiles.id, p.id));
    }
  }

  if (warnings.length) {
    console.log("\n⚠️  검토 필요:");
    for (const w of warnings) console.log("  - " + w);
  }
  console.log(`\n${APPLY ? "적용" : "dry-run"}: ${changed} profile(s) 변경 대상.`);
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
