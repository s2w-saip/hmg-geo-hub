"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Mail, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { acceptInvite, rejectInvite } from "../[id]/member/_actions";

// Project list 상단 알림 (GGMD v22 user flow #4-2.B). Surfaces all pending
// invites the logged-in user has received with inline 수락 / 거절 buttons.
// Per Q6(b), this is the ONLY accept path implemented — email link is
// deferred. The panel hides itself when there are no pending invites
// (parent decides whether to render this component).

export type PendingRow = {
  membershipId: string;
  projectId: string;
  projectName: string;
  invitedAt: string; // ISO
};

export function PendingInvitesPanel({ pending }: { pending: PendingRow[] }) {
  const t = useTranslations("projects.pending");
  const [busy, startTransition] = useTransition();

  function onAccept(membershipId: string) {
    startTransition(async () => {
      const r = await acceptInvite(membershipId);
      if (r.ok) toast.success(t("acceptSuccess"));
      else toast.error(r.error);
    });
  }
  function onReject(membershipId: string) {
    startTransition(async () => {
      const r = await rejectInvite(membershipId);
      if (r.ok) toast.success(t("rejectSuccess"));
      else toast.error(r.error);
    });
  }

  return (
    <Card className="border-brand-700/30 bg-brand-700/[0.04]">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-brand-700" aria-hidden />
          <CardTitle className="font-head text-base font-semibold tracking-tight">
            {t("title", { count: pending.length })}
          </CardTitle>
        </div>
        <CardDescription className="mt-1">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y divide-border">
          {pending.map((p) => (
            <li
              key={p.membershipId}
              className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <span className="text-sm text-foreground">{p.projectName}</span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => onAccept(p.membershipId)}
                >
                  <Check className="h-4 w-4" aria-hidden />
                  {t("accept")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => onReject(p.membershipId)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="h-4 w-4" aria-hidden />
                  {t("reject")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
