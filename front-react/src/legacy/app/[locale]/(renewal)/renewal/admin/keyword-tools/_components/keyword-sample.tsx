import type { ReactNode } from "react";
import { useLocale, useTranslations } from "use-intl";
import { Download, Search, Sparkles } from "lucide-react";
import { RnButton, RnCard, RnCardHead, RnCheckMark, RnPill, RnTag } from "@/components/renewal-ui";
import { getPresetById } from "@/lib/keyword/location-presets";

// The keyword tools on sample data (2026-11-02, user), drawn under the "account needed" veil (account-gate.tsx): what the
// two tools of the original /admin/keyword-tools give — search volume with its summary and 6-month trend, and the prompts
// generated from keywords. Both show at once (the original's tabs would hide one under the inert veil). Made-up rows; the
// summary is computed from them with the original's tiers (lib/hgh/adapters/admin.ts: high ≥ 100,000, mid ≥ 10,000).

type Intent = "informational" | "navigational" | "transactional" | "commercial";

const PRESET = "kr";

/** keyword, search volume, competition, CPC, the last 6 months (oldest first) */
const VOLUME: [string, number, "HIGH" | "MEDIUM" | "LOW", number, number[]][] = [
  ["전기차 보조금", 246000, "LOW", 0.38, [201000, 246000, 301000, 246000, 201000, 246000]],
  ["제네시스 GV80", 135000, "HIGH", 1.12, [110000, 135000, 135000, 165000, 135000, 135000]],
  ["현대 아이오닉 6", 74000, "MEDIUM", 0.86, [60500, 74000, 90500, 74000, 74000, 60500]],
  ["기아 EV6", 60500, "MEDIUM", 0.91, [49500, 60500, 60500, 74000, 60500, 60500]],
  ["전기차 충전 요금", 40500, "LOW", 0.24, [33100, 40500, 49500, 40500, 33100, 40500]],
  ["하이브리드 SUV 추천", 22200, "HIGH", 1.45, [18100, 22200, 22200, 27100, 22200, 18100]],
  ["기아 EV9 가격", 18100, "HIGH", 1.31, [14800, 18100, 22200, 18100, 18100, 14800]],
  ["아이오닉 5 충전 시간", 9900, "LOW", 0.19, [8100, 9900, 9900, 12100, 9900, 8100]],
];

/** generated prompt, search intent, its keyword, the keyword's volume (the original sorts by volume) */
const PROMPTS: [string, Intent, string, number][] = [
  ["2026년 전기차 보조금은 지역마다 얼마나 받을 수 있어?", "informational", "전기차 보조금", 246000],
  ["제네시스 GV80 시승 예약은 어디서 할 수 있어?", "transactional", "제네시스 GV80", 135000],
  ["아이오닉 6와 테슬라 모델 3 중 장거리 주행에 더 나은 전기 세단은?", "commercial", "현대 아이오닉 6", 74000],
  ["현대자동차 공식 홈페이지에서 아이오닉 6 견적을 내려면 어떻게 해?", "navigational", "현대 아이오닉 6", 74000],
  ["기아 EV6는 겨울에 실제 주행거리가 얼마나 줄어?", "informational", "기아 EV6", 60500],
  ["가족용으로 탈 하이브리드 SUV는 어떤 차를 추천해?", "commercial", "하이브리드 SUV 추천", 22200],
];

const TH = "h-[34px] border-b border-rn-line-2 px-3 text-left text-rn-12 font-semibold text-rn-muted";
const TD = "h-[38px] border-b border-rn-line px-3";

