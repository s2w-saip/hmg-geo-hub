"use client";

// 멘션 유형별 출처 카테고리 구성 — 유형 5행 × 100% 스택(디자인 571:380 우측 하단).
// 색은 카테고리 고정색(categoryColor), 우측 라벨 = 공식(HMG) 비중.

import { useTranslations } from "next-intl";
import type { TypeCategoryBar } from "../_data/citation-view";
import { categoryColor } from "./citations-view";

export function TypeCategoryChart({
  series,
  bars,
  label,
}: {
  series: string[];
  bars: TypeCategoryBar[];
  label: (name: string) => string;
}) {
  const t = useTranslations("answerAnalysis.citations.v2.typeCategory");
  const tType = useTranslations("answerAnalysis.mentions.breakdown.type");
  const hasAny = bars.some((b) => b.total > 0);
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-col gap-0.5">
        <h3 className="text-[15px] font-semibold tracking-tight text-foreground">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
      </header>
      {!hasAny ? (
        <p className="px-2 py-8 text-center text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {bars.map((b) => (
              <li key={b.type} className="flex items-center gap-2 text-xs">
                <span className="w-16 shrink-0 truncate text-foreground">{tType(b.type)}</span>
                <span className="flex h-5 flex-1 overflow-hidden rounded-full bg-muted" data-type-category-track={b.type}>
                  {b.segments.map((s) => (
                    <span
                      key={s.name}
                      className="h-full border-r border-card last:border-r-0"
                      style={{ width: `${s.pct}%`, background: categoryColor(s.name) }}
                      title={`${label(s.name)} ${s.pct.toFixed(1)}% (${s.value.toLocaleString()})`}
                    />
                  ))}
                </span>
                <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
                  {b.officialPct == null ? "—" : t("officialValue", { pct: `${b.officialPct.toFixed(1)}%` })}
                </span>
              </li>
            ))}
          </ul>
          <div className="mr-20 ml-[calc(4rem+0.5rem)] flex justify-between text-[10px] text-muted-foreground tabular-nums" aria-hidden>
            <span>0%</span>
            <span>50%</span>
            <span>100%</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {series.map((s) => (
              <span key={s} className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: categoryColor(s) }} aria-hidden />
                {label(s)}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
