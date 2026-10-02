"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableHeader } from "@/components/ui/sortable-header";
import { useSortableTable } from "@/hooks/use-sortable-table";
import { cn } from "@/lib/utils";
import { Link } from "@/i18n/navigation";
import type { ManagedEntityRow, SurfaceView } from "@/lib/hgh/adapters/admin-entities";
import { ECAT_BASE, fmtInt, OwnLineageBadge, RoleBadge } from "./ecat-shared";
import { EntityDrawer } from "./entity-drawer";

// Entity list (design 7절 엔티티 목록): tabs by active role + hub-added + draft changes, search
// over name / display brand, the observed numbers of the default period, and the draft role
// next to the active one. A row opens the entity drawer (detail + draft editing).

const TABS = ["all", "own", "competitor", "hidden", "removed", "hub", "changed"] as const;
type Tab = (typeof TABS)[number];
type SortKey = "name" | "answers" | "mentions" | "role";
const PAGE = 200;
const ROLE_ORDER = { own: 0, hidden: 1, removed: 2, competitor: 3 } as const;

function inTab(r: ManagedEntityRow, tab: Tab): boolean {
  switch (tab) {
    case "all":
      return true;
    case "hub":
      return r.origin === "hub";
    case "changed":
      return r.draftChanged;
    default:
      return r.activeRole === tab;
  }
}

export function EntityManager({
  rows,
  activeVer,
  draftVer,
  draftSurfaces,
  reviewCount,
}: {
  rows: ManagedEntityRow[];
  activeVer: number;
  draftVer: number | null;
  draftSurfaces: SurfaceView[];
  reviewCount: number | null;
}) {
  const t = useTranslations("adminEcat.list");
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [openId, setOpenId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c = Object.fromEntries(TABS.map((k) => [k, 0])) as Record<Tab, number>;
    for (const r of rows) for (const k of TABS) if (inTab(r, k)) c[k] += 1;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        inTab(r, tab) &&
        (!q || r.name.toLowerCase().includes(q) || (r.brandName ?? "").toLowerCase().includes(q) || r.entityId.startsWith(q)),
    );
  }, [rows, tab, query]);

  const { sorted, headerProps } = useSortableTable<ManagedEntityRow, SortKey>(
    filtered,
    {
      name: (r) => r.name,
      answers: (r) => r.answers,
      mentions: (r) => r.mentions,
      role: (r) => ROLE_ORDER[r.activeRole],
    },
    { defaultKey: "answers", defaultAsc: false, ascByDefault: ["name", "role"] },
  );

  const byId = useMemo(() => new Map(rows.map((r) => [r.entityId, r])), [rows]);
  const open = openId ? (byId.get(openId) ?? null) : null;

  return (
    <div className="flex flex-col gap-3" data-testid="ecat-entity-list">
      <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label={t("tabsLabel")}>
        {TABS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            data-testid={`ecat-tab-${k}`}
            onClick={() => {
              setTab(k);
              setShown(PAGE);
            }}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              tab === k ? "border-brand-700 bg-brand-700 text-white" : "border-border bg-background text-ink-700 hover:bg-bg-subtle",
            )}
          >
            {t(`tabs.${k}`)} <span className="tabular-nums opacity-80">{fmtInt(counts[k])}</span>
          </button>
        ))}
        <Link
          href={`${ECAT_BASE}/review`}
          className="rounded-full border border-dashed border-border px-3 py-1 text-xs text-ink-700 hover:bg-bg-subtle"
        >
          {t("tabs.review")} <span className="tabular-nums">{reviewCount == null ? "" : fmtInt(reviewCount)}</span>
        </Link>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("count", { shown: Math.min(shown, sorted.length), total: sorted.length })}
          <span className="ml-2">{t("periodNote")}</span>
        </p>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShown(PAGE);
            }}
            placeholder={t("search")}
            aria-label={t("search")}
            className="h-8 pl-8 text-xs"
            data-testid="ecat-search"
          />
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <SortableHeader {...headerProps("name")}>{t("colName")}</SortableHeader>
            </TableHead>
            <TableHead>{t("colType")}</TableHead>
            <TableHead>{t("colBrand")}</TableHead>
            <TableHead>
              <SortableHeader {...headerProps("role")}>{t("colRole")}</SortableHeader>
            </TableHead>
            {draftVer ? <TableHead>{t("colDraft", { ver: draftVer })}</TableHead> : null}
            <TableHead className="text-right">
              <SortableHeader {...headerProps("answers")}>{t("colAnswers")}</SortableHeader>
            </TableHead>
            <TableHead className="text-right">
              <SortableHeader {...headerProps("mentions")}>{t("colMentions")}</SortableHeader>
            </TableHead>
            <TableHead className="text-right">{t("colSurfaces")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.slice(0, shown).map((r) => (
            <TableRow
              key={r.entityId}
              className="cursor-pointer"
              data-testid="ecat-entity-row"
              data-entity-id={r.entityId}
              onClick={() => setOpenId(r.entityId)}
            >
              <TableCell className="font-medium">
                <button type="button" className="text-left hover:underline" onClick={() => setOpenId(r.entityId)}>
                  {r.name}
                </button>
                {r.origin === "hub" ? <Badge className="ml-1.5 bg-accent-info/15 text-[10px] text-ink-700">{t("hubBadge")}</Badge> : null}
                {!r.observed ? <span className="ml-1.5 text-[10px] text-muted-foreground">{t("notObserved")}</span> : null}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{r.entityType ?? ""}</TableCell>
              <TableCell className="text-xs">{r.brandName ?? ""}</TableCell>
              <TableCell>
                <span className="inline-flex flex-wrap items-center gap-1">
                  <RoleBadge role={r.activeRole} />
                  {r.activeOwnBrand && r.activeRole !== "own" ? <OwnLineageBadge brand={r.activeOwnBrand} /> : null}
                </span>
              </TableCell>
              {draftVer ? (
                <TableCell>
                  {r.draftChanged && r.draftRole ? (
                    <span className="inline-flex items-center gap-1">
                      <RoleBadge role={r.draftRole} />
                      {r.draftOwnBrand !== r.activeOwnBrand ? <OwnLineageBadge brand={r.draftOwnBrand} /> : null}
                      <span className="text-[10px] font-semibold text-accent-gold">{t("changedBadge")}</span>
                    </span>
                  ) : null}
                </TableCell>
              ) : null}
              <TableCell className="text-right tabular-nums">{fmtInt(r.answers)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtInt(r.mentions)}</TableCell>
              <TableCell className="text-right tabular-nums">{r.surfaceCount ? fmtInt(r.surfaceCount) : ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {sorted.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">{t("empty")}</p>
      ) : null}
      {sorted.length > shown ? (
        <Button variant="outline" size="sm" className="self-center text-xs" onClick={() => setShown((n) => n + PAGE)}>
          {t("more", { count: Math.min(PAGE, sorted.length - shown) })}
        </Button>
      ) : null}

      <EntityDrawer
        row={open}
        rows={rows}
        activeVer={activeVer}
        draftVer={draftVer}
        draftSurfaces={draftSurfaces}
        onClose={() => setOpenId(null)}
        onOpen={(id) => setOpenId(id)}
      />
    </div>
  );
}
