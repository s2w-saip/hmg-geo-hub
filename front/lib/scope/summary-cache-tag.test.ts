/**
 * 사실표(summary_*) 캐시 셀이 **`SUMMARY_TAG` 를 실제로 달고 있는가** — 배선 가드.
 *
 * T10 은 내부 라우트(`/api/internal/summary/published`)가 `revalidateTag(SUMMARY_TAG)`
 * 를 부르는 것까지만 검증했다. 그런데 그 시점에 **그 태그를 단 캐시 셀이 하나도 없었다** —
 * 사실표 셀도 `MIRROR_AGGREGATE_TAG` 하나만 달고 있어서, 러너의 무효화가 "미러 태그가
 * 함께 죽는 덕에" 결과적으로 동작했을 뿐 계약은 배선돼 있지 않았다. 나중에 사실표 캐시를
 * 미러와 분리하는 순간(설계상 예정된 변경) 러너의 무효화가 조용히 아무것도 안 하게 된다.
 *
 * 왜 소스 검사인가: `mirrorCache` 는 모듈 사설이고 `lazyCache` 로 감싸여 있어
 * `unstable_cache` 가 **첫 호출 때** 불린다. 태그를 실행으로 관찰하려면 게이트웨이 전체
 * (인증·프로젝트 스코프·DB)를 태워야 한다. 배선 여부는 소스가 정본이므로 소스를 본다
 * (`summary.tenant-boundary.test.ts` 와 같은 자세).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(fileURLToPath(new URL("./server.ts", import.meta.url)), "utf8");

/** `mirrorCache("<key>", …)` 호출 하나를 괄호 균형으로 잘라 낸다. */
function callBody(key: string): string {
  const marker = `mirrorCache("${key}",`;
  const i = SRC.indexOf(marker);
  expect(i, `mirrorCache("${key}") 호출을 찾지 못했다`).toBeGreaterThan(-1);
  let depth = 0;
  for (let n = i + "mirrorCache".length; n < SRC.length; n += 1) {
    if (SRC[n] === "(") depth += 1;
    else if (SRC[n] === ")") {
      depth -= 1;
      if (depth === 0) return SRC.slice(i, n + 1);
    }
  }
  throw new Error(`mirrorCache("${key}") 의 괄호가 안 닫힌다`);
}

const SUMMARY_KEYS = [...SRC.matchAll(/mirrorCache\("(summary-[a-z-]+)"/g)].map((m) => m[1]);

describe("사실표 캐시 셀의 SUMMARY_TAG 배선", () => {
  it("mirrorCache 가 extraTags 를 tags 에 펼친다", () => {
    expect(SRC).toMatch(/extraTags: readonly string\[\] = \[\]/);
    expect(SRC).toContain("tags: [MIRROR_AGGREGATE_TAG, ...extraTags]");
  });

  it("SUMMARY_TAG 를 단 캐시 셀이 하나 이상 있다", () => {
    const tagged = SUMMARY_KEYS.filter((k) => callBody(k).includes("[SUMMARY_TAG]"));
    expect(tagged.length).toBeGreaterThanOrEqual(1);
  });

  it("사실표 셀은 전부 SUMMARY_TAG 를 단다 (새 셀이 배선을 빠뜨리면 여기서 걸린다)", () => {
    // 셀 수 자체는 고정하지 않는다 — 화면이 늘면 셀도 는다. 고정하는 것은 "빠진 게 없다".
    // 하한이 11 → 10 으로 내려간 이유(PR② T6 라운드 2): S1 카드와 GEO 가 셀 둘을 쓰다가
    // **한 셀**(`summary-global-trend-s1`)을 공유하게 됐다 — 같은 3문장의 서로 다른
    // grouping set 을 나눠 쓰므로 셀을 나누면 `summary_trend_brands` 를 두 번 스캔한다.
    // 하한은 "정규식이 깨져 0개가 되는 것" 을 막는 바닥이지 셀 수 계약이 아니다.
    expect(SUMMARY_KEYS.length).toBeGreaterThanOrEqual(9); // T5·T6 라운드 2 가 카드+GEO 셀을 각각 합쳐 11→9. 하한은 정규식 붕괴(0개) 방지용이지 셀 수 계약이 아니다.
    const missing = SUMMARY_KEYS.filter((k) => !callBody(k).includes("[SUMMARY_TAG]"));
    expect(missing, `SUMMARY_TAG 미배선 셀: ${missing.join(", ")}`).toEqual([]);
  });

  it("미러 태그는 그대로 남는다 (사실표 셀도 미러 싱크로 함께 죽어야 한다)", () => {
    for (const k of SUMMARY_KEYS) expect(callBody(k)).not.toContain("MIRROR_AGGREGATE_TAG");
    // 개별 셀이 미러 태그를 다시 적지 않는 이유 = mirrorCache 가 항상 붙이기 때문.
    expect(SRC).toContain("tags: [MIRROR_AGGREGATE_TAG, ...extraTags]");
  });
});
