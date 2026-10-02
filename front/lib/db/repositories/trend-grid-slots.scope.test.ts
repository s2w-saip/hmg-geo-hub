import { describe, expect, it } from "vitest";
import { trendGridSlotRows } from "./trend-grid-slots";

// ════════════════════════════════════════════════════════════════════════════
// `[]` 와 `null` 의 어휘 (검증 C3, 2026-09-20)
// ════════════════════════════════════════════════════════════════════════════
//
//   `[]`   = **원장이 답했다** — "이 창에 자리가 없다". 축도 비어야 한다.
//   `null` = **판정 불가** — 문장을 돌리지 않았거나 실패했다. 종전 경로로 간다.
//
// 스코프를 못 만든 경우(유효 uuid 0개)는 문장을 돌리지도 않은 것이라 뒤쪽이다. 초판은
// `[]` 를 냈는데, 그러면 scope 미연결 프로젝트(`gapProjectIds` 가 빈 배열)의 추이가
// **통째로 빈다**(`applyTrendGridToBuckets` → `[]` → `getLiveTrendImpl` 이 null → 차트 없음).
// 바로 아래 `maxDays` 가드는 `null` 을 내고 있었으므로 한 파일 안에서 어휘가 갈려 있었다.
//
// ⚠️ 두 가드 모두 **DB 프로브 앞**에 있다 — 그래서 이 테스트가 DB 없이 돈다.

const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";

describe("trendGridSlotRows — 판정 불가는 null", () => {
  it("유효 uuid 가 하나도 없으면 null 이다(빈 배열이 아니다)", async () => {
    await expect(
      trendGridSlotRows({ surface: "project", projectIds: [], family: "all", maxDays: 180 }),
    ).resolves.toBeNull();
  });

  it("uuid 형식이 아닌 id 만 오면 null 이다 — 미연결 프로젝트가 그 자리다", async () => {
    await expect(
      trendGridSlotRows({
        surface: "project",
        projectIds: ["", "not-a-uuid"],
        family: "all",
        maxDays: 180,
      }),
    ).resolves.toBeNull();
  });

  it("maxDays 가드와 **같은 어휘**다", async () => {
    await expect(
      trendGridSlotRows({ surface: "global", projectIds: [ROOT], family: "all", maxDays: 0 }),
    ).resolves.toBeNull();
  });
});
