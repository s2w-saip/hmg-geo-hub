/**
 * **누적 영역 차트**(출처 카테고리 구성 추이)의 갭 표시 렌더 가드.
 *
 * 라인 차트 7종은 `trend-gap-bridge.render.test.tsx` 가 본다. 이 파일은 그 차트들과
 * 기하가 다른 한 종 — 100% 누적 영역 — 만 본다. 한 카테고리가 **두 누적 경계 사이의
 * 띠**라서, 이웃 연결이 선 하나가 아니라 **닫힌 밴드**여야 한다.
 *
 * recharts 는 `renderToStaticMarkup` 에서 SVG 를 안 내므로(형제 파일 헤더 참고)
 * recharts 만 얇은 스텁으로 바꾼다 — 축 스케일 훅은 결정적 가짜 스케일을 주고,
 * 나머지(i18n·zeroFill·누적 계산·styleOf)는 전부 실제 구현이 돈다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { RechartsStubState } from "@/test/recharts-stub";
import { readSourceText } from "@/test/source-text";

/**
 * 스텁이 읽는 가변 상태 — 형제 가드(`trend-gap-bridge.render.test.tsx`)와 **같은 공용
 * 스텁**(`test/recharts-stub.tsx`)을 쓴다. 스케일만 이 차트에 맞춘다: 구성비 0~1 을
 * 200~40px 로(주 간격 40px). 플롯 영역은 공용 기본값(0,0,400x200) 이라 값 0 이 곧
 * 플롯 바닥(200)이다.
 */
const axis = vi.hoisted(
  () => ({ xs: [] as Array<string | number>, yBase: 200, yUnit: 160 }) as RechartsStubState,
);

vi.mock("recharts", async () => {
  const { makeRechartsStub } = await import("@/test/recharts-stub");
  return makeRechartsStub({
    actual: await vi.importActual<Record<string, unknown>>("recharts"),
    state: axis,
  });
});

import { DefaultZIndexes } from "recharts";
import { COLLECTION_ERROR_GAP, type TrendGapRow } from "@/lib/viz/trend-gap";
import { trendCubicYExtent } from "@/lib/viz/trend-gap-curve";
import { planTrendGaps } from "@/lib/viz/trend-gap";
import { trendStackBoundaryRows } from "@/lib/viz/trend-gap-stack";
import { trendGapStackBands } from "@/components/dash/trend-gap-overlay";
import type { CitationTrend } from "@/lib/scope/result-adapter";
import {
  CategoryCompositionTrend,
  categoryColor,
} from "@/app/[locale]/(dash)/standard/answer-analysis/_components/citations-view";

const WEEKS = ["2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07"];
const CATS = ["Official (HMG)", "News & Media", "Blogs & Reviews"];

/** 가운데(8/24)가 수집 오류인 5주치 — 카테고리 3종. */
const GAP_ROWS: TrendGapRow[] = [
  { week: WEEKS[0], [CATS[0]]: 1, [CATS[1]]: 1, [CATS[2]]: 2 },
  { week: WEEKS[1], [CATS[0]]: 2, [CATS[1]]: 2, [CATS[2]]: 0 },
  { week: WEEKS[2], [CATS[0]]: null, [CATS[1]]: null, [CATS[2]]: null, gap: COLLECTION_ERROR_GAP },
  { week: WEEKS[3], [CATS[0]]: 1, [CATS[1]]: 1, [CATS[2]]: 2 },
  { week: WEEKS[4], [CATS[0]]: 3, [CATS[1]]: 1, [CATS[2]]: 0 },
];
const CLEAN_ROWS = GAP_ROWS.filter((r) => !r.gap);

function wrap(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}

/**
 * `absolute` 모드의 y 스케일 — 원값 1당 40px.
 *
 * 기본 스텁 스케일(구성비 0~1 을 200~40px, 값 1당 160px)은 **정규화 전용**이다. 원값을
 * 그대로 싣는 absolute 모드에 그 배율을 쓰면 누적 합 2 가 y −120 — 플롯(0~200) 위로
 * 60% 나간 좌표 — 가 되는데, 실제 차트는 `YAxis` 에 domain 을 안 주므로 recharts 가
 * 데이터에서 도메인을 잡아 **점이 플롯 밖으로 나갈 수 없다**(프리뷰 sweep 13/13 이
 * 플롯 8~258 안). 즉 그건 물리적으로 불가능한 픽스처라서, absolute 렌더는 값이 플롯
 * 안에 들어오는 배율을 쓴다.
 */
