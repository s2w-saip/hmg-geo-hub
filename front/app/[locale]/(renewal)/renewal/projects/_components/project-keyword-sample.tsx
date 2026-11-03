"use client";

import { useLocale, useTranslations } from "next-intl";
import { Check, ListChecks, ListTree, Plus, RefreshCw, Send, Trash2, X } from "lucide-react";
import { RnButton, RnCard, RnCardHead, RnCheckMark, RnIconButton, RnInfoTip, RnLineChart, RnPill, RnSegmented, RnTag, cx } from "@/components/renewal-ui";
import { countryName } from "@/lib/geo-catalog/country-name";

// Project › Intent › Google Keyword on sample data (2026-11-03, user), drawn under the "account needed" veil
// (account-gate.tsx): what the original project page gives — the tracked keywords, the interest trend with its average,
// the related searches of a keyword and the prompts made from its search results — in the renewal look. Every part shows
// at once (the original opens the related searches on demand; the inert veil would keep them shut). Made-up rows; the
// trend is the original's index (the period's highest month = 100) and the average is computed from it as the original.

type Intent = "informational" | "navigational" | "transactional" | "commercial";

const OWN = "var(--color-rn-navy)";
const COUNTRY = "KR";
const KEYWORDS = ["아이오닉 5", "전기차 보조금", "전기차 충전 요금", "현대 SUV 추천"];

/** the active keyword's last 12 months, oldest first */
const MONTHS = ["25.11", "25.12", "26.01", "26.02", "26.03", "26.04", "26.05", "26.06", "26.07", "26.08", "26.09", "26.10"];
const TREND = [62, 58, 71, 66, 74, 81, 77, 69, 72, 88, 100, 93];

/** related search, its volume, search intent, picked, already a tracked keyword */
const RELATED: [string, number, Intent, boolean, boolean][] = [
  ["아이오닉 5 가격", 49500, "commercial", true, false],
  ["아이오닉 5 N", 33100, "navigational", true, false],
  ["아이오닉 5 중고", 22200, "transactional", false, false],
  ["아이오닉 5 충전 시간", 9900, "informational", false, false],
  ["전기차 보조금", 246000, "informational", false, true],
];

/** rank, title, URL, snippet, suggested prompt, applied, already in the candidate pool */
const SERP: [number, string, string, string, string, boolean, boolean][] = [
  [1, "IONIQ 5 | 현대자동차", "www.hyundai.com/kr/ko/e/vehicles/ioniq5/intro", "1회 충전 주행거리, 초급속 충전, V2L까지 아이오닉 5의 사양과 가격을 확인하세요.", "아이오닉 5의 1회 충전 주행거리와 초급속 충전 시간은 어느 정도야?", true, false],
  [2, "아이오닉 5 트림별 가격 비교", "auto.example.kr/ioniq5/price", "롱레인지 · 스탠다드 트림별 가격과 옵션, 보조금 적용 실구매가를 정리했습니다.", "아이오닉 5 트림별 실구매가와 가성비 좋은 트림은?", true, true],
  [3, "아이오닉 5 1년 실차주 후기", "community.example.kr/ev/123456", "겨울철 주행거리, 충전 습관, 승차감까지 1년 동안 타 본 장단점을 적었습니다.", "아이오닉 5 실차주들이 꼽는 장점과 단점은 뭐야?", true, false],
  [4, "전기 SUV 비교: 아이오닉 5 vs EV6", "news.example.com/review/ev-suv", "같은 플랫폼의 두 차를 공간, 주행 질감, 충전 성능으로 비교했습니다.", "아이오닉 5와 EV6 중 가족용으로 더 나은 전기 SUV는?", false, false],
  [5, "아이오닉 5 충전 요금 계산", "ev.example.kr/charge-cost", "완속 · 급속 충전 요금과 월 주행거리별 충전비를 계산해 봅니다.", "아이오닉 5를 한 달 타면 충전비는 얼마나 나와?", true, false],
];

