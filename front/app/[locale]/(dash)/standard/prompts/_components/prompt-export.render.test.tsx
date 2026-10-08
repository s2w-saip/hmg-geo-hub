import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import {
  StandardPromptReadonlyList,
  type StandardPromptViewRow,
} from "./prompt-list-readonly";

// 내보내기 버튼의 **렌더 실측** — 정적 검사가 아니라 실제 렌더러로 마크업을 뽑는다
// (형제 파일 prompt-list-readonly.render.test.tsx 와 같은 방식).

function row(i: number): StandardPromptViewRow {
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
  };
}

function render(rows: StandardPromptViewRow[], locale: "ko" | "en") {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      <StandardPromptReadonlyList
        rows={rows}
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
    expect(render([row(1)], "ko")).toContain(ko.standardPromptsView.exportLabel);
    expect(render([row(1)], "en")).toContain(en.standardPromptsView.exportLabel);
    // 키 문자열이 그대로 그려지는 전형적 누락 지문
    expect(render([row(1)], "ko")).not.toContain("exportLabel");
  });

  // 라벨을 감싸는 <button …> 여는 태그를 잘라낸다(마크업 기준 판정).
  // ⚠️ 단순 "disabled" 부분일치는 못 쓴다 — Button 의 Tailwind 클래스에
  // `disabled:pointer-events-none` 이 항상 들어 있어 언제나 참이 된다
  // (2026-09-16 렌더 실측으로 발견). **속성** `disabled=""` 만 본다.
  const buttonTagFor = (html: string, label: string) => {
    const at = html.indexOf(label);
    expect(at).toBeGreaterThan(-1);
    const open = html.lastIndexOf("<button", at);
    return html.slice(open, html.indexOf(">", open) + 1);
  };
  const isDisabled = (tag: string) => /\sdisabled=""/.test(tag);

  it("행이 0건이면 비활성이다 (빈 워크북을 만들지 않는다)", () => {
    expect(isDisabled(buttonTagFor(render([], "ko"), ko.standardPromptsView.exportLabel))).toBe(true);
  });

  it("행이 있으면 활성이다", () => {
    expect(isDisabled(buttonTagFor(render([row(1)], "ko"), ko.standardPromptsView.exportLabel))).toBe(false);
  });

  it("행이 있으면 활성이고, 페이지(50행)를 넘겨도 버튼은 하나다", () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(i));
    const html = render(rows, "ko");
    const occurrences = html.split(ko.standardPromptsView.exportLabel).length - 1;
    expect(occurrences).toBe(1);
    // 화면은 1페이지(50행)만 그린다 — 그런데도 내보내기는 60행 전량이어야 한다.
    // 그 계약은 아래 소스 가드가 지킨다.
    expect(html).toContain("prompt 0");
    expect(html).not.toContain(">prompt 55<");
  });
});

describe("paged export keeps all filtered rows", () => {
  it("exports more than the visible 50 rows in their server order", async () => {
    const { exportCatalogPages } = await import("@/lib/standards/catalog-page");
    const all = Array.from({ length: 12005 }, (_, i) => row(i));
    const calls: number[] = [];
    const exported = await exportCatalogPages(async q => {
      calls.push(q.offset!);
      expect(q.search).toBe("prompt");
      expect(q.sort).toBe("text");
      return { rows: all.slice(q.offset, q.offset! + q.limit!) as never[], total: all.length,
        count: all.length, offset: q.offset!, limit: q.limit!, facets: {}, columns: [] };
    }, { search: "prompt", sort: "text", offset: 100, limit: 50 });
    expect(exported).toEqual(all);
    expect(calls).toEqual(Array.from({ length: 25 }, (_, i) => i * 500));
  });
});
