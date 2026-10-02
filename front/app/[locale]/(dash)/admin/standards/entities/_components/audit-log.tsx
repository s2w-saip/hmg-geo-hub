"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AuditItemView } from "@/lib/hgh/adapters/admin-entities";
import { ECAT_BASE, fmtTime, shortId } from "./ecat-shared";

// Audit history of entity versioning (app.ecat_audit_log, newest first). Actor ids are shown as
// their first 8 characters only. "Older" pages with before_id.

export function AuditLog({ items, limit, beforeId }: { items: AuditItemView[]; limit: number; beforeId: number | null }) {
  const t = useTranslations("adminEcat.audit");
  const last = items.length ? items[items.length - 1].auditId : null;
  return (
    <div className="flex flex-col gap-3" data-testid="ecat-audit">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("colTime")}</TableHead>
            <TableHead>{t("colAction")}</TableHead>
            <TableHead>{t("colActor")}</TableHead>
            <TableHead>{t("colTarget")}</TableHead>
            <TableHead>{t("colDetail")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((a) => (
            <TableRow key={a.auditId}>
              <TableCell className="text-xs whitespace-nowrap tabular-nums">{fmtTime(a.ts)}</TableCell>
              <TableCell className="font-mono text-xs">{a.action}</TableCell>
              <TableCell className="font-mono text-xs">{shortId(a.actorId)}</TableCell>
              <TableCell className="text-xs">
                {a.ver ? <span className="mr-2">{t("ver", { ver: a.ver })}</span> : null}
                {a.applyId ? (
                  <Link href={`${ECAT_BASE}/applies/${a.applyId}`} className="mr-2 underline">
                    {t("apply", { id: a.applyId })}
                  </Link>
                ) : null}
                {a.entityId ? <span className="mr-2 font-mono">{shortId(a.entityId)}</span> : null}
                {a.surfaceId ? <span className="mr-2">{t("surface", { id: a.surfaceId })}</span> : null}
                {a.reviewId ? <span>{t("review", { id: a.reviewId })}</span> : null}
              </TableCell>
              <TableCell className="max-w-96 truncate font-mono text-[11px] text-muted-foreground" title={a.detail ?? undefined}>
                {a.detail ?? ""}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">{t("empty")}</p>
      ) : null}
      <div className="flex gap-2">
        {beforeId ? (
          <Button asChild size="sm" variant="outline" className="text-xs">
            <Link href={`${ECAT_BASE}/audit`}>{t("newest")}</Link>
          </Button>
        ) : null}
        {items.length >= limit && last ? (
          <Button asChild size="sm" variant="outline" className="text-xs">
            <Link href={`${ECAT_BASE}/audit?before_id=${last}`}>{t("older")}</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
