import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type { FirstPositionResult } from "@/lib/db/repositories/scope-aggregates";
import { FirstRankKpiTab } from "./first-rank-kpi-tab";

// 고객 QA 2차 #3 — "AI 우선 노출도" 상세 히어로의 경쟁사 2×2 타일에서
// "19.9위" / "↗1.6위" 가 **글자 중간에서** 두 줄로 꺾인다(고객 원문: "1.6위, 0.9위 등
// 줄바뀜 현상 해결").
//
// 폭 산술(좌열은 `lg:w-[267px]` 고정이라 1280·1440 둘 다 같은 값):
//   before: 타일 = (267 − gap 10)/2 = 128.5px, `px-5`(40) → 콘텐츠 **88.5px**
//           필요 폭 ≈ "19.9위"(16px) 59 + gap 4 + Δ(아이콘12+gap2+"1.6위"12px 27) 41 ≈ 104px → 넘침
//   after : 타일 = (267 − gap 8)/2 = 129.5px, `px-2.5`(20) → 콘텐츠 **109.5px**
//           필요 폭 ≈ "19.9위"(15px) 46.5 + gap 4 + Δ("1.6위" 11px) 41.5 ≈ 92px → 들어감
// 픽셀 실측은 검증자 몫이고, 여기서는 **꺾임을 만들 수 있는 구조**를 고정한다.

const FP: FirstPositionResult = {
  unit: "week",
  brands: ["Hyundai", "Tesla", "BMW", "Kia", "Audi"],
  buckets: [
    { bucketStart: "2026-08-17", measuredDays: 7, firstAt: null, lastAt: null, brands: [
      { brand: "Hyundai", isTracked: true, avgPosition: 20.8, rankedAnswers: 10 },
      { brand: "Tesla", isTracked: false, avgPosition: 21.5, rankedAnswers: 5 },
      { brand: "BMW", isTracked: false, avgPosition: 19.0, rankedAnswers: 4 },
      { brand: "Kia", isTracked: false, avgPosition: 18.4, rankedAnswers: 4 },
      { brand: "Audi", isTracked: false, avgPosition: 17.3, rankedAnswers: 3 },
    ] },
    { bucketStart: "2026-08-24", measuredDays: 7, firstAt: null, lastAt: null, brands: [
      { brand: "Hyundai", isTracked: true, avgPosition: 19.2, rankedAnswers: 30 },
      { brand: "Tesla", isTracked: false, avgPosition: 19.9, rankedAnswers: 6 },
      { brand: "BMW", isTracked: false, avgPosition: 20.6, rankedAnswers: 5 },
      { brand: "Kia", isTracked: false, avgPosition: 17.5, rankedAnswers: 5 },
      { brand: "Audi", isTracked: false, avgPosition: 18.2, rankedAnswers: 4 },
    ] },
  ],
  latest: [
    { brand: "Kia", isTracked: false, avgPosition: 17.5, rank: 1, rankedAnswers: 5, mentions: 9 },
    { brand: "Audi", isTracked: false, avgPosition: 18.2, rank: 2, rankedAnswers: 4, mentions: 8 },
    { brand: "Hyundai", isTracked: true, avgPosition: 19.2, rank: 3, rankedAnswers: 30, mentions: 40 },
    { brand: "Tesla", isTracked: false, avgPosition: 19.9, rank: 4, rankedAnswers: 6, mentions: 7 },
    { brand: "BMW", isTracked: false, avgPosition: 20.6, rank: 5, rankedAnswers: 5, mentions: 6 },
  ],
};

function render(locale: "ko" | "en" = "ko") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">
      <FirstRankKpiTab firstPosition={FP} />
    </NextIntlClientProvider>,
  );
}

/** `<div` 깊이를 세어 그 엘리먼트만 정확히 잘라낸다(형제·부모가 안 섞이게). */
function sliceDiv(html: string, openIdx: number): string {
  const re = /<div\b|<\/div>/g;
  re.lastIndex = openIdx;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return html.slice(openIdx, m.index + m[0].length);
  }
  throw new Error("unbalanced div");
}

/** 경쟁사 미니 타일 마크업만 잘라낸다(표·히어로 스칼라와 섞이지 않게). */
function tiles(html: string): string[] {
  const out: string[] = [];
  for (let i = html.indexOf("data-rank-competitor-tile"); i !== -1; i = html.indexOf("data-rank-competitor-tile", i + 1)) {
    out.push(sliceDiv(html, html.lastIndexOf("<div", i)));
  }
  return out;
}

describe("우선 노출도 히어로 — 경쟁사 타일 줄바꿈 (QA 2차 #3)", () => {
  it.each(["ko", "en"] as const)("타일이 4장 렌더되고 값·Δ 가 한 줄에 놓인다 (%s)", (locale) => {
    const html = render(locale);
    const t = tiles(html);
    expect(t).toHaveLength(4);
    for (const tile of t) {
      // ① 글자 중간 꺾임 금지 — 값과 Δ 둘 다 nowrap.
      expect(tile).toContain("whitespace-nowrap");
      // ② 폭 확보 — 좌열 267px 2열에서 `px-5`(콘텐츠 88.5px)는 값+Δ 를 못 담는다.
      expect(tile).not.toMatch(/class="[^"]*\bpx-5\b/);
      // ③ 안전망 — 그래도 안 들어가면 Δ 가 **통째로** 다음 줄로 간다.
      expect(tile).toContain("flex-wrap");
    }
  });

  it("값·Δ 문자열이 쪼개지지 않고 통째로 남는다 (ko)", () => {
    const html = render("ko");
    // Tesla 19.9번째 · Δ 1.6번째(21.5 → 19.9 = 개선).
    // 단위는 2026-09-20 고객 요구로 '위' → '번째'(정본 키 = metricUnit.position).
    expect(html).toContain("19.9번째");
    expect(html).toContain("1.6번째");
  });

  it("Δ 배지(RankDelta) 루트가 nowrap — 표·히어로에서도 같은 규약", () => {
    const html = render("ko");
    // RankDelta 루트 className 의 고정 부분. 표(size=sm)·히어로(size=md) 공용.
    expect(html).toContain("inline-flex items-center gap-0.5 tabular-nums whitespace-nowrap");
  });
});
