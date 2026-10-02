// 타겟 URL 인용률(aggregateWebsiteTargetHitRate) — 실 DB(read-only) 검증.
// DATABASE_URL 이 있을 때만 실행 (CI 무DB skip). 로컬:
//   DATABASE_URL=... npx vitest run lib/db/repositories/scope-aggregates.target-hit-rate.int.test.ts
//
// 이 지표는 이미 고객에게 나간 인용 리포트(v1.1/v1.2 본문 KPI)와 **같은 산식**이라,
// 화면 값이 리포트와 어긋나면 대조가 깨진다. 그래서 리포트 발행값을 회귀 기준으로
// 박아 둔다(2026-08-26 실측, 8/21 회차 = 각 사이트 최신 스냅샷).
import { describe, expect, it } from "vitest";
import {
  aggregateWebsiteTargetHitRate,
  citationTrackedNormSql,
  websiteDeclaredOwnedBases,
} from "./scope-aggregates";
import { getDb } from "@/lib/db";
import { sql } from "drizzle-orm";

const hasDb = !!process.env.DATABASE_URL;

// aggregateWebsiteTargetHitRate({}, …) (필터 없음)은 "최신" 스냅샷을 읽는다 —
// 미러가 계속 증분 동기화되므로 그 "최신"은 이 테스트가 도는 시점마다 바뀐다
// (2026-08-30 실증: 8/21 회차 발행 이후 새 측정 라운드가 8/28~8/29 에 갱신되며
// Kia/KR 144→104, Genesis/GB 75→45, Genesis/NL 42→30 로 실제로 하락 — LLM 답변은
// 라운드마다 비결정적이라 인용이 항상 느는 방향으로만 움직이지 않는다). "발행
// 리포트와 같은 프롬프트를 센다"는 목적상 비교 대상은 **그 회차 시점의 스냅샷**
// 이어야 하므로, dateTo 로 그 시점을 얼려(freeze) 비교 양쪽을 모두 고정한다 —
// 그래야 이후 라운드가 아무리 쌓여도 이 표는 다시 드리프트하지 않는다. 실측으로
// dateTo="2026-08-22" 가 아래 네 값(발행 리포트 원문)을 정확히 재현함을 확인했다.
const REPORT_AS_OF = "2026-08-22";

// 발행 리포트의 「타겟 URL 인용률」 (프롬프트 기준, 2026-08-21 회차) — 분자/분모를
// 정수로 못박는다. 화면은 소수 1자리(round1), 리포트는 2자리라 비율 문자열은 서로
// 다를 수 있지만(80.6% vs 80.65%) **세는 대상은 같아야 한다**. 정수 비교가 표기
// 자릿수에 흔들리지 않는 진짜 회귀 게이트다.
//
// 2026-09-20 — 타겟 일치를 **리포트와 같은 정확 일치**로 되돌렸다(제품 결정). 그래서
// 분자는 다시 발행 리포트 원문과 **같아야 한다**. 2026-09-17(GGMD-61)에 잠깐 들어갔던
// 완화(쿼리 제거·`.html` 동치)는 여기서 GB 75→77 · IT 25→27 · NL 42→46 으로 분자를
// 부풀렸고, 그 증상이 이 표의 회귀 게이트다 — 분자가 `hit` 를 넘으면 완화가 되살아난 것이다.
// 분모는 두 규칙 모두에서 같다 — 등록 프롬프트 전량이 타겟을 갖고 있어
// (미러 실측 website_prompts 12,685행 중 타겟 공란 0건) 분모 정의 변경의 영향이 0이다.
const REPORT_VALUES: Array<{
  brand: string; cc: string; hit: number; measured: number;
}> = [
  { brand: "Kia", cc: "KR", hit: 144, measured: 150 },   // 리포트 96.00%
  { brand: "Genesis", cc: "GB", hit: 75, measured: 93 }, // 80.65%
  { brand: "Genesis", cc: "IT", hit: 25, measured: 35 }, // 71.43%
  { brand: "Genesis", cc: "NL", hit: 42, measured: 66 }, // 63.64%
];

async function projectIdFor(brand: string, cc: string): Promise<string | null> {
  const rows = (await getDb().execute(sql`
    SELECT scope_project_id FROM website_sites
    WHERE brand = ${brand} AND country_code = ${cc} AND scope_project_id IS NOT NULL
  `)) as unknown as Array<{ scope_project_id: string }>;
  return rows[0]?.scope_project_id ?? null;
}

