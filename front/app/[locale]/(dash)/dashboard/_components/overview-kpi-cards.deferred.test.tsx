import { describe, expect, it } from "vitest";
import { renderToReadableStream } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { MentionsBrandLive } from "@/lib/scope/result-adapter";
import type { KpiSummary } from "../_data/sample";
import type { LiveTrend } from "../_data/live";
import { OverviewKpiCards } from "./overview-kpi-cards";

// E-1(2026-09-10) 회귀 고정 — **카드 값이 extras 를 기다리지 않는다**.
//
// 종전에는 페이지가 네 read 를 한 Promise.all 로 모은 뒤에야 카드를 그려, 가장 느린
// read 하나가 ①~⑤ 값까지 붙잡았다(T12 프리뷰 실측: 셸 0.87 s → 본문 32.9 s).
// 여기서는 지연 슬롯의 프로미스를 일부러 늦게 풀고, **첫 flush 에 값이 있고 경쟁사
// 브랜드는 없는지**를 스트림 산출로 확인한다. 구조가 되돌아가면 값이 첫 청크에서
// 사라져 이 테스트가 깨진다.

const kpi = (key: KpiSummary["key"], value: number | null, delta: number | null): KpiSummary => ({
  key, value, delta, direction: delta == null || delta === 0 ? "flat" : delta > 0 ? "up" : "down",
  ratio: { numerator: 1, denominator: 100 },
});
const KPIS: KpiSummary[] = [kpi("visibility", 73.1, null)];
const WITH_DELTA: KpiSummary[] = [kpi("visibility", 73.1, -4.4)];
const TREND: LiveTrend = {
  unit: "week", lastMeasuredAt: null, totalAnswers: 0,
  points: [
    { bucketStart: "2026-08-03", firstAt: null, lastAt: null, measuredDays: 7, answers: 100, values: { visibility: 70 } },
    { bucketStart: "2026-08-10", firstAt: null, lastAt: null, measuredDays: 7, answers: 100, values: { visibility: 73.1 } },
  ],
};
const BRANDS: MentionsBrandLive[] = [
  { brand: "Tesla", mentions: 10, prompts: 1, share: 20, mentionRate: 40, avgPosition: null, isTracked: false },
];

/** 30 ms 뒤에 풀리는 프로미스 — 셸이 먼저 flush 되도록 갈라 놓는다. */
const late = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), 30));

async function chunks(node: React.ReactElement): Promise<string[]> {
  const stream = await renderToReadableStream(node);
  const reader = stream.getReader();
  const dec = new TextDecoder();
  const out: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(dec.decode(value, { stream: true }));
  }
  return out;
}

describe("OverviewKpiCards — 값은 Δ·스파크·경쟁사를 기다리지 않는다 (E-1)", () => {
  it("첫 flush 에 값이 있고, 지연 슬롯은 자리표시로 남는다", async () => {
    const cs = await chunks(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <OverviewKpiCards
          kpis={KPIS}
          locale="ko"
          deferred={{
            deltas: late(WITH_DELTA),
            trend: late<LiveTrend | null>(TREND),
            competitors: late({ brands: BRANDS, brandTrend: null, firstPosition: null, citationDomains: null }),
          }}
        />
      </NextIntlClientProvider>,
    );
    expect(cs.length, "지연 슬롯이 있는데 한 번에 다 나왔다 = 경계가 안 갈렸다").toBeGreaterThan(1);
    const shell = cs[0];
    expect(shell).toContain("73.1%"); // ① 값은 즉시
    // 지연 슬롯은 아직 열린 경계다(React 는 fallback + <template id="B:n"> 를 낸다).
    // 첫 청크에 몇 개가 실리는지는 React 의 flush 재량이라 개수는 스트림 전체로 센다.
    expect(shell).toMatch(/<template id="B:/);
    expect(shell).toContain("animate-pulse"); // 스켈레톤이 자리를 잡고 있다
    expect(shell).not.toContain("Tesla"); // 경쟁사 행은 아직
    expect(shell).not.toContain("4.4pp"); // Δ 도 아직

    // 카드 1장 × 지연 슬롯 3종(Δ · 스파크라인 · 경쟁사 행).
    expect((cs.join("").match(/<template id="B:/g) ?? []).length).toBe(3);
    const rest = cs.slice(1).join("");
    expect(rest).toContain("Tesla");
    expect(rest).toContain("4.4pp");
  });

  it("deferred 없이 값으로 넘기면 종전대로 한 번에 그린다(테스트·mock 경로)", async () => {
    const cs = await chunks(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <OverviewKpiCards kpis={WITH_DELTA} trend={TREND} brands={BRANDS} locale="ko" />
      </NextIntlClientProvider>,
    );
    const all = cs.join("");
    expect(all).toContain("73.1%");
    expect(all).toContain("4.4pp");
    expect(all).toContain("Tesla");
    expect(all).not.toMatch(/<template id="B:/);
  });
});