const ABS_Y_UNIT = 40;

function render(points: TrendGapRow[], absolute = false): string {
  axis.xs = points.map((p) => String(p.week));
  if (absolute) axis.yUnit = ABS_Y_UNIT;
  const trend: CitationTrend = { series: CATS, points };
  try {
    return wrap(
      <CategoryCompositionTrend title="T" trend={trend} label={(s) => s} absolute={absolute} />,
    );
  } finally {
    axis.yUnit = 160;
  }
}

function paths(html: string, cls: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  const re = new RegExp(`<path[^>]*class="${cls}"[^>]*>`, "g");
  for (const tag of html.match(re) ?? []) {
    const attrs: Record<string, string> = {};
    for (const [, k, v] of tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[k] = v;
    out.push(attrs);
  }
  return out;
}
const bands = (html: string) => paths(html, "recharts-trend-gap-band");
const bandCurves = (html: string) => paths(html, "recharts-trend-gap-band-curve");

/**
 * recharts 층(`ZIndexLayer`) 하나하나를 `{ z, inner }` 로 떠 온다.
 *
 * SVG 에는 CSS z-index 가 없어서 recharts 3.4+ 는 zIndex 마다 별도 `<g>` 포털을 만들고
 * 그래픽 아이템을 거기로 옮긴다. **층 밖에 남은 raw path 는 차트 children 자리에 그대로
 * 그려져 포털 전체보다 아래**로 내려간다 — 그래서 "선언 순서"만 보는 가드는 참이 아닌
 * 명제를 통과시킨다(2026-09-11 프리뷰 실측: 밴드 domIdx 26 < 음영 54 < 본 영역 57).
 * 층 안에는 path 만 들어가므로(중첩 `<g>` 없음) 비탐욕 매칭으로 충분하다.
 */
function layers(html: string): Array<{ z: string; inner: string }> {
  const re = /<g data-rc="ZIndexLayer" data-z="([^"]*)">([\s\S]*?)<\/g>/g;
  return [...html.matchAll(re)].map((m) => ({ z: m[1], inner: m[2] }));
}

/** 밴드 path 의 숫자 16개 → 상단·하단 두 3차 베지어. */
function split(d: string) {
  const n = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  expect(n).toHaveLength(16);
  const p = (i: number) => ({ x: n[i], y: n[i + 1] });
  return {
    upper: { p0: p(0), c1: p(2), c2: p(4), p1: p(6) },
    // 하단은 역방향으로 적혀 있다 — 정방향(p0→p1)으로 되돌려 둔다.
    lower: { p0: p(14), c1: p(12), c2: p(10), p1: p(8) },
  };
}
type Cubic = ReturnType<typeof split>["upper"];
function yAt(c: Cubic, t: number): number {
  const u = 1 - t;
  return u * u * u * c.p0.y + 3 * u * u * t * c.c1.y + 3 * u * t * t * c.c2.y + t * t * t * c.p1.y;
}

