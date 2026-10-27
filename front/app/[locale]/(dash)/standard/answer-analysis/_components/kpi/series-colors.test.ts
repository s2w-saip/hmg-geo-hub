import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SERIES_COLORS, seriesColor } from "./series-colors";

// 검증자 B5(2026-09-10) — **한 도넛 안에서 서로 다른 브랜드가 같은 색**으로 그려졌다.
// 원인은 `seriesColor(i) = SERIES_COLORS[i % 8]` 인데 색 인덱스가 표 행 순서(0~11)라,
// 라이브 행 구성(당사 3 + 경쟁사 9)에서 idx 3 과 idx 11 이 같은 색을 받는 것.
// 종전에는 경쟁사 조각이 1개뿐이라 구조적으로 드러나지 않았다(#4 수정으로 노출됨).
//
// 이 파일은 두 불변식을 잡는다.
//   1. 팔레트가 **표 행 상한만큼** 있다 — 순환이 한 화면 안에서 되돌아오지 않는다.
//   2. 이름이 아니라 **실제 색값**이 서로 다르다 — 토큰 두 개가 같은 hex 를 가리키면
//      배열 길이만 늘려도 화면에서는 여전히 겹치기 때문이다.

/** The competitor table's row cap (당사 포함): back/bff/screens/mention_view.py COMPETITOR_ROW_LIMIT. */
const COMPETITOR_ROW_LIMIT = 12;

const CSS = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

/** `@theme`/`:root` 의 `--name: value;` 를 전부 걷는다(첫 선언 = 라이트 기본값). */
const DECLS = new Map<string, string>();
for (const m of CSS.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
  if (!DECLS.has(m[1])) DECLS.set(m[1], m[2].trim());
}

/** `var(--a)` 사슬을 끝까지 따라가 최종 리터럴(hex)을 낸다. */
function resolve(value: string, depth = 0): string {
  const m = /^var\((--[a-z0-9-]+)\)$/.exec(value.trim());
  if (!m) return value.trim().toLowerCase();
  expect(depth).toBeLessThan(10);
  const next = DECLS.get(m[1]);
  expect(next, `${m[1]} 가 globals.css 에 없다`).toBeDefined();
  return resolve(next as string, depth + 1);
}

const RESOLVED = SERIES_COLORS.map((c) => resolve(c));

describe("SERIES_COLORS", () => {
  it("covers the competitor table's row cap so the cycle never wraps on one screen", () => {
    // 표는 당사 포함 최대 COMPETITOR_ROW_LIMIT 행이고, 색 인덱스가 곧 행 인덱스다.
    expect(SERIES_COLORS.length).toBeGreaterThanOrEqual(COMPETITOR_ROW_LIMIT);
  });

  it("keeps the original eight in place (다른 화면의 색이 흔들리면 안 된다)", () => {
    expect(SERIES_COLORS.slice(0, 8)).toEqual([
      "var(--color-series-1)",
      "var(--color-series-2)",
      "var(--color-series-3)",
      "var(--color-series-4)",
      "var(--color-series-5)",
      "var(--color-series-6)",
      "var(--color-series-7)",
      "var(--color-series-8)",
    ]);
  });

  it("resolves every entry to a real literal declared in globals.css", () => {
    for (const hex of RESOLVED) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("gives every row index its own colour — no two share a value", () => {
    // 이것이 결함 그 자체다: 수정 전 idx 3(Tesla)·idx 11(Volvo) 이 둘 다 #0d6e2f 였다.
    const byIndex = Array.from({ length: COMPETITOR_ROW_LIMIT }, (_, i) => resolve(seriesColor(i)));
    expect(new Set(byIndex).size).toBe(COMPETITOR_ROW_LIMIT);
    expect(new Set(RESOLVED).size).toBe(SERIES_COLORS.length);
  });

  it("still cycles for indices past the palette (배열 밖·음수도 안전)", () => {
    expect(seriesColor(SERIES_COLORS.length)).toBe(seriesColor(0));
    expect(seriesColor(-1)).toBe(SERIES_COLORS[SERIES_COLORS.length - 1]);
  });
});
