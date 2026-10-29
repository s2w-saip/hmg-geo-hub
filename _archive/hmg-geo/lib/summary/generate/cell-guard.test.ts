/**
 * 셀 선택 가드 픽스처 — 2026-09-10 웹 백필 정지의 두 얼굴을 각각 고정한다.
 *
 *   ① 프록시 전환 회차: 같은 셀을 서로 다른 region 으로 두 번 잰 것 → **통과** + 접힘 기록.
 *      이걸 실패로 판정해서 백필이 멈췄다("cycle_jobs(200) ≠ completed_units(345)").
 *   ② 진짜 누락: 셀 선택이 답변을 흘린 것 → **여전히 실패**.
 *
 * 두 경우를 가르는 것은 **비교 대상의 그레인**이다. 원장 카운터는 region 그레인이라
 * ①에서 필연적으로 커진다 — 그 값과 비교하면 ①과 ②를 구분할 수 없다.
 */
import { describe, expect, it } from "vitest";
import { checkCellSelection } from "./cell-guard";

describe("셀 선택 가드", () => {
  it("정상 회차 — region 과 country 그레인이 같고 jobs 도 같다", () => {
    const g = checkCellSelection({
      jobs: 200,
      completedRegionGrain: 200,
      completedCellGrain: 200,
    });
    expect(g).toEqual({ collapsed: 0, ok: true });
  });

  it("① 프록시 전환 회차 — 같은 셀 region 2개는 통과하고 접힘이 기록된다", () => {
    // 실측 `62167826…`: region 그레인 345, country 그레인 200, 굳힌 jobs 200.
    const g = checkCellSelection({
      jobs: 200,
      completedRegionGrain: 345,
      completedCellGrain: 200,
    });
    expect(g.ok, "프록시 전환 회차를 실패로 판정하면 백필이 멈춘다").toBe(true);
    expect(g.collapsed).toBe(145);

    // 두 번째 회차 `cc2e32da…` 도 같은 형태.
    expect(checkCellSelection({ jobs: 176, completedRegionGrain: 278, completedCellGrain: 176 }))
      .toEqual({ collapsed: 102, ok: true });

    // 셀 하나짜리 최소 사례 — 같은 (prompt, engine, country) 를 region 2개로 잰 경우.
    expect(checkCellSelection({ jobs: 1, completedRegionGrain: 2, completedCellGrain: 1 }))
      .toEqual({ collapsed: 1, ok: true });
  });

  it("② 진짜 누락 — 셀 하나가 빠지면 접힘이 있어도 실패한다", () => {
    // 접힘이 없는 순수 누락.
    expect(checkCellSelection({ jobs: 199, completedRegionGrain: 200, completedCellGrain: 200 }).ok)
      .toBe(false);
    // 전환 회차에서 **추가로** 하나를 흘린 경우 — 접힘에 묻히면 안 된다.
    const g = checkCellSelection({
      jobs: 199,
      completedRegionGrain: 345,
      completedCellGrain: 200,
    });
    expect(g.ok, "접힘이 진짜 누락을 가리면 안 된다").toBe(false);
    expect(g.collapsed).toBe(145);
  });

  it("jobs 가 더 많아도 실패한다 (중복 굳힘)", () => {
    expect(checkCellSelection({ jobs: 201, completedRegionGrain: 200, completedCellGrain: 200 }).ok)
      .toBe(false);
  });

  it("접힘은 음수가 되지 않는다 — country 그레인은 region 보다 좁거나 같다", () => {
    // 방어적: 카운터가 어긋나 역전돼도 음수를 timings 에 쓰지 않는다.
    expect(checkCellSelection({ jobs: 5, completedRegionGrain: 3, completedCellGrain: 5 }).collapsed)
      .toBe(0);
  });
});