describe.skipIf(!hasDb)("aggregateWebsiteTargetHitRate (live mirror)", { timeout: 180_000 }, () => {
  it("프로젝트 없음 → 분모 0, rate null", async () => {
    const r = await aggregateWebsiteTargetHitRate({}, []);
    expect(r).toEqual({
      hitPrompts: 0, ownedPrompts: 0, measuredPrompts: 0, rate: null, ownedRate: null,
    });
  });

  it("분자 ≤ 분모 이고 rate 는 [0,100] (전 사이트 통합)", async () => {
    const rows = (await getDb().execute(sql`
      SELECT scope_project_id FROM website_sites WHERE scope_project_id IS NOT NULL
    `)) as unknown as Array<{ scope_project_id: string }>;
    const ids = rows.map((r) => r.scope_project_id);
    if (ids.length === 0) return; // 미러 비어 있음
    const own = await websiteDeclaredOwnedBases({}, ids);
    const r = await aggregateWebsiteTargetHitRate({}, ids, own.prefixes, own.universe);
    // GGMD-61 — 타겟 ⊂ 자사 ⊂ 측정(수용 기준 A2). 술어 포함관계라 필터와 무관하게 성립한다.
    expect(r.hitPrompts).toBeLessThanOrEqual(r.ownedPrompts);
    expect(r.ownedPrompts).toBeLessThanOrEqual(r.measuredPrompts);
    for (const rate of [r.rate, r.ownedRate]) {
      if (rate != null) {
        expect(rate).toBeGreaterThanOrEqual(0);
        expect(rate).toBeLessThanOrEqual(100);
      }
    }
  });

  it.each(REPORT_VALUES)(
    "$brand/$cc — 발행 리포트와 같은 프롬프트를 센다(정확 일치)",
    async ({ brand, cc, hit, measured }) => {
      const pid = await projectIdFor(brand, cc);
      if (!pid) return; // 해당 사이트 미측정 환경
      const r = await aggregateWebsiteTargetHitRate({ dateTo: REPORT_AS_OF }, [pid]);
      if (r.rate == null) return; // 측정 대기
      // eslint-disable-next-line no-console
      console.log(`[${brand}/${cc}] ${r.hitPrompts}/${r.measuredPrompts} = ${r.rate}% (리포트 ${hit}/${measured})`);
      expect({ hit: r.hitPrompts, measured: r.measuredPrompts }).toEqual({ hit, measured });
    },
  );

  it("brand 축은 이 함수에 넘기면 안 된다 — website 프롬프트는 표준 카탈로그 밖", async () => {
    const pid = await projectIdFor("Genesis", "GB");
    if (!pid) return;
    const plain = await aggregateWebsiteTargetHitRate({}, [pid]);
    if (plain.rate == null) return;
    // catalogIn("brand") 가 표준 prompts 를 조인해 0건이 된다. 그래서 호출은 반드시
    // withWebsite(lib/scope/server.ts::fetchWebsiteTargetHitRate)를 거쳐야 하며,
    // 거기서 brand 는 project id 필터로 흡수되고 filters 에서 제거된다.
    // 이 테스트는 그 함정을 문서화한다 — 페이지가 리포지토리를 직접 부르면 카드가 빈다.
    const withBrand = await aggregateWebsiteTargetHitRate({ brand: ["Genesis"] }, [pid]);
    expect(withBrand.measuredPrompts).toBe(0);
    expect(plain.measuredPrompts).toBeGreaterThan(0);
  });

  it("타 프롬프트의 타겟이 인용된 경우는 도달로 세지 않는다 (flat 매칭 금지)", async () => {
    const pid = await projectIdFor("Genesis", "NL");
    if (!pid) return;
    const perPrompt = await aggregateWebsiteTargetHitRate({}, [pid]);
    if (perPrompt.rate == null) return;
    // 같은 스냅샷을 사이트 전체 타겟 집합(flat)으로 매칭한 값 — 반드시 크거나 같다.
    // 이 테스트가 깨지면 매칭이 프롬프트별에서 flat 으로 되돌아간 것이다.
    //
    // ⚠️ 정규화는 반드시 production 과 같은 citationTrackedNormSql 을 재사용한다.
    // 2026-08-30 실증: 이 보조 쿼리가 `#...` 텍스트 프래그먼트(Chrome
    // "scroll-to-text" 링크, `...#:~:text=...`)를 못 벗기는 축약 정규화를 손으로
    // 다시 구현했다가 실제로는 perPrompt(30) ≤ flat(40) 인데 flat 이 21 로
    // 과소 계산돼 **역방향(perPrompt > flat)으로 실패**했다 — production 의
    // aggregateWebsiteTargetHitRate 는 정상이었고, 이 테스트 자체의 정규화
    // 로직이 결함이었다(코드 아님, 테스트 버그).
    const cnorm = citationTrackedNormSql(sql`c.url`);
    const tnorm = citationTrackedNormSql(sql`wp.target_url`);
    const flat = (await getDb().execute(sql`
      WITH snap AS (
        SELECT DISTINCT ON (a.prompt_id, a.target, a.region) a.job_id, a.prompt_id
        FROM scope_answers a JOIN scope_runs r ON r.run_id = a.run_id
        WHERE r.project_id = ${pid} AND r.status IN ('completed','partial_failed')
          AND a.status = 'completed'
        ORDER BY a.prompt_id, a.target, a.region, a.measured_at DESC
      ), tset AS (
        SELECT DISTINCT ${tnorm} AS turl
        FROM website_prompts wp JOIN website_sites ws ON ws.id = wp.site_id
        WHERE ws.scope_project_id = ${pid} AND coalesce(wp.target_url,'') <> ''
      )
      SELECT count(DISTINCT snap.prompt_id)::int AS hits
      FROM snap JOIN scope_citations c ON c.job_id = snap.job_id
      WHERE ${cnorm} IN (SELECT turl FROM tset)
    `)) as unknown as Array<{ hits: number }>;
    expect(perPrompt.hitPrompts).toBeLessThanOrEqual(Number(flat[0]?.hits ?? 0));
  });
});