describe("CategoryCompositionTrend — 갭 창을 누적 밴드로 잇는다", () => {
  it("음영 1개 + 카테고리마다 닫힌 밴드 1개", () => {
    const html = render(GAP_ROWS);
    expect((html.match(/data-rc="ReferenceArea"/g) ?? []).length).toBe(1);
    const drawn = bands(html);
    expect(drawn).toHaveLength(CATS.length);
    for (const b of drawn) {
      expect(b.d.endsWith("Z"), `닫히지 않았다: ${b.d}`).toBe(true);
      expect(b["pointer-events"]).toBe("none");
      expect(b.stroke).toBe("none");
    }
  });

  it("밴드 색·투명도는 본 영역과 같다 (categoryColor · fillOpacity 0.85)", () => {
    const drawn = bands(render(GAP_ROWS));
    expect(drawn.map((b) => b.fill)).toEqual(CATS.map(categoryColor));
    expect(drawn.map((b) => b["fill-opacity"])).toEqual(["0.85", "0.85", "0.85"]);
  });

  it("경계 끝점이 이웃 주(8/17·8/31)의 실제 누적 경계와 맞물린다", () => {
    // 8/17: 2/4·2/4·0 → 경계 0, .5, 1, 1  → y 200, 120, 40, 40
    // 8/31: 1/4·1/4·2/4 → 경계 0, .25, .5, 1 → y 200, 160, 120, 40
    const expected = [
      { lo: [200, 200], up: [120, 160] },
      { lo: [120, 160], up: [40, 120] },
      { lo: [40, 120], up: [40, 40] },
    ];
    const drawn = bands(render(GAP_ROWS));
    drawn.forEach((b, i) => {
      const { upper, lower } = split(b.d);
      expect([upper.p0.x, upper.p1.x]).toEqual([40, 120]); // 갭 창 밖으로 안 샌다
      expect([lower.p0.x, lower.p1.x]).toEqual([40, 120]);
      expect([upper.p0.y, upper.p1.y]).toEqual(expected[i].up);
      expect([lower.p0.y, lower.p1.y]).toEqual(expected[i].lo);
    });
  });

  it("이웃 밴드는 경계 곡선을 **공유**한다 — 사이에 틈도 겹침도 없다", () => {
    const drawn = bands(render(GAP_ROWS));
    for (let i = 0; i + 1 < drawn.length; i += 1) {
      expect(split(drawn[i].d).upper).toEqual(split(drawn[i + 1].d).lower);
    }
  });

  it("경계 곡선이 갭 창 안에서 교차하지 않는다 (누적 단조)", () => {
    const drawn = bands(render(GAP_ROWS));
    for (const b of drawn) {
      const { upper, lower } = split(b.d);
      for (let i = 0; i <= 40; i += 1) {
        const t = i / 40;
        // SVG y 는 아래로 커진다 — 상단 경계가 하단보다 작거나 같아야 한다.
        expect(yAt(upper, t)).toBeLessThanOrEqual(yAt(lower, t) + 1e-6);
      }
    }
  });

  it("100% 정규화면 맨 위 경계가 축 상단(=1)을 넘지 않는다", () => {
    const drawn = bands(render(GAP_ROWS));
    const top = split(drawn[drawn.length - 1].d).upper;
    for (let i = 0; i <= 40; i += 1) {
      // y = 200 - 160·v → v ≤ 1 은 y ≥ 40.
      expect(yAt(top, i / 40)).toBeGreaterThanOrEqual(40 - 1e-6);
    }
  });

  /**
   * 축 상한(=1)을 **실제로 넘길 수 있는** 픽스처. 갭 두 칸 앞 주의 합이 0 이라
   * 맨 위 경계가 바닥(0%)까지 내려왔다가 갭 직전에 100% 로 치솟는다 — 그 접선을
   * 그대로 이으면 갭 안에서 150% 를 주장한다. 오버슛 리미터(플롯 높이 5% = 10px)
   * 만으로는 106% 까지밖에 못 막으므로, `valueBounds.max = 1` 배선이 살아 있어야
   * 100% 에서 멈춘다.
   */
  it("합이 0 인 주에서 치솟아도 100% 를 넘지 않는다 — valueBounds 배선 가드", () => {
    const rows: TrendGapRow[] = [
      { week: WEEKS[0], [CATS[0]]: 0, [CATS[1]]: 0, [CATS[2]]: 0 },
      { week: WEEKS[1], [CATS[0]]: 4, [CATS[1]]: 0, [CATS[2]]: 0 },
      { week: WEEKS[2], [CATS[0]]: null, [CATS[1]]: null, [CATS[2]]: null, gap: COLLECTION_ERROR_GAP },
      { week: WEEKS[3], [CATS[0]]: 4, [CATS[1]]: 0, [CATS[2]]: 0 },
      { week: WEEKS[4], [CATS[0]]: 4, [CATS[1]]: 0, [CATS[2]]: 0 },
    ];
    const drawn = bands(render(rows));
    const top = split(drawn[drawn.length - 1].d).upper;
    expect(top.p0.y).toBe(40); // 갭 양옆은 100%
    expect(top.p1.y).toBe(40);
    for (let i = 0; i <= 200; i += 1) {
      expect(yAt(top, i / 200)).toBeGreaterThanOrEqual(40 - 0.011);
    }
  });

  /**
   * 반대쪽 가드 — 허용치의 기준이 **플롯 높이**로 들어와 있는가(`usePlotArea` 배선).
   * absolute 모드에서 갭 양옆 값이 같으면 끝점 스팬이 0 이라, 플롯 높이가 없으면
   * 허용치도 0 이 되어 굴곡이 **완전히 펴진다**(직선). 플롯 높이 200 의 5% = 10px
   * 여유가 들어오면 본선 접선이 살아 봉긋해진다.
   */
  it("끝점 스팬이 0 이어도 굴곡이 남는다 — plotSpan 배선 가드", () => {
    const rows: TrendGapRow[] = [
      { week: WEEKS[0], [CATS[0]]: 1, [CATS[1]]: 0, [CATS[2]]: 0 },
      { week: WEEKS[1], [CATS[0]]: 2, [CATS[1]]: 0, [CATS[2]]: 0 },
      { week: WEEKS[2], [CATS[0]]: null, [CATS[1]]: null, [CATS[2]]: null, gap: COLLECTION_ERROR_GAP },
      { week: WEEKS[3], [CATS[0]]: 2, [CATS[1]]: 0, [CATS[2]]: 0 },
      { week: WEEKS[4], [CATS[0]]: 1, [CATS[1]]: 0, [CATS[2]]: 0 },
    ];
    const top = split(bands(render(rows, true))[0].d).upper;
    expect(top.p0.y).toBe(200 - ABS_Y_UNIT * 2); // 플롯(0~200) 안이다
    expect(top.p0.y).toBe(top.p1.y); // 끝점 스팬 0
    // 위로 봉긋 — 플롯 높이가 없었다면 제어점이 끝점과 같은 높이(직선)로 눌린다.
    expect(top.p0.y - top.c1.y).toBeGreaterThan(1);
    expect(top.p1.y - top.c2.y).toBeGreaterThan(1);
    // 그러나 허용치(플롯 높이의 5% = 10px) 안이다.
    for (let i = 0; i <= 200; i += 1) {
      expect(yAt(top, i / 200)).toBeGreaterThanOrEqual(top.p0.y - 10 - 0.011);
    }
  });

  it("카테고리 경계선(1px stroke)도 갭 창을 잇는다 — 밴드 상단과 같은 곡선", () => {
    const html = render(GAP_ROWS);
    const curves = bandCurves(html);
    expect(curves).toHaveLength(CATS.length);
    expect(curves.map((c) => c.stroke)).toEqual(CATS.map(categoryColor));
    expect(curves.every((c) => c.fill === "none")).toBe(true);
    bands(html).forEach((b, i) => {
      // 밴드 path 의 앞부분(상단 곡선)과 문자 그대로 같다.
      expect(b.d.startsWith(curves[i].d)).toBe(true);
    });
  });

  it("absolute(스택 미정규화) 모드도 같은 자세다", () => {
    const drawn = bands(render(GAP_ROWS, true));
    expect(drawn).toHaveLength(CATS.length);
    // 8/17 원값 누적 0,2,4,4 → y 200, 120, 40, 40 (absolute 배율 40px/값)
    expect(split(drawn[0].d).upper.p0.y).toBe(200 - ABS_Y_UNIT * 2);
  });

  it("갭이 둘이면 음영 2개 · 밴드는 런마다 카테고리 수만큼", () => {
    const rows: TrendGapRow[] = [
      GAP_ROWS[0],
      { week: WEEKS[1], [CATS[0]]: null, [CATS[1]]: null, [CATS[2]]: null, gap: COLLECTION_ERROR_GAP },
      // 8/24 는 이 픽스처에서만 정상 주다(갭은 8/17 과 8/31 두 군데).
      { week: WEEKS[2], [CATS[0]]: 2, [CATS[1]]: 1, [CATS[2]]: 1 },
      { week: WEEKS[3], [CATS[0]]: null, [CATS[1]]: null, [CATS[2]]: null, gap: COLLECTION_ERROR_GAP },
      GAP_ROWS[4],
    ];
    const html = render(rows);
    expect((html.match(/data-rc="ReferenceArea"/g) ?? []).length).toBe(2);
    expect(bands(html)).toHaveLength(CATS.length * 2);
    expect(bandCurves(html)).toHaveLength(CATS.length * 2);
  });

  it("연속 2주 결측은 음영 1개 · 밴드도 1세트 (창이 넓어질 뿐)", () => {
    const rows: TrendGapRow[] = [
      GAP_ROWS[0],
      { week: WEEKS[1], [CATS[0]]: null, [CATS[1]]: null, [CATS[2]]: null, gap: COLLECTION_ERROR_GAP },
      { week: WEEKS[2], [CATS[0]]: null, [CATS[1]]: null, [CATS[2]]: null, gap: COLLECTION_ERROR_GAP },
      GAP_ROWS[3],
      GAP_ROWS[4],
    ];
    const html = render(rows);
    expect((html.match(/data-rc="ReferenceArea"/g) ?? []).length).toBe(1);
    const drawn = bands(html);
    expect(drawn).toHaveLength(CATS.length);
    // 창은 8/10(x 0) → 8/31(x 120) — 결측 두 칸을 한 번에 건넌다.
    for (const b of drawn) {
      const { upper, lower } = split(b.d);
      expect([upper.p0.x, upper.p1.x]).toEqual([0, 120]);
      expect([lower.p0.x, lower.p1.x]).toEqual([0, 120]);
    }
  });

  it("축 끝 갭은 음영만 — 이을 이웃이 없으니 밴드가 없다", () => {
    const rows: TrendGapRow[] = [
      ...GAP_ROWS.slice(0, 2),
      { week: WEEKS[2], [CATS[0]]: 2, [CATS[1]]: 1, [CATS[2]]: 1 },
      GAP_ROWS[3],
      { week: WEEKS[4], [CATS[0]]: null, [CATS[1]]: null, [CATS[2]]: null, gap: COLLECTION_ERROR_GAP },
    ];
    const html = render(rows);
    expect((html.match(/data-rc="ReferenceArea"/g) ?? []).length).toBe(1);
    expect(bands(html)).toEqual([]);
    expect(bandCurves(html)).toEqual([]);
  });

  it("갭이 없으면 음영도 밴드도 경계선도 하나도 안 생긴다 — 회귀 0", () => {
    const html = render(CLEAN_ROWS);
    expect(bands(html)).toEqual([]);
    expect(bandCurves(html)).toEqual([]);
    expect(html).not.toContain("recharts-trend-gap-band");
    expect(html).not.toContain("data-rc=\"ReferenceArea\"");
    // 본 영역은 종전 그대로 카테고리 수만큼.
    expect((html.match(/data-rc="Area"/g) ?? []).length).toBe(CATS.length);
  });
});

