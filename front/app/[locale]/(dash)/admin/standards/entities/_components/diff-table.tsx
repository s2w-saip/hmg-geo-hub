"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { EcatRole, VersionDiffView } from "@/lib/hgh/adapters/admin-entities";
import { fmtInt, RoleBadge } from "./ecat-shared";

// Two versions' difference (GET .../versions/{ver}/diff): override rows added (a new override),
// removed (back to the Scope default: competitor, no merge) or changed (listed fields), and
// surfaces switched on, off or between add and block.

const REF_FIELDS = new Set(["merge_into", "parent_brand_id"]);
const SHOWN_FIELDS = ["name", "entity_type", "brand_code", "merge_into", "parent_brand_id", "note"] as const;

function roleOf(v: Record<string, unknown> | null): EcatRole {
  const r = v?.role;
  return r === "own" || r === "hidden" || r === "removed" || r === "competitor" ? r : "competitor";
}

export function DiffTable({ diff, names }: { diff: VersionDiffView; names: Record<string, string> }) {
  const t = useTranslations("adminEcat.diff");
  const label = (id: unknown): string => (typeof id === "string" ? (names[id] ?? id.slice(0, 8)) : "");
  const show = (field: string, v: unknown): string => {
    if (v == null || v === "") return t("empty");
    return REF_FIELDS.has(field) ? label(v) : String(v);
  };
  const nameOf = (e: VersionDiffView["entities"][number]) =>
    names[e.entityId] ?? (e.after?.name as string | undefined) ?? (e.before?.name as string | undefined) ?? e.entityId.slice(0, 8);

  if (!diff.entities.length && !diff.surfaces.length) {
    return <p className="text-xs text-muted-foreground" data-testid="ecat-diff-empty">{t("none")}</p>;
  }
  return (
    <div className="flex flex-col gap-4" data-testid="ecat-diff">
      <p className="text-xs text-muted-foreground">
        {t("counts", {
          entities: fmtInt(diff.entities.length),
          surfaces: fmtInt(diff.surfaces.length),
          ver: diff.ver,
          against: diff.against ?? 0,
        })}
      </p>
      {diff.entities.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colEntity")}</TableHead>
              <TableHead>{t("colChange")}</TableHead>
              <TableHead>{t("colRole")}</TableHead>
              <TableHead>{t("colFields")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {diff.entities.map((e) => {
              const fields = e.change === "changed" ? e.fields.filter((f) => f !== "role" && f !== "origin") : SHOWN_FIELDS.filter((f) => (e.after ?? e.before)?.[f] != null);
              return (
                <TableRow key={e.entityId} data-testid="ecat-diff-entity">
                  <TableCell className="font-medium">{nameOf(e)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      {t(`entity.${e.change}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1 text-xs">
                      <RoleBadge role={roleOf(e.before)} />
                      <span aria-hidden>{"→"}</span>
                      <RoleBadge role={roleOf(e.after)} />
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">
                    {fields.map((f) => (
                      <div key={f}>
                        <span className="text-muted-foreground">{t(`field.${f}`)}</span> {show(f, e.before?.[f])} {"→"} {show(f, e.after?.[f])}
                      </div>
                    ))}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : null}
      {diff.surfaces.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colSurface")}</TableHead>
              <TableHead>{t("colScope")}</TableHead>
              <TableHead>{t("colChange")}</TableHead>
              <TableHead>{t("colAction")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {diff.surfaces.map((s) => (
              <TableRow key={s.surfaceId} data-testid="ecat-diff-surface">
                <TableCell className="font-medium">{s.surface}</TableCell>
                <TableCell className="text-xs">{s.entityId ? label(s.entityId) : t("global")}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-[10px]">
                    {t(`surface.${s.change}`)}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">
                  {s.beforeAction ? t(`action.${s.beforeAction}`) : t("off")} {"→"} {s.afterAction ? t(`action.${s.afterAction}`) : t("off")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}
