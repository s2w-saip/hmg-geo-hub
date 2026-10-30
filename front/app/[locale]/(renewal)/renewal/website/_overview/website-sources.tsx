"use client";

// Renewal Website Overview — 출처별 구성비 (website/composition: the top domains + 기타, shares of all citations).
// One 100% bar shows the whole (the original page's donut, read as a part-to-whole), then the ranked list with
// the citation counts. 당사 = the screen's isOurs. Nothing is summed or computed here.

import { use } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowUpRight } from "lucide-react";
import { RnCard, RnCardHeader, RnEmpty, RnTag, cx } from "@/components/renewal-ui";
import type { CompositionView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import { useFormat } from "./website-format";

// own domains in navy steps, the others in warm greys, 기타 the lightest (the order of the list)
const OWN_FILL = ["#002c5f", "#1a4d8e", "#6b89b3", "#aacae6"];
const OTHER_FILL = ["#8a837b", "#b5aea6", "#cfc8c0"];
const REST_FILL = "#eee9e2";

export function sliceFills(sources: CompositionView["sources"]): string[] {
  let own = 0;
  let other = 0;
  return sources.map((s) => (s.domain === "" ? REST_FILL : s.isOurs ? OWN_FILL[Math.min(own++, OWN_FILL.length - 1)] : OTHER_FILL[Math.min(other++, OTHER_FILL.length - 1)]));
}

export function RnWebsiteSources({ composition, citationHref }: { composition: Promise<CompositionView>; citationHref: string }) {
  const t = useTranslations("renewal.website.overview");
  const tC = useTranslations("dashboard.composition");
  const tR = useTranslations("renewal.overview");
  const f = useFormat();
  const c = use(composition);
  const max = Math.max(0, ...c.sources.map((s) => s.share));
  const fills = sliceFills(c.sources);
  const label = (domain: string) => (domain === "" ? tC("others") : domain);
  return (
    <RnCard aria-label={t("sourcesTitle")} className="h-full min-w-0">
      <RnCardHeader
        title={t("sourcesTitle")}
        hint={t("sourcesHint")}
        actions={
          <Link prefetch={false} href={citationHref} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-rn-12 font-semibold text-rn-navy hover:underline">
            {t("sourcesDetail")}
            <ArrowUpRight className="size-3.5" aria-hidden />
          </Link>
        }
      />
      {c.degraded ? (
        <RnEmpty className="mx-6 mb-5">{t("sourcesFailed")}</RnEmpty>
      ) : c.sources.length === 0 ? (
        <RnEmpty className="mx-6 mb-5">{tC("empty")}</RnEmpty>
      ) : (
        <>
          <div role="img" aria-label={t("sourcesBarAria")} className="mx-6 mb-2 flex h-3 overflow-hidden rounded-[3px] bg-rn-page" data-rn-sources-bar="">
            {c.sources.map((s, i) => (
              <i
                key={s.domain || "~rest"}
                title={`${label(s.domain)} ${s.share.toFixed(1)}% · ${t("citations", { count: f.count(s.citations) })}`}
                className="block h-full border-r border-rn-surface last:border-r-0"
                style={{ width: `${s.share}%`, background: fills[i] }}
              />
            ))}
          </div>
          <ol className="m-0 flex list-none flex-col p-0 pb-4" data-rn-sources="">
            {c.sources.map((s, i) => {
              const rest = s.domain === "";
              return (
                <li
                  key={rest ? "~rest" : s.domain}
                  data-rn-source={rest ? "rest" : s.domain}
                  className="grid h-9 grid-cols-[22px_minmax(0,1.5fr)_minmax(40px,1fr)_auto_52px] items-center gap-2.5 border-b border-rn-line px-6 text-rn-13 last:border-b-0"
                >
                  <span className="flex items-center gap-1.5 text-rn-12 text-rn-faint tabular-nums">
                    <i aria-hidden className="inline-block size-2 shrink-0 rounded-[2px]" style={{ background: fills[i] }} />
                    {rest ? "" : i + 1}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className={cx("truncate", rest ? "text-rn-muted" : "font-semibold text-rn-ink")} title={rest ? undefined : s.domain}>
                      {label(s.domain)}
                    </span>
                    {s.isOurs ? <RnTag className="shrink-0 whitespace-nowrap">{tR("ownTag")}</RnTag> : null}
                  </span>
                  <span className="h-[5px] overflow-hidden rounded-[2px] bg-rn-page">
                    <i className={cx("block h-full rounded-[2px]", s.isOurs ? "bg-rn-navy" : "bg-rn-faint")} style={{ width: `${max > 0 ? ((s.share / max) * 100).toFixed(1) : 0}%` }} />
                  </span>
                  <span className="text-rn-12 whitespace-nowrap text-rn-muted tabular-nums">{t("citations", { count: f.count(s.citations) })}</span>
                  <b className="text-right font-semibold text-rn-ink tabular-nums">{s.share.toFixed(1)}%</b>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </RnCard>
  );
}