export function KeywordSample() {
  const t = useTranslations("keywordTools");
  const locale = useLocale();
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const preset = getPresetById(PRESET);
  const place = preset ? `${preset.flag} ${locale === "ko" ? preset.name : preset.nameEn} · ${preset.language_code}` : PRESET;
  const total = VOLUME.reduce((s, [, v]) => s + v, 0);
  const summary: [string, number][] = [
    [t("summary.total"), VOLUME.length],
    [t("summary.avg"), Math.round(total / VOLUME.length)],
    [t("summary.totalVolume"), total],
    [t("summary.high"), VOLUME.filter(([, v]) => v >= 100000).length],
    [t("summary.mid"), VOLUME.filter(([, v]) => v >= 10000 && v < 100000).length],
    [t("summary.low"), VOLUME.filter(([, v]) => v < 10000).length],
  ];
  const promptKeywords = [...new Set(PROMPTS.map(([, , k]) => k))];
  return (
    <>
      <RnCard data-rn-keyword-sample="volume">
        <RnCardHead
          title={t("tabs.volume")}
          chips={<RnPill>{place}</RnPill>}
          actions={
            <RnButton size="sm">
              <Download className="size-3.5" aria-hidden />
              {t("exportCsv")}
            </RnButton>
          }
        />
        <div className="grid grid-cols-[280px_minmax(0,1fr)] gap-4 px-4.5 pb-4">
          <Inputs place={place} keywords={VOLUME.map(([k]) => k)} action={<><Search className="size-4" aria-hidden />{t("run")}</>} />
          <div className="flex min-w-0 flex-col gap-3">
            <dl className="m-0 grid grid-cols-6 gap-2">
              {summary.map(([label, value]) => (
                <div key={label} className="rounded-xl border border-rn-line px-3 py-2">
                  <dt className="text-rn-11 text-rn-muted">{label}</dt>
                  <dd className="m-0 text-rn-20 font-bold text-rn-ink tabular-nums">{nf.format(value)}</dd>
                </div>
              ))}
            </dl>
            <table className="w-full border-separate border-spacing-0 text-rn-13">
              <thead>
                <tr>
                  <th className={TH}>{t("volumeCols.keyword")}</th>
                  <th className={`${TH} text-right`}>{t("volumeCols.volume")}</th>
                  <th className={TH}>{t("volumeCols.competition")}</th>
                  <th className={`${TH} text-right`}>{t("volumeCols.cpc")}</th>
                  <th className={TH}>{t("volumeCols.trend")}</th>
                </tr>
              </thead>
              <tbody>
                {VOLUME.map(([keyword, volume, competition, cpc, trend]) => (
                  <tr key={keyword}>
                    <td className={`${TD} font-medium text-rn-ink`}>{keyword}</td>
                    <td className={`${TD} text-right tabular-nums`}>{nf.format(volume)}</td>
                    <td className={TD}>
                      <span className="rounded border border-rn-line-2 px-1.5 text-rn-11 font-semibold text-rn-ink-2">{competition}</span>
                    </td>
                    <td className={`${TD} text-right tabular-nums`}>{cpc.toFixed(2)}</td>
                    <td className={TD}>
                      <Trend values={trend} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </RnCard>
      <RnCard data-rn-keyword-sample="prompts">
        <RnCardHead
          title={t("tabs.toPrompt")}
          chips={<RnPill>{t("resultsCount", { count: PROMPTS.length })}</RnPill>}
          actions={
            <RnButton size="sm">
              <Download className="size-3.5" aria-hidden />
              {t("exportCsv")}
            </RnButton>
          }
        />
        <div className="grid grid-cols-[280px_minmax(0,1fr)] gap-4 px-4.5 pb-4">
          <Inputs
            place={place}
            keywords={promptKeywords}
            extra={
              <span className="flex items-center gap-2 text-rn-13 text-rn-ink-2">
                <RnCheckMark state="on" />
                {t("includeVolume")}
              </span>
            }
            action={<><Sparkles className="size-4" aria-hidden />{t("generate")}</>}
          />
          <table className="w-full self-start border-separate border-spacing-0 text-rn-13">
            <thead>
              <tr>
                <th className={`${TH} w-1/2`}>{t("promptCols.prompt")}</th>
                <th className={TH}>{t("promptCols.intent")}</th>
                <th className={TH}>{t("promptCols.keyword")}</th>
                <th className={`${TH} text-right`}>{t("promptCols.volume")}</th>
              </tr>
            </thead>
            <tbody>
              {PROMPTS.map(([question, intent, keyword, volume]) => (
                <tr key={question}>
                  <td className={`${TD} font-medium text-rn-ink`}>{question}</td>
                  <td className={TD}>
                    <RnTag className="bg-rn-inset py-0.5 text-rn-ink-2">{t(`intent.${intent}`)}</RnTag>
                  </td>
                  <td className={`${TD} text-rn-muted`}>{keyword}</td>
                  <td className={`${TD} text-right tabular-nums`}>{nf.format(volume)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </RnCard>
    </>
  );
}

/** The tool's inputs as the viewer would have filled them: market, keywords (one per line), the run button. */
function Inputs({ place, keywords, extra, action }: { place: string; keywords: string[]; extra?: ReactNode; action: ReactNode }) {
  const t = useTranslations("keywordTools");
  return (
    <div className="flex flex-col gap-3 self-start rounded-xl bg-rn-page p-3.5">
      <div className="flex flex-col gap-1.5">
        <span className="text-rn-12 font-semibold text-rn-ink-2">{t("location")}</span>
        <span className="flex h-9 items-center rounded-rn-control border border-rn-line-2 bg-rn-surface px-3 text-rn-13 text-rn-ink">{place}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center justify-between text-rn-12">
          <span className="font-semibold text-rn-ink-2">{t("keywords")}</span>
          <span className="text-rn-muted">{t("keywordCount", { count: keywords.length })}</span>
        </span>
        <span className="min-h-[168px] rounded-rn-control border border-rn-line-2 bg-rn-surface px-3 py-2 font-mono text-rn-12 leading-[1.75] whitespace-pre-line text-rn-ink">
          {keywords.join("\n")}
        </span>
      </div>
      {extra}
      <RnButton variant="primary">{action}</RnButton>
    </div>
  );
}

function Trend({ values }: { values: number[] }) {
  const max = Math.max(...values);
  return (
    <span className="flex h-6 items-end gap-0.5">
      {values.map((v, i) => (
        <i key={i} className="w-1.5 rounded-sm bg-rn-navy/60" style={{ height: `${Math.max(12, (v / max) * 100)}%` }} />
      ))}
    </span>
  );
}
