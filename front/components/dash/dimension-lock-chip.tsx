import { useTranslations } from "next-intl";
import { Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { DimensionGroup } from "./dimension-filter-panel";

// Project context의 dimension lock을 헤더에 표시하는 readonly chip
// (F4=B 결정). DimensionFilterPanel의 lockedGroups와 짝.
//
// 예: Project = "Ioniq 6 한국 런칭" → 헤더에 [🔒 Hyundai] [🔒 KR] chip,
// 필터 영역에서는 vehicle/geography 카드 자체가 제거됨.

export type DimensionLockChipProps = {
  group: DimensionGroup;
  value: string;
  className?: string;
};

export function DimensionLockChip({
  group,
  value,
  className,
}: DimensionLockChipProps) {
  const tNav = useTranslations("dashboard.filters.group");
  return (
    <Badge
      variant="outline"
      className={cn(
        "inline-flex items-center gap-1 border-border bg-card text-foreground",
        className,
      )}
      title={`${tNav(group)}: ${value}`}
    >
      <Lock className="h-3 w-3 text-muted-foreground" aria-hidden />
      <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {tNav(group)}
      </span>
      <span className="text-xs font-medium">{value}</span>
    </Badge>
  );
}

export function DimensionLockChipGroup({
  locks,
  className,
}: {
  locks: { group: DimensionGroup; value: string }[];
  className?: string;
}) {
  if (locks.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {locks.map((l) => (
        <DimensionLockChip key={l.group} group={l.group} value={l.value} />
      ))}
    </div>
  );
}