// ── 툴팁 배선 (소스 대조 — 스텁 툴팁은 content 를 렌더하지 않는다) ────────────

describe("CategoryCompositionTrend — 갭 툴팁 배선", () => {
  const src = readSourceText(
    path.join(
      path.resolve(__dirname, "..", ".."),
      "app/[locale]/(dash)/standard/answer-analysis/_components/citations-view.tsx",
    ),
  );
  const block =
    /export function CategoryCompositionTrend[\s\S]*?\n}\n/.exec(src)?.[0] ?? "";

  it("차트 블록을 찾았다", () => {
    expect(block).not.toBe("");
  });

  it("filterNull={false} + GapAwareTooltip — 전 시리즈 null 인 갭 슬롯이 걷히지 않게", () => {
    expect(block).toContain("filterNull={false}");
    expect(block).toContain("content={<GapAwareTooltip />}");
  });

  // 2026-09-11 제품 책임자 "다른 차트에도 갭 툴팁 지워줘" — 갭 슬롯은 툴팁 자체가 없다.
  it("갭 문구가 남아 있지 않다 — 사전 키도 JSX 리터럴도", () => {
    expect(src).not.toContain('useTranslations("trend.gap")');
    expect(src).not.toContain('tGap("collectionError")');
    expect(block).not.toContain("오류로 인해 수집되지 않음");
  });

  it("음영은 Area 보다 **먼저** 선언된다 — 뒤에 깔려야 값을 가리지 않는다", () => {
    const iArea = block.search(/<Area\b/);
    expect(iArea).toBeGreaterThan(0);
    expect(block.indexOf("trendGapAreas(")).toBeLessThan(iArea);
  });

  it("밴드는 Area **뒤에** 선언된다 — 같은 층에서는 삽입 순서가 위아래를 정한다", () => {
    expect(block.indexOf("trendGapStackBands(")).toBeGreaterThan(block.search(/<Area\b/));
  });
});

