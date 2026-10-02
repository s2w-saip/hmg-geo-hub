"use client";

import { useTranslations } from "next-intl";
import { MousePointerClick, Users, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AiVisits } from "@/lib/ga4/conversion";

// AI 유입 사이트 방문 수 (sub-KPI). Volume lens — what the conversion-rate core
// KPI can't show: inflow magnitude (sessions/회), repeat-visit frequency
// (sessions/user), and landing-page distribution. Country-leaf live only; uses
// the same AI cohort + filters as ConversionView (filters narrow it identically).
//
// The daily 방문 수 추이 is NOT here — it's overlaid on ConversionView's trend
// chart (shared date axis) per the 2026-06-25 request. This section keeps the
// volume KPI cards + entry-page table.
//
// 2026-09-29 (U8, backend API source): the API reports sessions only (no user counts,
// BG-32 not provided). totalUsers / pages[].users may be null; then the unique-visitor and
// visit-frequency cards and the users column are hidden instead of showing "0 users"
// (known_diff U8-N4). The legacy GA4 source still fills them and renders as before.

/** AiVisits with optional user counts (null = not reported by the source). */
export type VisitsViewData = Omit<AiVisits, "totalUsers" | "pages"> & {
  totalUsers: number | null;
  pages: { url: string; sessions: number; users: number | null }[];
};

export function VisitsView({ data }: { data: AiVisits | VisitsViewData }) {
  const t = useTranslations("aiFunnelView.visits");
  const totalUsers = data.totalUsers;
  const hasUsers = totalUsers !== null;
  const freq = totalUsers !== null && totalUsers > 0 ? data.totalSessions / totalUsers : 0;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-1">
        <h3 className="font-head text-sm font-semibold tracking-tight text-foreground">
          {t("title")}
        </h3>
        <p className="text-[11px] text-muted-foreground">{t("subtitle")}</p>
      </div>

      <div className={cn("grid gap-3", hasUsers ? "sm:grid-cols-3" : "sm:grid-cols-1")}>
        <StatCard
          icon={MousePointerClick}
          label={t("kpi.visits")}
          value={`${data.totalSessions.toLocaleString()}${t("unit.visits")}`}
          hint={t("kpi.visitsHint")}
          color="text-brand-700"
        />
        {hasUsers ? (
          <>
            <StatCard
              icon={Users}
              label={t("kpi.visitors")}
              value={`${totalUsers.toLocaleString()}${t("unit.users")}`}
              hint={t("kpi.visitorsHint")}
              color="text-muted-foreground"
            />
            <StatCard
              icon={Repeat}
              label={t("kpi.frequency")}
              value={freq.toFixed(2)}
              hint={t("kpi.frequencyHint")}
              color="text-muted-foreground"
            />
          </>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <div className="border-b border-border px-4 py-3">
          <h4 className="text-sm font-semibold tracking-tight text-foreground">
            {t("table.title")}
          </h4>
          <p className="text-[11px] text-muted-foreground">{t("table.hint")}</p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              <th className="px-3 py-2">{t("table.col.url")}</th>
              <th className="px-3 py-2 text-right">{t("table.col.sessions")}</th>
              {hasUsers ? <th className="px-3 py-2 text-right">{t("table.col.users")}</th> : null}
            </tr>
          </thead>
          <tbody>
            {data.pages.map((p) => (
              <tr key={p.url} className="border-t border-border first:border-t-0">
                <td className="px-3 py-2 text-foreground">{p.url}</td>
                <td className="px-3 py-2 text-right font-medium text-foreground">
                  {p.sessions.toLocaleString()}
                </td>
                {hasUsers ? (
                  <td className="px-3 py-2 text-right text-muted-foreground">
                    {(p.users ?? 0).toLocaleString()}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint: string;
  color: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-background p-4">
      <div className="flex items-center gap-2">
        <Icon className={cn("h-4 w-4", color)} aria-hidden />
        <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
      </div>
      <span className={cn("font-head text-2xl font-semibold tracking-tight tabular-nums", color)}>
        {value}
      </span>
      <span className="text-[11px] text-muted-foreground">{hint}</span>
    </div>
  );
}
