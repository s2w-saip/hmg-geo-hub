"use client";

import { useTranslations } from "next-intl";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DimensionState } from "@/lib/auth/scope-policy";
import type { FilterDimension } from "@/lib/scope/dimensions";
import { cn } from "@/lib/utils";

// Sentinel for the "no narrowing" option. radix-ui's Select can't use "" as a
// value, so we encode the unset state as a distinct string and strip it from
// the URL when picked.
const ALL = "__ALL__";

export interface DashboardFiltersProps {
  // Pre-resolved server-side: which dimensions are editable, what each user is
  // allowed to pick, and the current selection. Computed via
  // resolveDimensionState(user.scope, dim, requested) on the server so the
  // policy stays in one place — the client never decides what's locked.
  states: Record<FilterDimension, DimensionState>;
}

const ORDER: FilterDimension[] = ["brand", "region", "country"];

export function DashboardFilters({ states }: DashboardFiltersProps) {
  const t = useTranslations("dashboard.filters");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function update(dim: FilterDimension, next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === ALL) params.delete(dim);
    else params.set(dim, next);
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  return (
    <div
      aria-label={t("groupLabel")}
      className={cn(
        "flex flex-wrap items-end gap-3 sm:gap-4",
        isPending && "opacity-70",
      )}
    >
      {ORDER.map((dim) => {
        const state = states[dim];
        const triggerId = `filter-${dim}`;
        // Locked dimensions render as a disabled trigger showing the pinned
        // value — never as a hidden field — so the user can see *why* they
        // can't change it (their scope) rather than wondering where the
        // control went.
        return (
          <div key={dim} className="flex flex-col gap-1.5">
            <label
              htmlFor={triggerId}
              className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
            >
              {t(`labels.${dim}`)}
            </label>
            <Select
              value={state.value ?? ALL}
              onValueChange={(v) => update(dim, v)}
              disabled={!state.editable}
            >
              <SelectTrigger id={triggerId} className="min-w-[10rem]">
                <SelectValue placeholder={t("allOption")} />
              </SelectTrigger>
              <SelectContent>
                {state.editable ? (
                  <SelectItem value={ALL}>{t("allOption")}</SelectItem>
                ) : null}
                {state.options.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      })}
    </div>
  );
}