// ── z-order ────────────────────────────────────────────────────────────────

describe("밴드 z-order — 갭 음영 위, 본 영역과 같은 층", () => {
  const rechartsDir = path.join(
    path.resolve(__dirname, "..", ".."),
    "node_modules/recharts/es6/cartesian",
  );
  const readSrc = (f: string) => readSourceText(path.join(rechartsDir, f));

  it("recharts 전제: Area 도 ReferenceArea 도 기본 층이 DefaultZIndexes.area 다", () => {
    // 두 컴포넌트의 zIndex 기본값은 export 되지 않는다(내부 defaultProps 객체) —
    // 그래서 전제는 **설치된 recharts 소스**에서 직접 읽어 고정한다.
    expect(readSrc("Area.js")).toContain("zIndex: DefaultZIndexes.area");
    expect(readSrc("ReferenceArea.js")).toContain("zIndex: DefaultZIndexes.area");
    // 그리고 그 층은 본선(line)보다 아래다 — 밴드가 보조선·본선을 덮지 않는다.
    expect(DefaultZIndexes.area).toBeLessThan(DefaultZIndexes.line);
  });

  it("밴드·경계선 path 가 전부 area 층 안에 있다", () => {
    const html = render(GAP_ROWS);
    const ls = layers(html);
    expect(ls).toHaveLength(1); // 갭 런 1개 = 층 래퍼 1개
    expect(ls.map((l) => l.z)).toEqual([String(DefaultZIndexes.area)]);
    const inner = ls.map((l) => l.inner).join("");
    // 층 밖에 남은 밴드 path 가 하나도 없다.
    expect(bands(inner)).toEqual(bands(html));
    expect(bandCurves(inner)).toEqual(bandCurves(html));
    expect(bands(inner)).toHaveLength(CATS.length);
  });

  it("갭이 둘이면 층 래퍼도 둘 — 런마다 자기 층 포털에 들어간다", () => {
    const rows: TrendGapRow[] = [
      GAP_ROWS[0],
      { week: WEEKS[1], [CATS[0]]: null, [CATS[1]]: null, [CATS[2]]: null, gap: COLLECTION_ERROR_GAP },
      { week: WEEKS[2], [CATS[0]]: 2, [CATS[1]]: 1, [CATS[2]]: 1 },
      { week: WEEKS[3], [CATS[0]]: null, [CATS[1]]: null, [CATS[2]]: null, gap: COLLECTION_ERROR_GAP },
      GAP_ROWS[4],
    ];
    const html = render(rows);
    expect(layers(html).map((l) => l.z)).toEqual([
      String(DefaultZIndexes.area),
      String(DefaultZIndexes.area),
    ]);
  });

  it("갭이 없으면 층 래퍼도 없다 — 빈 포털을 만들지 않는다", () => {
    expect(layers(render(CLEAN_ROWS))).toEqual([]);
  });
});

