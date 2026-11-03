"use client";

import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Download, Maximize2, Plus, Send, Sparkles, Trash2, X } from "lucide-react";
import { RnButton, RnCard, RnCardHead, RnCheckMark, RnIconButton, RnPill, RnTag, cx } from "@/components/renewal-ui";

// Project › Intent › Social Scraping on sample data (2026-11-03, user), drawn under the "account needed" veil
// (account-gate.tsx): what the original project page gives — the purchase context map of the community corpus (contexts,
// conditions, their combinations), the picks composed into prompts, and the recommended prompts sent to the candidate
// pool — in the renewal look. Every table shows at once (the original's tabs would hide three of them under the inert
// veil), each on its first page. Made-up rows.

type Perspective = "buyer" | "seller" | "neutral";
type Frequency = "high" | "medium" | "low";
type Layer = "l1" | "l2" | "l3";
type Funnel = "awareness" | "consideration" | "purchase";

/** the corpus totals over every page (the original's summary line) */
const STATS = { contexts: 48, conditions: 62, relations: 214, sources: 37, combinations: 96 };

/** name, theme, dominant perspective, the conditions it drives, mentions, picked */
const CONTEXTS: [string, string, Perspective, number, number, boolean][] = [
  ["첫 차 구매", "생애 단계", "buyer", 9, 1240, true],
  ["출퇴근 장거리 운전", "이동 패턴", "buyer", 7, 980, false],
  ["자녀 출산 · 육아", "생애 단계", "neutral", 8, 864, true],
  ["캠핑 · 차박", "여가", "buyer", 6, 702, false],
  ["전기차 전환 고민", "기술 전환", "neutral", 5, 655, false],
  ["법인 · 리스 차량 교체", "업무", "neutral", 4, 415, false],
];

/** name, category, dominant perspective, the contexts that drive it, mentions, picked */
const CONDITIONS: [string, string, Perspective, number, number, boolean][] = [
  ["1회 충전 주행거리", "성능", "neutral", 12, 1580, false],
  ["실구매가 · 보조금", "가격", "seller", 10, 1322, true],
  ["2열 공간 · 카시트", "공간", "buyer", 7, 911, false],
  ["충전 인프라 접근성", "인프라", "seller", 9, 876, false],
  ["연비 · 유지비", "비용", "buyer", 8, 790, false],
  ["안전 사양(ADAS)", "안전", "buyer", 6, 655, false],
];

/** condition A, condition B, frequency, co-occurrences, picked */
const COMBINATIONS: [string, string, Frequency, number, boolean][] = [
  ["1회 충전 주행거리", "충전 인프라 접근성", "high", 412, true],
  ["실구매가 · 보조금", "연비 · 유지비", "high", 356, false],
  ["2열 공간 · 카시트", "안전 사양(ADAS)", "medium", 198, false],
  ["1회 충전 주행거리", "실구매가 · 보조금", "medium", 171, false],
  ["2열 공간 · 카시트", "연비 · 유지비", "low", 88, false],
  ["적재 공간", "1회 충전 주행거리", "low", 64, false],
];

/** question, where it came from, layer, funnel stage, priority (0–100), composed by hand, already in the pool, selected */
const PROMPTS: [string, string, Layer, Funnel, number, boolean, boolean, boolean][] = [
  ["첫 차로 전기차를 사려는데 보조금 받으면 실제로 얼마에 살 수 있어?", "첫 차 구매 × 실구매가 · 보조금", "l3", "purchase", 92, true, false, true],
  ["아이 둘 키우는 집에서 카시트 두 개 달기 좋은 SUV는 뭐야?", "자녀 출산 · 육아 × 2열 공간 · 카시트", "l3", "consideration", 88, false, false, true],
  ["출퇴근 왕복 100km면 전기차 1회 충전으로 일주일을 버틸 수 있어?", "출퇴근 장거리 운전", "l1", "consideration", 81, false, false, true],
  ["아파트에 충전기가 없으면 전기차를 사도 괜찮을까?", "충전 인프라 접근성", "l2", "awareness", 77, false, true, false],
  ["차박하기 좋은 전기 SUV는 실내 공간이 얼마나 돼?", "캠핑 · 차박", "l1", "consideration", 70, false, false, false],
];

