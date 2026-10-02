// 감시 ③ URL 인용률 사실표(0081) 커버리지: 등급 판정과 알림 본문 (2026-09-27).
//
// 8b 단계·백필은 비치명이라 실패가 조용하다. 이 감시가 그 실패를 사람에게 보이게 하는
// 유일한 경로이므로, "울려야 할 때 울리고 울리면 안 될 때 조용한가" 를 고정한다.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  gaps: [] as unknown[] | null,
  unitOn: true,
  mock: false,
  throwOn: false,
}));

vi.mock("@/lib/db/repositories/summary-cycle-health", async (orig) => ({
  ...(await orig<object>()),
  readUrlHitsGaps: async () => {
    if (state.throwOn) throw new Error("db down");
    return state.gaps;
  },
}));
vi.mock("@/lib/scope/website-owned-unit-flag", () => ({
  websiteOwnedUnitEnabled: async () => state.unitOn,
}));
vi.mock("@/lib/scope", async (orig) => ({
  ...(await orig<object>()),
  isMockMode: () => state.mock,
}));

const GAP = (failed: boolean | null, anchor = "2026-09-25 00:00:00+00") => ({
  cycleId: "c1", projectId: "p1", anchorAt: anchor, generationId: "g1", failed,
});

describe("scanUrlHitsCoverage", () => {
  beforeEach(() => {
    state.gaps = [];
    state.unitOn = true;
    state.mock = false;
    state.throwOn = false;
  });

  it("누락 0 이면 통과(0)", async () => {
    const { scanUrlHitsCoverage } = await import("./cycle-chain");
    expect(await scanUrlHitsCoverage()).toMatchObject({ checked: true, severity: 0, gaps: [] });
  });

  it("유닛 판정 키가 켜진 배포에서 누락이 있으면 주의(1)", async () => {
    state.gaps = [GAP(true), GAP(null, "2026-09-18 00:00:00+00")];
    const { scanUrlHitsCoverage, buildUrlHitsGapAlertBody } = await import("./cycle-chain");
    const v = await scanUrlHitsCoverage();
    expect(v).toMatchObject({ checked: true, unitOn: true, severity: 1 });
    const body = buildUrlHitsGapAlertBody(v);
    expect(body).toContain("2개");
    expect(body).toContain("2026-09-18, 2026-09-25");
    expect(body).toContain("url_hits_failed=1): 1개");
    expect(body).toContain("--url-hits --all-published");
  });

  it("키가 꺼진 배포는 카드가 이 표를 안 읽는다: 판정은 하되 울리지 않는다(0)", async () => {
    state.gaps = [GAP(true)];
    state.unitOn = false;
    const { scanUrlHitsCoverage } = await import("./cycle-chain");
    expect(await scanUrlHitsCoverage()).toMatchObject({ checked: true, unitOn: false, severity: 0 });
  });

  it("0081 미적용·조회 실패·mock 은 **판정 불가**(통과가 아니다, 울리지도 않는다)", async () => {
    const { scanUrlHitsCoverage } = await import("./cycle-chain");
    state.gaps = null;
    expect(await scanUrlHitsCoverage()).toMatchObject({ checked: false, reason: "0081-missing", severity: 0 });
    state.gaps = [];
    state.throwOn = true;
    expect(await scanUrlHitsCoverage()).toMatchObject({ checked: false, reason: "error", error: "db down" });
    state.throwOn = false;
    state.mock = true;
    expect(await scanUrlHitsCoverage()).toMatchObject({ checked: false, reason: "mock" });
  });
});

describe("cycle-chain-watch 라우트 배선", () => {
  it("감시 ③ 을 다른 둘과 **독립으로** 판정하고 Slack 으로 보낸다", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../../app/api/cron/cycle-chain-watch/route.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/Promise\.all\(\[\s*scanViewLag\(\),\s*scanGenerationBacklog\(\),\s*scanUrlHitsCoverage\(\),/);
    expect(src).toContain("emitUrlHits(urlHits)");
    expect(src).toContain("postSlackAlert({ severity: v.severity, title, body: buildUrlHitsGapAlertBody(v) })");
    expect(src).toContain("Math.max(viewLag.severity, backlog.severity, urlHits.severity)");
  });
});
