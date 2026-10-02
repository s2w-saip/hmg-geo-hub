"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ScopeKind } from "@/lib/hgh/adapters/admin-entities";
import { requestApplyAction } from "../_ecat-actions";
import { ECAT_BASE, Notice } from "./ecat-shared";

// Apply request (design 3절 ④, decision 27): the admin picks the range every time (no default):
// unexposed rounds only, from a round date, or every round. A range that reaches an exposed round
// needs an approver (the preview says so). Reason is required. On success the apply page opens
// and polls until the loader has computed the preview.

const KINDS: ScopeKind[] = ["unexposed", "from_round", "all"];

export function ApplyRequestForm({ ver, blockedKey }: { ver?: number | null; blockedKey?: string | null }) {
  const t = useTranslations("adminEcat.apply");
  const te = useTranslations("adminEcat.errors");
  const router = useRouter();
  const [kind, setKind] = useState<ScopeKind | null>(null);
  const [from, setFrom] = useState("");
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const ready = !!kind && !!reason.trim() && (kind !== "from_round" || /^\d{4}-\d{2}-\d{2}$/.test(from)) && !blockedKey;

  function submit() {
    if (!kind) return;
    start(async () => {
      const r = await requestApplyAction({ scopeKind: kind, fromRoundDate: kind === "from_round" ? from : null, reason, ver: ver ?? null });
      if (r.ok) {
        toast.success(t("requested", { id: r.value.applyId }));
        router.push(`${ECAT_BASE}/applies/${r.value.applyId}`);
      } else toast.error(te(r.errorKey));
    });
  }

  return (
    <div className="flex flex-col gap-3" data-testid="ecat-apply-form">
      {blockedKey ? <Notice tone="warn">{t(`blocked.${blockedKey}`)}</Notice> : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-semibold text-ink-700">{t("scopeLegend")}</legend>
        {KINDS.map((k) => (
          <label
            key={k}
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-xs",
              kind === k ? "border-brand-700 bg-brand-25" : "border-border",
            )}
          >
            <input
              type="radio"
              name="ecat-scope"
              value={k}
              checked={kind === k}
              onChange={() => setKind(k)}
              className="mt-0.5"
              data-testid={`ecat-scope-${k}`}
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{t(`scope.${k}`)}</span>
              <span className="text-muted-foreground">{t(`scopeHint.${k}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {kind === "from_round" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ecat-from-round">{t("fromRound")}</Label>
          <Input id="ecat-from-round" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-44 text-xs" />
        </div>
      ) : null}
      {kind && kind !== "unexposed" ? <Notice tone="warn">{t("exposedNotice")}</Notice> : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ecat-apply-reason">{t("reason")}</Label>
        <Textarea
          id="ecat-apply-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder={t("reasonPlaceholder")}
          data-testid="ecat-apply-reason"
        />
      </div>
      <Button onClick={submit} disabled={pending || !ready} className="self-start" data-testid="ecat-apply-submit">
        {t("submit")}
      </Button>
    </div>
  );
}
