import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { GeoRegionRow, LiveGeo } from "../_data/live-types";
import { GeoSnapshot } from "./geo-snapshot";

// 답변은 있는데 브랜드 언급이 0 인 시장은 점유율 0/0 이다 — 순위 "#1"·"0.0%" 가 아니라 "—"(지도와 같은 표기).

vi.mock("next-intl/server", () => ({ getRequestConfig: <T,>(fn: T) => fn }));

const { loadMessages } = await import("@/i18n/request");

const market = (o: Partial<GeoRegionRow>): GeoRegionRow => ({
  region: "kia-europe",
  hmgSov: 0,
  hmgRank: 1,
  fieldSize: 1,
  topBrand: null,
  topRival: null,
  countries: [],
  ...o,
});

async function render(geo: LiveGeo): Promise<string> {
  const messages = await loadMessages("ko");
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={messages} timeZone="Asia/Seoul">
      <GeoSnapshot geo={geo} />
    </NextIntlClientProvider>,
  );
}

describe("GeoSnapshot: market without mentions", () => {
  it("shows — instead of #1 · 0.0%", async () => {
    const html = await render({ markets: [market({ noMentions: true })], pending: [], ourLabel: "Kia" });
    expect(html).not.toContain("#1");
    expect(html).not.toContain("0.0%");
    expect(html).toContain("—");
  });

  it("keeps a measured market as before", async () => {
    const html = await render({ markets: [market({ hmgSov: 33.3, hmgRank: 2, fieldSize: 5 })], pending: [], ourLabel: "Kia" });
    expect(html).toContain("#2");
    expect(html).toContain("33.3%");
  });
});
