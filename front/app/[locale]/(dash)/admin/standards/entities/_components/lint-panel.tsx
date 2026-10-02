"use client";

import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { useRouter } from "@/i18n/navigation";
import type { LintFindingView, LintView } from "@/lib/hgh/adapters/admin-entities";
import { runLintAction, saveLintAcksAction } from "../_ecat-actions";
import { fmtTime, Notice } from "./ecat-shared";

// Lint results of the draft (design 3절 ②): L1 and L3 block the apply request, every L2 needs
// its own confirmation. Escalated L2 items (own-brand entities) are left out of "confirm all":
// they are confirmed one by one after the samples were read (design 8절 위험 6, 승인 피로).

const LEVEL_CLASS = {
  L1: "border-danger/40 bg-danger/5",
  L3: "border-danger/40 bg-danger/5",
  L2: "border-sentiment-mixed/60 bg-sentiment-mixed/10",
  INFO: "border-border bg-muted/40",
} as const;

export function LintPanel({ ver, lint }: { ver: number; lint: LintView | null }) {
  const t = useTranslations("adminEcat.lint");
  const te = useTranslations("adminEcat.errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [acks, setAcks] = useState<Set<string>>(() => new Set(lint?.acked ?? []));

  const groups = useMemo(() => {
    const g: Record<LintFindingView["level"], LintFindingView[]> = { L1: [], L2: [], L3: [], INFO: [] };
    for (const f of lint?.findings ?? []) g[f.level].push(f);
    return g;
  }, [lint]);
  const l2 = groups.L2;
  const dirty = useMemo(() => {
    const saved = new Set(lint?.acked ?? []);
    return saved.size !== acks.size || [...acks].some((k) => !saved.has(k));
  }, [acks, lint]);

  function run() {
    start(async () => {
      const r = await runLintAction(ver);
      if (r.ok) {
        setAcks(new Set(r.value.acked));
        toast.success(t("ran", { l1: r.value.counts.L1 ?? 0, l2: r.value.counts.L2 ?? 0, l3: r.value.counts.L3 ?? 0 }));
        router.refresh();
      } else toast.error(te(r.errorKey));
    });
  }

  function save() {
    start(async () => {
      const r = await saveLintAcksAction(ver, [...acks]);
      if (r.ok) {
        setAcks(new Set(r.value.acked));
        toast.success(t("acksSaved", { count: r.value.acked.length }));
        router.refresh();
      } else toast.error(te(r.errorKey));
    });
  }

  function toggle(key: string, on: boolean) {
    setAcks((cur) => {
      const next = new Set(cur);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-3" data-testid="ecat-lint">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {lint?.lintedAt
            ? t("summary", {
                at: fmtTime(lint.lintedAt),
                l1: groups.L1.length,
                l2: l2.length,
                l3: groups.L3.length,
                unacked: lint.unacked.length,
              })
            : t("never")}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={run} disabled={pending} data-testid="ecat-lint-run">
            {t("run")}
          </Button>
          {l2.length ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setAcks(new Set([...acks, ...l2.filter((f) => !f.escalate).map((f) => f.key)]))}
                disabled={pending || !!lint?.stale}
                data-testid="ecat-lint-ack-all"
              >
                {t("ackAllPlain")}
              </Button>
              <Button size="sm" onClick={save} disabled={pending || !dirty || !!lint?.stale} data-testid="ecat-lint-ack-save">
                {t("saveAcks")}
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {lint?.stale ? <Notice tone="warn">{t("stale")}</Notice> : null}
      {lint && lint.blocked ? <Notice tone="danger">{t("blocked")}</Notice> : null}
      {lint && lint.observedSource ? <p className="text-[11px] text-muted-foreground">{t("observedSource", { source: lint.observedSource })}</p> : null}
      {(["L1", "L3", "L2", "INFO"] as const).map((lv) =>
        groups[lv].length ? (
          <div key={lv} className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold text-ink-700">{t(`level.${lv}`)}</p>
            <ul className="flex flex-col gap-1.5">
              {groups[lv].map((f) => (
                <li
                  key={f.key}
                  className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-xs", LEVEL_CLASS[f.level])}
                  data-testid="ecat-lint-finding"
                  data-level={f.level}
                >
                  {f.level === "L2" ? (
                    <Checkbox
                      checked={acks.has(f.key)}
                      onCheckedChange={(v) => toggle(f.key, v === true)}
                      disabled={pending || !!lint?.stale}
                      aria-label={t("ack", { target: f.target })}
                      className="mt-0.5"
                    />
                  ) : null}
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">
                      {f.target} <span className="font-mono text-[10px] text-muted-foreground">{f.code}</span>
                    </span>
                    {f.detail ? <span className="text-ink-700">{f.detail}</span> : null}
                    {f.escalate ? <span className="text-[11px] font-semibold text-accent-gold">{t("escalate")}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
      {lint && lint.lintedAt && !lint.findings.length ? <Notice>{t("clean")}</Notice> : null}
    </div>
  );
}
