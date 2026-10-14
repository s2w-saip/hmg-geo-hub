"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SectionCard } from "@/components/section-card";
import { APPLY_POLL_MAX, APPLY_POLL_MS, isApplyBusy } from "@/lib/hgh/ecat-model";
import type { AbandonPinsView, ApplyDetailView, EcatResult, LintView } from "@/lib/hgh/adapters/admin-entities";
import { applyStepAction, getApplyAction } from "../_ecat-actions";
import { ApplyStatusBadge, ECAT_BASE, fmtInt, fmtTime, Notice, shortId } from "./ecat-shared";
import { PreviewPanel } from "./preview-view";

// Apply request page (design 3절 ③~⑦): status, the preview once the loader computed it, and the
// actions the backend allows now (actions[]). The page polls while the loader works (preview
// pending, approved waiting for the loader, running). Approval: a range with an exposed round
// needs an approver (can_approve false for other admins, the backend answers 403
// ECAT_EXPOSED_REQUIRES_APPROVAL); an unexposed-only range is approved by the requesting admin.
// "Preview again" follows the draft lint: a current lint with L1 / L3 disables it (the backend would answer
// ECAT_LINT_BLOCKED). Hidden role changes take effect on every period at once, whatever the range.
// Polling stops with the pollStopped notice after APPLY_POLL_MAX polls, after APPLY_POLL_FAIL_MAX failed reads in a
// row, or at once when the read throws (401 / 403 refusals): a failing read no longer polls on without a word.

type Step = "preview" | "approve" | "reject" | "resume" | "abandon" | "rollback";

const PINS_SHOWN = 20;

/** Failed apply reads in a row after which the page stops polling and shows pollStopped. */
export const APPLY_POLL_FAIL_MAX = 3;

export interface ApplyPollStep {
  /** The fresh detail (null when the read failed). */
  detail: ApplyDetailView | null;
  /** Failed reads in a row so far. */
  fails: number;
  /** Stop polling (the page shows pollStopped). */
  stop: boolean;
}

/** One poll of the apply detail: a refused read (the action throws) stops at once, a failed one after APPLY_POLL_FAIL_MAX in a row. */
export async function pollApplyOnce(read: () => Promise<EcatResult<ApplyDetailView>>, fails: number): Promise<ApplyPollStep> {
  try {
    const r = await read();
    if (r.ok) return { detail: r.value, fails: 0, stop: false };
    return { detail: null, fails: fails + 1, stop: fails + 1 >= APPLY_POLL_FAIL_MAX };
  } catch {
    return { detail: null, fails: fails + 1, stop: true };
  }
}

/** Which cycles an abandon pins (before: planned, after: measured) and what that means for later applies (review N2). */
export function AbandonPinsNotice({ pins }: { pins: AbandonPinsView }) {
  const t = useTranslations("adminEcat.applyDetail.abandonPins");
  const ts = useTranslations("adminEcat.apply.scope");
  const tsf = useTranslations("adminEcat.surface");
  if (!pins.cycles.length) {
    return <Notice testId="ecat-abandon-pins">{t(pins.state === "planned" ? "nonePlanned" : "none")}</Notice>;
  }
  const shown = pins.cycles.slice(0, PINS_SHOWN);
  return (
    <Notice tone="warn" testId="ecat-abandon-pins">
      <span className="flex flex-col gap-1">
        <span>{t(pins.state, { count: pins.cycles.length, unexposed: pins.unexposed, scope: ts("unexposed") })}</span>
        {pins.requiresApprovalLater ? <span>{t("approval", { active: pins.activeVer ?? pins.newVer })}</span> : null}
        <span className="flex flex-col gap-0.5 tabular-nums" data-testid="ecat-abandon-pins-list">
          {shown.map((c) => (
            <span key={c.cycKey} data-testid="ecat-abandon-pin">
              {t("cycle", { date: c.roundDate, surface: c.surface ? tsf(c.surface) : "", ver: c.pinVer })}
              {c.exposed ? "" : ` (${t("unexposedTag")})`}
            </span>
          ))}
          {pins.cycles.length > shown.length ? <span>{t("more", { count: pins.cycles.length - shown.length })}</span> : null}
        </span>
      </span>
    </Notice>
  );
}