const TH = "h-[34px] border-b border-rn-line-2 px-3 text-left text-rn-12 font-semibold text-rn-muted";
const TD = "h-[38px] border-b border-rn-line px-3";
const TONE: Record<Perspective, string> = {
  buyer: "bg-rn-up/12 text-rn-up-ink",
  seller: "bg-rn-down/10 text-rn-danger-ink",
  neutral: "bg-rn-inset text-rn-ink-2",
};

export function ProjectSocialSample() {
  const t = useTranslations("socialScraping.contextMap");
  const locale = useLocale();
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const picks: [string, string][] = [
    ...CONTEXTS.filter((r) => r[5]).map(([name]): [string, string] => [t("composer.chipContext"), name]),
    ...CONDITIONS.filter((r) => r[5]).map(([name]): [string, string] => [t("composer.chipCondition"), name]),
    ...COMBINATIONS.filter((r) => r[4]).map(([a, b]): [string, string] => [t("composer.chipCombo"), `${a} × ${b}`]),
  ];
  const selected = PROMPTS.filter((p) => p[7]).length;
  const perspective = (p: Perspective) => <RnTag className={cx("py-0.5", TONE[p])}>{t(`perspective.${p}`)}</RnTag>;
  return (
    <>
      <RnCard data-rn-social-sample="summary">
        <RnCardHead
          title={t("titleGeneric")}
          chips={
            <>
              <RnPill>{`${t("stats.contexts")} ${nf.format(STATS.contexts)}`}</RnPill>
              <RnPill>{`${t("stats.conditions")} ${nf.format(STATS.conditions)}`}</RnPill>
              <RnPill>{`${t("stats.relations")} ${nf.format(STATS.relations)}`}</RnPill>
              <RnPill>{`${t("stats.sources")} ${nf.format(STATS.sources)}`}</RnPill>
            </>
          }
          actions={
            <RnButton size="sm">
              <Download className="size-3.5" aria-hidden />
              {t("exportExcel")}
            </RnButton>
          }
        />
        <div data-rn-social-sample="composer" className="mx-4.5 mb-3.5 flex flex-wrap items-center gap-2 rounded-xl bg-rn-page px-3.5 py-2.5">
          <span className="text-rn-13 font-bold text-rn-ink">{t("composer.title")}</span>
          {picks.map(([kind, name]) => (
            <span key={`${kind}-${name}`} className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-rn-navy/8 pr-1 pl-2.5 text-rn-12 font-bold text-rn-navy">
              <span className="font-medium">{kind}</span>
              {name}
              <RnIconButton label={t("composer.removeChip", { name })} className="size-5">
                <X className="size-3" aria-hidden />
              </RnIconButton>
            </span>
          ))}
          <span className="ml-auto flex items-center gap-2 text-rn-12 text-rn-ink-2">
            <RnCheckMark state="on" />
            {t("composer.crossLabel")}
          </span>
          <RnButton size="sm" variant="ghost">
            {t("composer.clear")}
          </RnButton>
          <RnButton size="sm" variant="primary">
            <Sparkles className="size-3.5" aria-hidden />
            {t("composer.generate")}
          </RnButton>
        </div>
      </RnCard>
      <div className="grid grid-cols-2 gap-2.5">
        <MapTable sample="contexts" title={t("contextsSection")} total={STATS.contexts} rows={CONTEXTS.length}>
          <thead>
            <tr>
              <th className={TH}>{t("col.name")}</th>
              <th className={TH}>{t("col.theme")}</th>
              <th className={TH}>{t("col.perspective")}</th>
              <th className={`${TH} text-right`}>{t("col.drivenConditions")}</th>
              <th className={`${TH} text-right`}>{t("col.mentions")}</th>
              <th className={`${TH} w-[104px]`} />
            </tr>
          </thead>
          <tbody>
            {CONTEXTS.map(([name, theme, p, driven, mentions, on]) => (
              <tr key={name}>
                <td className={`${TD} font-medium text-rn-ink`}>{name}</td>
                <td className={`${TD} text-rn-12 text-rn-muted`}>{theme}</td>
                <td className={TD}>{perspective(p)}</td>
                <td className={`${TD} text-right text-rn-muted tabular-nums`}>{driven}</td>
                <td className={`${TD} text-right tabular-nums`}>{nf.format(mentions)}</td>
                <td className={`${TD} text-right`}>
                  <RowActions picked={on} />
                </td>
              </tr>
            ))}
          </tbody>
        </MapTable>
        <MapTable sample="conditions" title={t("conditionsSection")} total={STATS.conditions} rows={CONDITIONS.length}>
          <thead>
            <tr>
              <th className={TH}>{t("col.name")}</th>
              <th className={TH}>{t("col.category")}</th>
              <th className={TH}>{t("col.perspective")}</th>
              <th className={`${TH} text-right`}>{t("col.drivenByContexts")}</th>
              <th className={`${TH} text-right`}>{t("col.mentions")}</th>
              <th className={`${TH} w-[104px]`} />
            </tr>
          </thead>
          <tbody>
            {CONDITIONS.map(([name, category, p, drivenBy, mentions, on]) => (
              <tr key={name}>
                <td className={`${TD} font-medium text-rn-ink`}>{name}</td>
                <td className={`${TD} text-rn-12 text-rn-muted`}>{category}</td>
                <td className={TD}>{perspective(p)}</td>
                <td className={`${TD} text-right text-rn-muted tabular-nums`}>{drivenBy}</td>
                <td className={`${TD} text-right tabular-nums`}>{nf.format(mentions)}</td>
                <td className={`${TD} text-right`}>
                  <RowActions picked={on} />
                </td>
              </tr>
            ))}
          </tbody>
        </MapTable>
        <MapTable sample="combinations" title={t("combinationsSection")} total={STATS.combinations} rows={COMBINATIONS.length}>
          <thead>
            <tr>
              <th className={TH}>{t("col.conditionA")}</th>
              <th className={TH}>{t("col.conditionB")}</th>
              <th className={TH}>{t("col.frequency")}</th>
              <th className={`${TH} text-right`}>{t("col.cooccurrence")}</th>
              <th className={`${TH} w-[104px]`} />
            </tr>
          </thead>
          <tbody>
            {COMBINATIONS.map(([a, b, frequency, co, on]) => (
              <tr key={`${a}-${b}`}>
                <td className={`${TD} font-medium text-rn-ink`}>{a}</td>
                <td className={`${TD} font-medium text-rn-ink`}>{b}</td>
                <td className={TD}>
                  <RnTag className="bg-rn-inset py-0.5 text-rn-ink-2">{t(`frequency.${frequency}`)}</RnTag>
                </td>
                <td className={`${TD} text-right tabular-nums`}>{nf.format(co)}</td>
                <td className={`${TD} text-right`}>
                  <RowActions picked={on} />
                </td>
              </tr>
            ))}
          </tbody>
        </MapTable>
        <RnCard data-rn-social-sample="catalog">
          <RnCardHead
            title={t("catalogSection")}
            chips={<RnPill>{t("catalogSelectedCount", { count: selected })}</RnPill>}
            actions={
              <>
                <RnButton size="sm" variant="ghost">
                  <Trash2 className="size-3.5" aria-hidden />
                  {t("catalogRemoveSelected")}
                </RnButton>
                <RnButton size="sm">
                  <Plus className="size-3.5" aria-hidden />
                  {t("catalogGenerateMore")}
                </RnButton>
                <RnButton size="sm" variant="primary">
                  <Send className="size-3.5" aria-hidden />
                  {t("catalogSendToPool")}
                </RnButton>
              </>
            }
          />
          <div className="px-4.5 pb-3">
            <table className="w-full border-separate border-spacing-0 text-rn-13">
              <thead>
                <tr>
                  <th className={`${TH} w-[60px]`}>
                    <RnCheckMark state="partial" />
                  </th>
                  <th className={TH}>{t("col.question")}</th>
                  <th className={`${TH} w-[84px]`}>{t("col.layer")}</th>
                  <th className={`${TH} w-[56px]`}>{t("col.funnel")}</th>
                  <th className={`${TH} w-[68px] text-right`}>{t("col.priority")}</th>
                </tr>
              </thead>
              <tbody>
                {PROMPTS.map(([question, source, layer, funnel, priority, composed, added, on]) => (
                  <tr key={question} className={cx("align-top", added && "opacity-50")}>
                    <td className={`${TD} py-2.5`}>
                      {added ? <RnTag className="bg-rn-inset py-0.5 whitespace-nowrap text-rn-ink-2">{t("catalogAddedBadge")}</RnTag> : <RnCheckMark state={on ? "on" : "off"} />}
                    </td>
                    <td className={`${TD} py-2`}>
                      <p className="m-0 leading-[1.5] text-rn-ink">{question}</p>
                      <p className="m-0 mt-0.5 flex items-center gap-1.5 text-rn-11 text-rn-muted">
                        {composed ? <RnTag className="py-0">{t("catalogComposedBadge")}</RnTag> : null}
                        <span className="truncate">{source}</span>
                      </p>
                    </td>
                    <td className={`${TD} py-2.5`}>
                      <RnTag className="bg-rn-inset py-0.5 text-rn-ink-2">{t(`layer.${layer}`)}</RnTag>
                    </td>
                    <td className={`${TD} py-2.5 text-rn-12 text-rn-muted`}>{t(`funnel.${funnel}`)}</td>
                    <td className={`${TD} py-2.5 text-right tabular-nums`}>{priority}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </RnCard>
      </div>
    </>
  );
}

/** One table of the context map on its first page, with the pager under it. */
function MapTable({ sample, title, total, rows, children }: { sample: string; title: string; total: number; rows: number; children: ReactNode }) {
  const t = useTranslations("socialScraping.contextMap");
  return (
    <RnCard data-rn-social-sample={sample}>
      <RnCardHead title={title} chips={<RnPill>{total}</RnPill>} />
      <div className="px-4.5">
        <table className="w-full border-separate border-spacing-0 text-rn-13">{children}</table>
      </div>
      <div className="flex items-center justify-end gap-1 px-4.5 py-2 text-rn-12 text-rn-muted tabular-nums">
        <span className="mr-1">{t("pageRange", { first: 1, last: rows, total })}</span>
        <RnIconButton label={t("prevPage")} disabled>
          <ChevronLeft className="size-4" aria-hidden />
        </RnIconButton>
        <RnIconButton label={t("nextPage")}>
          <ChevronRight className="size-4" aria-hidden />
        </RnIconButton>
      </div>
    </RnCard>
  );
}

/** A map row's pick (into the composer) and its detail. */
function RowActions({ picked }: { picked: boolean }) {
  const t = useTranslations("socialScraping.contextMap");
  return (
    <span className="inline-flex items-center gap-1">
      <RnButton size="sm" variant={picked ? "primary" : "secondary"} className="h-6 px-2">
        {picked ? t("pickAdded") : t("pickAdd")}
      </RnButton>
      <RnIconButton label={t("detailButton")} className="size-6">
        <Maximize2 className="size-3.5" aria-hidden />
      </RnIconButton>
    </span>
  );
}
