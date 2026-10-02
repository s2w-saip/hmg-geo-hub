import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type { AllowedScope } from "@/lib/auth/types";
import { AccountScopeChips } from "./account-scope-chips";

// 계정 스코프 칩의 국가 라벨 — 가상코드·의사코드가 들어와도 렌더가 죽지 않아야 한다.
// 2026-09-29 운영 실측: hyundai-cpo([CPO,US])로 /ko/website 접속 시
// `RangeError: invalid_argument at DisplayNames.of` 로 페이지 에러 경계가 떴다
// (칩이 계정 원본 countries 를 가드 없이 Intl 에 넘겼다). 국가 5개 이하일 때만
// 목록 분기를 타므로 소규모 가상코드 계정만 걸렸다.

function render(countries: string[], locale: "ko" | "en" = "ko"): string {
  const scope: AllowedScope = {
    all: false,
    brands: ["Hyundai"],
    regions: ["hyundai-north-america"],
    countries,
  };
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      <AccountScopeChips scope={scope} />
    </NextIntlClientProvider>,
  );
}

describe("AccountScopeChips — country labels never throw", () => {
  it("[CPO, US] renders: CPO as raw code, US as a country name", () => {
    const html = render(["CPO", "US"]);
    expect(html).toContain("CPO, 미국");
  });

  it("[CN-BJ, CN] renders the pseudo-country label", () => {
    const html = render(["CN-BJ", "CN"]);
    expect(html).toContain("중국-베이징, 중국");
  });

  it("[worldwide, KR] renders the virtual-code i18n label", () => {
    const html = render(["worldwide", "KR"]);
    expect(html).toContain("월드와이드(글로벌), 대한민국");
  });

  it("[MIDDLEEAST, SA] renders the hub label (ko and en)", () => {
    expect(render(["MIDDLEEAST", "SA"])).toContain("중동 허브(MENA), 사우디아라비아");
    expect(render(["MIDDLEEAST", "SA"], "en")).toContain("Middle East Hub (MENA), Saudi Arabia");
  });

  it("[HYUNDAI-N, EU] renders the brand virtual code and EU hub labels", () => {
    expect(render(["HYUNDAI-N", "EU"])).toContain("현대 N, 유럽 허브(EU)");
  });
});
