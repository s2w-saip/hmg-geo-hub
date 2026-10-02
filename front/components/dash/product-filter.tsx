"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Lock } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  PRODUCT_BRAND_PARAM,
  PRODUCT_PARAM,
  productBrands,
  segmentOptions,
  modelOptions,
  type ProductLevel,
  type ProductRow,
} from "./product-catalog";

// Cascading Product filter — Segment ▸ Model (parent narrows child). Rows come
// from the server (product-catalog-server::fetchProductRows → DISTINCT
// tracked_vehicles; swap target when the customer table arrives). Brand is the
// auth context, NOT a facet: admins switch it; everyone else is locked to their
// scope brand. ILLUSTRATIVE — writes its own URL params (pSegment/pModel),
// which the scope query mapping ignores; selecting one does not reload the
// live data yet.
export function ProductFilter({
  rows,
  canSelectBrand = false,
  scopedBrand = null,
}: {
  /** Product catalog rows (server-fetched, passed in by the page). */
  rows: ProductRow[];
  /** Admin (or scope.all) → Brand is a selectable dropdown. */
  canSelectBrand?: boolean;
  /** Non-admin's authorization brand (locked). null → all brands. */
  scopedBrand?: string | null;
}) {
  const t = useTranslations("dashboard.filters");
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [, startTransition] = useTransition();

  const brand = canSelectBrand
    ? (sp.get(PRODUCT_BRAND_PARAM) ?? "")
    : (scopedBrand ?? "");
  const list = (lvl: ProductLevel) =>
    (sp.get(PRODUCT_PARAM[lvl]) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const segment = list("segment");
  const model = list("model");

  const brands = brand ? [brand] : []; // [] = all
  const opts: Record<ProductLevel, string[]> = {
    segment: segmentOptions(rows, brands),
    model: modelOptions(rows, brands, segment),
  };

  // Keep only still-valid descendant selections after an ancestor changes.
  function prune(next: { brand: string; segment: string[]; model: string[] }) {
    const b = next.brand ? [next.brand] : [];
    const seg = next.segment.filter((x) => segmentOptions(rows, b).includes(x));
    const mod = next.model.filter((x) => modelOptions(rows, b, seg).includes(x));
    return { brand: next.brand, segment: seg, model: mod };
  }

  function commit(next: ReturnType<typeof prune>) {
    const params = new URLSearchParams(sp.toString());
    const put = (key: string, vals: string[]) =>
      vals.length ? params.set(key, vals.join(",")) : params.delete(key);
    if (canSelectBrand) put(PRODUCT_BRAND_PARAM, next.brand ? [next.brand] : []);
    put(PRODUCT_PARAM.segment, next.segment);
    put(PRODUCT_PARAM.model, next.model);
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  function setBrand(b: string) {
    commit(prune({ brand: b, segment, model }));
  }

  function toggle(level: ProductLevel, value: string) {
    const next = { brand, segment, model };
    const cur = next[level];
    next[level] = cur.includes(value)
      ? cur.filter((v) => v !== value)
      : [...cur, value];
    commit(prune(next));
  }

  function clearLevel(level: ProductLevel) {
    const next = { brand, segment, model };
    next[level] = [];
    commit(prune(next));
  }

  const selected: Record<ProductLevel, string[]> = { segment, model };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Brand — auth context. Admin: selectable; others: locked chip. */}
      {canSelectBrand ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors",
                brand
                  ? "border-brand-700 bg-brand-700/5 font-medium text-foreground"
                  : "border-input bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                {t("product.brand")}
              </span>
              <span className="truncate">{brand || t("product.allBrands")}</span>
              <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            <DropdownMenuRadioGroup value={brand} onValueChange={setBrand}>
              <DropdownMenuRadioItem value="">{t("product.allBrands")}</DropdownMenuRadioItem>
              {productBrands(rows).map((b) => (
                <DropdownMenuRadioItem key={b} value={b}>
                  {b}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-dashed border-border bg-muted/30 px-2.5 text-xs text-muted-foreground"
          title={t("product.brandLocked")}
        >
          <Lock className="h-3 w-3" aria-hidden />
          <span className="text-[10px] tracking-wide uppercase">{t("product.brand")}</span>
          <span className="font-medium text-foreground">
            {scopedBrand || t("product.allBrands")}
          </span>
        </span>
      )}

      {/* Cascading facets: Segment ▸ Model */}
      {(["segment", "model"] as ProductLevel[]).map((level) => (
        <LevelFacet
          key={level}
          label={t(`product.${level}`)}
          options={opts[level]}
          selected={selected[level]}
          clearLabel={t("clearAxis")}
          onToggle={(v) => toggle(level, v)}
          onClear={() => clearLevel(level)}
        />
      ))}
    </div>
  );
}

function LevelFacet({
  label,
  options,
  selected,
  clearLabel,
  onToggle,
  onClear,
}: {
  label: string;
  options: string[];
  selected: string[];
  clearLabel: string;
  onToggle: (v: string) => void;
  onClear: () => void;
}) {
  const count = selected.length;
  const active = count > 0;
  const disabled = options.length === 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors disabled:opacity-40",
            active
              ? "border-brand-700 bg-brand-700/5 font-medium text-foreground"
              : "border-input bg-card text-muted-foreground hover:text-foreground",
          )}
        >
          <span className="truncate">{label}</span>
          {active ? (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-700 px-1 text-[10px] font-semibold tabular-nums text-white">
              {count}
            </span>
          ) : null}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-52 overflow-y-auto">
        {options.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt}
            checked={selected.includes(opt)}
            onCheckedChange={() => onToggle(opt)}
            onSelect={(e) => e.preventDefault()}
          >
            {opt}
          </DropdownMenuCheckboxItem>
        ))}
        {active ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                onClear();
              }}
              className="justify-center text-xs text-muted-foreground"
            >
              {clearLabel}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
