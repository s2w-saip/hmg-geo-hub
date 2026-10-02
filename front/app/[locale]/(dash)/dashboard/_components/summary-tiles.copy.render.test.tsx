import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { KpiSummary } from "../_data/sample";
import { SummaryTiles } from "./summary-tiles";

// U5 검증 D2: 원천별 카드 문구. messages 는 전역이라 api 문구로 종전 키를 덮으면 legacy(롤백
// 경로)의 라벨이 틀어진다. 그래서 api 카드만 KpiSummary.copyVariant="api" 를 달고, 타일이
// 분자·분모 라벨과 정의·산식 툴팁을 dashboard.kpi.api.*(messages/units/u5)에서 고른다.
//   ⑦ trafficConversion  분모 = 세션(DC-03), 종전 = AI 채널 활성사용자
//   ownedUrlRate·targetUrlRate  측정 단위(DC-02), 종전 = 측정 프롬프트
// 병합 사전은 실제 로더(i18n/request loadMessages)로 만든다: u5 파일이 빠지면 api 라벨이
// 키 문자열로 새어 나와 이 테스트가 깨진다.

vi.mock("next-intl/server", () => ({ getRequestConfig: <T,>(fn: T) => fn }));
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("next/navigation");
  return { ...actual, useSearchParams: () => new URLSearchParams() };
});

const { loadMessages } = await import("@/i18n/request");

const CARDS: KpiSummary[] = [
  { key: "trafficConversion", value: 4.4, delta: null, direction: "flat", ratio: { numerator: 7, denominator: 160 } },
  { key: "ownedUrlRate", value: 30, delta: null, direction: "flat", ratio: { numerator: 12, denominator: 40 } },
  { key: "targetUrlRate", value: 12.5, delta: null, direction: "flat", ratio: { numerator: 5, denominator: 40 } },
];

async function render(items: KpiSummary[], locale: "ko" | "en"): Promise<string> {
  const messages = await loadMessages(locale);
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
      <TooltipProvider>
        <SummaryTiles items={items} perturb={false} />
      </TooltipProvider>
    </NextIntlClientProvider>,
  );
}

type Tree = Record<string, unknown>;
const at = (tree: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Tree)[k] : undefined), tree);

describe("summary tiles: ratio labels by source (U5 D2)", () => {
  it.each([
    ["ko", ["AI 채널 세션", "자사 URL 인용 측정", "타겟 URL 인용 측정", "완료 측정"], ["AI 채널 활성사용자", "측정 프롬프트"]],
    ["en", ["AI-channel sessions", "Measurements citing owned URL", "Measurements citing target URL", "Completed measurements"], ["AI-channel active users", "Measured prompts"]],
  ] as const)("%s: api cards read the api wording, legacy cards keep the legacy wording", async (locale, apiWords, legacyWords) => {
    const api = await render(CARDS.map((c) => ({ ...c, copyVariant: "api" as const })), locale);
    const legacy = await render(CARDS, locale);
    for (const w of apiWords) {
      expect(api, `api has ${w}`).toContain(w);
      expect(legacy, `legacy lacks ${w}`).not.toContain(w);
    }
    for (const w of legacyWords) {
      expect(api, `api lacks ${w}`).not.toContain(w);
      expect(legacy, `legacy has ${w}`).toContain(w);
    }
    expect(api).not.toContain("dashboard.kpi");
  });

  it.each(["ko", "en"] as const)("%s: every api key the tile can ask for exists (tooltip definition and formula too)", async (locale) => {
    const m = await loadMessages(locale);
    for (const key of ["trafficConversion", "ownedUrlRate", "targetUrlRate"]) {
      for (const part of [`ratio.${key}.num`, `ratio.${key}.den`, `definition.${key}`, `formula.${key}`]) {
        expect(typeof at(m, `dashboard.kpi.api.${part}`), `${locale}: dashboard.kpi.api.${part}`).toBe("string");
        // the legacy key (rollback path) is still there
        expect(typeof at(m, `dashboard.kpi.${part}`), `${locale}: dashboard.kpi.${part}`).toBe("string");
      }
    }
  });
});
