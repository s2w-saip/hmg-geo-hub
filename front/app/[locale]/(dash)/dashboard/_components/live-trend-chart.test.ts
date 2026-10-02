import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatTrendTooltipValue,
  trendBucketLabel,
  trendBucketLabelFormatter,
} from "./live-trend-chart";
import type { LiveTrend, LiveTrendPoint } from "../_data/live";

// Hydration 결정론 회귀 테스트 (React #418, 2026-07-22).
//
// X축 라벨은 SSR HTML에 텍스트로 들어간다. firstAt은 풀 타임스탬프
// (min(measured_at))라, 포매터의 timeZone을 고정하지 않으면 서버(UTC)가 만든
// HTML과 브라우저(뷰어 TZ)의 hydration 렌더가 서로 다른 날짜를 찍는다.
// 두 픽스처는 실측 패턴을 재현한다:
//   · 00:05 UTC — UTC-음수 시간대(미주)에서 하루 앞으로 밀림
//   · 20:30 UTC — UTC+9(KST) 등에서 하루 뒤로 밀림
// → 어느 비-UTC TZ에서 테스트를 돌려도, 라벨이 UTC 달력 날짜와 다르면 실패한다.
// (2026-09-03 커버리지 범례 제거로 라벨이 recharts 축에만 남아, 렌더 대신 라벨
// 헬퍼를 직접 검증한다.)
const points: LiveTrend["points"] = [
  {
    bucketStart: "2026-07-13",
    firstAt: "2026-07-13T20:30:00.000Z",
    values: { visibility: 10 },
    measuredDays: 2,
    answers: 5,
    lastAt: "2026-07-14T00:00:00.000Z",
  },
  {
    bucketStart: "2026-07-20",
    firstAt: "2026-07-20T00:05:09.643Z",
    values: { visibility: 12 },
    measuredDays: 1,
    answers: 3,
    lastAt: "2026-07-20T01:00:00.000Z",
  },
];

const utcLabel = (iso: string) =>
  new Intl.DateTimeFormat("ko", {
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));

