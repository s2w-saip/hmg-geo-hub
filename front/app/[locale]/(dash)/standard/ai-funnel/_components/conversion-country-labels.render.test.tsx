import { describe, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes } from "react";

// UnmappedNotice 가 로케일 Link 를 import 한다 — vitest 에선 next/navigation 을 못 풀므로
// 단순 앵커로 바꾼다(링크는 이 테스트의 관심사가 아니다).
vi.mock("@/i18n/navigation", () => ({
  Link: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}));
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { CountryConversionTable, groupConversionByRegion } from "./conversion-countries-table";
import { ConversionPendingNotice } from "./conversion-pending-notice";
import { ConversionUnmappedNotice } from "./conversion-unmapped-notice";

// 전환 화면의 국가 라벨 — 입력은 GA4 매핑 카탈로그(ga4_properties.country_code ∪ 레거시
// env MAP)다. 관리자 GA4 화면이 자유 입력(<Input>, 서버는 trim·대문자만)이라 ISO 가
// 보장되지 않는다. 비ISO 코드가 들어와도 렌더가 죽지 않고, 의사 코드는 정본 라벨로 푼다
// (country-name::countryName 경유).

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}

const row = (country: string) => ({
  brand: "Hyundai",
  country,
  aiConvRate: 0.1,
  humanConvRate: 0.05,
  lift: 2,
  aiUsers: 10,
  humanUsers: 100,
});

describe("conversion country labels never throw on non-ISO codes", () => {
  it("CountryConversionTable renders CPO raw and CN-BJ as its pseudo label", () => {
    const html = render(
      <CountryConversionTable rows={[row("CPO"), row("CN-BJ"), row("US")]} activeBrand="Hyundai" />,
    );
    expect(html).toContain("CPO");
    expect(html).toContain("중국-베이징");
    expect(html).toContain("미국");
  });

  it("ConversionPendingNotice resolves a pseudo code", () => {
    expect(render(<ConversionPendingNotice brand="Hyundai" country="CN-BJ" />)).toContain(
      "중국-베이징",
    );
  });

  it("ConversionUnmappedNotice resolves a pseudo code", () => {
    expect(render(<ConversionUnmappedNotice brand="Hyundai" country="CN-BJ" />)).toContain(
      "중국-베이징",
    );
  });
});

describe("groupConversionByRegion", () => {
  // A 1/10(10.0%), B 2/12(16.7%) — 한 권역(activeBrand null = 단일 그룹)
  const a = { brand: "Hyundai", country: "US", aiConvRate: 10, humanConvRate: 10, lift: 0, aiUsers: 10, humanUsers: 10 };
  const b = { brand: "Hyundai", country: "CA", aiConvRate: 16.7, humanConvRate: 16.7, lift: 0, aiUsers: 12, humanUsers: 12 };

  it("weights the region rate by raw conversions, not by rounded country rates", () => {
    const [g] = groupConversionByRegion(
      [{ ...a, aiKeyEvents: 1, humanKeyEvents: 1 }, { ...b, aiKeyEvents: 2, humanKeyEvents: 2 }],
      null,
    );
    // 3 / 22 = 13.6%. 반올림 전환율로 되살리면 (1 + 2.004) / 22 = 13.7%
    expect([g.aiConvRate, g.humanConvRate, g.aiUsersSum]).toEqual([13.6, 13.6, 22]);
  });

  it("falls back to rate × users for rows without raw conversions", () => {
    const [g] = groupConversionByRegion([a, b], null);
    expect(g.aiConvRate).toBe(13.7);
  });
});
