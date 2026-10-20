"use client";

import { useMemo } from "react";
import { useTranslations, useLocale } from "next-intl";
import { cn } from "@/lib/utils";
import { useSortableTable } from "@/hooks/use-sortable-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import type { AiTrafficConversionCountry } from "@/lib/ga4/conversion";
import { rhqForCountry, rhqLabel } from "@/lib/rhq";
import { countryName } from "@/lib/geo-catalog/country-name";

// Region/HQ view of the AI Conversion page — 2-depth (권역 > 국가).
//
// HQ scope reaches ~80 countries — a flat 80-row table overflows the
// viewport and loses 권역 context. Group by 권역 instead: one section per
// region with its own header, sortable inner table, and 권역-level
// weighted aggregate. RHQ scope (Europe only) collapses to one section,
// which is still useful — keeps the layout consistent across roles.
//
// Sections are listed by 권역 측정 활성사용자 desc (biggest market first).
// Only 권역 with at least one measured market are shown; unmeasured 권역
// are summarized by the page-level coverage strip above.

type CountrySortKey =
  | "country"
  | "aiUsers"
  | "humanUsers"
  | "aiRate"
  | "humanRate"
  | "lift";

// 분모(사용자·세션) 0 = 측정값 없음 → null("—"). 0.0% 로 그리면 격차가 −일반 전환율이 되어 표 맨 아래로 가라앉는다.
const pct = (n: number, d: number): number | null =>
  d > 0 ? Math.round((n / d) * 1000) / 10 : null;
const gap = (ai: number | null, human: number | null): number | null =>
  ai == null || human == null ? null : Math.round((ai - human) * 10) / 10;
