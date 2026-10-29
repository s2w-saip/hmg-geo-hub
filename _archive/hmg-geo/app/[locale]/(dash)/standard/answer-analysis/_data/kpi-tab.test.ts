import { describe, expect, it } from "vitest";
import {
  DEFAULT_KPI_TAB,
  IMPLEMENTED_KPI_TABS,
  KPI_TABS,
  isImplementedKpiTab,
  kpiTabQuery,
  resolveKpiTab,
} from "./kpi-tab";

describe("resolveKpiTab", () => {
  it.each(KPI_TABS)("accepts the known tab %s", (tab) => {
    expect(resolveKpiTab(tab)).toBe(tab);
  });

  // 스펙 SHALL: "파라미터 부재·미지값은 exposure 로 폴백한다". 폴백이 없으면
  // 손으로 URL 을 고친 사용자가 빈 화면을 본다.
  it.each([undefined, null, "", "  ", "unknown", "Exposure", "SOV"])(
    "falls back to exposure for %j",
    (raw) => {
      expect(resolveKpiTab(raw as string | undefined)).toBe(DEFAULT_KPI_TAB);
    },
  );

  it("trims whitespace around a valid value", () => {
    expect(resolveKpiTab(" sov ")).toBe("sov");
  });

  // 중복 파라미터(?kpi=sov&kpi=exposure)는 Next 가 배열로 준다 — 첫 값만 본다.
  it("takes the first value of a repeated param", () => {
    expect(resolveKpiTab(["sov", "exposure"])).toBe("sov");
    expect(resolveKpiTab(["nope", "sov"])).toBe(DEFAULT_KPI_TAB);
    expect(resolveKpiTab([])).toBe(DEFAULT_KPI_TAB);
  });
});

describe("kpiTabQuery", () => {
  // 스펙 시나리오 "탭 전환 시 필터 유지" 의 기계적 근거. 값은 원문 그대로
  // 옮겨야 한다 — FILTER_SEP("~")·기간("..") 인코딩을 해석하면 왕복에서 깨진다.
  it("carries every filter param and only swaps kpi", () => {
    const p = new URLSearchParams();
    p.set("geography", "KR~US");
    p.set("depth2", "EV,Hybrid Brand Awareness");
    p.set("time", "2026-06-01..2026-07-01");
    p.set("kpi", "exposure");

    const q = new URLSearchParams(kpiTabQuery(p, "sov").slice(1));
    expect(q.get("geography")).toBe("KR~US");
    expect(q.get("depth2")).toBe("EV,Hybrid Brand Awareness");
    expect(q.get("time")).toBe("2026-06-01..2026-07-01");
    expect(q.get("kpi")).toBe("sov");
  });

  // 기본 탭은 파라미터를 지운다 — 공유된 URL 이 `?kpi=exposure` 로 지저분해지지 않게.
  it("drops the param for the default tab but keeps the filters", () => {
    const p = new URLSearchParams("engine=chatgpt&kpi=sov");
    expect(kpiTabQuery(p, "exposure")).toBe("?engine=chatgpt");
  });

  it("returns an empty string when nothing is left", () => {
    expect(kpiTabQuery(new URLSearchParams("kpi=first-rank"), "exposure")).toBe("");
  });

  it("does not mutate the input params", () => {
    const p = new URLSearchParams("kpi=exposure&engine=gemini");
    kpiTabQuery(p, "favorability");
    expect(p.get("kpi")).toBe("exposure");
  });
});

describe("isImplementedKpiTab", () => {
  // PR ② 범위 — 우호도·우선 노출도는 탭만 있고 지면은 PendingCard.
  it("marks exposure/sov implemented and the other two pending", () => {
    // PR ③(2026-09-02)부터 네 탭 전부 지면이 있다.
    expect(IMPLEMENTED_KPI_TABS).toEqual(["exposure", "sov", "favorability", "first-rank"]);
    expect(isImplementedKpiTab("exposure")).toBe(true);
    expect(isImplementedKpiTab("sov")).toBe(true);
    expect(isImplementedKpiTab("favorability")).toBe(true);
    expect(isImplementedKpiTab("first-rank")).toBe(true);
  });
});