// ── absolute(단일 카테고리) 모드 — 플롯 영역 이탈 ────────────────────────────

/**
 * 프리뷰 실측 재현 픽스처. 2026-09-11 재검증에서 `?source=<카테고리>` 13개 화면 중
 * **6개**가 밴드 봉우리를 플롯 위로 밀어냈고 2개는 SVG 상단에서 잘렸다.
 *
 * 인과: absolute 모드는 데이터 상한이 없어 `valueBounds.max` 가 `undefined` 다 →
 * `yTop` 이 `undefined` 가 되어 `withinAxis` 가 **위쪽 검사를 통째로 건너뛴다**.
 * 그러면 남는 상한은 보조선의 오버슛 리미터뿐인데 그 기준은 축이 아니라 **양 끝점**
 * ±(플롯 높이의 5% = 12.5px) 이라, 이웃 주가 축 꼭대기 근처면 그만큼 플롯 밖이다.
 *
 * 픽스처는 실측 좌표계를 그대로 쓴다 — 플롯 `44,8 980x250`(상단 y 8 · 바닥 y 258),
 * 주 간격 98px, 갭은 8/24 한 칸. `yBase 258 · yUnit 1` 스케일이라 값 v 가 픽셀
 * `258 - v` 로 실려서, 실측 끝점 y 를 값으로 되돌려 넣기만 하면 같은 기하가 된다.
 *
 * 끝점 y0·y1 은 sweep 실측 그대로다. 이웃 주(갭 두 칸 앞·뒤)는 실측값을 모르므로
 * **최악(값 0 → 가장 가파른 접선)** 으로 박았다 — 그러면 리미터가 상한(`끝점 - 12.5px`)
 * 에 정확히 물려서, 실측에서 상한까지 물렸던 8개 카테고리의 `min` 이 소수 3자리까지
 * 재현되고 나머지는 실측보다 **더 엄한** 조건이 된다. 그 결과 이탈하는 카테고리 집합은
 * 실측과 같은 6개(HMG·Competitor·Dealer·Automotive·Social&Video·Academic)다.
 */
