"use client";

import { useTranslations, useLocale } from "next-intl";
import { cn } from "@/lib/utils";
import { countryName } from "@/lib/geo-catalog";
import { rhqLabel } from "@/lib/rhq";
import type { MarketCompetition } from "../_data/live-types";

// The fields this snapshot draws (LiveGeo and the screens' GeoView both carry them).
type SnapshotGeo = {
  markets: (MarketCompetition & { region: string; countries: (MarketCompetition & { code: string })[] })[];
  pending: string[];
  ourLabel: string;
};

// GEO 스냅샷 — "시장별 경쟁 위치". 각 시장(권역→국가)에서 HMG가 경쟁사 대비 어디에
// 서 있는지: HMG 합산 점유율(SoV) + 순위 + 최대 경쟁사. 국가 드릴다운은 그 시장의
// 선두 HMG 브랜드를 보여줘 "독일=Kia, 한국=Hyundai" 같은 차이를 드러낸다. 권역(RHQ)은
// 활성 브랜드 정본(lib/rhq)에서 파생 — 라벨은 권역 id로 조회. 미측정 권역은 "측정 예정".

export function GeoSnapshot({ geo }: { geo: SnapshotGeo }) {
  const t = useTranslations("dashboard.geo");
  const locale = useLocale();
  const { markets, pending } = geo;
  if (markets.length === 0 && pending.length === 0) return null;

  const label = (regionId: string) =>
    rhqLabel(regionId, locale === "en" ? "en" : "ko") ?? regionId;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">
          {t("title")}
        </h3>
        <span className="text-[11px] text-muted-foreground">
          {t("metric", { brand: geo.ourLabel })}
        </span>
      </div>

      <ul className="flex flex-col gap-4">
        {markets.map((m) => (
          <li key={m.region} className="flex flex-col gap-1.5">
            {/* 권역 행 — HMG 순위 · 점유율 · 최대 경쟁사 */}
            <div className="flex items-center gap-3">
              <RankBadge rank={m.noMentions ? null : m.hmgRank} />
              <span className="w-20 shrink-0 truncate text-xs font-semibold text-foreground">
                {label(m.region)}
              </span>
              <Bar value={m.noMentions ? 0 : m.hmgSov} strong />
              <span className="w-14 shrink-0 text-right text-xs font-semibold tabular-nums text-foreground">
                {m.noMentions ? "—" : `${m.hmgSov.toFixed(1)}%`}
              </span>
              <span className="w-44 shrink-0 truncate text-right text-[11px] text-muted-foreground">
                {m.topRival
                  ? `${t("rival")} ${m.topRival.name} ${m.topRival.sov.toFixed(1)}%`
                  : ""}
              </span>
            </div>

            {/* 국가 드릴다운 — 그 시장의 선두 HMG 브랜드 */}
            <ul className="flex flex-col gap-1 pl-9">
              {m.countries.map((c) => (
                <li key={c.code} className="flex items-center gap-3">
                  <span className="flex w-24 shrink-0 items-center gap-1.5 text-[11px]">
                    <span className="truncate font-semibold text-foreground">
                      {countryName(c.code, locale)}
                    </span>
                  </span>
                  <Bar value={c.noMentions ? 0 : c.hmgSov} />
                  <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-foreground">
                    {c.noMentions ? "—" : `${c.hmgSov.toFixed(1)}%`}
                  </span>
                  <span className="w-44 shrink-0 truncate text-right text-[11px] text-muted-foreground">
                    {c.topBrand
                      ? `${t("lead")} ${c.topBrand.name} ${c.topBrand.sov.toFixed(1)}%`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      {pending.length > 0 ? (
        <p className="border-t border-border pt-3 text-[11px] text-muted-foreground">
          <span className="font-semibold">{t("notMeasured")}</span>
          {" · "}
          {pending.map(label).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

// HMG의 시장 내 순위 배지. 1위 = 브랜드 톤(선두), 그 외 = 골드 톤(도전자). null = 언급 0 이라 순위 없음("—").
function RankBadge({ rank }: { rank: number | null }) {
  if (rank == null) {
    return (
      <span className="inline-flex h-5 w-8 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-bold text-muted-foreground">
        —
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex h-5 w-8 shrink-0 items-center justify-center rounded text-[10px] font-bold tabular-nums text-white",
        rank === 1
          ? "bg-[var(--color-brand-700)]"
          : "bg-[var(--color-accent-gold)]",
      )}
    >
      #{rank}
    </span>
  );
}

// 점유율(SoV) 막대. 길이 = HMG 점유율. 토큰만 사용(컴포넌트 내 hex 금지).
function Bar({ value, strong }: { value: number; strong?: boolean }) {
  const w = Math.max(0, Math.min(100, value));
  return (
    <div
      className={cn(
        "relative flex-1 overflow-hidden rounded-full bg-[var(--color-bg-soft)]",
        strong ? "h-2.5" : "h-2",
      )}
    >
      <div
        className={cn(
          "absolute inset-y-0 left-0 rounded-full",
          strong ? "bg-[var(--color-brand-700)]" : "bg-[var(--color-brand-300)]",
        )}
        style={{ width: `${w}%` }}
      />
    </div>
  );
}
