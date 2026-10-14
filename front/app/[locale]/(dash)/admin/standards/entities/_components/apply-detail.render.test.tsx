import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { loadMessages } from "@/i18n/request";

// Apply detail polling (B082): a failed read no longer polls on without a word. The poll step is a
// plain function (no DOM in this test runner): ok resets the failure count, a failed read counts,
// APPLY_POLL_FAIL_MAX failures in a row stop with the existing pollStopped notice, and a read that
// throws (the action's 401 / 403 UnauthorizedError) stops at once. The first render of a busy apply
// is unchanged (busy line, no pollStopped notice) and the notice key exists in both locales.

vi.mock("../_ecat-actions", () => ({ getApplyAction: vi.fn(), applyStepAction: vi.fn() }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/standards/entities/applies/7",
}));

const { ApplyDetail, APPLY_POLL_FAIL_MAX, pollApplyOnce } = await import("./apply-detail");
const e = await import("@/lib/hgh/adapters/admin-entities");
const { UnauthorizedError } = await import("@/lib/auth/errors");
const { APPLY_POLL_MAX } = await import("@/lib/hgh/ecat-model");

const MESSAGES = { ko: await loadMessages("ko"), en: await loadMessages("en") };
const U = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const apply = (status: string) =>
  e.toApplyDetail({
    apply_id: 7, ver: 3, from_ver: 2, status, scope_kind: "unexposed", from_round_date: null, reason: "fix N", requested_at: "2026-10-01T00:00:00Z",
    requested_by: U(1), approved_at: null, approved_by: null, has_preview: false, requires_approval: false, approver_required: false, can_approve: false,
    actions: [], error_code: null, preview: null, queue: [{ change_id: 1, op: "preview", status: "pending", requested_at: "2026-10-01T00:00:00Z", error: null }],
  } as never);

type Read = Awaited<ReturnType<Parameters<typeof pollApplyOnce>[0]>>;

/** Drives pollApplyOnce like the page does (fails carried over) until it stops or the reads run out. */
async function drive(reads: Array<Read | Error>) {
  let fails = 0;
  const steps: Array<{ ok: boolean; fails: number; stop: boolean }> = [];
  for (const r of reads) {
    const s = await pollApplyOnce(async () => {
      if (r instanceof Error) throw r;
      return r;
    }, fails);
    fails = s.fails;
    steps.push({ ok: s.detail !== null, fails: s.fails, stop: s.stop });
    if (s.stop) break;
  }
  return steps;
}

const OK = { ok: true as const, value: apply("draft") };
const BAD = { ok: false as const, errorKey: "generic" };

describe("apply detail polling stops on failed reads (B082)", () => {
  it("failed reads in a row stop with pollStopped; a good read resets the count", async () => {
    expect(APPLY_POLL_FAIL_MAX).toBe(3);
    expect(APPLY_POLL_FAIL_MAX).toBeLessThan(APPLY_POLL_MAX);
    expect(await drive([BAD, BAD, BAD, OK])).toEqual([
      { ok: false, fails: 1, stop: false },
      { ok: false, fails: 2, stop: false },
      { ok: false, fails: 3, stop: true },
    ]);
    expect(await drive([BAD, BAD, OK, BAD, BAD, OK])).toEqual([
      { ok: false, fails: 1, stop: false },
      { ok: false, fails: 2, stop: false },
      { ok: true, fails: 0, stop: false },
      { ok: false, fails: 1, stop: false },
      { ok: false, fails: 2, stop: false },
      { ok: true, fails: 0, stop: false },
    ]);
  });

  it("a read that throws (401 / 403 refusal) stops at once instead of an unhandled rejection", async () => {
    expect(await drive([OK, new UnauthorizedError("refused"), OK])).toEqual([
      { ok: true, fails: 0, stop: false },
      { ok: false, fails: 1, stop: true },
    ]);
  });

  it("a good read hands the fresh detail over unchanged", async () => {
    const s = await pollApplyOnce(async () => ({ ok: true, value: apply("previewed") }), 2);
    expect(s).toEqual({ detail: apply("previewed"), fails: 0, stop: false });
  });

  for (const locale of ["ko", "en"] as const) {
    it(`${locale}: first render of a busy apply is unchanged (busy line, no pollStopped notice); the notice text exists`, () => {
      const html = renderToStaticMarkup(
        <NextIntlClientProvider
          locale={locale}
          messages={MESSAGES[locale]}
          timeZone="Asia/Seoul"
          onError={(err) => {
            throw err;
          }}
        >
          <ApplyDetail initial={apply("draft")} />
        </NextIntlClientProvider>,
      );
      const stopped = (MESSAGES[locale] as { adminEcat: { applyDetail: { pollStopped: string } } }).adminEcat.applyDetail.pollStopped;
      expect(typeof stopped === "string" && stopped.length > 0).toBe(true);
      expect(html).toContain('data-testid="ecat-apply-busy"');
      expect(html).not.toContain(stopped);
    });
  }
});