const SWEEP_PLOT = { x: 44, y: 8, width: 980, height: 250 } as const;
const SWEEP_PLOT_TOP = SWEEP_PLOT.y; // 8
const SWEEP_PLOT_BOTTOM = SWEEP_PLOT.y + SWEEP_PLOT.height; // 258
/** `[카테고리, 갭 직전(8/17) 픽셀 y, 갭 직후(8/31) 픽셀 y]` — sweep-fddc181.json 그대로. */
const SWEEP: ReadonlyArray<readonly [string, number, number]> = [
  ["Official (HMG)", 27.507, 19.042],
  ["Official (Competitor)", 8.225, 57.5],
  ["Dealer & Marketplace", 71.26, 9.894],
  ["Automotive Media", 37.058, 16.433],
  ["News & Media", 99.167, 33.708],
  ["Community & Forums", 126.425, 42.75],
  ["Social & Video", 18.313, 58.781],
  ["Blogs & Reviews", 86.958, 73.875],
  ["Wiki & Reference", 218.385, 194.442],
  ["Government & Public", 21.75, 23.469],
  ["Award & Certification", 28.694, 103.278],
  ["Academic & Research", 11.571, 26.75],
  ["Other", 176.603, 83.147],
];
/** path 는 소수 3자리로 반올림돼 나온다 — 그보다 넉넉한 여유. */
const SWEEP_EPS = 0.02;

describe("absolute(단일 카테고리) 밴드는 플롯 영역을 벗어나지 않는다", () => {
  beforeEach(() => {
    axis.plotArea = { ...SWEEP_PLOT };
    axis.xStep = 98;
    axis.yBase = SWEEP_PLOT_BOTTOM; // 값 0 = 스택 바닥 = 플롯 바닥
    axis.yUnit = 1; // 값 1 = 1px
  });
  afterEach(() => {
    axis.plotArea = undefined;
    axis.xStep = undefined;
    axis.yBase = 200;
    axis.yUnit = 160;
  });

  /** 실측 끝점 픽셀을 값으로 되돌린 5주치 — 가운데(8/24)가 갭. */
  function sweepRows(cat: string, y0: number, y1: number): TrendGapRow[] {
    const v = (y: number) => SWEEP_PLOT_BOTTOM - y;
    return [
      { week: WEEKS[0], [cat]: 0 },
      { week: WEEKS[1], [cat]: v(y0) },
      { week: WEEKS[2], [cat]: null, gap: COLLECTION_ERROR_GAP },
      { week: WEEKS[3], [cat]: v(y1) },
      { week: WEEKS[4], [cat]: 0 },
    ];
  }

  function sweepBand(cat: string, y0: number, y1: number) {
    axis.xs = WEEKS;
    const html = wrap(
      <CategoryCompositionTrend
        title="T"
        trend={{ series: [cat], points: sweepRows(cat, y0, y1) }}
        label={(s) => s}
        absolute
      />,
    );
    const drawn = bands(html);
    expect(drawn, `${cat}: 밴드가 하나여야 한다`).toHaveLength(1);
    return split(drawn[0].d);
  }

  it("끝점은 실측 좌표를 그대로 재현한다 — 픽스처 자체의 건전성", () => {
    for (const [cat, y0, y1] of SWEEP) {
      const { upper } = sweepBand(cat, y0, y1);
      expect([upper.p0.y, upper.p1.y], cat).toEqual([y0, y1]);
      expect([upper.p0.x, upper.p1.x], cat).toEqual([98, 294]);
    }
  });

  it("13개 카테고리 전부 봉우리가 플롯 상단(y 8) 위로 안 솟는다", () => {
    const above: Array<[string, number]> = [];
    for (const [cat, y0, y1] of SWEEP) {
      const { upper } = sweepBand(cat, y0, y1);
      const e = trendCubicYExtent(upper.p0.y, upper.c1.y, upper.c2.y, upper.p1.y);
      if (e.min < SWEEP_PLOT_TOP - SWEEP_EPS) {
        above.push([cat, Number((SWEEP_PLOT_TOP - e.min).toFixed(3))]);
      }
    }
    expect(above, "플롯 상단을 넘은 카테고리(이름, 초과 px)").toEqual([]);
  });

  /**
   * `valueBounds` 자체를 **안 넘긴** 호출도 플롯 안에 머문다 — 인자가 선택이라
   * (`trendGapStackBands(bridges, keys, styleOf)`) 새 호출부가 빼먹을 수 있고,
   * 그때 위·아래 상한이 통째로 사라지면 안 된다. 두 폴백을 한 번에 태우는 유일한 경로다.
   */
  it("valueBounds 를 아예 안 넘겨도 위·아래 둘 다 플롯 안이다", () => {
    axis.xs = WEEKS;
    const cat = "Official (Competitor)";
    const rows = sweepRows(cat, 8.225, 57.5);
    const stack = trendStackBoundaryRows(rows, {
      xKey: "week",
      seriesKeys: [cat],
      normalize: false,
    });
    const plan = planTrendGaps(stack.rows, { xKey: "week", seriesKeys: stack.boundaryKeys });
    const html = renderToStaticMarkup(
      <>{trendGapStackBands(plan.bridges, stack.boundaryKeys, () => ({ fill: "#000" }))}</>,
    );
    const drawn = bands(html);
    expect(drawn).toHaveLength(1);
    const { upper, lower } = split(drawn[0].d);
    const eUp = trendCubicYExtent(upper.p0.y, upper.c1.y, upper.c2.y, upper.p1.y);
    const eLo = trendCubicYExtent(lower.p0.y, lower.c1.y, lower.c2.y, lower.p1.y);
    expect(eUp.min).toBeGreaterThanOrEqual(SWEEP_PLOT_TOP - SWEEP_EPS);
    expect(eLo.max).toBeLessThanOrEqual(SWEEP_PLOT_BOTTOM + SWEEP_EPS);
  });

  it("13개 카테고리 전부 밴드 바닥이 플롯 하단(y 258) 아래로 안 처진다", () => {
    const below: Array<[string, number]> = [];
    for (const [cat, y0, y1] of SWEEP) {
      const { lower } = sweepBand(cat, y0, y1);
      const e = trendCubicYExtent(lower.p0.y, lower.c1.y, lower.c2.y, lower.p1.y);
      if (e.max > SWEEP_PLOT_BOTTOM + SWEEP_EPS) {
        below.push([cat, Number((e.max - SWEEP_PLOT_BOTTOM).toFixed(3))]);
      }
    }
    expect(below, "플롯 하단을 넘은 카테고리(이름, 초과 px)").toEqual([]);
  });

});

