"use client";

import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Crown, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSortableTable } from "@/hooks/use-sortable-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import type { DiscoveredBrandRow } from "@/lib/db/repositories/entity-registry";
import { setEntityRole } from "../_actions";

type Role = DiscoveredBrandRow["role"];
type SortKey = "name" | "mentions" | "answers" | "role";

// 엔티티 카탈로그 — 측정에서 발견된 브랜드 전체 + 역할 편집. 역할 변경은 즉시
// 전 화면 KPI의 당사 판정에 반영된다(집계 캐시 무효화 — _actions.ts). 경쟁사는
// 파생 기본값(명부 미저장), 자사/제외만 명부에 등재된다.
export function EntityCatalog({ rows }: { rows: DiscoveredBrandRow[] }) {
  const t = useTranslations("adminStandardEntities.catalog");
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q));
  }, [rows, query]);

  const { sorted, headerProps } = useSortableTable<DiscoveredBrandRow, SortKey>(
    filtered,
    {
      name: (r) => r.name,
      mentions: (r) => r.mentions,
      answers: (r) => r.answers,
      // 자사 → 제외 → 경쟁사 순으로 묶이게 정렬 가중치.
      role: (r) => (r.role === "own" ? 0 : r.role === "excluded" ? 1 : 2),
    },
    { defaultKey: "mentions", defaultAsc: false, ascByDefault: ["name", "role"] },
  );

  function onRoleChange(row: DiscoveredBrandRow, role: Role) {
    if (role === row.role) return;
    startTransition(async () => {
      const r = await setEntityRole(row.entityId, row.name, role);
      if (r.ok) toast.success(t("roleUpdated", { brand: row.name }));
      else toast.error(r.error);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("count", { total: rows.length, own: rows.filter((r) => r.role === "own").length })}
        </p>
        <div className="relative w-full sm:w-56">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <SortableHeader {...headerProps("name")}>{t("colBrand")}</SortableHeader>
            </TableHead>
            <TableHead className="text-right">
              <SortableHeader {...headerProps("mentions")}>{t("colMentions")}</SortableHeader>
            </TableHead>
            <TableHead className="text-right">
              <SortableHeader {...headerProps("answers")}>{t("colAnswers")}</SortableHeader>
            </TableHead>
            <TableHead>
              <SortableHeader {...headerProps("role")}>{t("colRole")}</SortableHeader>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((row) => (
            <TableRow key={row.entityId}>
              <TableCell className="font-medium">
                <span className="inline-flex items-center gap-1.5">
                  {row.name}
                  {row.role === "own" ? (
                    <Badge className="gap-1 bg-brand-700 text-[10px] text-white">
                      <Crown className="h-3 w-3" aria-hidden />
                      {t("ownBadge")}
                    </Badge>
                  ) : null}
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.mentions.toLocaleString()}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.answers.toLocaleString()}
              </TableCell>
              <TableCell>
                <Select
                  value={row.role}
                  onValueChange={(v) => onRoleChange(row, v as Role)}
                  disabled={pending}
                >
                  <SelectTrigger className="h-8 w-36 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="own">{t("roleOwn")}</SelectItem>
                    <SelectItem value="competitor">{t("roleCompetitor")}</SelectItem>
                    <SelectItem value="excluded">{t("roleExcluded")}</SelectItem>
                  </SelectContent>
                </Select>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {sorted.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          {t("empty")}
        </p>
      ) : null}
      <p className="text-[11px] text-muted-foreground">{t("excludedHint")}</p>
    </div>
  );
}
