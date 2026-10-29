import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { FEEDBACK_EMAILS, FEEDBACK_EMAIL_TEXT } from "./beta-notice";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";

// 2026-08-28 고객 요청: 메일 클릭 = 아웃룩 연결(mailto) → **클립보드 복사**.
// 이 리포에는 jsdom/testing-library 가 없어 클릭 동작을 단위 테스트로 재현할 수
// 없다(컴포넌트 테스트 관례가 react-dom/server 스모크다). 그래서 여기서는
// **되돌아가면 즉시 드러나는 계약**만 기계로 고정하고, 실제 복사 동작은 프리뷰
// 브라우저 실측으로 확인한다(PR 본문 참조).

const SRC = readFileSync("components/dash/beta-notice.tsx", "utf-8");

describe("베타 안내 — 메일 클릭은 복사다", () => {
  it("mailto: 가 남아 있지 않다", () => {
    expect(SRC).not.toContain("mailto:");
  });

  it("메일 표면 2곳이 <a> 가 아니라 <button type=\"button\"> 이다", () => {
    // 이동이 아니라 복사이므로 링크 관용구(새 탭·주소 복사)가 의미를 잃는다.
    const buttons = [...SRC.matchAll(/<button\s+type="button"\s+onClick=\{copy\}/g)];
    expect(buttons).toHaveLength(2); // 배너 + 팝업
  });

  it("두 주소를 한 번에 복사한다 (안내문 '두 주소 모두 포함'과 정합)", () => {
    expect(FEEDBACK_EMAIL_TEXT).toBe("geo@hyundai.com, geo@innocean.com");
    for (const e of FEEDBACK_EMAILS) expect(FEEDBACK_EMAIL_TEXT).toContain(e);
  });

  it("클립보드 실패 폴백이 있다 (비보안 컨텍스트·권한 거부)", () => {
    expect(SRC).toContain("legacyCopy");
    expect(SRC).toContain("document.execCommand");
  });

  it("복사 결과가 사용자에게 보인다 (aria-live + 상태 문구)", () => {
    expect(SRC).toContain('aria-live="polite"');
    for (const m of [ko, en] as unknown as Array<{ betaNotice: Record<string, string> }>) {
      expect(m.betaNotice.copied).toBeTruthy();
      expect(m.betaNotice.copyFailed).toBeTruthy();
    }
  });

  it("라벨이 '보내기'가 아니라 '복사' 의미다 (ko/en 모두)", () => {
    expect(ko.betaNotice.mailLabel).toContain("복사");
    expect(en.betaNotice.mailLabel.toLowerCase()).toContain("copy");
  });
});