describe("LiveTrendChart 라벨 결정론", () => {
  it("주 버킷 라벨이 프로세스 TZ와 무관하게 firstAt 의 UTC 달력 날짜다", () => {
    const fmt = trendBucketLabelFormatter("ko");
    for (const p of points) {
      expect(trendBucketLabel(fmt, p, "week")).toBe(utcLabel(p.firstAt!));
    }
  });

  it("서로 다른 TZ 표기(하루 밀림)가 나오지 않는다", () => {
    const fmt = trendBucketLabelFormatter("ko");
    const labels = points.map((p) => trendBucketLabel(fmt, p, "week"));
    // 20:30Z가 +TZ에서 밀리면 7.14, 00:05Z가 -TZ에서 밀리면 7.19가 나온다.
    for (const iso of ["2026-07-14T00:00:00Z", "2026-07-19T00:00:00Z"]) {
      expect(labels).not.toContain(utcLabel(iso));
    }
  });

  it("일 버킷 라벨은 bucketStart 를 쓴다", () => {
    const fmt = trendBucketLabelFormatter("ko");
    expect(trendBucketLabel(fmt, points[0], "day")).toBe(
      utcLabel("2026-07-13T00:00:00Z"),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 앵커 축 라벨 (2026-09-20 프리뷰 관찰)
// ════════════════════════════════════════════════════════════════════════════
//
// 축 on 에서 버킷 키는 귀속 날짜(`round_date`/`anchor_week`)인데 라벨만 `firstAt`
// (그 버킷의 첫 측정 시각)에 머물러 있었다. 실제로 나온 것:
//   · website x축이 목·월·화가 섞인 **측정 시작일**로 찍혔다
//   · 두 버킷의 첫 측정일이 같은 날이면 **같은 라벨이 두 번**(`7. 27.` × 2)
//   · 마지막 점 라벨이 카드 기준일과 달랐다(09-17 vs 09-11)
//
// 기대값은 손계산이다. 달력 사실(2026): 07-24 금 · 07-31 금 · 09-11 금 · 09-14 월.
describe("축 on — x축 라벨은 버킷 키(귀속 날짜)다", () => {
  const fmt = trendBucketLabelFormatter("ko");
  /** 관찰된 website 추이를 만든 모양: 귀속은 금요일인데 측정은 며칠 전에 시작한다. */
  const web: LiveTrendPoint[] = [
    { bucketStart: "2026-07-24", firstAt: "2026-07-27T01:00:00.000Z", values: {}, measuredDays: 1, answers: 1, lastAt: null },
    { bucketStart: "2026-07-31", firstAt: "2026-07-27T22:00:00.000Z", values: {}, measuredDays: 1, answers: 1, lastAt: null },
    { bucketStart: "2026-09-11", firstAt: "2026-09-17T02:00:00.000Z", values: {}, measuredDays: 1, answers: 1, lastAt: null },
  ];

  it("축 on 이면 라벨이 `bucketStart` 다 (금요일 격자)", () => {
    expect(web.map((p) => trendBucketLabel(fmt, p, "week", "anchor"))).toEqual([
      utcLabel("2026-07-24T00:00:00Z"),
      utcLabel("2026-07-31T00:00:00Z"),
      utcLabel("2026-09-11T00:00:00Z"),
    ]);
  });

  it("축 on 이면 라벨 **중복이 사라진다** (관찰된 `7. 27.` × 2)", () => {
    const off = web.map((p) => trendBucketLabel(fmt, p, "week"));
    // 종전(축 off 규칙): 첫 두 점이 같은 날(07-27)이라 라벨이 겹친다 = 관찰된 결함.
    expect(off[0]).toBe(off[1]);
    const on = web.map((p) => trendBucketLabel(fmt, p, "week", "anchor"));
    expect(new Set(on).size).toBe(on.length);
  });

  it("마지막 점 라벨이 기준일과 같다 (측정 시작일이 아니다)", () => {
    const last = web[web.length - 1];
    expect(trendBucketLabel(fmt, last, "week", "anchor")).toBe(
      utcLabel("2026-09-11T00:00:00Z"),
    );
    // 종전에는 09-17(목)이 나왔다.
    expect(trendBucketLabel(fmt, last, "week")).toBe(utcLabel("2026-09-17T00:00:00Z"));
  });

  it("글로벌: 귀속이 같은 두 회차가 한 점으로 접히면 라벨도 하나다", () => {
    const merged: LiveTrendPoint = {
      bucketStart: "2026-08-24",
      // 접힌 뒤 `firstAt` 은 대표 앵커라 화요일(08-25)일 수 있다 — 관찰된 `8. 25.`.
      firstAt: "2026-08-25T12:50:00.000Z",
      values: {}, measuredDays: 1, answers: 1, lastAt: null,
    };
    expect(trendBucketLabel(fmt, merged, "week", "anchor")).toBe(
      utcLabel("2026-08-24T00:00:00Z"),
    );
  });

  it("축 off·미지정은 **한 글자도** 안 바뀐다", () => {
    for (const axis of [undefined, "measured" as const]) {
      expect(web.map((p) => trendBucketLabel(fmt, p, "week", axis))).toEqual(
        web.map((p) => trendBucketLabel(fmt, p, "week")),
      );
    }
  });

  it("일 버킷은 축과 무관하게 `bucketStart` 다", () => {
    expect(trendBucketLabel(fmt, web[0], "day", "anchor")).toBe(
      trendBucketLabel(fmt, web[0], "day"),
    );
  });
});

// ── 라벨은 버킷 키가 아니라 **귀속 날짜**다 (2026-09-20 결정 (b)) ───────────
//
// 미러 추이의 버킷 키는 주(`ca.anchor_week`, 월요일)인데 website 회차의 귀속 날짜는
// **금요일**이다. 달력에서 고르는 날짜·카드 기준일·추이 라벨이 같아야 하므로 라벨은
// 귀속 날짜다. 글로벌은 귀속이 월요일이라 버킷 키와 같다.
//
// 손계산: 2026-09-07 월 · 2026-09-11 금 · 2026-09-14 월.
describe("축 on 주 라벨 = 그 버킷의 귀속 날짜", () => {
  const fmt = trendBucketLabelFormatter("ko");
  const pt = (bucketStart: string, roundDate?: string): LiveTrendPoint => ({
    bucketStart,
    ...(roundDate ? { roundDate } : {}),
    firstAt: "2026-09-17T02:00:00.000Z",
    values: {}, measuredDays: 1, answers: 1, lastAt: null,
  });

  it("website(금요일 귀속): 버킷 09-07 인데 라벨은 **09-11**", () => {
    expect(trendBucketLabel(fmt, pt("2026-09-07", "2026-09-11"), "week", "anchor")).toBe(
      utcLabel("2026-09-11T00:00:00Z"),
    );
  });

  it("글로벌(월요일 귀속): 버킷과 라벨이 같다", () => {
    expect(trendBucketLabel(fmt, pt("2026-09-14", "2026-09-14"), "week", "anchor")).toBe(
      utcLabel("2026-09-14T00:00:00Z"),
    );
  });

  it("귀속 날짜가 없으면 버킷 키로 떨어진다 (안전망)", () => {
    expect(trendBucketLabel(fmt, pt("2026-09-14"), "week", "anchor")).toBe(
      utcLabel("2026-09-14T00:00:00Z"),
    );
  });

  it("축 off 는 `roundDate` 가 실려 있어도 **안 쓴다**", () => {
    expect(trendBucketLabel(fmt, pt("2026-09-07", "2026-09-11"), "week")).toBe(
      utcLabel("2026-09-17T00:00:00Z"),
    );
  });
});

describe("LiveTrendChart 회차 버킷 라벨 — 앵커의 KST 일(2026-09-28)", () => {
  const cyclePoint = (bucketStart: string, anchor: string): LiveTrend["points"][number] => ({
    bucketStart,
    firstAt: anchor,
    values: { visibility: 10 },
    measuredDays: 1,
    answers: 5,
    lastAt: anchor,
    cycleAnchorAt: anchor,
  });

  it("KST 자정 직후 앵커(…T15:48Z)는 다음 날로 — firstAt(UTC) 이 아니라 앵커의 KST 일", () => {
    const fmt = trendBucketLabelFormatter("ko");
    const p = cyclePoint("2026-09-13", "2026-09-13T15:48:44.276Z");
    expect(trendBucketLabel(fmt, p, "week")).toBe(utcLabel("2026-09-14T00:00:00Z"));
    expect(trendBucketLabel(fmt, p, "day")).toBe(utcLabel("2026-09-14T00:00:00Z"));
  });

  it("KST 자정 전 앵커(01:10Z)는 종전과 같은 날", () => {
    const fmt = trendBucketLabelFormatter("ko");
    const p = cyclePoint("2026-09-08", "2026-09-08T01:10:00.000Z");
    expect(trendBucketLabel(fmt, p, "week")).toBe(utcLabel("2026-09-08T00:00:00Z"));
  });

  it("같은 KST 날 충돌이면 표시값의 시각을 붙여 x 범주가 겹치지 않는다", () => {
    const fmt = trendBucketLabelFormatter("ko");
    const a = cyclePoint("2026-09-13", "2026-09-13T15:48:44.000Z");
    const b = cyclePoint("2026-09-14", "2026-09-14T03:00:00.000Z");
    const la = trendBucketLabel(fmt, a, "week", undefined, { day: "2026-09-14", time: "00:48" });
    const lb = trendBucketLabel(fmt, b, "week", undefined, { day: "2026-09-14", time: "12:00" });
    expect(la).toBe(`${utcLabel("2026-09-14T00:00:00Z")} 00:48`);
    expect(lb).toBe(`${utcLabel("2026-09-14T00:00:00Z")} 12:00`);
    expect(la).not.toBe(lb);
  });
});

describe("LiveTrendChart 툴팁 단위", () => {
  it("% 축 KPI 에는 % 를 붙이고 순위 축은 그대로다", () => {
    expect(formatTrendTooltipValue(12.3, "visibility")).toBe("12.3%");
    expect(formatTrendTooltipValue(45, "citationShare")).toBe("45%");
    expect(formatTrendTooltipValue(2.4, "position")).toBe("2.4");
  });

  it("숫자가 아니면 그대로 문자열화한다", () => {
    expect(formatTrendTooltipValue(undefined, "visibility")).toBe("");
    expect(formatTrendTooltipValue("n/a", "visibility")).toBe("n/a");
  });
});

// 잘림 회귀 가드 (2026-09-04 고객 리포트 "추이 그래프가 잘려서 보인다").
//
// recharts 의 LineChart margin 은 플롯 영역을 컨테이너 안쪽으로 들이는 값이라
// **음수를 주면 컨테이너 밖으로 밀려 잘린다**. 종전 left/right = -8 은 헤들리스
// 크롬 실측(recharts 3.8.1, 동일 축 설정 A/B)에서 두 가지를 잘랐다:
//   · 세로 축 라벨 "%" 가 1~2px 조각으로 남았다.
//   · **마지막 버킷의 데이터 포인트(dot)가 통째로 사라졌다** — 선만 오른쪽 끝으로
//     흘러가 그 회차에 측정이 없는 것처럼 보인다(가장 최근 회차라 오독이 크다).
// right 0 은 dot 이 절반만 잘려 여전히 부족했고, right 12 에서 둘 다 온전해진다.
//
// "픽셀이 맞는가"는 코드로 볼 수 없지만 **"음수로 되돌아갔는가"는 볼 수 있다** —
// 잘림의 필요조건이므로 그것만 고정한다.
describe("추이 차트 여백 — 음수 마진 금지", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./live-trend-chart.tsx", import.meta.url)),
    "utf8",
  );
  const margin = src.match(/<LineChart[^>]*margin=\{\{([^}]*)\}\}/)?.[1];

  it("LineChart 에 margin 이 지정돼 있다", () => {
    expect(margin).toBeDefined();
  });

  it("left/right 가 음수가 아니다 (플롯이 컨테이너 밖으로 나가지 않는다)", () => {
    const val = (k: string) => Number(margin!.match(new RegExp(`${k}:\\s*(-?\\d+)`))?.[1]);
    expect(val("left")).toBeGreaterThanOrEqual(0);
    expect(val("right")).toBeGreaterThanOrEqual(0);
  });

  it("마지막 버킷 dot 이 온전하려면 right 여백이 필요하다 (실측 최소 12)", () => {
    const right = Number(margin!.match(/right:\s*(-?\d+)/)?.[1]);
    expect(right).toBeGreaterThanOrEqual(12);
  });
});