const TH = "h-[34px] border-b border-rn-line-2 px-3 text-left text-rn-12 font-semibold text-rn-muted";
const TD = "h-[38px] border-b border-rn-line px-3";

export function ProjectKeywordSample() {
  const t = useTranslations("projectDetail.intent.googleKeyword");
  const locale = useLocale();
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const average = Math.round(TREND.reduce((s, v) => s + v, 0) / TREND.length);
  const picked = RELATED.filter(([, , , on]) => on).length;
  const applied = SERP.filter(([, , , , , on]) => on).length;
  return (
    <>
      <RnCard data-rn-keyword-sample="keywords" className="flex flex-wrap items-center gap-2 px-4.5 py-3">
        <div role="tablist" aria-label={t("keywordTabsLabel")} className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {KEYWORDS.map((k, i) => (
            <span
              key={k}
              role="tab"
              aria-selected={i === 0}
              className={cx(
                "inline-flex h-8 items-center gap-1 rounded-lg border pr-1 pl-3 text-rn-13",
                i === 0 ? "border-rn-navy bg-rn-navy/8 font-bold text-rn-navy" : "border-rn-line-2 bg-rn-surface pr-3 text-rn-ink-2",
              )}
            >
              {k}
              {i === 0 ? (
                <>
                  <RnIconButton label={t("manage")} className="size-6">
                    <ListTree className="size-3.5" aria-hidden />
                  </RnIconButton>
                  <RnIconButton label={t("delete")} className="size-6">
                    <Trash2 className="size-3.5" aria-hidden />
                  </RnIconButton>
                </>
              ) : null}
            </span>
          ))}
          <RnIconButton label={t("addKeyword")}>
            <Plus className="size-4" aria-hidden />
          </RnIconButton>
        </div>
        <RnButton size="sm">
          <ListChecks className="size-3.5" aria-hidden />
          {t("enterSelect")}
        </RnButton>
        <RnSegmented label={t("trendTitle")} value="12m" onChange={() => {}} items={(["3m", "6m", "12m"] as const).map((r) => ({ value: r, label: t(`range.${r}`) }))} />
        <RnPill>{countryName(COUNTRY, locale)}</RnPill>
      </RnCard>
      <RnCard data-rn-keyword-sample="related">
        <RnCardHead
          title={t("related.title", { keyword: KEYWORDS[0] })}
          chips={<RnPill>{`${t("related.analysisComplete")} · ${t("related.found", { count: RELATED.length })}`}</RnPill>}
          actions={
            <>
              <RnButton size="sm" variant="primary">
                <Plus className="size-3.5" aria-hidden />
                {`${t("related.addSelected")} · ${t("related.selected", { count: picked })}`}
              </RnButton>
              <RnIconButton label={t("related.close")}>
                <X className="size-4" aria-hidden />
              </RnIconButton>
            </>
          }
        />
        <div className="px-4.5 pb-3">
          <table className="w-full border-separate border-spacing-0 text-rn-13">
            <thead>
              <tr>
                <th className={`${TH} w-10`}>
                  <RnCheckMark state="partial" />
                </th>
                <th className={TH}>{t("related.colKeyword")}</th>
                <th className={`${TH} w-32 text-right`}>{t("related.colVolume")}</th>
                <th className={`${TH} w-32`}>{t("related.colIntent")}</th>
                <th className={`${TH} w-12`} />
              </tr>
            </thead>
            <tbody>
              {RELATED.map(([term, volume, intent, on, tracked]) => (
                <tr key={term} className={tracked ? "opacity-50" : undefined}>
                  <td className={TD}>
                    <RnCheckMark state={on ? "on" : "off"} />
                  </td>
                  <td className={`${TD} font-medium text-rn-ink`}>{term}</td>
                  <td className={`${TD} text-right tabular-nums`}>{nf.format(volume)}</td>
                  <td className={TD}>
                    <RnTag className="bg-rn-inset py-0.5 text-rn-ink-2">{t(`intent.${intent}`)}</RnTag>
                  </td>
                  <td className={`${TD} text-right`}>
                    <RnIconButton label={tracked ? t("related.added") : t("related.add")} className="size-6">
                      {tracked ? <Check className="size-3.5" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
                    </RnIconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </RnCard>
      <div className="grid grid-cols-[minmax(0,1fr)_260px] gap-2.5">
        <RnCard data-rn-keyword-sample="trend">
          <RnCardHead title={t("trendTitle")} info={<RnInfoTip label={t("trendTitle")}>{t("trendInfo")}</RnInfoTip>} />
          <div className="px-4.5 pb-3">
            <RnLineChart
              x={MONTHS}
              series={[{ key: "keyword", name: KEYWORDS[0], color: OWN, values: TREND, own: true }]}
              height={220}
              yTick={(v) => String(v)}
              value={(v) => String(v)}
              tooltipTitle={(x) => x}
              ariaLabel={t("trendTitle")}
              domain={{ lo: 0, hi: 100, ticks: [0, 25, 50, 75, 100] }}
            />
          </div>
        </RnCard>
        <RnCard data-rn-keyword-sample="average" className="flex flex-col">
          <RnCardHead title={t("avgTitle")} info={<RnInfoTip label={t("avgTitle")} align="end">{t("avgInfo")}</RnInfoTip>} />
          <div className="flex flex-1 flex-col justify-center gap-3 px-4.5 pb-5">
            <p className="m-0 text-rn-28 font-bold text-rn-ink tabular-nums">
              {average}
              <span className="ml-1 text-rn-13 font-medium text-rn-muted">/ 100</span>
            </p>
            <span className="h-2 overflow-hidden rounded-full bg-rn-inset">
              <i className="block h-full rounded-full bg-rn-navy" style={{ width: `${average}%` }} />
            </span>
          </div>
        </RnCard>
      </div>
      <RnCard data-rn-keyword-sample="serp">
        <RnCardHead
          title={t("serpTitle")}
          chips={<RnPill>{t("appliedCount", { count: applied })}</RnPill>}
          actions={
            <>
              <RnButton size="sm">
                <RefreshCw className="size-3.5" aria-hidden />
                {t("regenerate")}
              </RnButton>
              <RnButton size="sm" variant="primary">
                <Send className="size-3.5" aria-hidden />
                {t("addSelected")}
              </RnButton>
            </>
          }
        />
        <div className="px-4.5 pb-3">
          <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13">
            <thead>
              <tr>
                <th className={`${TH} w-14 text-center`}>{t("apply")}</th>
                <th className={`${TH} w-10`} />
                <th className={`${TH} w-[26%]`}>{t("col.titleUrl")}</th>
                <th className={TH}>{t("col.snippet")}</th>
                <th className={`${TH} w-[28%]`}>{t("suggested")}</th>
                <th className={`${TH} w-12`} />
              </tr>
            </thead>
            <tbody>
              {SERP.map(([rank, title, url, snippet, prompt, on, added]) => (
                <tr key={rank} className="align-top">
                  <td className={`${TD} py-2.5 text-center`}>
                    <span className="inline-grid">
                      <RnCheckMark state={on ? "on" : "off"} />
                    </span>
                  </td>
                  <td className={`${TD} py-2.5 text-rn-muted tabular-nums`}>{rank}</td>
                  <td className={`${TD} py-2.5`}>
                    <p className="m-0 truncate font-medium text-rn-ink">{title}</p>
                    <p className="m-0 truncate text-rn-12 text-rn-muted">{url}</p>
                  </td>
                  <td className={`${TD} py-2.5 text-rn-12 leading-[1.55] text-rn-ink-2`}>{snippet}</td>
                  <td className={`${TD} py-2.5 leading-[1.55] text-rn-ink`}>{prompt}</td>
                  <td className={`${TD} py-2 text-right`}>
                    <RnIconButton label={added ? t("addToPromptDone") : t("addToPrompt")} className="size-6">
                      {added ? <Check className="size-3.5" aria-hidden /> : <Send className="size-3.5" aria-hidden />}
                    </RnIconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </RnCard>
    </>
  );
}
