import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { planTrendRead } from "@/lib/db/repositories/summary-trend-aggregates";

// ── 폴백 목적지 회귀 가드 (T11 기준 6) ──────────────────────────────────────
//
// PR② 는 카드를 집계층으로 옮기면서 **폴백 목적지도 미러로** 바꿨다. 같은 화면의
// 형제 위젯(주제 도넛·GEO 경쟁)은 세부층에 남아 있어, 집계층이 거부하는 축에서
// 한 화면에 두 원천이 섞였다(실측: 카드 모수 3,080(미러) vs 형제 30,606 언급 기준
// 세부층 2,992). 규칙은 이것이다:
//
//   집계층만 거부(`agg-*`)  → **세부층 사실표**   (PR② 이전 경로)
//   게이트가 거부(`gate-*`) → **미러**            (사실표도 못 읽는 상태)
//
// 값 대조는 실DB 하네스가 한다. 여기서는 **배선이 그 모양인지**를 고정한다 —
// 소스에서 `agg-*` 판정 뒤에 `onMirror` 로 빠지는 경로가 없어야 한다.

const src = readFileSync(
  fileURLToPath(new URL("./server.ts", import.meta.url)),
  "utf8",
);

/** `viaX` 함수 본문만 잘라낸다(다음 최상위 선언 전까지). */
function bodyOf(name: string): string {
  const i = src.indexOf(`async function ${name}<T>(`);
  expect(i, name).toBeGreaterThan(0);
  const j = src.indexOf("\n}\n", i);
  return src.slice(i, j);
}

describe("집계층 게이트는 `agg-*` 를 세부층으로 보낸다", () => {
  for (const fn of ["viaTrend", "viaGlobalS1", "viaGlobalTrend"]) {
    it(`${fn} — onDetail 인자를 받고, agg 판정 분기가 detail() 로 간다`, () => {
      const body = bodyOf(fn);
      // ① 세부층 목적지 인자가 있다.
      expect(body, fn).toMatch(/onDetail:/);
      // ② `planTrendRead` 거부·접힘 미실행·`empty` 세 분기가 전부 detail() 로 간다.
      const branches = [...body.matchAll(/fallback:[^`]*`\);\n\s*return (\w+)\(\)/g)]
        .map((m) => m[1]);
      expect(branches.length, `${fn} 폴백 분기 수`).toBeGreaterThanOrEqual(2);
      expect(branches.every((b) => b === "detail"), `${fn} → ${branches.join(",")}`).toBe(true);
    });
  }

  it("게이트 거부(회차·화면·cumulative)만 미러로 간다", () => {
    for (const fn of ["viaTrend", "viaGlobalS1", "viaGlobalTrend"]) {
      const body = bodyOf(fn);
      // route 가 summary 가 아닐 때(= 게이트 거부)만 onMirror.
      expect(body, fn).toMatch(/route\.path !== "summary"[\s\S]{0,40}return onMirror\(\)/);
    }
  });
});

// ── 호출부 인자까지 본다 (PR③, 2026-09-10) ─────────────────────────────────
//
// 위 두 describe 는 **게이트 본문**만 본다. 그래서 T11 재검이 남긴 사각이 그대로였다:
// 게이트가 `onDetail` 을 아무리 옳게 부르더라도, 호출부가 그 자리에 **미러를 넘기면**
// 결과는 종전 결함(형제 위젯과 원천이 갈린다)과 같다. 실제로 그런 호출부가 셋 있고,
// 셋 다 "세부층 쌍둥이가 없다"는 이유가 코드 주석에 적혀 있다. 그 셋을 **명시 허용
// 목록**으로 고정한다 — 넷째가 생기면 이 테스트가 먼저 깨진다.
const DETAIL_ARG_INDEX: Record<string, number> = {
  // viaTrend(ids, f, screen, onSummary, onDetail, onMirror)
  viaTrend: 4,
  // viaGlobalS1(f, pick, onDetail, onMirror)
  viaGlobalS1: 2,
  // viaGlobalTrend(f, screen, read, onDetail, onMirror)
  viaGlobalTrend: 3,
};

/**
 * `agg-*` 폴백을 **미러**로 보내는 것이 의도인 호출부. 셋 다 PR② 에서 새로 생겨
 * 세부층 쌍둥이가 없다(주석이 그 사유를 적고 있다) — 형제 위젯 혼합 문제도 없다:
 * 종전 목적지가 이미 미러였거나(④ GEO), 오늘 이 경로를 타는 화면이 없다(도메인 롤업 2종).
 */
const MIRROR_DETAIL_ALLOWED = new Set([
  "fetchStandardGeoKpi",
  "fetchStandardCitationDomains",
  "fetchWebsiteCitationDomains",
  // PR④ B1 — 경쟁사 행. 세부층 `StandardAggregates.brands` 는 `name`·`mentionCount`·
  // `answerCount`·`isTracked` 넷뿐이라 점유율·우선노출도·감정을 못 낸다(= 쌍둥이 부재).
  // 형제 위젯 혼합도 없다: 이 행의 종전 목적지가 이미 미러였다.
  "fetchStandardCompetitorBrands",
]);

/** 최상위 콤마로 인자를 가른다(괄호·중괄호·대괄호·문자열·템플릿 안의 콤마는 무시). */
function splitArgs(src: string, open: number): { args: string[]; end: number } {
  const args: string[] = [];
  let depth = 0, start = open + 1, i = open + 1;
  let quote: string | null = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      if (ch === ")" && depth === 0) { args.push(src.slice(start, i)); return { args, end: i }; }
      depth--;
    } else if (ch === "," && depth === 0) { args.push(src.slice(start, i)); start = i + 1; }
  }
  throw new Error("괄호가 닫히지 않았다");
}

