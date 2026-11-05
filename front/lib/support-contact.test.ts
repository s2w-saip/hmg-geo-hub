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
  // the same rule for every 'could not load' notice of a screen's data (2026-11-05 '같은 기준으로 붙여줘야지'): the
  // titles say what failed and their description carries the contact (dashError, the visibility / conversion cards)
  it("every load-failure notice names the contact, in both languages", () => {
    const TITLES = new Set(["dashError.title", "renewal.visibility.states.downTitle", "renewal.conversion.states.downTitle"]);
    const leaves = (o: unknown, p = ""): [string, string][] =>
      typeof o === "string" ? [[p, o]] : o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => leaves(v, p ? `${p}.${k}` : k)) : [];
    const load = leaves(ko).filter(([p, v]) => /불러오지 못(했|해)/.test(v) && !TITLES.has(p)).map(([p]) => p);
    expect(load.length).toBeGreaterThan(20);
    const value = (m: unknown, p: string) => p.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], m);
    for (const p of [...load, "renewal.visibility.states.downDesc", "renewal.conversion.states.downDesc"])
      for (const [locale, messages] of [["ko", ko], ["en", en]] as const) {
        expect(value(messages, p), `${locale} ${p}`).toContain("{contact}");
        expect(createTranslator({ locale, messages })(p as never, SUPPORT), `${locale} ${p}`).toContain(FEEDBACK_EMAIL_TEXT);
      }
  });
  it("the contact is the beta notice's addresses, kept in one place", () => {
    expect(NOTICE_EMAILS).toBe(FEEDBACK_EMAILS);
    expect(FEEDBACK_EMAIL_TEXT).toBe(FEEDBACK_EMAILS.join(", "));
  });
});
