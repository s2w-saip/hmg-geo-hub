import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SectionDoneMarker } from "./section-marker";

describe("SectionDoneMarker", () => {
  it("프로브가 찾는 속성을 가진, 사용자에게 안 보이는 요소 하나를 낸다", () => {
    const html = renderToStaticMarkup(<SectionDoneMarker id="dashboard:geo" />);
    expect(html).toContain('data-hmg-section-done="dashboard:geo"');
    // hidden = UA 스타일시트의 display:none → flex/grid 아이템으로도 세지 않는다.
    expect(html).toContain("hidden");
    // 텍스트를 내지 않는다 (레이아웃·스크린리더 무영향).
    expect(html.replace(/<[^>]*>/g, "")).toBe("");
  });
});
