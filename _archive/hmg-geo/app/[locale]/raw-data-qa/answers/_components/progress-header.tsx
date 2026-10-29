import { getTranslations } from "next-intl/server";
import type { QaProgress } from "@/lib/db/repositories/qa-review";

// 진행률을 **두 줄**로 낸다.
//
// 모집단이 미러 전체(십수만 행)라 전체 백분율 자체는 운용 지표가 되지 못한다 —
// 실제로 쓰이는 것은 필터 기준 쪽이다. 그래도 전체를 함께 두는 이유는 "내가 보는
// 조각이 전체의 어디쯤인가"를 잃지 않기 위해서다(설계 §8.4).
function percent(reviewed: number, total: number): string {
  if (total === 0) return "0";
  return (Math.round((reviewed / total) * 1000) / 10).toFixed(1);
}

export async function ProgressHeader({
  progress,
}: {
  progress: { scoped: QaProgress; total: QaProgress };
}) {
  const t = await getTranslations("qaReview.list");
  const { scoped, total } = progress;
  const nf = new Intl.NumberFormat();

  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <p className="font-head text-base font-semibold tracking-tight text-foreground">
        {t("progressScoped", {
          total: nf.format(scoped.total),
          reviewed: nf.format(scoped.reviewed),
          percent: percent(scoped.reviewed, scoped.total),
        })}
      </p>
      <span className="text-sm text-destructive">{t("issues", { count: scoped.issues })}</span>
      <span className="text-sm text-muted-foreground">
        {t("notes", { count: scoped.notes })}
      </span>
      <p className="w-full text-xs text-muted-foreground">
        {t("progressTotal", {
          total: nf.format(total.total),
          reviewed: nf.format(total.reviewed),
        })}
      </p>
    </div>
  );
}
