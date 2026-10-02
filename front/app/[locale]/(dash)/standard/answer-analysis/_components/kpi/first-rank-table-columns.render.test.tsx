import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type { FirstPositionResult } from "@/lib/db/repositories/scope-aggregates";
import {
  COMPETITOR_LIMIT,
  FirstRankKpiTab,
  RANK_COL_CLASS,
  toggleCompetitor,
} from "./first-rank-kpi-tab";

// 2026-09-11 제품 결정(프로덕션 스크린샷): "AI 우선 노출도" 순위 표의 **지표 정렬이
// 어긋난다**. 원인은 헤더 4칸 vs 행 5요소 — 순위 셀 하나에 텍스트와 막대를 같이 넣어
// 놓고 `<col>` 폭은 그보다 좁게 선언해서, 셀 고유 폭이 열을 밀고 막대는 "순위" 헤더
// 밖에, 스파크라인은 "추이" 헤더 왼쪽 가장자리에 걸쳐 찍혔다.
//
// 정적 검사로는 안 잡히는 종류의 결함이라(문법은 멀쩡하다) **열 수·헤더-셀 대응**을
// 마크업에서 직접 센다. 픽셀 정렬 실측은 브라우저 픽스처(검증자 몫)가 따로 본다.
//
// 픽스처 = 스크린샷의 값 그대로: Hyundai 1위·18.3 / Kia 2위·19.7 / Tesla 3위·20.0 /
// Genesis 6위·21.0 (경쟁사 선택 = Tesla).

const FP: FirstPositionResult = {
  unit: "week",
  brands: ["Hyundai", "Kia", "Tesla", "BMW", "Audi", "Genesis"],
  buckets: [
    { bucketStart: "2026-08-24", measuredDays: 7, firstAt: null, lastAt: null, brands: [
      { brand: "Hyundai", isTracked: true, avgPosition: 18.9, rankedAnswers: 40 },
      { brand: "Kia", isTracked: true, avgPosition: 20.1, rankedAnswers: 30 },
      { brand: "Tesla", isTracked: false, avgPosition: 19.4, rankedAnswers: 12 },
      { brand: "BMW", isTracked: false, avgPosition: 20.4, rankedAnswers: 9 },
      { brand: "Audi", isTracked: false, avgPosition: 20.8, rankedAnswers: 8 },
      { brand: "Genesis", isTracked: true, avgPosition: 21.6, rankedAnswers: 7 },
    ] },
    { bucketStart: "2026-08-31", measuredDays: 7, firstAt: null, lastAt: null, brands: [
      { brand: "Hyundai", isTracked: true, avgPosition: 18.3, rankedAnswers: 44 },
      { brand: "Kia", isTracked: true, avgPosition: 19.7, rankedAnswers: 33 },
      { brand: "Tesla", isTracked: false, avgPosition: 20.0, rankedAnswers: 14 },
      { brand: "BMW", isTracked: false, avgPosition: 20.5, rankedAnswers: 10 },
      { brand: "Audi", isTracked: false, avgPosition: 20.9, rankedAnswers: 9 },
      { brand: "Genesis", isTracked: true, avgPosition: 21.0, rankedAnswers: 8 },
    ] },
  ],
  latest: [
    { brand: "Hyundai", isTracked: true, avgPosition: 18.3, rank: 1, rankedAnswers: 44, mentions: 60 },
    { brand: "Kia", isTracked: true, avgPosition: 19.7, rank: 2, rankedAnswers: 33, mentions: 41 },
    { brand: "Tesla", isTracked: false, avgPosition: 20.0, rank: 3, rankedAnswers: 14, mentions: 17 },
    { brand: "BMW", isTracked: false, avgPosition: 20.5, rank: 4, rankedAnswers: 10, mentions: 12 },
    { brand: "Audi", isTracked: false, avgPosition: 20.9, rank: 5, rankedAnswers: 9, mentions: 11 },
    { brand: "Genesis", isTracked: true, avgPosition: 21.0, rank: 6, rankedAnswers: 8, mentions: 9 },
  ],
};

