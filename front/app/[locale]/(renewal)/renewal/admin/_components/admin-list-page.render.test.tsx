import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { useAdminListPage } from "./admin-list-page";

// The pages of an admin list (2026-11-05): the first page of 50 and the pager under the table, as first rendered.

function List({ n }: { n: number }) {
  const paged = useAdminListPage(
    Array.from({ length: n }, (_, i) => i + 1),
    [],
  );
  return (
    <div>
      {paged.rows.map((r) => (
        <i key={r} data-row={r} />
      ))}
      {paged.pager}
    </div>
  );
}
const html = (n: number) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <List n={n} />
    </NextIntlClientProvider>,
  );
const rowsOf = (out: string) => [...out.matchAll(/data-row="(\d+)"/g)].map(([, r]) => Number(r));

describe("admin list pages", () => {
  it("shows the first 50 rows and the pages after them", () => {
    const out = html(1205);
    expect(rowsOf(out)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(out).toContain("1–50 / 1,205");
    expect(out).toContain("1 / 25 페이지");
    expect(out).toMatch(/<option value="50" selected="">페이지당 50<\/option>/);
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>.*?이전<\/button>/);
    expect(out).toMatch(/<button(?![^>]*disabled="")[^>]*>다음/);
  });

  it("a list of one page has the range and size only", () => {
    const out = html(6);
    expect(rowsOf(out)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out).toContain("1–6 / 6");
    expect(out).not.toContain("이전");
    expect(out).not.toContain("다음");
  });
});
