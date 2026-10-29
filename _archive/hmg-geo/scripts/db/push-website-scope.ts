/**
 * 웹사이트 사이트/프롬프트 → scope 푸시 스크립트 (DB 기반)
 *
 * seed-website-prompts.ts 는 xlsx 원본(prompt/작업용, gitignored)이 있어야
 * 재실행할 수 있다. 이 스크립트는 이미 DB 에 적재된 website_sites /
 * website_prompts 를 읽어 scope 쪽 미생성분만 푸시한다:
 *
 *   site  →  scope createProject  (scope_project_id 없는 site 만)
 *         →  scope putSchedule    (enabled, interval_days=7 — 주 1회 측정)
 *   prompt → scope createPrompt   (scope_prompt_id 없는 행만, keywords=[target_url])
 *
 * 리전 매핑: scope 의 regions 는 ISO alpha-2 강제(^[A-Z]{2}$)라 비ISO
 * country_code 는 측정 프록시 국가로 대표-매핑한다 (2026-07-02 결정):
 *   worldwide → KR(글로벌 페이지 = 한국 IP, 2026-07-02 결정 — 한동안 US로
 *   드리프트돼 4개 worldwide 프로젝트가 US 측정됐고 2026-07-29 KR로 일괄 교정),
 *   MIDDLEEAST → AE(두바이/GCC 허브), EU → DE(유럽 HQ·기측정 리전)
 * 로컬 DB 의 country_code 는 그대로 두고 scope regions 에만 매핑을 적용한다.
 *
 * schedule 은 targets/regions 를 빈 배열로 두어 프로젝트 자체 regions +
 * scope 기본 targets(chatgpt, gemini)로 폴백시킨다 (planner 의 폴백 규칙).
 *
 *   npx tsx --env-file=.env.local scripts/db/push-website-scope.ts [옵션]
 *
 * 옵션:
 *   --dry-run          쓰기 없이 푸시 계획만 출력
 *   --brand=Genesis    해당 브랜드만 (쉼표 구분 복수 가능, e.g. Hyundai,Kia)
 *   --interval-days=7  measurement interval (기본 7 = 주 1회)
 *
 * idempotent: scope id 가 이미 있는 행은 건너뛰므로 중단 후 재실행 안전.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, asc, eq, isNull } from "drizzle-orm";
import { websiteSites, websitePrompts } from "../../lib/db/schema";
import { getScopeClient } from "../../lib/scope/index";

const DATABASE_URL = process.env.DATABASE_URL!;
if (!DATABASE_URL) throw new Error("Missing DATABASE_URL");

const isDryRun = process.argv.includes("--dry-run");
const brandArg = process.argv.find((a) => a.startsWith("--brand="));
const brandFilter = brandArg
  ? new Set(brandArg.slice("--brand=".length).split(",").map((s) => s.trim()))
  : null;
const intervalArg = process.argv.find((a) => a.startsWith("--interval-days="));
const intervalDays = intervalArg
  ? parseInt(intervalArg.slice("--interval-days=".length), 10)
  : 7;
if (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 30) {
  throw new Error(`invalid --interval-days: ${intervalDays} (1..30)`);
}

// 비ISO country_code → 측정 리전(프록시 국가) 대표 매핑.
const REGION_OVERRIDES: Record<string, string> = {
  worldwide: "KR", // seed-website-prompts.ts의 VIRTUAL_REGION_COUNTRY와 반드시 일치

  MIDDLEEAST: "AE",
  EU: "DE",
};

function scopeRegion(countryCode: string): string | null {
  const mapped = REGION_OVERRIDES[countryCode] ?? countryCode;
  return /^[A-Z]{2}$/.test(mapped) ? mapped : null;
}

const sql = postgres(DATABASE_URL, { prepare: false });
const db = drizzle(sql);
const scope = isDryRun ? null : getScopeClient();

// 소량 병렬 (scope API 보호) — 프롬프트 푸시용.
const CONCURRENCY = 4;

async function pushSitePrompts(
  siteId: string,
  scopeProjectId: string,
): Promise<{ pushed: number; failed: number }> {
  const pending = await db
    .select()
    .from(websitePrompts)
    .where(and(eq(websitePrompts.siteId, siteId), isNull(websitePrompts.scopePromptId)))
    .orderBy(asc(websitePrompts.fileSeq), asc(websitePrompts.seqNo));

  let pushed = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (row) => {
        try {
          const sp = await scope!.createPrompt(scopeProjectId, {
            text: row.promptText,
            keywords: [row.targetUrl],
          });
          await db
            .update(websitePrompts)
            .set({ scopePromptId: sp.prompt_id, updatedAt: new Date() })
            .where(eq(websitePrompts.id, row.id));
          pushed++;
        } catch (e) {
          failed++;
          console.warn(
            `    [scope] createPrompt failed (file=${row.fileSeq} seq=${row.seqNo}):`,
            e instanceof Error ? e.message : e,
          );
        }
      }),
    );
    if (pushed > 0 && pushed % 200 < CONCURRENCY) {
      console.log(`    … ${pushed}/${pending.length} pushed`);
    }
  }
  return { pushed, failed };
}

const sites = await db
  .select()
  .from(websiteSites)
  .orderBy(asc(websiteSites.brand), asc(websiteSites.countryCode));

const targets = sites.filter((s) => !brandFilter || brandFilter.has(s.brand));
console.log(
  `[push-website-scope] sites=${targets.length}/${sites.length}` +
  ` interval_days=${intervalDays}${brandFilter ? ` brand=${[...brandFilter].join(",")}` : ""}` +
  `${isDryRun ? " (dry-run)" : ""}`,
);

let projCreated = 0, projExist = 0, schedSet = 0, promptPushed = 0, promptFailed = 0, skipped = 0;

for (const site of targets) {
  const region = scopeRegion(site.countryCode);
  if (!region) {
    console.warn(`SKIP ${site.brand}/${site.countryCode}: no valid region mapping`);
    skipped++;
    continue;
  }

  // site 의 대표 도메인 = 프롬프트 행에서 최빈 도메인.
  const domains = await db
    .select({ domain: websitePrompts.domain })
    .from(websitePrompts)
    .where(eq(websitePrompts.siteId, site.id));
  const domainCounts = new Map<string, number>();
  for (const d of domains) domainCounts.set(d.domain, (domainCounts.get(d.domain) ?? 0) + 1);
  const domain = [...domainCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const pendingCount = domains.length; // 전체 행 수 (표시용)

  if (isDryRun) {
    console.log(
      `[plan] ${site.brand}/${site.countryCode} → region=${region}` +
      ` domain=${domain ?? "-"} prompts=${pendingCount}` +
      ` project=${site.scopeProjectId ? "exists" : "CREATE"}`,
    );
    continue;
  }

  // 1. 프로젝트 생성 (미생성분만)
  let projectId = site.scopeProjectId;
  if (!projectId) {
    try {
      const proj = await scope!.createProject({
        name: `Website — ${site.brand} / ${site.countryCode}`,
        domain,
        tracked_brands: [{ brand_name: site.brand }],
        regions: [region],
      });
      projectId = proj.project_id;
      await db
        .update(websiteSites)
        .set({ scopeProjectId: projectId, updatedAt: new Date() })
        .where(eq(websiteSites.id, site.id));
      projCreated++;
      console.log(`[scope] project created: ${site.brand}/${site.countryCode} → ${projectId} (region=${region})`);
    } catch (e) {
      console.warn(
        `[scope] createProject FAILED ${site.brand}/${site.countryCode}:`,
        e instanceof Error ? e.message : e,
      );
      continue;
    }
  } else {
    projExist++;
  }

  // 2. 주기 스케줄 upsert — 프롬프트 푸시 *전에* 걸어 24h 기본 window 로
  //    첫 tick 이 도는 일이 없게 한다 (row 없으면 global 24h 폴백).
  try {
    await scope!.putSchedule(projectId, {
      enabled: true,
      interval_days: intervalDays,
      targets: [],
      regions: [],
    });
    schedSet++;
  } catch (e) {
    console.warn(
      `[scope] putSchedule FAILED ${site.brand}/${site.countryCode}:`,
      e instanceof Error ? e.message : e,
    );
    continue; // schedule 없이 프롬프트를 넣으면 데일리로 돌므로 중단
  }

  // 3. 프롬프트 푸시 (미푸시분만)
  const res = await pushSitePrompts(site.id, projectId);
  promptPushed += res.pushed;
  promptFailed += res.failed;
  console.log(
    `[done] ${site.brand}/${site.countryCode}: prompts pushed=${res.pushed} failed=${res.failed}`,
  );
}

console.log(
  `\ndone. projects created=${projCreated} existed=${projExist} skipped=${skipped}` +
  ` | schedules set=${schedSet}` +
  ` | prompts pushed=${promptPushed} failed=${promptFailed}`,
);

await sql.end();
