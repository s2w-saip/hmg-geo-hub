import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { GoogleKeywordView } from "./google-keyword-view";

function render(ui: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("GoogleKeywordView smoke render", () => {
  it("renders the tab strip and the 선택 삭제 entry point", () => {
    const html = render(
      <GoogleKeywordView
        projectId="p1"
        canEdit
        projectCountry="KR"
        allowedCountries={["KR", "US"]}
        initialKeywords={[
          { id: "a", label: "아이오닉5" },
          { id: "b", label: "EV3" },
        ]}
      />,
    );
    expect(html).toContain("아이오닉5");
    expect(html).toContain("EV3");
    expect(html).toContain(ko.projectDetail.intent.googleKeyword.enterSelect);
  });

  it("hides the 선택 삭제 entry point for a read-only viewer", () => {
    const html = render(
      <GoogleKeywordView
        projectId="p1"
        canEdit={false}
        projectCountry="KR"
        allowedCountries={["KR"]}
        initialKeywords={[{ id: "a", label: "아이오닉5" }]}
      />,
    );
    expect(html).not.toContain(ko.projectDetail.intent.googleKeyword.enterSelect);
  });
});
