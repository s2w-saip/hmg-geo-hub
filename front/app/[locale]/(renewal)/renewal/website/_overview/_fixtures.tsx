import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { TilesView, TileView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";

// Shared by the renewal Website Overview render tests: the website screens' answers on the 2026-10-09 Gold round
// (trimmed), the ko wrapper and a few markup helpers.

export const settled = <T,>(v: T): Promise<T> => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });

export const tile = (t: Partial<TileView> & Pick<TileView, "key">): TileView => ({
  unit: "percent", value: 50, pending: false, delta: null, direction: "flat", tone: "flat", period: null, ...t,
});

export const TILES: TilesView = {
  groups: [
    {
      category: "content",
      tiles: [
        tile({ key: "visibility", value: 88, delta: -5.2, direction: "down", tone: "bad", engineConsistency: 34.7, ratio: { numerator: 17796, denominator: 20216 } }),
        tile({ key: "shareOfVoice", value: 96.3, delta: 1.4, direction: "up", tone: "good", ratio: { numerator: 270222, denominator: 280474 }, competitorSov: { brand: "Tata", value: 41067.2 } }),
        tile({ key: "sentiment", value: null, pending: true }),
        tile({ key: "position", unit: "rank", value: 1.1, delta: 0, direction: "flat", tone: "flat" }),
      ],
    },
    {
      category: "source",
      tiles: [
        tile({ key: "ownedUrlRate", value: 88, ratio: { numerator: 8815, denominator: 10021 }, provenance: { source: "live", cycleLabel: null, cycleLabelEn: null } }),
        tile({ key: "citationAccuracy", value: 65.3, delta: 1.4, direction: "up", tone: "good" }),
      ],
    },
  ],
  suppressionCaption: null,
};

export const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );

export const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");

/** The markup from `attr` up to the next element carrying the same attribute name. */
export function part(out: string, attr: string, value: string): string {
  const from = out.indexOf(`${attr}="${value}"`);
  const next = out.indexOf(`${attr}=`, from + 1);
  return out.slice(from, next < 0 ? undefined : next);
}
