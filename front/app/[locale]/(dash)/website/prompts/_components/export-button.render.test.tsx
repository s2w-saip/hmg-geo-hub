import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";

// 이 버튼의 계약은 **href 하나**다 — 서버가 그 URL 로 같은 술어를 다시 만든다.
// 현재 화면 URL 의 파라미터를 그대로 싣지 않으면 "화면과 다른 엑셀"이 된다.
// 실제 렌더러로 마크업을 뽑아 href 를 본다(정적 검사 아님).

const search = vi.hoisted(() => ({ value: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search.value),
}));

const { WebsitePromptExportButton } = await import("./export-button");

function render(qs: string, locale: "ko" | "en", disabled = false) {
  search.value = qs;
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      <WebsitePromptExportButton disabled={disabled} />
    </NextIntlClientProvider>,
  );
}

const hrefOf = (html: string) => /href="([^"]*)"/.exec(html)?.[1] ?? "";
// renderToStaticMarkup 은 &amp; 로 이스케이프한다 — URL 로 다루려면 되돌린다.
const paramsOf = (html: string) =>
  new URLSearchParams(hrefOf(html).replace(/&amp;/g, "&").split("?")[1] ?? "");

describe("웹사이트 내보내기 버튼 — href", () => {
  it("현재 필터를 그대로 싣고 locale 을 붙인다", () => {
    const p = paramsOf(render("geography=KR&language=ko&engine=chatgpt&sort=brand&dir=asc", "ko"));
    expect(p.get("geography")).toBe("KR");
    expect(p.get("language")).toBe("ko");
    expect(p.get("engine")).toBe("chatgpt");
    expect(p.get("sort")).toBe("brand");
    expect(p.get("dir")).toBe("asc");
    expect(p.get("locale")).toBe("ko");
  });

  it("다중 선택(같은 키 반복)이 href 에 그대로 남는다", () => {
    const p = paramsOf(render("geography=KR&geography=US", "ko"));
    expect(p.getAll("geography")).toEqual(["KR", "US"]);
  });

  it("?page 는 뺀다 — 내보내기는 정의상 전량이다", () => {
    const p = paramsOf(render("geography=KR&page=3", "ko"));
    expect(p.get("page")).toBeNull();
    expect(p.get("geography")).toBe("KR");
  });

  it("locale 이 en 이면 서버가 영문 헤더로 만든다", () => {
    const html = render("", "en");
    expect(paramsOf(html).get("locale")).toBe("en");
    expect(html).toContain(en.website.prompts.exportLabel);
  });

  it("`download` 속성을 안 붙인다 — 에러 JSON 이 파일로 저장되지 않게", () => {
    // download 가 있으면 브라우저는 응답 내용과 무관하게 저장한다. 성공 응답은
    // 서버가 Content-Disposition: attachment 를 붙이므로 그대로 저장되고,
    // 에러 응답에는 그 헤더가 없어 내용이 보인다(라우트 테스트가 짝을 이룬다).
    const html = render("geography=KR", "ko");
    expect(html).toContain("href=");
    expect(html).not.toMatch(/\sdownload(=|\s|>)/);
  });

  it("라우트 경로가 실제 핸들러와 같다", () => {
    expect(hrefOf(render("", "ko")).startsWith("/api/website/prompts/export?")).toBe(true);
  });

  it("0건이면 링크가 아니라 비활성 버튼이다", () => {
    const html = render("geography=KR", "ko", true);
    expect(html).not.toContain("href=");
    expect(/\sdisabled=""/.test(html)).toBe(true);
    expect(html).toContain(ko.website.prompts.exportLabel);
  });
});