/**
 * 주석을 지운다 — **판정 전에 반드시 거친다**(2026-09-11 검증 F3).
 *
 * `splitArgs` 가 잘라 주는 인자 문자열에는 그 앞줄 주석이 딸려 온다. 그대로
 * `/Detail\b/` 로 판정하면 **주석 속 낱말**이 통과시킨다 — 실증: `onDetail` 자리에
 * 미러를 넘기면서 바로 위에 `// … Detail 쌍둥이 …` 라고 적기만 해도 가드가 침묵했고,
 * 현행 `fetchWebsiteCitationDomains` 의 추출값은 **주석 문자열 자체**였다.
 * 가드가 코드를 보는지 주석을 보는지는 이 한 줄이 가른다.
 */
function stripComments(text: string): string {
  return text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
}

/** `onDetail` 자리의 인자가 **세부층 목적지**인가 — 주석을 지운 코드만 본다. */
function isDetailDestination(arg: string): boolean {
  return /Detail\b/.test(stripComments(arg));
}

/** 이 오프셋을 감싸는 최상위 선언 이름(= 페처). */
function enclosingFetcher(offset: number): string {
  const head = src.slice(0, offset);
  const m = [...head.matchAll(/^(?:export )?(?:async function|const) (\w+)/gm)].pop();
  return m?.[1] ?? "(unknown)";
}

describe("호출부가 `onDetail` 자리에 넘기는 것", () => {
  it("세부층이 아닌 것을 넘기는 호출부는 허용 목록에 있는 것뿐이다", () => {
    const seen: Array<{ fn: string; caller: string; arg: string }> = [];
    for (const [gate, idx] of Object.entries(DETAIL_ARG_INDEX)) {
      // 선언(`async function viaX<T>(`)이 아니라 **호출**만 고른다.
      const re = new RegExp(`(?<!function )\\b${gate}(?:<[^(]*>)?\\(`, "g");
      for (const m of src.matchAll(re)) {
        const open = m.index + m[0].length - 1;
        const { args } = splitArgs(src, open);
        expect(args.length, `${gate} 인자 수 (${enclosingFetcher(m.index)})`).toBeGreaterThan(idx);
        seen.push({
          fn: gate,
          caller: enclosingFetcher(m.index),
          arg: stripComments(args[idx]).trim(),
        });
      }
    }
    // 게이트 3종의 호출부가 실제로 잡혔는지 — 정규식이 조용히 0건이 되면 가드가 죽는다.
    expect(seen.length, "게이트 호출부 수").toBeGreaterThanOrEqual(8);
    expect(new Set(seen.map((s) => s.fn))).toEqual(new Set(Object.keys(DETAIL_ARG_INDEX)));

    const offenders = seen.filter((s) => !isDetailDestination(s.arg));
    expect(
      new Set(offenders.map((o) => o.caller)),
      `세부층이 아닌 목적지: ${offenders.map((o) => `${o.caller}→${o.arg.slice(0, 60)}`).join(" | ")}`,
    ).toEqual(MIRROR_DETAIL_ALLOWED);
  });

  it("허용 목록의 이름이 전부 실재한다(목록이 썩지 않게)", () => {
    for (const name of MIRROR_DETAIL_ALLOWED) {
      expect(src, name).toMatch(new RegExp(`function ${name}\\(`));
    }
  });

  // ── 가드 자신의 음성 대조 (F3) ──────────────────────────────────────────
  // 위 판정이 **주석이 아니라 코드**를 보는지 확인한다. 이게 없으면 가드는 통과하는데
  // 실제로는 미러를 넘기는 배선이 그대로 머지된다(검증자가 실증한 우회).
  it("주석 속 `Detail` 은 통과시키지 않는다 — 코드만 본다", () => {
    expect(isDetailDestination("cachedSummaryWebsiteSubKpisDetail")).toBe(true);
    // 우회 형태 그대로: 주석에는 Detail, 코드에는 미러.
    expect(isDetailDestination(
      "\n      // 세부층 Detail 쌍둥이가 없으므로 미러로 간다\n      () => cachedWebsiteSubKpis(ids, f)",
    )).toBe(false);
    expect(isDetailDestination("/* Detail */ () => cachedWebsiteCitations(ids, f)")).toBe(false);
    // 주석이 붙어 있어도 **코드가 세부층이면** 통과한다(과잉 차단 방지).
    expect(isDetailDestination(
      "\n      // 미러가 아니라 세부층이다\n      cachedSummaryGlobalSourceCompositionDetail",
    )).toBe(true);
  });
});

describe("무엇이 `agg-*` 인가 — 리더가 내는 사유(값 판정의 단일 출처)", () => {
  it("depth2·depth3·own_variant 밖 셋뿐이고, 전부 세부층 목적지다", () => {
    const p = (f: Parameters<typeof planTrendRead>[0]["filters"]) =>
      planTrendRead({ surface: "global", filters: f });
    expect(p({ depth2: ["x"] })).toEqual({ ok: false, reason: "unsupported-agg:depth2" });
    expect(p({ depth3: ["x"] })).toEqual({ ok: false, reason: "unsupported-agg:depth3" });
    expect(p({ brand: ["Hyundai", "Kia"] })).toEqual({
      ok: false, reason: "unsupported-agg:own-variant",
    });
    // 기본 경로는 통과 — 폴백 목적지 논의가 정상 화면에 영향을 주지 않는다.
    expect(p({}).ok).toBe(true);
    expect(p({ region: ["KR"] }).ok).toBe(true);
  });
});
