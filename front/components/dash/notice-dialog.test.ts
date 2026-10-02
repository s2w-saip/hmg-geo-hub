import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";

// 알림 팝업 공용 템플릿 계약. jsdom 이 없어 열림·닫힘은 프리뷰 브라우저 실측으로
// 확인하고, 여기서는 되돌아가면 즉시 드러나는 배선만 고정한다.

const read = (p: string) => readFileSync(p, "utf-8");
const BETA = read("components/dash/beta-notice.tsx");
const CONV = read(
  "app/[locale]/(dash)/standard/ai-funnel/_components/conversion-sample-notice-dialog.tsx",
);
const CONV_PAGE = read("app/[locale]/(dash)/standard/ai-funnel/conversion/page.tsx");
const CONV_LAYOUT = read("app/[locale]/(dash)/standard/ai-funnel/conversion/layout.tsx");

describe("알림 팝업 — 메인 팝업과 같은 템플릿", () => {
  it("메인 팝업과 Conversion 안내 팝업이 같은 틀(NoticeDialogFrame)을 쓴다", () => {
    for (const src of [BETA, CONV]) expect(src).toContain("<NoticeDialogFrame");
  });

  it("메인 팝업은 세션 1회·오늘 다시 보지 않기(primary) 그대로다", () => {
    expect(BETA).toMatch(/useSessionNotice\(\{[^}]*primary: true/);
    expect(BETA).toContain("onHideToday={hideToday}");
  });

  it("Conversion 안내 팝업은 조건 없이 뜬다 (저장소·오늘 다시 보지 않기 없음)", () => {
    expect(CONV).toContain("usePageNotice()");
    expect(CONV).not.toContain("useSessionNotice");
    expect(CONV).not.toContain("onHideToday");
    expect(CONV).not.toMatch(/sessionStorage|localStorage/);
  });

  it("레이아웃에 마운트한다 (필터·기간 변경마다 다시 뜨지 않게)", () => {
    expect(CONV_LAYOUT).toContain("<ConversionSampleNoticeDialog />");
    expect(CONV_PAGE).not.toContain("ConversionSampleNoticeDialog");
  });

  it("안내 문구가 ko/en 모두 있다", () => {
    for (const m of [ko, en]) {
      const n = m.aiFunnelConversion.sampleNotice;
      expect(n.title).toBeTruthy();
      expect(n.line1).toContain("Google Analytics");
      expect(n.line2).toContain("Kia Italy");
    }
    expect(ko.aiFunnelConversion.sampleNotice.line1).toContain("유입율과 전환율");
    expect(en.aiFunnelConversion.sampleNotice.line1).toContain("conversion rates");
  });
});
