"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Link, useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ApplyItemView, VersionDiffView, VersionSummaryView } from "@/lib/hgh/adapters/admin-entities";
import { applyStepAction, versionDiffAction } from "../_ecat-actions";
import { ApplyRequestForm } from "./apply-request-form";
import { DiffTable } from "./diff-table";
import { ApplyStatusBadge, ECAT_BASE, fmtInt, fmtTime, Notice, shortId, VersionStatusBadge } from "./ecat-shared";

// Version list and comparison (design 7절 버전 목록·되돌리기) plus the apply request list.
// Rollback: the active version's last applied request can be rolled back; the backend makes a
// rollback draft with the previous content and an apply request with the same range, whose page
// opens next (its preview is computed automatically).

export function VersionList({
  versions,
  activeVer,
  draftVer,
  applies,
  names,
}: {
  versions: VersionSummaryView[];
  activeVer: number;
  draftVer: number | null;
  applies: ApplyItemView[];
  names: Record<string, string>;
}) {
  const t = useTranslations("adminEcat.versions");
  const tc = useTranslations("adminEcat.common");
  const to = useTranslations("adminEcat.origin");
  const ts = useTranslations("adminEcat.apply.scope");
  const te = useTranslations("adminEcat.errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [left, setLeft] = useState<string>(String(draftVer ?? activeVer));
  const [right, setRight] = useState<string>("");
  const [diff, setDiff] = useState<VersionDiffView | null>(null);
  const [rollbackOf, setRollbackOf] = useState<number | null>(null);
  const [rollbackReason, setRollbackReason] = useState("");
  const [widenOpen, setWidenOpen] = useState(false);

  function compare() {
    start(async () => {
      const r = await versionDiffAction(Number(left), right ? Number(right) : null);
      if (r.ok) setDiff(r.value);
      else toast.error(te(r.errorKey));
    });
  }

  function rollback() {
    if (!rollbackOf) return;
    start(async () => {
      const r = await applyStepAction(rollbackOf, "rollback", rollbackReason);
      if (r.ok) {
        setRollbackOf(null);
        toast.success(t("rollbackRequested", { id: r.value.applyId }));
        router.push(`${ECAT_BASE}/applies/${r.value.applyId}`);
      } else toast.error(te(r.errorKey));
    });
  }

  const active = versions.find((v) => v.ver === activeVer);
  const rollbackTarget = active?.lastApply?.status === "applied" ? active.lastApply.applyId : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3" data-testid="ecat-versions">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colVer")}</TableHead>
              <TableHead>{t("colStatus")}</TableHead>
              <TableHead>{t("colTitle")}</TableHead>
              <TableHead>{t("colOrigin")}</TableHead>
              <TableHead className="text-right">{t("colRows")}</TableHead>
              <TableHead>{t("colCreated")}</TableHead>
              <TableHead>{t("colActivated")}</TableHead>
              <TableHead>{t("colLastApply")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions.map((v) => (
              <TableRow key={v.ver} data-testid="ecat-version-row" data-ver={v.ver}>
                <TableCell className="font-medium tabular-nums">{t("ver", { ver: v.ver })}</TableCell>
                <TableCell>
                  <VersionStatusBadge status={v.status} />
                </TableCell>
                <TableCell className="text-xs">
                  <div className="font-medium">{v.title}</div>
                  {v.reason ? <div className="text-muted-foreground">{v.reason}</div> : null}
                </TableCell>
                <TableCell className="text-xs">{to(v.origin)}</TableCell>
                <TableCell className="text-right text-xs tabular-nums">
                  {t("rows", { entities: fmtInt(v.entityRows), surfaces: fmtInt(v.surfaceRows) })}
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {fmtTime(v.createdAt)} <span className="text-muted-foreground">{shortId(v.createdBy)}</span>
                </TableCell>
                <TableCell className="text-xs tabular-nums">{fmtTime(v.activatedAt)}</TableCell>
                <TableCell className="text-xs">
                  {v.lastApply ? (
                    <Link href={`${ECAT_BASE}/applies/${v.lastApply.applyId}`} className="inline-flex items-center gap-1 hover:underline">
                      <ApplyStatusBadge status={v.lastApply.status} />
                      <span>{ts(v.lastApply.scopeKind)}</span>
                      {v.lastApply.fromRoundDate ? <span className="tabular-nums">{v.lastApply.fromRoundDate}</span> : null}
                    </Link>
                  ) : null}
                </TableCell>
                <TableCell className="text-right">
                  {v.ver === activeVer ? (
                    <span className="inline-flex gap-1">
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setWidenOpen(true)}>
                        {t("widen")}
                      </Button>
                      {rollbackTarget ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => setRollbackOf(rollbackTarget)}
                          disabled={!!draftVer}
                          title={draftVer ? t("rollbackNeedsNoDraft") : undefined}
                          data-testid="ecat-version-rollback"
                        >
                          {t("rollback")}
                        </Button>
                      ) : null}
                    </span>
                  ) : v.status === "draft" ? (
                    <Button asChild size="sm" variant="outline" className="h-7 text-xs">
                      <Link href={`${ECAT_BASE}/draft`}>{t("openDraft")}</Link>
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-border p-4" data-testid="ecat-compare">
        <p className="text-sm font-semibold">{t("compareTitle")}</p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ecat-cmp-left">{t("compareVer")}</Label>
            <Select value={left} onValueChange={setLeft}>
              <SelectTrigger id="ecat-cmp-left" className="h-8 w-40 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {versions.map((v) => (
                  <SelectItem key={v.ver} value={String(v.ver)}>
                    {t("ver", { ver: v.ver })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ecat-cmp-right">{t("compareAgainst")}</Label>
            <Select value={right || "base"} onValueChange={(v) => setRight(v === "base" ? "" : v)}>
              <SelectTrigger id="ecat-cmp-right" className="h-8 w-40 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="base">{t("compareBase")}</SelectItem>
                {versions.map((v) => (
                  <SelectItem key={v.ver} value={String(v.ver)}>
                    {t("ver", { ver: v.ver })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" onClick={compare} disabled={pending} data-testid="ecat-compare-run">
            {t("compareRun")}
          </Button>
        </div>
        {diff ? <DiffTable diff={diff} names={names} /> : null}
      </div>

      <div className="flex flex-col gap-3" data-testid="ecat-applies">
        <p className="text-sm font-semibold">{t("appliesTitle")}</p>
        {applies.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colApply")}</TableHead>
                <TableHead>{t("colVer")}</TableHead>
                <TableHead>{t("colStatus")}</TableHead>
                <TableHead>{t("colScope")}</TableHead>
                <TableHead className="text-right">{t("colAffected")}</TableHead>
                <TableHead>{t("colRequested")}</TableHead>
                <TableHead>{t("colReason")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {applies.map((a) => (
                <TableRow key={a.applyId} data-testid="ecat-apply-row">
                  <TableCell>
                    <Link href={`${ECAT_BASE}/applies/${a.applyId}`} className="font-medium tabular-nums hover:underline">
                      {t("applyId", { id: a.applyId })}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs tabular-nums">
                    {t("verFrom", { ver: a.ver, from: a.fromVer ?? 0 })}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1">
                      <ApplyStatusBadge status={a.status} />
                      {a.requiresApproval ? <span className="text-[10px] text-accent-gold">{t("needsApprover")}</span> : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">
                    {ts(a.scopeKind)} {a.fromRoundDate ?? ""}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{fmtInt(a.affectedAnswers)}</TableCell>
                  <TableCell className="text-xs tabular-nums">
                    {fmtTime(a.requestedAt)} <span className="text-muted-foreground">{shortId(a.requestedBy)}</span>
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-xs">{a.reason}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-xs text-muted-foreground">{t("appliesNone")}</p>
        )}
      </div>

      <Dialog open={rollbackOf != null} onOpenChange={(o) => (o ? null : setRollbackOf(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("rollbackTitle", { ver: activeVer })}</DialogTitle>
            <DialogDescription>{t("rollbackDescription")}</DialogDescription>
          </DialogHeader>
          <Notice tone="warn">{t("rollbackScopeNote")}</Notice>
          <Textarea
            value={rollbackReason}
            onChange={(e) => setRollbackReason(e.target.value)}
            rows={3}
            aria-label={tc("reason")}
            placeholder={tc("reasonRequired")}
            data-testid="ecat-rollback-reason"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRollbackOf(null)} disabled={pending}>
              {tc("cancel")}
            </Button>
            <Button onClick={rollback} disabled={pending || !rollbackReason.trim()} data-testid="ecat-rollback-confirm">
              {t("rollback")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={widenOpen} onOpenChange={setWidenOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("widenTitle", { ver: activeVer })}</DialogTitle>
            <DialogDescription>{t("widenDescription")}</DialogDescription>
          </DialogHeader>
          <ApplyRequestForm ver={activeVer} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
