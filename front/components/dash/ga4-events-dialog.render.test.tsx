import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import u8ko from "@/messages/units/u8.ko.json";
import u8en from "@/messages/units/u8.en.json";

// GA4 전환 이벤트 저장 토스트(B057, U8-N8): api 저장은 재판정 큐에 들어가 다음 적재 뒤 반영된다 — 액션이
// value.notice 로 준 반영 대기 문구(adminGa4.events.savedPending)를 토스트에 쓴다. 현행 원천은 notice = null 이라
// 종전 '저장됨' 문구 그대로다(액션 쪽 notice 계약은 lib/ga4/tracked-events-actions.api.test.ts 가 덮는다).

vi.mock("@/lib/ga4/tracked-events-actions", () => ({
  loadConversionEvents: vi.fn(),
  saveConversionEvents: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { Ga4EventsDialog, savedToastText } = await import("./ga4-events-dialog");

describe("저장 성공 토스트 문구", () => {
  it("notice(반영 대기)가 있으면 그 문구", () => {
    const pending = u8ko.adminGa4.events.savedPending;
    expect(savedToastText({ notice: pending }, ko.adminGa4.events.saved)).toBe(pending);
    expect(savedToastText({ notice: u8en.adminGa4.events.savedPending }, en.adminGa4.events.saved)).toBe(
      u8en.adminGa4.events.savedPending,
    );
  });

  it("notice 가 null 이면(현행 원천·변경 없는 api 저장) 종전 '저장됨'", () => {
    expect(savedToastText({ notice: null }, ko.adminGa4.events.saved)).toBe(ko.adminGa4.events.saved);
  });
});

describe("다이얼로그 마크업", () => {
  it("열기 버튼은 그대로(닫힌 상태에서는 목록을 부르지 않는다)", () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <Ga4EventsDialog propertyId="123" title="KR" />
      </NextIntlClientProvider>,
    );
    expect(html).toContain(ko.adminGa4.events.button);
  });
});