function render(locale: "ko" | "en" = "ko", competitor: string | null = "Tesla") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">
      <FirstRankKpiTab firstPosition={FP} initialLadder initialCompetitor={competitor} />
    </NextIntlClientProvider>,
  );
}

/** 2026-09-20 요구용 렌더: 토글(래더)과 복수 선택을 직접 준다. */
function renderTab(
  opts: { ladder?: boolean; competitors?: string[]; locale?: "ko" | "en" } = {},
) {
  const locale = opts.locale ?? "ko";
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">
      <FirstRankKpiTab
        firstPosition={FP}
        initialLadder={opts.ladder ?? true}
        initialCompetitors={opts.competitors ?? []}
      />
    </NextIntlClientProvider>,
  );
}

/** 표 마크업만(히어로 차트·래더와 섞이지 않게). */
function table(html: string): string {
  const open = html.indexOf("<table");
  return html.slice(open, html.indexOf("</table>", open));
}
/** 한 `<tr>` 의 셀(th·td)을 순서대로 — 셀 안에 th/td 가 중첩되지 않으므로 안전. */
function cells(row: string): Array<{ tag: string; cls: string; html: string }> {
  const out: Array<{ tag: string; cls: string; html: string }> = [];
  const re = /<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  for (let m = re.exec(row); m; m = re.exec(row)) {
    out.push({ tag: m[1], cls: /class="([^"]*)"/.exec(m[2])?.[1] ?? "", html: m[3] });
  }
  return out;
}
function bodyRows(t: string): string[] {
  const body = t.slice(t.indexOf("<tbody"), t.indexOf("</tbody>"));
  return body.split("<tr").slice(1).map((r) => "<tr" + r);
}

