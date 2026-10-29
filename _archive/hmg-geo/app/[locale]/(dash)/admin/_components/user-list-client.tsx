"use client";

import { useMemo, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { rhqLabel } from "@/lib/rhq";
import { Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SortableHeader } from "@/components/ui/sortable-header";
import { useSortableTable } from "@/hooks/use-sortable-table";
import { EditUserDialog, type EditableUser } from "./edit-user-dialog";
import type { Role, OperatorScope } from "@/lib/auth/types";

// What the server-side parent sends down. Drizzle's ProfileRow leaks Date
// objects that don't serialize cleanly across the server→client boundary,
// so we project to plain primitives in the server component before passing.
export interface UserRow {
  id: string;
  email: string | null;
  role: Role;
  scopeAll: boolean;
  brands: string[] | null;
  regions: string[] | null;
  countries: string[] | null;
  operator: OperatorScope;
  createdAt: string | null; // ISO date string (YYYY-MM-DD)
  lastSignInAt: string | null; // ISO date string (YYYY-MM-DD)
}

interface Props {
  users: UserRow[];
  selfId: string;
}

// Sortable columns — every header cell is a sort toggle.
type SortKey =
  | "email"
  | "role"
  | "scope"
  | "operator"
  | "createdAt"
  | "lastSignIn";

// Per-role Badge variant. Admin gets the destructive (strongest) tone since the
// privilege level is highest; HQ uses default (brand primary); region/country
// use secondary/outline neutrals so they recede into the row.
function roleBadgeVariant(
  role: Role,
): "default" | "destructive" | "secondary" | "outline" {
  switch (role) {
    case "admin":
      return "destructive";
    case "hq":
      return "default";
    case "region":
      return "secondary";
    case "country":
      return "outline";
    case "vendor":
      // Visually distinct from country (outline) and aligned with region's
      // secondary tone — vendor sits at the same "external partner" tier.
      return "secondary";
    case "website":
      // Read-only single-surface viewer — recedes like country.
      return "outline";
  }
}

// Operator (운영권한) Badge tone. Escalates with privilege: read-only recedes
// (outline), assigned is neutral (secondary), global is emphasized (default).
function operatorBadgeVariant(
  op: OperatorScope,
): "default" | "secondary" | "outline" {
  switch (op) {
    case "global":
      return "default";
    case "assigned":
      return "secondary";
    case "none":
      return "outline";
  }
}

// Numeric rank for sorting operator by privilege level (none < assigned < global)
// rather than by alphabetized label.
const OPERATOR_RANK: Record<OperatorScope, number> = {
  none: 0,
  assigned: 1,
  global: 2,
};

// Compact scope summary for the display row. Full editing happens in the
// dialog — this string only needs to communicate "what shape of access this
// user has" at a glance.
function scopeSummary(
  u: UserRow,
  labels: { all: string; none: string },
  lang: "ko" | "en",
): string {
  if (u.scopeAll) return labels.all;
  const parts: string[] = [];
  if (u.brands?.length) parts.push(u.brands.join(", "));
  // region 값 = RHQ 권역 id → 표시 라벨(rhqLabel)로.
  if (u.regions?.length)
    parts.push(u.regions.map((r) => rhqLabel(r, lang) ?? r).join(", "));
  if (u.countries?.length) parts.push(u.countries.join(", "));
  return parts.length ? parts.join(" · ") : labels.none;
}

export function UserListClient({ users, selfId }: Props) {
  const t = useTranslations("admin.list");
  const tSearch = useTranslations("admin.list.search");
  const tRoles = useTranslations("roles");
  const lang = useLocale() === "en" ? "en" : "ko";
  const tCols = useTranslations("admin.list.columns");
  const tOp = useTranslations("admin.list.operator");

  const [query, setQuery] = useState("");
  const [openUserId, setOpenUserId] = useState<string | null>(null);

  // Client-side filter — email substring + translated role label substring.
  // Case-insensitive. With the planned scale (tens to a few hundred users)
  // this stays well under a frame's worth of work; revisit only if the list
  // is paginated server-side later.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const email = (u.email ?? "").toLowerCase();
      const roleLabel = tRoles(u.role).toLowerCase();
      return email.includes(q) || roleLabel.includes(q);
    });
  }, [users, query, tRoles]);

  // Client-side sort over the filtered set. String columns flip to ascending
  // on first click; createdAt defaults to descending to preserve the server's
  // newest-first ordering. Operator sorts by privilege rank, not label.
  const sorters = useMemo<Record<SortKey, (u: UserRow) => string | number>>(
    () => ({
      email: (u: UserRow) => (u.email ?? "").toLowerCase(),
      role: (u: UserRow) => tRoles(u.role).toLowerCase(),
      scope: (u: UserRow) =>
        scopeSummary(u, { all: t("scopeAll"), none: t("noScope") }, lang).toLowerCase(),
      operator: (u: UserRow) => OPERATOR_RANK[u.operator],
      createdAt: (u: UserRow) => u.createdAt ?? "",
      lastSignIn: (u: UserRow) => u.lastSignInAt ?? "",
    }),
    [tRoles, t],
  );

  const { sorted, headerProps } = useSortableTable<UserRow, SortKey>(
    filtered,
    sorters,
    {
      defaultKey: "createdAt",
      defaultAsc: false,
      ascByDefault: ["email", "role", "scope"],
    },
  );

  const openUser = useMemo(
    () => users.find((u) => u.id === openUserId) ?? null,
    [users, openUserId],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Search row — a single input is enough for this scale. Clear (×)
          surfaces only when there's something to clear. */}
      <div className="relative max-w-sm">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tSearch("placeholder")}
          className="h-9 pl-9 pr-9 text-sm"
          aria-label={tSearch("placeholder")}
        />
        {query && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => setQuery("")}
            aria-label={tSearch("clear")}
            className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </Button>
        )}
      </div>

      {/* Rows — display-only. Container is borderless to match other
          SectionCards; only hairlines between rows + a hairline under the
          header keep visual structure. Hover gives the only "this is
          clickable" signal alongside the role=button affordance. */}
      {filtered.length === 0 ? (
        <p className="rounded-md bg-muted/40 px-4 py-6 text-center text-xs text-muted-foreground">
          {query ? tSearch("empty") : t("empty")}
        </p>
      ) : (
        <>
        <div className="flex flex-col gap-2 md:hidden">
          {sorted.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => setOpenUserId(u.id)}
              aria-label={t("rowAria", { email: u.email ?? u.id })}
              className="rounded-lg border border-border bg-card px-4 py-3 text-left shadow-soft transition-colors hover:border-brand-700/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 truncate font-mono text-sm font-medium text-foreground">
                  {u.email ?? "—"}
                </span>
                <Badge variant={roleBadgeVariant(u.role)}>
                  {tRoles(u.role)}
                </Badge>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <span className="text-muted-foreground">{tCols("scope")}</span>
                <span className="truncate text-right text-foreground">
                  {scopeSummary(u, {
                    all: t("scopeAll"),
                    none: t("noScope"),
                  }, lang)}
                </span>
                <span className="text-muted-foreground">{tCols("operator")}</span>
                <span className="flex justify-end">
                  <Badge variant={operatorBadgeVariant(u.operator)}>
                    {tOp(u.operator)}
                  </Badge>
                </span>
                <span className="text-muted-foreground">{tCols("lastSignIn")}</span>
                <span className="text-right text-foreground">
                  {u.lastSignInAt ?? t("neverSignedIn")}
                </span>
              </div>
            </button>
          ))}
        </div>

        <div className="hidden overflow-x-auto md:block">
          <div
            role="table"
            aria-label={t("heading")}
            className="min-w-[880px]"
          >
            {/* Header row — each cell is a sort toggle (see useSortableTable). */}
            <div
              role="row"
              className="grid grid-cols-[2fr_1fr_1.5fr_1fr_1fr_1fr] gap-3 border-b border-border px-4 pb-2 text-[10px] font-semibold tracking-[0.14em] uppercase"
            >
              <span role="columnheader">
                <SortableHeader {...headerProps("email")}>
                  {tCols("email")}
                </SortableHeader>
              </span>
              <span role="columnheader">
                <SortableHeader {...headerProps("role")}>
                  {tCols("role")}
                </SortableHeader>
              </span>
              <span role="columnheader">
                <SortableHeader {...headerProps("scope")}>
                  {tCols("scope")}
                </SortableHeader>
              </span>
              <span role="columnheader">
                <SortableHeader {...headerProps("operator")}>
                  {tCols("operator")}
                </SortableHeader>
              </span>
              <span role="columnheader">
                <SortableHeader {...headerProps("createdAt")}>
                  {tCols("createdAt")}
                </SortableHeader>
              </span>
              <span role="columnheader">
                <SortableHeader {...headerProps("lastSignIn")}>
                  {tCols("lastSignIn")}
                </SortableHeader>
              </span>
            </div>

            {/* Data rows — entire row is the click target. role="button"
                + Enter/Space handler keeps keyboard parity with mouse. */}
            <ul className="divide-y divide-border">
              {sorted.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => setOpenUserId(u.id)}
                    aria-label={t("rowAria", { email: u.email ?? u.id })}
                    className="grid w-full grid-cols-[2fr_1fr_1.5fr_1fr_1fr_1fr] items-center gap-3 px-4 py-3 text-left text-xs transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <span className="truncate font-mono text-foreground">
                      {u.email ?? "—"}
                    </span>
                    <span>
                      <Badge variant={roleBadgeVariant(u.role)}>
                        {tRoles(u.role)}
                      </Badge>
                    </span>
                    <span className="truncate text-muted-foreground">
                      {scopeSummary(u, {
                        all: t("scopeAll"),
                        none: t("noScope"),
                      }, lang)}
                    </span>
                    <span>
                      <Badge variant={operatorBadgeVariant(u.operator)}>
                        {tOp(u.operator)}
                      </Badge>
                    </span>
                    <span className="text-muted-foreground">
                      {u.createdAt ?? "—"}
                    </span>
                    <span className="text-muted-foreground">
                      {u.lastSignInAt ?? t("neverSignedIn")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
        </>
      )}

      {/* Mount the dialog conditionally on a selected user so opening always
          starts from fresh form state (no stale values from the previously
          opened row). The parent server component re-renders this list
          after revalidatePath, which refreshes the `users` prop and the
          dialog's user reference together. */}
      {openUser && (
        <EditUserDialog
          user={openUser as EditableUser}
          selfId={selfId}
          open={openUserId !== null}
          onOpenChange={(open) => {
            if (!open) setOpenUserId(null);
          }}
        />
      )}
    </div>
  );
}