/**
 * 반대쪽 가드 — 플롯 영역 폴백이 **축 경계를 밀어내면 안 된다**. 정규화 모드는
 * `valueBounds.max = 1` 이 살아 있어야 하고, 그 상한(구성비 100% = y 40)은 플롯
 * 상단(y 0)보다 **아래**다. 폴백이 우선순위를 뒤집으면 13밴드 맨 위가 100% 위로
 * 40px 더 자란다 — 측정이 없는 주에 "합이 100% 를 넘는다"는 거짓 주장이다.
 */
describe("정규화 13밴드 — 상한은 100% 선이지 플롯 상단이 아니다", () => {
  const CATS13 = SWEEP.map(([c]) => c);
  /** 갭 두 칸 앞 합이 0 → 맨 위 경계가 바닥에서 100% 로 치솟는 픽스처. */
  const rows: TrendGapRow[] = [
    { week: WEEKS[0], ...Object.fromEntries(CATS13.map((c) => [c, 0])) },
    { week: WEEKS[1], ...Object.fromEntries(CATS13.map((c, i) => [c, i === 0 ? 4 : 0])) },
    {
      week: WEEKS[2],
      ...Object.fromEntries(CATS13.map((c) => [c, null])),
      gap: COLLECTION_ERROR_GAP,
    },
    { week: WEEKS[3], ...Object.fromEntries(CATS13.map((c, i) => [c, i === 0 ? 4 : 0])) },
    { week: WEEKS[4], ...Object.fromEntries(CATS13.map((c, i) => [c, i === 0 ? 4 : 0])) },
  ];

  it("밴드 13개 · 맨 위 경계가 100%(y 40)를 안 넘는다", () => {
    axis.xs = WEEKS;
    const html = wrap(
      <CategoryCompositionTrend
        title="T"
        trend={{ series: CATS13, points: rows }}
        label={(s) => s}
      />,
    );
    const drawn = bands(html);
    expect(drawn).toHaveLength(13);
    const top = split(drawn[drawn.length - 1].d).upper;
    expect([top.p0.y, top.p1.y]).toEqual([40, 40]); // 갭 양옆은 100%
    const e = trendCubicYExtent(top.p0.y, top.c1.y, top.c2.y, top.p1.y);
    // 플롯 상단(y 0)이 상한이 됐다면 여기서 40 밑(작은 y)으로 내려간다.
    expect(e.min).toBeGreaterThanOrEqual(40 - SWEEP_EPS);
  });
});