describe("우선 노출도 순위 표 — 헤더·셀 열 정렬 (2026-09-11)", () => {
  it.each(["ko", "en"] as const)("colgroup·헤더·모든 행이 같은 열 수를 쓴다 (%s)", (locale) => {
    const t = table(render(locale));
    const cols = t.match(/<col\b/g) ?? [];
    expect(cols).toHaveLength(RANK_COL_CLASS.length);

    const head = cells(t.slice(t.indexOf("<thead"), t.indexOf("</thead>")));
    expect(head).toHaveLength(RANK_COL_CLASS.length);

    const rows = bodyRows(t);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(cells(row)).toHaveLength(RANK_COL_CLASS.length);
  });

  it("열마다 헤더와 셀이 **같은 정렬·패딩 클래스**를 쓴다", () => {
    // 헤더와 셀이 각자 패딩을 들고 있으면 한쪽만 고쳐져 다시 어긋난다.
    const t = table(render());
    const head = cells(t.slice(t.indexOf("<thead"), t.indexOf("</thead>")));
    for (const row of bodyRows(t)) {
      const body = cells(row);
      RANK_COL_CLASS.forEach((cls, i) => {
        expect(head[i].cls).toContain(cls);
        expect(body[i].cls).toContain(cls);
      });
    }
  });

  it("순위 막대는 자기 열에 있다 (값 텍스트 셀에 같이 들어가지 않는다)", () => {
    // 결함 재현 지문: 막대(role=img)가 값 셀 안에 있으면 셀 고유 폭이 선언 폭을
    // 넘겨 뒤 열을 통째로 민다. 2026-09-20 에 번호 컬럼이 맨 앞에 붙어 한 칸씩 밀렸다.
    const t = table(render());
    for (const row of bodyRows(t)) {
      const c = cells(row);
      expect(c[0].html).toMatch(/^\d+$/); // 번호
      expect(c[2].html).not.toContain('role="img"'); // 평균 위치 값
      expect(c[3].html).toContain('role="img"'); // 평균 위치 막대
      expect(c[4].html).toContain("<svg"); // 추이 스파크라인
    }
  });

  // 2026-09-20 고객 요구 ③·④: 번호 열과 막대 열은 **화면에 보이는 컬럼명이 없다**.
  // 종전 단언("모든 헤더에 문구가 있다")은 그 요구로 뒤집혔다. 다만 접근 이름까지
  // 없애면 보조기술이 열을 못 읽으므로 `sr-only` 로 남기고 그것을 여기서 고정한다.
  it.each(["ko", "en"] as const)("번호·막대 열의 헤더는 sr-only 이고 나머지는 보이는 문구다 (%s)", (locale) => {
    const t = table(render(locale));
    const head = cells(t.slice(t.indexOf("<thead"), t.indexOf("</thead>")));
    const dict = locale === "ko" ? ko : en;
    const tbl = dict.answerAnalysis.mentions.kpi.firstRank.table;
    // 숨은 열 2개: 접근 이름은 있고, 보이는 문구는 없다.
    expect(head[0].html).toContain(`<span class="sr-only">${tbl.order}</span>`);
    expect(head[3].html).toContain(`<span class="sr-only">${tbl.avgPosition}</span>`);
    // 나머지 4개는 sr-only 가 아닌 문구를 그대로 그린다.
    for (const i of [1, 2, 4, 5]) {
      expect(head[i].html).not.toContain("sr-only");
      expect(head[i].html.replace(/<[^>]*>/g, "").trim()).not.toBe("");
    }
    // 값 열의 이름은 '평균 위치'(종전 '순위')다.
    expect(head[2].html).toContain(tbl.rank);
  });

  it("표 최소 폭이 고정 열 합보다 크다 — 선언 폭이 무시되지 않게", () => {
    // 종전: min-w-[34rem]=544px < 고정 열 합 563px → 항상 넘쳐서 열이 밀렸다.
    const t = table(render());
    const minRem = Number(/min-w-\[(\d+(?:\.\d+)?)rem\]/.exec(t)?.[1]);
    const fixedPx = [...t.matchAll(/<col class="w-\[(\d+)px\]"/g)].reduce((s, m) => s + Number(m[1]), 0);
    expect(Number.isFinite(minRem)).toBe(true);
    expect(minRem * 16).toBeGreaterThan(fixedPx);
    expect(t).toContain("table-fixed");
  });

  it("래더 값 라벨과 브랜드 라벨이 서로 다른 칸에 있고 트랙 안에 머문다", () => {
    // 종전 결함: 값은 트랙 오른쪽 축 칸에 min/max 2개뿐 → 최상·최하 브랜드 라벨과
    // 같은 y 에서 겹쳤다. 이제 마커마다 값 라벨이 좌측 칸에 따로 선다.
    const html = render();
    const ladder = html.slice(html.indexOf("data-rank-ladder"));
    const values = [...ladder.matchAll(/data-rank-ladder-value[^>]*style="([^"]*)"/g)].map((m) => m[1]);
    const labels = [...ladder.matchAll(/data-rank-ladder-label[^>]*style="([^"]*)"/g)].map((m) => m[1]);
    // 마커 = 당사 3 + 선택 경쟁사 1.
    expect(values).toHaveLength(4);
    expect(labels).toHaveLength(4);
    // 같은 마커의 값·라벨은 같은 top, 서로 다른 마커는 26px 이상 떨어져 있다.
    const tops = values.map((s) => Number(/top:\s*([\d.]+)px/.exec(s)?.[1]));
    labels.forEach((s, i) => expect(Number(/top:\s*([\d.]+)px/.exec(s)?.[1])).toBe(tops[i]));
    const sorted = [...tops].sort((a, b) => a - b);
    sorted.slice(1).forEach((v, i) => expect(v - sorted[i]).toBeGreaterThanOrEqual(26));
    for (const v of tops) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(375 - 26);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GGMD 고객 요구 (2026-09-20): 값 계산은 그대로, 표의 순서·번호·선택만 바뀐다.

/** 표 본문의 (번호, 브랜드) 쌍. 번호는 `data-rank-order` 가 아니라 **그려진 글자**다. */
function orderedBrands(html: string): Array<[string, string]> {
  return bodyRows(table(html)).map((row) => {
    const c = cells(row);
    return [c[0].html.trim(), c[1].html.trim()] as [string, string];
  });
}

describe("순위별 보기 토글이 표 순서를 가른다 (고객 요구 ①)", () => {
  it("토글 ON 은 종전 그대로 (전체를 평균 위치 오름차순)", () => {
    expect(orderedBrands(renderTab({ ladder: true }))).toEqual([
      ["1", "Hyundai"],
      ["2", "Kia"],
      ["3", "Tesla"],
      ["4", "BMW"],
      ["5", "Audi"],
      ["6", "Genesis"],
    ]);
  });

  it("토글 OFF 는 당사 3사가 최상위, 그 아래 타사 (종전에는 순서가 같았다)", () => {
    expect(orderedBrands(renderTab({ ladder: false }))).toEqual([
      ["1", "Hyundai"],
      ["2", "Kia"],
      ["3", "Genesis"],
      ["4", "Tesla"],
      ["5", "BMW"],
      ["6", "Audi"],
    ]);
  });

  it("번호는 **화면에 보이는 순서** 1..N 이다 (경쟁 순위 값이 아니다)", () => {
    // Genesis 의 경쟁 순위는 6위인데 토글 OFF 에서는 3번째 줄이다.
    const rows = orderedBrands(renderTab({ ladder: false }));
    expect(rows.map(([n]) => n)).toEqual(["1", "2", "3", "4", "5", "6"]);
    // 선택으로 행이 줄어도 번호는 1부터 다시 센다.
    const narrowed = orderedBrands(renderTab({ ladder: false, competitors: ["Audi"] }));
    expect(narrowed).toEqual([
      ["1", "Hyundai"],
      ["2", "Kia"],
      ["3", "Genesis"],
      ["4", "Audi"],
    ]);
  });
});

describe("경쟁사 복수 선택 (고객 요구 ②)", () => {
  it("두 개를 고르면 둘 다 표에 남는다 (종전 단일 선택은 하나만 남겼다)", () => {
    const rows = orderedBrands(renderTab({ competitors: ["Tesla", "BMW"] }));
    expect(rows.map(([, b]) => b)).toEqual(["Hyundai", "Kia", "Tesla", "BMW", "Genesis"]);
  });

  it("선택한 경쟁사가 래더 마커에도 전부 올라간다", () => {
    const html = renderTab({ competitors: ["Tesla", "BMW"] });
    const ladder = html.slice(html.indexOf("data-rank-ladder"));
    const marks = [...ladder.matchAll(/data-rank-ladder-mark="([^"]+)"/g)].map((m) => m[1]);
    expect(marks).toEqual(["Hyundai", "Kia", "Genesis", "Tesla", "BMW"]);
  });

  it("선택이 2개 이상이면 트리거가 개수를 말한다", () => {
    // 드롭다운 **내용**은 열기 전까지 마크업에 없다(Radix). 정적 렌더로 볼 수 있는
    // 것은 트리거 라벨뿐이라 상한 동작은 아래 순수 함수 테스트가 고정한다.
    const html = renderTab({ competitors: ["Tesla", "BMW"] });
    expect(html).toContain("data-rank-competitor-select");
    expect(html).toContain("2개 선택");
    expect(renderTab({ competitors: ["Tesla"] })).toContain(">Tesla<");
  });

  it("상한은 추가에만 걸리고 해제는 언제나 된다 (toggleCompetitor)", () => {
    expect(COMPETITOR_LIMIT).toBe(5);
    const full = ["a", "b", "c", "d", "e"];
    // 상한에 닿으면 새 브랜드는 안 들어간다.
    expect(toggleCompetitor(full, "f")).toEqual(full);
    // 그래도 이미 고른 것은 뺄 수 있다. 아니면 되돌릴 방법이 없다.
    expect(toggleCompetitor(full, "c")).toEqual(["a", "b", "d", "e"]);
    // 상한 미만이면 뒤에 붙는다(클릭 순서 보존).
    expect(toggleCompetitor(["a"], "b")).toEqual(["a", "b"]);
    // 입력 배열은 건드리지 않는다.
    expect(full).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("단일 값 seam(initialCompetitor)은 그대로 1개 선택으로 열린다", () => {
    const rows = orderedBrands(render("ko", "BMW"));
    expect(rows.map(([, b]) => b)).toEqual(["Hyundai", "Kia", "BMW", "Genesis"]);
  });
});
