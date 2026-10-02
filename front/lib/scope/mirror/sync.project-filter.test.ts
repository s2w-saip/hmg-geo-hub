import { describe, expect, it } from "vitest";
import { selectSyncTargets, orderSyncTargets } from "./sync";

/**
 * `?projectIds=` 대상 좁히기의 계약.
 *
 * 지켜야 할 것 셋:
 *  ① **루트를 특별 취급하지 않는다.** 요청에 없으면 루트도 빠진다 — 루트의
 *     prompts 50 + runs 50 = 100 왕복(`maxRuns` 와 무관한 고정 비용)을 피하는 것이
 *     이 파라미터의 주된 실익이다.
 *  ② **못 찾은 id 를 조용히 버리지 않는다.** 오타 하나로 "돌렸다고 믿는데 안 돈"
 *     상태가 되는 것이 이 리포가 2026-08-30 하루에만 세 번 값을 치른 실패 모양이다
 *     (조용한 페이지 절단 · 조용한 재확인 상한 · 멱등 force 패스).
 *  ③ **순서를 보존한다.** 입력은 이미 `orderSyncTargets` 로 로테이션 정렬된
 *     배열이므로, 여기서 재정렬하면 기아 방지 설계가 무효가 된다.
 */

const ROOT = "26751906-c175-485c-9e69-29fc68d0fdbb";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";

describe("selectSyncTargets — 대상 좁히기", () => {
  it("미지정이면 전체를 그대로 반환한다 (기존 동작 보존)", () => {
    expect(selectSyncTargets([ROOT, A, B], undefined)).toEqual({
      ids: [ROOT, A, B],
      notFound: [],
    });
  });

  it("빈 배열도 전체로 본다 — 빈 필터가 '아무것도 안 함'이 되면 안 된다", () => {
    // 라우트는 빈 문자열을 400 으로 막지만, 이 함수 자체도 안전한 쪽으로 닫는다.
    expect(selectSyncTargets([ROOT, A], []).ids).toEqual([ROOT, A]);
  });

  it("요청한 것만 남긴다", () => {
    expect(selectSyncTargets([ROOT, A, B, C], [A, C])).toEqual({
      ids: [A, C],
      notFound: [],
    });
  });

  it("★ 루트를 특별 취급하지 않는다 — 요청에 없으면 루트도 뺀다", () => {
    const r = selectSyncTargets([ROOT, A, B], [A]);
    expect(r.ids).toEqual([A]);
    expect(r.ids).not.toContain(ROOT);
  });

  it("루트만 요청하는 것도 된다", () => {
    expect(selectSyncTargets([ROOT, A, B], [ROOT]).ids).toEqual([ROOT]);
  });

  it("★ 대상에 없는 id 를 조용히 버리지 않고 notFound 로 낸다", () => {
    const r = selectSyncTargets([ROOT, A], [A, "deadbeef-0000-4000-8000-00000000dead"]);
    expect(r.ids).toEqual([A]);
    expect(r.notFound).toEqual(["deadbeef-0000-4000-8000-00000000dead"]);
  });

  it("전부 못 찾으면 ids 는 비고 notFound 에 전부 담긴다", () => {
    const r = selectSyncTargets([ROOT], [A, B]);
    expect(r.ids).toEqual([]);
    expect(r.notFound).toEqual([A, B]);
  });

  it("중복 요청은 한 번만 보고한다", () => {
    expect(selectSyncTargets([ROOT], [A, A]).notFound).toEqual([A]);
  });

  it("★ 순서를 보존한다 — 요청 순서가 아니라 입력(로테이션 정렬) 순서다", () => {
    // orderSyncTargets 가 정한 순서가 기아 방지의 본체다. 요청 순서로 재정렬하면
    // 그 설계가 무효가 된다.
    const ordered = orderSyncTargets(
      ROOT,
      [ROOT, A, B, C],
      new Map([
        [A, new Date("2026-08-30T00:00:00Z")], // 최근 → 뒤로
        [B, new Date("2026-08-01T00:00:00Z")], // 오래됨 → 앞으로
        // C 는 미동기화 → 0 → 가장 앞
      ]),
    );
    expect(ordered).toEqual([ROOT, C, B, A]);
    // 요청을 A,B,C 순으로 줘도 결과는 정렬 순서(C,B,A)를 따른다.
    expect(selectSyncTargets(ordered, [A, B, C]).ids).toEqual([C, B, A]);
  });

  it("입력 배열을 변형하지 않는다", () => {
    const ids = [ROOT, A, B];
    selectSyncTargets(ids, [A]);
    expect(ids).toEqual([ROOT, A, B]);
  });
});
