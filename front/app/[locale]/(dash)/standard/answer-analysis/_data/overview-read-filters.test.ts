import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { overviewReadFilters, normalizeFilters } from "@/lib/scope/server";
import { readStandardFilters } from "@/components/dash/standard-filters";
import type { StandardFilters } from "@/lib/scope/result-adapter";

// ════════════════════════════════════════════════════════════════════════════
// B1-a 차단 수리 — 두 화면이 **같은 인자**로 Overview 원천 read 를 부른다
// ════════════════════════════════════════════════════════════════════════════
//
// 종전 배선 가드는 소스 텍스트 grep 이라 "같은 함수를 **다른 인자**로 부르는" 결함을
// 구조적으로 못 봤다(독립 검증 B4). 그래서 여기서는 **실제 객체**를 만든다:
// 두 페이지가 쓰는 바로 그 파서(`readStandardFilters`)로 같은 URL 상태를 읽고,
// 각 페이지의 `cumulative` 식을 그대로 적용한 뒤, Overview 원천 read 에 실제로 넘어가는
// 인자(`overviewReadFilters` 의 반환)를 깊은 동등으로 비교한다.
//
// 왜 이것이 값 문제인가: `cumulative: true` + 스냅샷 모드는 게이트가 미지원 축으로 보고
// (`lib/summary/read/gate.ts`) 사실표를 포기한다. 그러면 언급 카드만 미러 스냅샷으로
// 떨어지는데, 미러 스냅샷에는 `in_full_cycle` 게이트가 없어 **모집단이 다르다**.

/** 대시보드 경로(읽기 계층의 Overview 원천)의 필터 구성 — `cumulative` 를 기간 유무로 가른다. */
function dashboardFilters(sp: Record<string, string | string[] | undefined>): StandardFilters {
  const raw = readStandardFilters(sp);
  return { ...raw, cumulative: Boolean(raw.dateFrom || raw.dateTo) };
}

/** 언급(`mention/page.tsx`)의 필터 구성 — `cumulative: true` **상시**. */
function mentionFilters(sp: Record<string, string | string[] | undefined>): StandardFilters {
  return { ...readStandardFilters(sp), cumulative: true };
}

const CASES: Array<[string, Record<string, string | string[] | undefined>]> = [
  ["기본(기간 미선택)", {}],
  ["브랜드 필터", { brand: "Hyundai" }],
  ["브랜드+지역+엔진", { brand: "Kia", region: "US", engine: "chatgpt" }],
  ["기간 선택(시작만)", { time: "2026-09-01.." }],
  ["기간 선택(양끝)", { time: "2026-09-01..2026-09-14" }],
];

describe("두 화면의 Overview 원천 read 인자가 깊은 동등이다", () => {
  for (const [name, sp] of CASES) {
    it(`${name} — 인자 객체가 같다`, () => {
      const mention = overviewReadFilters(mentionFilters(sp));
      const dashboard = overviewReadFilters(dashboardFilters(sp));
      expect(mention).toEqual(dashboard);
    });

    it(`${name} — 캐시 키까지 같다 (한 요청에서 중복 제거)`, () => {
      const a = normalizeFilters(overviewReadFilters(mentionFilters(sp)));
      const b = normalizeFilters(overviewReadFilters(dashboardFilters(sp)));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  }

  it("수리 전이었다면 기본 화면에서 갈렸다 (이 테스트가 공허하지 않다는 증거)", () => {
    const sp = {};
    // 정규화를 **안 거치면** 두 인자는 다르다 — `cumulative` 축 하나로.
    expect(mentionFilters(sp)).not.toEqual(dashboardFilters(sp));
    expect(JSON.stringify(normalizeFilters(mentionFilters(sp)))).not.toBe(
      JSON.stringify(normalizeFilters(dashboardFilters(sp))),
    );
  });

  it("기간을 고르면 두 화면이 원래 같았다 (정규화가 그 경우를 안 건드린다)", () => {
    const sp = { time: "2026-09-01..2026-09-14" };
    expect(overviewReadFilters(mentionFilters(sp))).toEqual(mentionFilters(sp));
  });

  it("값이 이미 같으면 **같은 객체**를 돌려준다 (dedup 키가 안 갈린다)", () => {
    const f = dashboardFilters({});
    expect(overviewReadFilters(f)).toBe(f);
  });
});

describe("Overview 원천 밖 read 는 누적 의미론 그대로다", () => {
  it("정규화는 노출률 두 read 에만 걸린다", () => {
    const SERVER = readFileSync(
      fileURLToPath(new URL("../../../../../../lib/scope/server.ts", import.meta.url)),
      "utf8",
    );
    // 호출부는 다섯: 카드(`withOverviewCards`)·추이(`withOverviewSlots`)·
    // 우선 노출도(`withOverviewFirstPosition` 은 한 번 정규화해 둘 다 쓴다)·
    // 경쟁사 값 인자(`competitorValueReadArgs`, 2026-09-20 — 두 화면이 이것으로 인자를
    // 만든다)· **카드 Δ 통로**(`fetchStandardOverviewCardDelta`, 2026-09-20 — 인용
    // 상세의 공식(당사) Δ 가 Overview 와 같은 입력을 읽는다).
    expect((SERVER.match(/overviewReadFilters\(filters\)/g) ?? []).length).toBe(5);
    expect(SERVER).toContain("fetchStandardAggregates(overviewReadFilters(filters))");
    // 추이·Δ 는 정규화를 한 번 해서 **두 배열**을 만든다(N2).
    // 세 번째는 카드 Δ 통로다 — Δ 배열 하나만 만든다(주 배열은 안 읽는다).
    expect((SERVER.match(/const f = overviewReadFilters\(filters\);/g) ?? []).length).toBe(3);
    expect((SERVER.match(/fetchStandardTrend\(f, "week"\)/g) ?? []).length).toBe(2);
    expect(
      (SERVER.match(/fetchStandardTrend\(deltaTrendFilters\(f\), DELTA_TREND_BUCKET\)/g) ?? []).length,
    ).toBe(3);
  });

  it("언급 화면은 여전히 `cumulative: true` 를 만든다 (다른 지표용, back/bff/screens/mention_data.py)", () => {
    const SCREEN = readFileSync(
      fileURLToPath(new URL("../../../../../../../back/bff/screens/mention_data.py", import.meta.url)),
      "utf8",
    );
    expect(SCREEN).toContain('filters = {**read_standard_filters(sp, scope), "cumulative": True}');
  });
});
