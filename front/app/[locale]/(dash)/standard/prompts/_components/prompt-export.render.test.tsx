import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import { StandardPromptReadonlyList } from "./prompt-list-readonly";
import type { PromptRow, PromptsPage } from "../_data/screen-types";

// 내보내기 버튼의 **렌더 실측** — 정적 검사가 아니라 실제 렌더러로 마크업을 뽑는다
// (형제 파일 prompt-list-readonly.render.test.tsx 와 같은 방식).

function row(i: number): PromptRow {
  return {
    id: `id-${i}`,
    text: `prompt ${i}`,
    brand: "Hyundai",
    brandPresence: "branded",
    listType: "Brand Message",
    depth1: "D1",
    depth2: null,
    depth3: null,
    depth4: null,
    funnelStage: "인지/탐색",
    kind: "single",
    regions: ["KR"],
    lang: "KO",
    scopePromptId: `scope-${i}`,
    presence: "branded",
    common: false,
    markets: { real: ["KR"], pseudo: [] },
  };
}

/** One server page: the first 50 of `total` rows. */
function render(total: number, locale: "ko" | "en") {
  const rows = Array.from({ length: Math.min(total, 50) }, (_, i) => row(i));
  const initial: PromptsPage = {
    rows, total, count: total, offset: 0, limit: 50, page: 1, pages: Math.max(1, Math.ceil(total / 50)),
    rangeFrom: total ? 1 : 0, rangeTo: rows.length, facets: {}, columns: ["listType", "depth1"], collation: "ko",
  };
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">
      <StandardPromptReadonlyList
        remote={{ initial, load: async () => initial, exportRows: async () => ({ rows, columns: initial.columns }) }}
        scopeAll
        scopeRole="admin"
        scopeBrands={[]}
        scopeRegions={[]}
        scopeCountries={[]}
      />
    </NextIntlClientProvider>,
  );
}

describe("내보내기 버튼 — 렌더", () => {
  it("ko/en 양쪽에서 사전 문구로 렌더된다 (원시 키가 새지 않는다)", () => {
    expect(render(1, "ko")).toContain(ko.standardPromptsView.exportLabel);
    expect(render(1, "en")).toContain(en.standardPromptsView.exportLabel);
    expect(render(1, "ko")).not.toContain("exportLabel");
  });

  // 라벨을 감싸는 <button …> 여는 태그를 잘라낸다(마크업 기준 판정).
  // ⚠️ 단순 "disabled" 부분일치는 못 쓴다 — Button 의 Tailwind 클래스에
  // `disabled:pointer-events-none` 이 항상 들어 있어 언제나 참이 된다. **속성** `disabled=""` 만 본다.
  const buttonTagFor = (html: string, label: string) => {
    const at = html.indexOf(label);
    expect(at).toBeGreaterThan(-1);
    const open = html.lastIndexOf("<button", at);
    return html.slice(open, html.indexOf(">", open) + 1);
  };
  const isDisabled = (tag: string) => /\sdisabled=""/.test(tag);

  it("행이 0건이면 비활성이다 (빈 워크북을 만들지 않는다)", () => {
    expect(isDisabled(buttonTagFor(render(0, "ko"), ko.standardPromptsView.exportLabel))).toBe(true);
  });

  it("행이 있으면 활성이다", () => {
    expect(isDisabled(buttonTagFor(render(1, "ko"), ko.standardPromptsView.exportLabel))).toBe(false);
  });

  it("전체가 한 페이지(50행)를 넘어도 버튼은 하나고, 화면은 받은 페이지만 그린다", () => {
    const html = render(60, "ko");
    expect(html.split(ko.standardPromptsView.exportLabel).length - 1).toBe(1);
    expect(html).toContain("prompt 0");
    expect(html).not.toContain(">prompt 55<");
  });
});
