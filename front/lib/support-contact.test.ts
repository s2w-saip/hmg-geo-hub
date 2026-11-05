import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import { FEEDBACK_EMAILS as NOTICE_EMAILS } from "@/components/dash/beta-notice";
import { FEEDBACK_EMAILS, FEEDBACK_EMAIL_TEXT, SUPPORT } from "./support-contact";

// 2026-11-05 (사용자 '명확히 집계가 실패했다고 명시하고, 담당자 연락처도 공지해야지'): the aggregation-failure notices say
// that the aggregation failed and name the operations contact, the same addresses as the beta notice, from one place.
const NOTICES = [
  "answerAnalysis.mentions.kpi.degraded",
  "answerAnalysis.mentions.kpi.degradedTrend",
  "renewal.mention.degraded.all",
  "renewal.mention.degraded.trend",
  "dashError.description",
] as const;

describe("aggregation-failure notices", () => {
  it("say it failed and name the contact, in both languages", () => {
    for (const [locale, messages, failed] of [["ko", ko, "실패했습니다"], ["en", en, "failed"]] as const) {
      const t = createTranslator({ locale, messages });
      for (const key of NOTICES) {
        const text = t(key as never, SUPPORT);
        expect(text, `${locale} ${key}`).toContain(failed);
        expect(text, `${locale} ${key}`).toContain(FEEDBACK_EMAIL_TEXT);
        expect(text, `${locale} ${key}`).not.toContain("{contact}");
      }
    }
  });
  it("the contact is the beta notice's addresses, kept in one place", () => {
    expect(NOTICE_EMAILS).toBe(FEEDBACK_EMAILS);
    expect(FEEDBACK_EMAIL_TEXT).toBe(FEEDBACK_EMAILS.join(", "));
  });
});
