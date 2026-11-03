import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RnRoundCalendar, type RnDayRange } from "./round-calendar";

// The renewal round picker opens on the month of the picked period's end. A period past the last round — a URL or a
// saved filter from before the service week (2026-11-02), e.g. a 월간 saved as 10-04..11-02 — opened on a month
// where every day is disabled; it now opens on the nearest month that has rounds.

const ROUNDS = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"];
const LABELS = {
  prev: "prev",
  next: "next",
  noRound: "no round",
  defaultRound: "default",
  weekdays: ["S", "M", "T", "W", "T", "F", "S"],
  month: (y: number, m: number) => `${y}-${m}`,
};
const cal = (value: RnDayRange) =>
  renderToStaticMarkup(<RnRoundCalendar selectableDates={ROUNDS} value={value} onChange={() => {}} defaultDay={null} labels={LABELS} />);
const monthOf = (html: string) => /<span class="tabular-nums">([^<]+)<\/span>/.exec(html)?.[1] ?? null;
const enabled = (html: string, day: string) => {
  const tag = new RegExp(`<button[^>]*data-day="${day}"[^>]*>`).exec(html)?.[0] ?? "";
  return tag !== "" && !tag.includes("disabled");
};

describe("RnRoundCalendar: the month it opens on", () => {
  it("a period that ends past the last round opens on the last round's month, with its rounds", () => {
    const html = cal({ from: "2026-10-04", to: "2026-11-02" });
    expect(monthOf(html)).toBe("2026-10");
    expect(enabled(html, "2026-10-05")).toBe(true);
  });

  it("a period before the first round opens on the first round's month", () => {
    expect(monthOf(cal({ from: "2025-01-01", to: "2025-02-01" }))).toBe("2026-9");
  });

  it("inside the rounds it is the period's end month, and with no period the latest round's (as before)", () => {
    expect(monthOf(cal({ from: "2026-09-07", to: "2026-09-21" }))).toBe("2026-9");
    expect(monthOf(cal({ from: "2026-09-28" }))).toBe("2026-9");
    expect(monthOf(cal({}))).toBe("2026-10");
  });
});
