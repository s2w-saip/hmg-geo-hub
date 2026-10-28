import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import { readSourceText } from "@/test/source-text";
import { RnSavedFiltersSection, useSavedFilters, type SavedFilter, type SavedFiltersSource } from "./saved-filters";

// Saved filters (2026-10-28): per account on the server. The panel's first render from the list the page
// read with it (or a loading row when the page could not read it), and every message the panel uses.

const ITEMS: SavedFilter[] = [
  { id: "a", name: "독일 전기차", isDefault: false, query: "geography=DE&engine=chatgpt" },
  { id: "b", name: "유럽", isDefault: true, query: "geography=DE~FR" },
];

function Section({ source, activeId, currentQuery }: { source: SavedFiltersSource; activeId: string | null; currentQuery: string }) {
  const saved = useSavedFilters(source);
  return (
    <RnSavedFiltersSection saved={saved} activeId={activeId} onActivate={() => {}} currentQuery={currentQuery} summarize={(q) => q} hrefOf={(q) => q} />
  );
}

const html = (initial: SavedFilter[] | null, { activeId = null as string | null, currentQuery = "" } = {}) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <Section source={{ page: "overview", userId: "u1", initial }} activeId={activeId} currentQuery={currentQuery} />
    </NextIntlClientProvider>,
  );
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((s) => s.trim().replaceAll("&amp;", "&"))
    .filter(Boolean);
const saveButton = (markup: string) => markup.match(/<button[^>]*>\+ 현재 조건 저장<\/button>/)?.[0] ?? "";

describe("saved filters panel", () => {
  it("shows the list the page read: order, the one default, conditions and the active filter", () => {
    const markup = html(ITEMS, { activeId: "a", currentQuery: "geography=DE&engine=chatgpt" });
    expect(text(markup)).toEqual(["저장한 필터", "+ 현재 조건 저장", "독일 전기차", "geography=DE&engine=chatgpt", "★", "유럽", "geography=DE~FR"]);
    expect(markup.match(/aria-pressed="true"[^>]*data-fk="p:a"|data-fk="p:a"[^>]*aria-pressed="true"/)).not.toBeNull();
    expect(saveButton(markup)).not.toContain('aria-disabled="true"');
  });

  it("asks to overwrite or save anew when the active filter's conditions changed", () => {
    expect(text(html(ITEMS, { activeId: "a", currentQuery: "geography=FR" }))).toContain("‘독일 전기차’에서 조건이 바뀌었습니다");
    expect(text(html(ITEMS, { activeId: "a", currentQuery: "engine=chatgpt&geography=DE" })).join(" ")).not.toContain("바뀌었습니다");
  });

  it("an empty list says what saving does; nothing to save keeps the button off", () => {
    const markup = html([]);
    expect(text(markup)).toContain(ko.renewal.saved.empty);
    expect(saveButton(markup)).toContain('aria-disabled="true"');
  });

  it("when the page could not read the list: a loading row (no empty text) and saving off until it arrives", () => {
    const markup = html(null, { currentQuery: "brand=Kia" });
    expect(markup).toContain(`role="status" aria-label="${ko.renewal.saved.loading}"`);
    expect(text(markup)).not.toContain(ko.renewal.saved.empty);
    expect(saveButton(markup)).toContain('aria-disabled="true"');
  });

  it("every message the panel uses exists in ko and en", () => {
    const source = readSourceText(fileURLToPath(new URL("./saved-filters.tsx", import.meta.url)));
    const keys = [...new Set([...source.matchAll(/\bt\("(\w+)"/g)].map((m) => m[1]))];
    expect(keys.length).toBeGreaterThan(20);
    for (const [locale, messages] of [["ko", ko], ["en", en]] as const) {
      const saved = messages.renewal.saved as Record<string, string>;
      expect(keys.filter((k) => typeof saved[k] !== "string"), locale).toEqual([]);
    }
  });
});
