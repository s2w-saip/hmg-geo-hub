"use client";

import { useTranslations, useFormatter } from "next-intl";
import {
  Mail,
  XCircle,
  UserMinus,
  ShieldCheck,
  ShieldOff,
  Check,
  X,
  History,
} from "lucide-react";
import type { MemberAuditAction } from "@/lib/db/repositories/member-audit-logs";

export type AuditLogEntry = {
  id: string;
  actorEmail: string | null;
  targetEmail: string | null;
  action: MemberAuditAction;
  context: string | null;
  createdAt: string; // ISO
};

// Append-only ledger rendered at the bottom of the Member tab. Each row
// reads as "<actor> <verb> <target> · <relative time>". Self-acted events
// (accept / reject) collapse to "<actor> <verb> the invite" so the row
// doesn't repeat the same email twice.

const ACTION_ICON: Record<MemberAuditAction, React.ComponentType<{ className?: string }>> = {
  invite: Mail,
  cancel_invite: XCircle,
  remove: UserMinus,
  promote: ShieldCheck,
  demote: ShieldOff,
  accept: Check,
  reject: X,
};

const ACTION_COLOR: Record<MemberAuditAction, string> = {
  invite: "text-brand-700",
  cancel_invite: "text-muted-foreground",
  remove: "text-destructive",
  promote: "text-emerald-600",
  demote: "text-amber-600",
  accept: "text-emerald-600",
  reject: "text-muted-foreground",
};

export function AuditLog({ entries }: { entries: AuditLogEntry[] }) {
  const t = useTranslations("projectDetail.member.audit");
  // Relative time via next-intl — the reference `now` and locale come from the
  // i18n config, so server and client agree (no `Date.now()` in render → no
  // React #418) and the output is localized ("3분 전" / "3 minutes ago").
  const format = useFormatter();

  if (entries.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        {t("empty")}
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-card">
      {entries.map((e) => {
        const Icon = ACTION_ICON[e.action];
        const isSelfAct = e.action === "accept" || e.action === "reject";
        const actor = e.actorEmail ?? t("unknownUser");
        const target = e.targetEmail ?? t("unknownUser");
        return (
          <li
            key={e.id}
            className="flex items-start gap-3 px-4 py-2.5 text-sm"
          >
            <Icon
              className={`mt-0.5 h-4 w-4 shrink-0 ${ACTION_COLOR[e.action]}`}
              aria-hidden
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="text-foreground">
                {isSelfAct
                  ? t(`line.${e.action}_self`, { actor })
                  : t(`line.${e.action}`, { actor, target })}
              </p>
              {e.context ? (
                <span className="text-[11px] text-muted-foreground">
                  {e.context}
                </span>
              ) : null}
            </div>
            <time
              className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
              dateTime={e.createdAt}
            >
              {format.relativeTime(new Date(e.createdAt))}
            </time>
          </li>
        );
      })}
    </ul>
  );
}

export function AuditLogHeader() {
  const t = useTranslations("projectDetail.member.audit");
  return (
    <div className="flex items-center gap-2">
      <History className="h-4 w-4 text-muted-foreground" aria-hidden />
      <span className="text-sm font-semibold tracking-tight text-foreground">
        {t("title")}
      </span>
    </div>
  );
}
