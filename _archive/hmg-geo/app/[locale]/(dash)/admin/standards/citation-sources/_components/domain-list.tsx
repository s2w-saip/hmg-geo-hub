"use client";

import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, RotateCcw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
// taxonomy 에서 직접 가져온다 — 배럴(@/lib/citation-categorizer)은 geo-catalog/owned
// → lib/public-suffix(147KB PSL 스냅샷)까지 끌고 오는데, 이 파일은 "use client" 라
// 그게 그대로 브라우저 번들이 된다. 여기서 필요한 건 전부 taxonomy 의 상수뿐이다.
import {
  CITATION_CATEGORIES,
  CITATION_CATEGORY_SLUGS,
  FALLBACK_CATEGORY,
  type CitationCategory,
} from "@/lib/citation-categorizer/taxonomy";
import type { CitationDomainCurationRow } from "@/lib/db/repositories/citation-overrides";
import type { ClassificationSource } from "@/lib/citation-categorizer/source";
import {
  clearCitationDomainOverride,
  setCitationDomainCategory,
} from "../_actions";

type SortKey = "domain" | "citations" | "category" | "source";

const ALL = "__all__";

// 출처 배지 스타일 — 운영자 교정(override)만 강조하고, 나머지 계층은 조용한
// 회색 계열로 둔다. 색상은 토큰 클래스만 쓴다(컴포넌트 hex 금지).
const SOURCE_VARIANT: Record<
  ClassificationSource,
  "default" | "secondary" | "outline"
> = {
  override: "default",
  owned: "secondary",
  seed: "secondary",
  rule: "outline",
  fallback: "outline",
};

// 인용 도메인 큐레이션 — 도메인별 카테고리 교정 + 원복.
// 실제 작업량의 대부분은 미분류(Other) 정리라 "Other 만" 토글을 1급 필터로 둔다.
export function DomainList({
  rows,
  limit,
}: {
  rows: CitationDomainCurationRow[];
  limit: number;
}) {
  const t = useTranslations("adminCitationSources.list");
  const tc = useTranslations("citationCategories");
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>(ALL);
  const [otherOnly, setOtherOnly] = useState(false);

  const categoryLabel = (c: CitationCategory) => tc(CITATION_CATEGORY_SLUGS[c]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !r.domain.toLowerCase().includes(q)) return false;
      if (otherOnly && r.category !== FALLBACK_CATEGORY) return false;
      if (category !== ALL && r.category !== category) return false;
      return true;
    });
  }, [rows, query, category, otherOnly]);

  const { sorted, headerProps } = useSortableTable<
    CitationDomainCurationRow,
    SortKey
  >(
    filtered,
    {
      domain: (r) => r.domain,
      citations: (r) => r.citations,
      category: (r) => r.category,
      // 교정된 행이 먼저 오게 — 원복 대상을 찾기 쉽다.
      source: (r) => (r.source === "override" ? 0 : 1),
    },
    { defaultKey: "citations", defaultAsc: false, ascByDefault: ["domain", "category"] },
  );

  const overrideCount = rows.filter((r) => r.source === "override").length;
  const otherCount = rows.filter((r) => r.category === FALLBACK_CATEGORY).length;

  function onCategoryChange(row: CitationDomainCurationRow, next: string) {
    if (next === row.category) return;
    startTransition(async () => {
      const r = await setCitationDomainCategory(row.domain, next, row.overrideNote);
      if (r.ok) toast.success(t("saved", { domain: row.domain }));
      else toast.error(r.error);
    });
  }

  function onRevert(row: CitationDomainCurationRow) {
    startTransition(async () => {
      const r = await clearCitationDomainOverride(row.domain);
      if (r.ok) toast.success(t("reverted", { domain: row.domain }));
      else toast.error(r.error);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("count", {
            total: rows.length,
            overrides: overrideCount,
            other: otherCount,
          })}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              checked={otherOnly}
              onCheckedChange={(v) => setOtherOnly(v === true)}
              aria-label={t("otherOnly")}
            />
            {t("otherOnly")}
          </label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="h-8 w-44 text-xs" aria-label={t("filterCategory")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("filterAll")}</SelectItem>
              {CITATION_CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {categoryLabel(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[26%]">
              <SortableHeader {...headerProps("domain")}>{t("colDomain")}</SortableHeader>
            </TableHead>
            <TableHead className="w-[10%] text-right">
              <SortableHeader {...headerProps("citations")}>
                {t("colCitations")}
              </SortableHeader>
            </TableHead>
            <TableHead className="w-[18%]">
              <SortableHeader {...headerProps("category")}>
                {t("colCategory")}
              </SortableHeader>
            </TableHead>
            <TableHead className="w-[18%]">
              <SortableHeader {...headerProps("source")}>{t("colSource")}</SortableHeader>
            </TableHead>
            <TableHead className="w-[20%]">{t("colNote")}</TableHead>
            <TableHead className="w-[8%] text-right">{t("colActions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((row) => (
            <TableRow key={row.domain}>
              <TableCell className="font-medium">{row.domain}</TableCell>
              <TableCell className="text-right tabular-nums">
                {row.citations.toLocaleString()}
              </TableCell>
              <TableCell>
                <Select
                  value={row.category}
                  onValueChange={(v) => onCategoryChange(row, v)}
                  disabled={pending}
                >
                  <SelectTrigger className="h-8 w-44 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CITATION_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {categoryLabel(c)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell>
                <span className="inline-flex flex-wrap items-center gap-1">
                  <Badge variant={SOURCE_VARIANT[row.source]} className="text-[10px]">
                    {t(`source.${row.source}`)}
                  </Badge>
                  {row.shadowsOwned ? (
                    <Badge
                      variant="destructive"
                      className="gap-1 text-[10px]"
                      title={t("shadowsOwned")}
                    >
                      <AlertTriangle className="h-3 w-3" aria-hidden />
                      {t("shadowsOwned")}
                    </Badge>
                  ) : null}
                </span>
              </TableCell>
              <TableCell className="truncate text-xs text-muted-foreground">
                {row.overrideNote ?? ""}
              </TableCell>
              <TableCell className="text-right">
                {row.source === "override" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1 text-xs"
                    disabled={pending}
                    onClick={() => onRevert(row)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                    {t("revert")}
                  </Button>
                ) : null}
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
      <p className="text-[11px] text-muted-foreground">{t("hint", { limit })}</p>
    </div>
  );
}