const fmtRate = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`);

interface RegionGroup {
  region: string; // catalog region key
  rows: AiTrafficConversionCountry[];
  // 권역 가중 합산 — 측정된 시장만 (분모/분자 모두 합산).
  aiUsersSum: number;
  humanUsersSum: number;
  aiConvRate: number | null;
  humanConvRate: number | null;
  lift: number | null;
}

/** 권역(RHQ)별 묶음 + 권역 가중 전환율. 순수 함수(표 컴포넌트·시험이 같이 쓴다). */
export function groupConversionByRegion(
  rows: AiTrafficConversionCountry[],
  activeBrand: string | null,
): RegionGroup[] {
  const byRegion = new Map<string, AiTrafficConversionCountry[]>();
  for (const r of rows) {
    // r.country = ISO code (scope_answers.region). 활성 브랜드의 RHQ 권역으로.
    const key = (activeBrand && rhqForCountry(activeBrand, r.country)) ?? "unknown";
    const list = byRegion.get(key) ?? [];
    list.push(r);
    byRegion.set(key, list);
  }
  const out: RegionGroup[] = [];
  for (const [region, rs] of byRegion) {
    // 권역 전환율 = 국가 전환 수 합 ÷ 국가 사용자 합. 전환 수 원값(aiKeyEvents)이 있으면 그 합이고, 없는 옛 행만
    // 반올림된 전환율 × 사용자로 되살린다(그 경우 최대 0.1%p 어긋난다).
    const aiUsersSum = rs.reduce((s, r) => s + r.aiUsers, 0);
    const humanUsersSum = rs.reduce((s, r) => s + r.humanUsers, 0);
    const aiKeySum = rs.reduce((s, r) => s + (r.aiKeyEvents ?? ((r.aiConvRate ?? 0) / 100) * r.aiUsers), 0);
    const humanKeySum = rs.reduce(
      (s, r) => s + (r.humanKeyEvents ?? ((r.humanConvRate ?? 0) / 100) * r.humanUsers),
      0,
    );
    const aiConvRate = pct(aiKeySum, aiUsersSum);
    const humanConvRate = pct(humanKeySum, humanUsersSum);
    out.push({
      region,
      rows: rs,
      aiUsersSum,
      humanUsersSum,
      aiConvRate,
      humanConvRate,
      lift: gap(aiConvRate, humanConvRate),
    });
  }
  // Biggest region (by AI users) first.
  return out.sort((a, b) => b.aiUsersSum - a.aiUsersSum);
}

export function CountryConversionTable({
  rows,
  activeBrand,
}: {
  rows: AiTrafficConversionCountry[];
  // 권역(RHQ) 그룹핑 기준 브랜드. null이면(admin 전체-브랜드) 단일 "전체" 그룹.
  activeBrand: string | null;
}) {
  const t = useTranslations("aiFunnelView.conversion");

  // Group by 권역 + per-region weighted aggregate.
  const groups: RegionGroup[] = useMemo(() => groupConversionByRegion(rows, activeBrand), [rows, activeBrand]);

  if (groups.length === 0) return null;

  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <RegionSection key={g.region} group={g} t={t} />
      ))}
    </div>
  );
}

function RegionSection({
  group,
  t,
}: {
  group: RegionGroup;
  t: ReturnType<typeof useTranslations>;
}) {
  const locale = useLocale();
  // group.region = RHQ 권역 id ("unknown"이면 미귀속 그룹). 라벨은 권역 id로 조회.
  const regionLabel =
    group.region === "unknown"
      ? t("regionUnknown")
      : rhqLabel(group.region, locale === "en" ? "en" : "ko") ?? group.region;
  const labeled = useMemo(
    () =>
      group.rows.map((r) => ({
        ...r,
        // r.country = GA4 매핑 카탈로그 국가(관리자 자유 입력 — ISO 보장 없음).
        // 가드 없는 Intl.of 는 비표준 코드에서 RangeError 로 표 전체가 죽는다.
        countryLabel: countryName(r.country, locale),
      })),
    [group.rows, locale],
  );
  const { sorted, headerProps } = useSortableTable<
    (typeof labeled)[number],
    CountrySortKey
  >(
    labeled,
    {
      country: (r) => r.countryLabel,
      aiUsers: (r) => r.aiUsers,
      humanUsers: (r) => r.humanUsers,
      aiRate: (r) => r.aiConvRate,
      humanRate: (r) => r.humanConvRate,
      lift: (r) => r.lift,
    },
    { defaultKey: "lift", defaultAsc: false, ascByDefault: ["country"] },
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold tracking-tight text-foreground">
            {regionLabel}
          </h3>
          <p className="text-[11px] text-muted-foreground">
            {t("region.summary", {
              count: group.rows.length,
              ai: fmtRate(group.aiConvRate),
              human: fmtRate(group.humanConvRate),
              lift: group.lift == null ? "—" : `${group.lift >= 0 ? "+" : ""}${group.lift.toFixed(1)}pp`,
            })}
          </p>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            <th className="px-3 py-2"><SortableHeader {...headerProps("country")}>{t("countries.col.country")}</SortableHeader></th>
            <th className="px-3 py-2"><SortableHeader {...headerProps("aiUsers")} align="right">{t("table.col.aiUsers")}</SortableHeader></th>
            <th className="px-3 py-2"><SortableHeader {...headerProps("humanUsers")} align="right">{t("table.col.humanUsers")}</SortableHeader></th>
            <th className="px-3 py-2"><SortableHeader {...headerProps("aiRate")} align="right">{t("table.col.aiRate")}</SortableHeader></th>
            <th className="px-3 py-2"><SortableHeader {...headerProps("humanRate")} align="right">{t("table.col.humanRate")}</SortableHeader></th>
            <th className="px-3 py-2"><SortableHeader {...headerProps("lift")} align="right">{t("table.col.lift")}</SortableHeader></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={`${r.brand}-${r.country}`} className="border-t border-border first:border-t-0">
              <td className="px-3 py-2 text-foreground">{r.countryLabel}</td>
              <td className="px-3 py-2 text-right text-foreground">{r.aiUsers.toLocaleString()}</td>
              <td className="px-3 py-2 text-right text-muted-foreground">{r.humanUsers.toLocaleString()}</td>
              <td className="px-3 py-2 text-right font-medium text-foreground">{fmtRate(r.aiConvRate)}</td>
              <td className="px-3 py-2 text-right text-muted-foreground">{fmtRate(r.humanConvRate)}</td>
              <td
                className={cn(
                  "px-3 py-2 text-right font-semibold",
                  r.lift != null && r.lift > 0
                    ? "text-emerald-600"
                    : r.lift != null && r.lift < 0
                      ? "text-destructive"
                      : "text-muted-foreground",
                )}
              >
                {r.lift == null ? "—" : `${r.lift > 0 ? "+" : ""}${r.lift.toFixed(1)}pp`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
