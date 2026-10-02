import { getLocale, getTranslations } from "next-intl/server";
import {
  FolderPlus,
  Users,
  Sparkles,
  PlayCircle,
  Globe,
  Car,
} from "lucide-react";
import { SectionCard } from "@/components/section-card";
import { countryName } from "@/lib/geo-catalog";
import type { ProjectRow } from "@/lib/db/schema";

// Aggregate dashboard rendered above the project card list. Reads only
// project rows + already-fetched prompt/member totals so it stays cheap
// (per-project queries already happen in the page; we just summarise).
//
// Tiles:
//   - Total projects (scope-filtered by the page layer)
//   - Active members across visible projects
//   - 최근 7일 신규 프로젝트
//   - 실행 대기 프롬프트 (queued + running)
//
// Plus brand/country distribution micro-bars so HQ/region operators can
// scan the portfolio composition at a glance.

export type ProjectsOverviewInput = {
  projects: ProjectRow[];
  totalActiveMembers: number;
  totalQueuedPrompts: number;
};

const RECENT_WINDOW_DAYS = 7;

export async function ProjectsOverview({
  projects,
  totalActiveMembers,
  totalQueuedPrompts,
}: ProjectsOverviewInput) {
  const t = await getTranslations("projects.overview");
  const locale = await getLocale();
  const now = new Date();
  const cutoff = new Date(now.getTime() - RECENT_WINDOW_DAYS * 86_400_000);

  const recentCount = projects.filter((p) => p.createdAt >= cutoff).length;

  const brandDistribution = countBy(projects, (p) => p.brand ?? "—");
  // country column holds ISO codes; render locale-specific full names.
  const countryDistribution = countBy(projects, (p) =>
    countryName(p.country, locale),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          icon={FolderPlus}
          label={t("tiles.total")}
          value={projects.length}
        />
        <Tile
          icon={Users}
          label={t("tiles.members")}
          value={totalActiveMembers}
        />
        <Tile
          icon={Sparkles}
          label={t("tiles.recent", { days: RECENT_WINDOW_DAYS })}
          value={recentCount}
        />
        <Tile
          icon={PlayCircle}
          label={t("tiles.queued")}
          value={totalQueuedPrompts}
        />
      </div>

      {projects.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard
            title={t("distribution.brand.title")}
            description={t("distribution.brand.description")}
          >
            <DistributionList icon={Car} entries={brandDistribution} />
          </SectionCard>
          <SectionCard
            title={t("distribution.country.title")}
            description={t("distribution.country.description")}
          >
            <DistributionList icon={Globe} entries={countryDistribution} />
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
      <Icon className="h-5 w-5 text-brand-700" aria-hidden />
      <div className="flex min-w-0 flex-col">
        <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        <span className="font-head text-xl font-semibold tracking-tight tabular-nums text-foreground">
          {typeof value === "number" ? value.toLocaleString() : value}
        </span>
      </div>
    </div>
  );
}

function DistributionList({
  icon: Icon,
  entries,
}: {
  icon: React.ComponentType<{ className?: string }>;
  entries: { key: string; count: number }[];
}) {
  const max = Math.max(1, ...entries.map((e) => e.count));
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">—</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {entries.slice(0, 6).map((e) => (
        <li key={e.key} className="flex items-center gap-3">
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="w-28 shrink-0 truncate text-sm text-foreground">
            {e.key}
          </span>
          <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="absolute top-0 left-0 h-full rounded-full bg-brand-700"
              style={{ width: `${(e.count / max) * 100}%` }}
            />
          </div>
          <span className="w-8 shrink-0 text-right text-xs tabular-nums font-medium text-muted-foreground">
            {e.count}
          </span>
        </li>
      ))}
    </ul>
  );
}

function countBy<T>(arr: T[], key: (x: T) => string): { key: string; count: number }[] {
  const m = new Map<string, number>();
  for (const x of arr) {
    const k = key(x);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return Array.from(m, ([k, count]) => ({ key: k, count })).sort(
    (a, b) => b.count - a.count,
  );
}
