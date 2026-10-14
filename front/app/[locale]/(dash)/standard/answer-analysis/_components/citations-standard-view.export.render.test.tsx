import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { CitationsLive } from "@/lib/scope/result-adapter";

// 표준 도메인 순위 엑셀 내보내기(P6 B048).
//
// 종전 `void downloadXlsx(...)` 는 생성 실패(exceljs 청크 로드 실패·워크북 오류)를 삼켜 "버튼이 안
// 먹는다"로만 보였고, 생성 중에도 버튼이 살아 있어 연타마다 파일이 다시 만들어졌다. 이제 버튼은
// 한 번에 하나만 돌리고(생성 중 비활성 + aria-busy), 실패는 기존 문구(standardPromptsView.exportFailed)
// 토스트로 알린다. 정적 렌더에는 클릭이 없어서, 버튼 배선은 생성 상태 훅을 바꿔 끼워 확인하고
// 실패 경로는 실제 downloadXlsx(노드에는 document 가 없어 저장 단계에서 실패한다)로 확인한다.

vi.mock("next/navigation", () => ({
  usePathname: () => "/ko/standard/answer-analysis/citation",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));
const st = vi.hoisted(() => ({ busy: null as boolean | null }));
vi.mock("./citations-view", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./citations-view")>();
  return {
    ...actual,
    // st.busy null = the real hook (the default render); true / false = a fixed export state
    useExportTask: (onError: (e: unknown) => void) =>
      st.busy === null ? actual.useExportTask(onError) : { busy: st.busy, run: async () => {} },
  };
});

const { CitationsStandardView } = await import("./citations-standard-view");
const { runExportTask } = await import("./citations-view");
const { downloadXlsx } = await import("@/lib/export/xlsx");

const LIVE: CitationsLive = {
  summary: { total: 100, uniqueDomains: 2, officialOwnShare: 40 },
  asOf: "2026-09-21",
  domains: [
    { domain: "hyundai.com", citations: 40, share: 40, prompts: 3, coverageRate: 5, urls: [], promptList: [], isOurs: true, category: "Official (HMG)", subcategory: null },
    { domain: "jdpower.com", citations: 60, share: 60, prompts: 2, coverageRate: 4, urls: [], promptList: [], isOurs: false, category: "Automotive Media", subcategory: null },
  ],
  categories: [
    { name: "Official (HMG)", value: 40 },
    { name: "Automotive Media", value: 60 },
  ],
  trend: null,
  categoryTrend: null,
  engineCategories: null,
  promptSplit: null,
};

function render(data: CitationsLive) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <CitationsStandardView data={data} typeCategories={[]} toneSummary={null} />
    </NextIntlClientProvider>,
  );
}

/** The export button's opening tag (the only button carrying the "Excel 내보내기" label). */
function exportButton(html: string): string {
  const label = ko.answerAnalysis.exportExcel;
  const end = html.indexOf(label);
  expect(end, "export button not found").toBeGreaterThan(0);
  const start = html.lastIndexOf("<button", end);
  return html.slice(start, html.indexOf(">", start) + 1);
}

describe("표준 도메인 순위 엑셀 — 생성 중 비활성, 실패는 기존 문구 (P6 B048)", () => {
  it("평소: 행이 있으면 활성, aria-busy 없음(종전 마크업); 행이 없으면 종전대로 비활성", () => {
    st.busy = null;
    const idle = exportButton(render(LIVE));
    expect(idle).not.toContain('disabled=""');
    expect(idle).not.toContain("aria-busy");
    expect(exportButton(render({ ...LIVE, domains: [] }))).toContain('disabled=""');
  });

  it("생성 중: 버튼 비활성 + aria-busy (연타 = 중복 파일 생성 방지)", () => {
    st.busy = true;
    const busy = exportButton(render(LIVE));
    expect(busy).toContain('disabled=""');
    expect(busy).toContain('aria-busy="true"');
    st.busy = false;
    expect(exportButton(render(LIVE))).not.toContain('disabled=""');
    st.busy = null;
  });

  it("생성 실패(저장 단계 오류)는 삼켜지지 않고 onError(기존 문구 토스트)로 간다, 끝나면 다시 활성", async () => {
    const guard = { current: false };
    const busy: boolean[] = [];
    const onError = vi.fn();
    await runExportTask(guard, (b) => busy.push(b), () => downloadXlsx("citation-sources-test", ["#"], [[1]]), onError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toMatch(/document is not defined/);
    expect([busy, guard.current]).toEqual([[true, false], false]);
    // the notice text is the existing key (no new copy)
    expect(ko.standardPromptsView.exportFailed).toBeTruthy();
  });
});
