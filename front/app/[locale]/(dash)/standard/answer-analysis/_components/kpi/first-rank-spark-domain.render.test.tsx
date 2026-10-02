import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { FirstPositionResult } from "@/lib/db/repositories/scope-aggregates";
import { FirstRankKpiTab } from "./first-rank-kpi-tab";
import { SPARK_BOX } from "./spark-line";

// 2026-09-11 독립 검증 2차 지적 — **호출부 회귀 가드**.
//
// 스파크 축 결함은 `spark-line.tsx` 가 아니라 **호출부 배선**에 있었다(축 모수 =
// 최신 스냅샷 `worst` / 그리는 값 = 과거 회차). 그래서 단위 테스트만으로는 못 막는다:
// 검증자가 `first-rank-kpi-tab` 에서 도메인·invert 배선을 통째로 지워도 `npm test`
// 3,511건이 전부 통과함을 실증했다. 이 파일은 **탭을 실제로 렌더해서** 그려진 좌표를
// 읽는다 — 배선이 빠지면 여기서 깨진다.
//
// 실데이터 지문(검증자 실측): Hyundai spark `[16.7, 31.5, 19.4, 18.3]`, 최신 worst 23.9.
//   종전 매핑 y = [21.71, 40.28, 25.1, 23.72] → 31.5 회차가 40.28 로 viewBox(하단 32) 밖.
//   31.5 는 **최신 스냅샷의 최악(23.9)보다 나쁜 과거 회차**라 `worst + 1 - v` 가 음수였다.

const H = SPARK_BOX.h;
const PAD = SPARK_BOX.pad;
const TOP = PAD;
const BOTTOM = H - PAD;

const CYCLES = ["2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31"];
/** brand → [tracked, 회차별 avgPosition]. 마지막 회차가 곧 최신 스냅샷 값. */
const SERIES: Record<string, [boolean, number[]]> = {
  Hyundai: [true, [16.7, 31.5, 19.4, 18.3]], // 검증자 지문 — 과거 회차가 worst 보다 나쁘다
  Kia: [true, [20.1, 20.4, 20.1, 19.7]], // 폭 0.7위 — 공유 축에서는 납작해야 한다
  Tesla: [false, [20.6, 20.4, 20.2, 20.0]],
  Genesis: [true, [23.0, 23.5, 23.7, 23.9]], // 최신 최악 = worst 23.9
};
const NAMES = Object.keys(SERIES);
const FP: FirstPositionResult = {
  unit: "week",
  brands: NAMES,
  buckets: CYCLES.map((bucketStart, i) => ({
    bucketStart,
    measuredDays: 7,
    firstAt: null,
    lastAt: null,
    brands: NAMES.map((b) => ({
      brand: b,
      isTracked: SERIES[b][0],
      avgPosition: SERIES[b][1][i],
      rankedAnswers: 10,
    })),
  })),
  latest: NAMES.map((b) => ({ brand: b, isTracked: SERIES[b][0], avgPosition: SERIES[b][1][3], rankedAnswers: 10, mentions: 12 }))
    .sort((a, z) => a.avgPosition - z.avgPosition)
    .map((r, i) => ({ ...r, rank: i + 1 })),
};

function html(): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <FirstRankKpiTab firstPosition={FP} />
    </NextIntlClientProvider>,
  );
}

/** 표 본문의 브랜드 → 그 행 스파크라인의 점 y 좌표(viewBox 단위, 회차 순). */
function sparkYByBrand(markup: string): Map<string, number[]> {
  const table = markup.slice(markup.indexOf("<table"), markup.indexOf("</table>"));
  const body = table.slice(table.indexOf("<tbody"), table.indexOf("</tbody>"));
  const out = new Map<string, number[]>();
  for (const row of body.split("<tr").slice(1)) {
    const brand = /<th[^>]*>([^<]+)<\/th>/.exec(row)?.[1]?.trim();
    if (!brand) continue;
    // ⚠️ 스파크 svg 로 범위를 좁힌다 — 같은 행의 WoW 배지(lucide TrendingUp/Down)도
    //    `points` 를 갖는데 그쪽은 **쉼표 없는** 좌표라 섞이면 조용히 NaN 이 된다.
    const open = row.indexOf(`<svg viewBox="0 0 ${SPARK_BOX.w} ${H}"`);
    if (open === -1) {
      out.set(brand, []);
      continue;
    }
    const svg = row.slice(open, row.indexOf("</svg>", open));
    const pts: Array<[number, number]> = [];
    for (const m of svg.matchAll(/<polyline[^>]*points="([^"]+)"/g))
      for (const p of m[1].trim().split(/\s+/)) {
        const [x, y] = p.split(",").map(Number);
        pts.push([x, y]);
      }
    for (const m of svg.matchAll(/<circle[^>]*cx="([\d.]+)"[^>]*cy="([\d.]+)"/g)) pts.push([+m[1], +m[2]]);
    out.set(
      brand,
      pts.sort((a, b) => a[0] - b[0]).map(([, y]) => y),
    );
  }
  return out;
}

