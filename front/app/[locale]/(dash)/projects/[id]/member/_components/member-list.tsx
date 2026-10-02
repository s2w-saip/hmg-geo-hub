"use client";

import { useState, useTransition } from "react";
import { useTranslations, useFormatter } from "next-intl";
import { toast } from "sonner";
import { Clock, Check, X, ShieldCheck, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSortableTable } from "@/hooks/use-sortable-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import { cancelInvite, removeMember } from "../_actions";
import {
  promoteToOwner,
  demoteToViewer,
} from "../../setting/_actions";

type SortKey = "email" | "role" | "status" | "invitedAt";

export type MemberRow = {
  id: string;
  email: string | null;
  role: "owner" | "viewer";
  status: "pending" | "active";
  invitedAt: string; // ISO
};

type ConfirmAction =
  | { kind: "promote"; member: MemberRow }
  | { kind: "demote"; member: MemberRow };

export function MemberList({
  projectId,
  members,
  canEdit,
}: {
  projectId: string;
  members: MemberRow[];
  canEdit: boolean;
}) {
  const t = useTranslations("projectDetail.member.list");
  // Hydration-safe date formatting — locale + timeZone come from the i18n
  // config, so SSR (UTC) and client (KST) render byte-identical text.
  const format = useFormatter();
  const [pending, startTransition] = useTransition();

  // Role transfers (promote / demote) are irreversible from the UI flow —
  // gate them behind a 2-step confirm dialog. Cancel + Remove keep their
  // single-click flow because they're recoverable (re-invite restores).
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);

  // For demote-to-Viewer: never allow the last active Owner to be demoted.
  // We mirror the server-side guard here purely to keep the button hidden
  // when the action would always fail.
  const activeOwnerCount = members.filter(
    (m) => m.role === "owner" && m.status === "active",
  ).length;

  const { sorted, headerProps } = useSortableTable<MemberRow, SortKey>(
    members,
    {
      email: (m) => m.email ?? "",
      // Owner > viewer for the natural "leadership first" sort.
      role: (m) => (m.role === "owner" ? 1 : 0),
      // active > pending so "fully joined" sorts above invites.
      status: (m) => (m.status === "active" ? 1 : 0),
      invitedAt: (m) => new Date(m.invitedAt).getTime(),
    },
    {
      defaultKey: "role",
      defaultAsc: false,
      ascByDefault: ["email"],
    },
  );

  function onCancel(membershipId: string) {
    startTransition(async () => {
      const r = await cancelInvite(projectId, membershipId);
      if (r.ok) toast.success(t("cancelSuccess"));
      else toast.error(r.error);
    });
  }
  function onRemove(membershipId: string) {
    startTransition(async () => {
      const r = await removeMember(projectId, membershipId);
      if (r.ok) toast.success(t("removeSuccess"));
      else toast.error(r.error);
    });
  }
  function runConfirmed() {
    if (!confirm) return;
    const { kind, member } = confirm;
    startTransition(async () => {
      const r =
        kind === "promote"
          ? await promoteToOwner(projectId, member.id)
          : await demoteToViewer(projectId, member.id);
      if (r.ok) {
        toast.success(t(kind === "promote" ? "promoteSuccess" : "demoteSuccess"));
        setConfirm(null);
      } else {
        // Keep the dialog open so the operator can read the error and
        // retry — same pattern as EditUserDialog in /admin.
        toast.error(r.error);
      }
    });
  }

  if (members.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        {t("empty")}
      </p>
    );
  }

  return (
    <>
      <div className="overflow-hidden rounded-md border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              <th className="px-3 py-2"><SortableHeader {...headerProps("email")}>{t("emailLabel")}</SortableHeader></th>
              <th className="px-3 py-2 w-24"><SortableHeader {...headerProps("role")}>{t("roleLabel")}</SortableHeader></th>
              <th className="px-3 py-2 w-28"><SortableHeader {...headerProps("status")}>{t("statusLabel")}</SortableHeader></th>
              <th className="px-3 py-2 w-32"><SortableHeader {...headerProps("invitedAt")}>{t("invitedAtLabel")}</SortableHeader></th>
              {canEdit ? <th className="px-3 py-2 w-40"></th> : null}
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => (
              <tr key={m.id} className="border-t border-border first:border-t-0">
                <td className="px-3 py-3 text-sm font-medium text-foreground">{m.email ?? t("unknownUser")}</td>
                <td className="px-3 py-3">
                  <Badge variant={m.role === "owner" ? "default" : "secondary"} className="uppercase text-[10px]">
                    {m.role}
                  </Badge>
                </td>
                <td className="px-3 py-3">
                  {m.status === "pending" ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      <Clock className="h-3 w-3" aria-hidden />
                      {t("statusPending")}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-brand-700/10 px-2 py-0.5 text-[10px] font-medium text-brand-700">
                      <Check className="h-3 w-3" aria-hidden />
                      {t("statusActive")}
                    </span>
                  )}
                </td>
                <td className="px-3 py-3 text-xs tabular-nums text-muted-foreground">
                  {format.dateTime(new Date(m.invitedAt), { dateStyle: "medium" })}
                </td>
                {canEdit ? (
                  <td className="px-3 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {m.role === "viewer" && m.status === "active" ? (
                        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setConfirm({ kind: "promote", member: m })} className="text-muted-foreground hover:text-brand-700">
                          <ShieldCheck className="h-4 w-4" aria-hidden />
                          {t("promote")}
                        </Button>
                      ) : null}
                      {m.role === "owner" && m.status === "active" && activeOwnerCount > 1 ? (
                        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setConfirm({ kind: "demote", member: m })} className="text-muted-foreground hover:text-foreground">
                          <ShieldOff className="h-4 w-4" aria-hidden />
                          {t("demote")}
                        </Button>
                      ) : null}
                      {m.role !== "owner" ? (
                        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => (m.status === "pending" ? onCancel(m.id) : onRemove(m.id))} className="text-muted-foreground hover:text-destructive">
                          <X className="h-4 w-4" aria-hidden />
                          {m.status === "pending" ? t("cancel") : t("remove")}
                        </Button>
                      ) : null}
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <DialogContent
          // Block accidental dismissal during the in-flight transition —
          // matches the EditUserDialog pattern.
          onPointerDownOutside={(e) => {
            if (pending) e.preventDefault();
          }}
        >
          {confirm ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {t(
                    confirm.kind === "promote"
                      ? "promoteConfirm.title"
                      : "demoteConfirm.title",
                  )}
                </DialogTitle>
                <DialogDescription>
                  {t(
                    confirm.kind === "promote"
                      ? "promoteConfirm.description"
                      : "demoteConfirm.description",
                    { email: confirm.member.email ?? t("unknownUser") },
                  )}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setConfirm(null)}
                  disabled={pending}
                >
                  {t("confirmDialog.cancel")}
                </Button>
                <Button
                  type="button"
                  variant={confirm.kind === "promote" ? "default" : "outline"}
                  onClick={runConfirmed}
                  disabled={pending}
                >
                  {confirm.kind === "promote" ? (
                    <ShieldCheck className="h-4 w-4" aria-hidden />
                  ) : (
                    <ShieldOff className="h-4 w-4" aria-hidden />
                  )}
                  {t(
                    confirm.kind === "promote"
                      ? "promoteConfirm.confirm"
                      : "demoteConfirm.confirm",
                  )}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