export function ApplyDetail({
  initial,
  lint = null,
  hiddenFromDiff = null,
}: {
  initial: ApplyDetailView;
  lint?: LintView | null;
  hiddenFromDiff?: number | null;
}) {
  const t = useTranslations("adminEcat.applyDetail");
  const ts = useTranslations("adminEcat.apply.scope");
  const tc = useTranslations("adminEcat.common");
  const te = useTranslations("adminEcat.errors");
  const router = useRouter();
  const [d, setD] = useState(initial);
  const [pending, start] = useTransition();
  const [ask, setAsk] = useState<Step | null>(null);
  const [reason, setReason] = useState("");
  const [polls, setPolls] = useState(0);
  const [pollFailed, setPollFailed] = useState(false);
  const fails = useRef(0);
  const busy = isApplyBusy(d);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!busy || pollFailed || polls >= APPLY_POLL_MAX) return;
    timer.current = setTimeout(async () => {
      const s = await pollApplyOnce(() => getApplyAction(d.applyId), fails.current);
      fails.current = s.fails;
      if (s.detail) {
        const wasBusy = isApplyBusy(d);
        setD(s.detail);
        if (wasBusy && !isApplyBusy(s.detail)) router.refresh();
      }
      if (s.stop) setPollFailed(true);
      else setPolls((n) => n + 1);
    }, APPLY_POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [busy, pollFailed, polls, d, router]);

  function run(step: Step, why: string | null) {
    start(async () => {
      const r = await applyStepAction(d.applyId, step, why);
      if (!r.ok) {
        toast.error(te(r.errorKey));
        return;
      }
      setAsk(null);
      setReason("");
      if (step === "rollback" && r.value.applyId !== d.applyId) {
        toast.success(t("rollbackRequested", { id: r.value.applyId }));
        router.push(`${ECAT_BASE}/applies/${r.value.applyId}`);
        return;
      }
      setD(r.value);
      setPolls(0);
      fails.current = 0;
      setPollFailed(false);
      toast.success(t(`done.${step}`));
      router.refresh();
    });
  }

  const can = (s: Step) => d.actions.includes(s);
  const previewLintBlocked = !!lint && lint.blocked && !lint.stale;
  const hiddenCount = d.preview?.hiddenChanges ?? hiddenFromDiff ?? 0;
  const needsReason = ask === "reject" || ask === "abandon" || ask === "rollback";

  return (
    <div className="flex flex-col gap-6" data-testid="ecat-apply-detail" data-apply-id={d.applyId} data-status={d.status}>
      <SectionCard title={t("title", { id: d.applyId })} description={t("subtitle", { ver: d.ver, from: d.fromVer ?? 0 })}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <ApplyStatusBadge status={d.status} />
            <span>
              {ts(d.scopeKind)}
              {d.fromRoundDate ? ` ${d.fromRoundDate}` : ""}
            </span>
            {d.affectedAnswers != null ? <span>{t("affected", { count: fmtInt(d.affectedAnswers) })}</span> : null}
            {busy ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground" data-testid="ecat-apply-busy">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                {t(d.status === "draft" ? "busyPreview" : "busyApply")}
              </span>
            ) : null}
          </div>
          <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <div>
              <dt className="inline text-muted-foreground">{t("requested")}</dt>{" "}
              <dd className="inline tabular-nums">
                {fmtTime(d.requestedAt)} {shortId(d.requestedBy)}
              </dd>
            </div>
            {d.approvedAt ? (
              <div>
                <dt className="inline text-muted-foreground">{t("approved")}</dt>{" "}
                <dd className="inline tabular-nums">
                  {fmtTime(d.approvedAt)} {shortId(d.approvedBy)}
                </dd>
              </div>
            ) : null}
            {d.startedAt ? (
              <div>
                <dt className="inline text-muted-foreground">{t("started")}</dt> <dd className="inline tabular-nums">{fmtTime(d.startedAt)}</dd>
              </div>
            ) : null}
            {d.finishedAt ? (
              <div>
                <dt className="inline text-muted-foreground">{t("finished")}</dt> <dd className="inline tabular-nums">{fmtTime(d.finishedAt)}</dd>
              </div>
            ) : null}
            <div className="sm:col-span-2">
              <dt className="inline text-muted-foreground">{t("reason")}</dt> <dd className="inline">{d.reason}</dd>
            </div>
          </dl>

          {d.errorCode ? (
            <Notice tone="danger" testId="ecat-apply-error">
              {te.has(d.errorCode) ? te(d.errorCode) : t("errorCode", { code: d.errorCode })}
            </Notice>
          ) : null}
          {d.requiresApproval || d.approverRequired ? (
            <Notice tone="warn" testId="ecat-apply-approver">
              {d.canApprove ? t("approverYou") : t("approverOther")}
            </Notice>
          ) : null}
          {busy && (pollFailed || polls >= APPLY_POLL_MAX) ? <Notice>{t("pollStopped")}</Notice> : null}
          {hiddenCount > 0 ? (
            <Notice tone="warn" testId="ecat-apply-hidden-notice">
              {t("hiddenNotice", { count: hiddenCount })}
            </Notice>
          ) : null}
          {d.abandonPins && d.abandonPins.state !== "planned" ? <AbandonPinsNotice pins={d.abandonPins} /> : null}
          {can("preview") && previewLintBlocked ? (
            <Notice tone="danger" testId="ecat-apply-preview-lint-blocked">
              {t("previewLintBlocked")}
            </Notice>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {can("approve") ? (
              <Button size="sm" onClick={() => setAsk("approve")} disabled={pending || !d.canApprove} data-testid="ecat-apply-approve">
                {t("action.approve")}
              </Button>
            ) : null}
            {can("preview") ? (
              <Button size="sm" variant="outline" onClick={() => run("preview", null)}
                disabled={pending || previewLintBlocked}
                data-testid="ecat-apply-repreview">
                {t("action.preview")}
              </Button>
            ) : null}
            {can("resume") ? (
              <Button size="sm" variant="outline" onClick={() => run("resume", null)} disabled={pending} data-testid="ecat-apply-resume">
                {t("action.resume")}
              </Button>
            ) : null}
            {can("abandon") ? (
              <Button
                size="sm"
                variant="outline"
                className="text-danger"
                onClick={() => setAsk("abandon")}
                disabled={pending || busy}
                data-testid="ecat-apply-abandon"
              >
                {t("action.abandon")}
              </Button>
            ) : null}
            {can("reject") ? (
              <Button size="sm" variant="outline" className="text-danger" onClick={() => setAsk("reject")} disabled={pending} data-testid="ecat-apply-reject">
                {t("action.reject")}
              </Button>
            ) : null}
            {can("rollback") ? (
              <Button size="sm" variant="outline" onClick={() => setAsk("rollback")} disabled={pending} data-testid="ecat-apply-rollback">
                {t("action.rollback")}
              </Button>
            ) : null}
          </div>
        </div>
      </SectionCard>

      <SectionCard title={t("previewTitle")} description={t("previewDescription")}>
        {d.preview ? (
          <PreviewPanel preview={d.preview} />
        ) : d.previewUnreadable ? (
          <Notice tone="warn">{t("previewUnreadable")}</Notice>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="ecat-preview-pending">
            {busy ? t("previewPending") : t("previewNone")}
          </p>
        )}
      </SectionCard>

      {d.queue.length ? (
        <SectionCard title={t("queueTitle")}>
          <ul className="flex flex-col gap-1 text-xs">
            {d.queue.map((q) => (
              <li key={q.changeId} className="flex flex-wrap gap-3 tabular-nums">
                <span>{q.changeId}</span>
                <span>{q.op ?? ""}</span>
                <span>{q.status}</span>
                <span className="text-muted-foreground">{fmtTime(q.requestedAt)}</span>
                <span className="text-muted-foreground">{fmtTime(q.appliedAt)}</span>
                {q.hasError ? <span className="text-danger">{t("queueError")}</span> : null}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <Dialog open={ask != null} onOpenChange={(o) => (o ? null : setAsk(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{ask ? t(`confirm.${ask}.title`) : ""}</DialogTitle>
            <DialogDescription>{ask ? t(`confirm.${ask}.body`) : ""}</DialogDescription>
          </DialogHeader>
          {ask === "abandon" && d.abandonPins ? <AbandonPinsNotice pins={d.abandonPins} /> : null}
          {ask === "approve" && (d.preview?.cycles.exposed.length ?? 0) > 0 ? (
            <Notice tone="warn">{t("confirmExposed", { count: d.preview?.cycles.exposed.length ?? 0 })}</Notice>
          ) : null}
          {ask === "approve" && d.preview?.refreeze?.applies && d.preview.refreeze.count > 0 ? (
            <Notice tone="warn" testId="ecat-confirm-refreeze">
              {t("confirmRefreeze", { exposed: d.preview.refreeze.exposed, count: d.preview.refreeze.count })}
            </Notice>
          ) : null}
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            aria-label={tc("reason")}
            placeholder={needsReason ? tc("reasonRequired") : tc("reasonOptional")}
            data-testid="ecat-apply-step-reason"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAsk(null)} disabled={pending}>
              {tc("cancel")}
            </Button>
            <Button
              onClick={() => ask && run(ask, reason || null)}
              disabled={pending || (needsReason && !reason.trim())}
              data-testid="ecat-apply-step-confirm"
            >
              {ask ? t(`action.${ask}`) : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
