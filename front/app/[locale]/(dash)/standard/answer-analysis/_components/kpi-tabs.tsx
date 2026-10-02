"use client";

// 4-KPI 탭 바. 탭 상태는 URL(`?kpi=`)이 정본이고 이 컴포넌트는 **링크만** 그린다 —
// 로컬 상태를 두면 URL 과 두 갈래가 되어 "탭 전환 시 필터 유지"의 근거가 흐려진다.
//
// 링크는 현재 쿼리를 그대로 옮기고 `kpi` 만 바꾼다(kpiTabQuery). 그래서 디멘션·
// 프롬프트 필터가 자동으로 유지되고, 새 축이 추가돼도 여기를 고칠 일이 없다.
// prefetch 는 끈다: 탭 4개를 미리 당기면 무거운 미러 집계를 4배로 유발한다.

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { KPI_TABS, kpiTabQuery, type KpiTab } from "../_data/kpi-tab";

export function KpiTabs({ active }: { active: KpiTab }) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams.toString());

  return (
    <nav aria-label={t("tabsAria")}>
      <ul className="flex flex-wrap items-center gap-1">
        {KPI_TABS.map((tab) => {
          const isActive = tab === active;
          return (
            <li key={tab}>
              <Link
                href={`${pathname}${kpiTabQuery(params, tab)}`}
                prefetch={false}
                aria-current={isActive ? "page" : undefined}
                // 피그마 327:116 탭: 15px semibold, 활성 = 검정 1.2px 밑줄(border-b-[1.2px]),
                // 비활성 = 잉크 40%. 색만으로 구분하지 않도록 aria-current 도 유지.
                className={cn(
                  "inline-block border-b-[1.2px] px-3 py-2 text-[15px] font-semibold transition-colors",
                  isActive
                    ? "border-foreground text-foreground"
                    : "border-transparent text-foreground/40 hover:text-foreground/70",
                )}
              >
                {t(`tabs.${tab}`)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