const amp = (ys: number[]) => Math.max(...ys) - Math.min(...ys);

describe("우선 노출도 추이 — 호출부 축 배선 (실렌더)", () => {
  const rows = sparkYByBrand(html());

  it("종전 매핑이 실제로 viewBox 밖을 찍었다 — 결함 재현(기준선)", () => {
    // 이 계산은 종전 호출부의 산술 그대로다. 고쳐진 값과 대조하기 위한 기준선.
    const worst = 23.9;
    const legacy = SERIES.Hyundai[1].map((v) => Math.round((H - PAD - ((H - 2 * PAD) * (worst + 1 - v)) / worst) * 100) / 100);
    expect(legacy).toEqual([21.71, 40.28, 25.1, 23.72]);
    expect(legacy[1]).toBeGreaterThan(BOTTOM); // 31.5 회차가 하단 밖
  });

  it("모든 행의 모든 점이 viewBox 안에 있다", () => {
    expect(rows.size).toBe(NAMES.length);
    for (const [brand, ys] of rows) {
      expect(ys, brand).toHaveLength(CYCLES.length);
      for (const y of ys) {
        expect(y, `${brand} y=${y}`).toBeGreaterThanOrEqual(TOP);
        expect(y, `${brand} y=${y}`).toBeLessThanOrEqual(BOTTOM);
      }
    }
  });

  it("순위가 좋아진 회차가 위에 온다 — invert 배선 가드", () => {
    // Hyundai: 16.7(최고) → 꼭대기, 31.5(최악) → 바닥. 배선이 빠져 0 기준 축으로
    // 돌아가면 방향이 뒤집혀 여기서 깨진다.
    const [y0, y1, y2, y3] = rows.get("Hyundai")!;
    expect(y0).toBe(TOP);
    expect(y1).toBe(BOTTOM);
    expect(y0).toBeLessThan(y2); // 16.7 이 19.4 보다 위
    expect(y3).toBeLessThan(y2); // 18.3 이 19.4 보다 위
    // Genesis 는 계속 나빠진다 → 단조 하강.
    const g = rows.get("Genesis")!;
    for (let i = 1; i < g.length; i++) expect(g[i]).toBeGreaterThan(g[i - 1]);
  });

  it("표 전체가 같은 축을 쓴다 — 행 간 진폭 차가 보존된다", () => {
    // 행마다 자기 범위로 정규화하면 **모든 행이** 30px 를 꽉 채워 구분이 사라진다.
    expect(amp(rows.get("Hyundai")!)).toBeCloseTo(H - 2 * PAD, 6); // 도메인 전폭(14.8위)
    expect(amp(rows.get("Kia")!)).toBeLessThan(3); // 0.7위 변동
    expect(amp(rows.get("Tesla")!)).toBeLessThan(3); // 0.6위 변동
    expect(amp(rows.get("Genesis")!)).toBeLessThan(3); // 0.9위 변동
    // 같은 값은 어느 행이든 같은 y — 축이 하나라는 직접 증거(Kia·Tesla 의 20.1/20.2 부근).
    const domainSpan = 31.5 - 16.7;
    const expected = (v: number) => PAD + ((v - 16.7) / domainSpan) * (H - 2 * PAD);
    expect(rows.get("Kia")![0]).toBeCloseTo(expected(20.1), 6);
    expect(rows.get("Tesla")![3]).toBeCloseTo(expected(20.0), 6);
  });
});
