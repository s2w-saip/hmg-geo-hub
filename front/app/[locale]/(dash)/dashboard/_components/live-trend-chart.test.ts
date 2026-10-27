import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatTrendTooltipValue, trendBucketLabelFormatter } from "./live-trend-chart";

// Hydration 결정론 회귀 테스트 (React #418, 2026-07-22).
//
// X축 라벨은 SSR HTML에 텍스트로 들어간다. 화면(website/trend)이 보낸 행 날짜(YYYY-MM-DD)는
// `new Date(day)` 로 UTC 자정이 되므로, 포매터의 timeZone을 고정하지 않으면 서버(UTC)가 만든
// HTML과 브라우저(뷰어 TZ)의 hydration 렌더가 다른 날짜를 찍는다(UTC-음수 시간대에서 하루 앞).
// 어느 비-UTC TZ에서 테스트를 돌려도, 라벨이 그 날짜와 다르면 실패한다. 어떤 날짜를 라벨로
// 쓰는가(귀속 날짜·앵커의 KST 일·같은 날 충돌)는 화면(back/bff/screens/overview.py)이 정한다.
const utcLabel = (iso: string) =>
  new Intl.DateTimeFormat("ko", {
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));

describe("LiveTrendChartView 라벨 결정론", () => {
  it("행 날짜 라벨이 프로세스 TZ와 무관하게 그 날짜다", () => {
    const fmt = trendBucketLabelFormatter("ko");
    for (const day of ["2026-07-13", "2026-07-20", "2026-09-11"]) {
      expect(fmt.format(new Date(day))).toBe(utcLabel(`${day}T00:00:00Z`));
    }
  });

  it("하루 밀린 표기가 나오지 않는다", () => {
    const fmt = trendBucketLabelFormatter("ko");
    const label = fmt.format(new Date("2026-07-20"));
    expect(label).not.toBe(utcLabel("2026-07-19T00:00:00Z"));
    expect(label).not.toBe(utcLabel("2026-07-21T00:00:00Z"));
  });

  it("뷰는 행 날짜를 이 포매터로만 찍는다 (라벨 규칙을 다시 계산하지 않는다)", () => {
    const src = readFileSync(fileURLToPath(new URL("./live-trend-chart.tsx", import.meta.url)), "utf8");
    expect(src).toContain("label: fmt.format(new Date(r.day))");
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
