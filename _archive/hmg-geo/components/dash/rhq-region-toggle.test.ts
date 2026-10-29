import { describe, expect, it } from "vitest";
import {
  isRegionSelected,
  toggleRhqRegion,
  type RhqToggleState,
} from "./rhq-region-toggle";

// 측정된 국가 → 권역 (활성 브랜드 기준). 유럽 3개국 / 아태 2개국.
const MAP = new Map<string, string>([
  ["DE", "hyundai-europe"],
  ["FR", "hyundai-europe"],
  ["GB", "hyundai-europe"],
  ["KR", "hyundai-asia-pacific"],
  ["AU", "hyundai-asia-pacific"],
]);

const EMPTY: RhqToggleState = { nav: [], geography: [] };
const sorted = (s: string[]) => [...s].sort();

describe("toggleRhqRegion", () => {
  it("권역을 켜면 그 권역의 국가가 전부 선택된다", () => {
    // 이 테스트가 이 수정의 전부다 — 이전엔 nav 만 바뀌고 geography 는 빈 채라
    // 권역을 골라도 필터가 안 걸렸다.
    const out = toggleRhqRegion("hyundai-europe", EMPTY, MAP);
    expect(out.nav).toEqual(["hyundai-europe"]);
    expect(sorted(out.geography)).toEqual(["DE", "FR", "GB"]);
  });

  it("다른 권역 국가는 딸려오지 않는다", () => {
    const out = toggleRhqRegion("hyundai-europe", EMPTY, MAP);
    expect(out.geography).not.toContain("KR");
    expect(out.geography).not.toContain("AU");
  });

  it("권역을 끄면 그 권역의 국가 선택이 사라진다", () => {
    const on = toggleRhqRegion("hyundai-europe", EMPTY, MAP);
    const off = toggleRhqRegion("hyundai-europe", on, MAP);
    expect(off.nav).toEqual([]);
    expect(off.geography).toEqual([]);
  });

  it("권역 두 개를 켜면 양쪽 국가가 모두 선택된다", () => {
    const a = toggleRhqRegion("hyundai-europe", EMPTY, MAP);
    const b = toggleRhqRegion("hyundai-asia-pacific", a, MAP);
    expect(sorted(b.nav)).toEqual(["hyundai-asia-pacific", "hyundai-europe"]);
    expect(sorted(b.geography)).toEqual(["AU", "DE", "FR", "GB", "KR"]);
  });

  it("둘 중 하나만 끄면 나머지 권역 국가는 남는다", () => {
    const a = toggleRhqRegion("hyundai-europe", EMPTY, MAP);
    const b = toggleRhqRegion("hyundai-asia-pacific", a, MAP);
    const c = toggleRhqRegion("hyundai-europe", b, MAP);
    expect(c.nav).toEqual(["hyundai-asia-pacific"]);
    expect(sorted(c.geography)).toEqual(["AU", "KR"]);
  });

  it("권역을 켜면 권역 밖의 기존 선택은 정리된다", () => {
    // 좁혀진 목록 뒤에 숨은 채 필터에 남으면 "유럽을 골랐는데 KR 데이터가 섞여
    // 나온다"가 된다 — 눈에 안 보이는 필터라 원인 추적이 어렵다.
    const prev: RhqToggleState = { nav: [], geography: ["KR"] };
    const out = toggleRhqRegion("hyundai-europe", prev, MAP);
    expect(sorted(out.geography)).toEqual(["DE", "FR", "GB"]);
  });

  it("마지막 권역을 끄면 정리가 걸리지 않는다 (선택 없음 = 전체)", () => {
    const on: RhqToggleState = { nav: ["hyundai-europe"], geography: ["DE", "FR", "GB"] };
    const out = toggleRhqRegion("hyundai-europe", on, MAP);
    expect(out.nav).toEqual([]);
    expect(out.geography).toEqual([]);
  });

  it("권역 안에서 국가를 수동으로 뺀 상태가 유지된다", () => {
    // 권역 체크 = 펼쳐 보는 중, 국가 체크 = 실제 선택. 권역이 켜져 있다고 해서
    // 사용자가 뺀 국가를 되돌려 놓지 않는다(다른 권역을 켜는 건 별개 동작).
    const manual: RhqToggleState = {
      nav: ["hyundai-europe"],
      geography: ["DE", "FR"], // GB 를 사용자가 뺌
    };
    const out = toggleRhqRegion("hyundai-asia-pacific", manual, MAP);
    expect(sorted(out.geography)).toEqual(["AU", "DE", "FR", "KR"]);
    expect(out.geography).not.toContain("GB");
  });

  it("입력 상태를 변형하지 않는다", () => {
    const prev: RhqToggleState = { nav: [], geography: ["KR"] };
    toggleRhqRegion("hyundai-europe", prev, MAP);
    expect(prev).toEqual({ nav: [], geography: ["KR"] });
  });

  it("측정 국가가 없는 권역은 선택을 만들지 않는다", () => {
    const out = toggleRhqRegion("hyundai-africa", EMPTY, MAP);
    expect(out.nav).toEqual(["hyundai-africa"]);
    // nav 는 켜지되 고를 국가가 없으므로 필터는 빈 채 — 정리 규칙상 기존 선택도
    // 권역 밖이라 사라진다.
    expect(out.geography).toEqual([]);
  });

  // ── 2026-08-12: 토글 방향을 nav 가 아니라 국가 선택에서 파생 ──────────────

  it("부분 선택된 권역을 다시 누르면 해제된다 (선택/해제 2단계)", () => {
    // 2026-09-01: 이전엔 "마저 채우기"라 전체선택 → 일부선택 → 해제의 3단계였다.
    // 일부 선택도 체크로 보이므로, 다시 누르는 의도는 해제다.
    const partial: RhqToggleState = {
      nav: ["hyundai-europe"],
      geography: ["DE", "FR"],
    };
    const out = toggleRhqRegion("hyundai-europe", partial, MAP);
    expect(out.nav).toEqual([]);
    expect(out.geography).toEqual([]);
  });

  it("국가만으로 채운 권역을 누르면 nav 에 없었어도 꺼진다", () => {
    // 국가 드롭다운에서 DE·FR·GB 를 직접 골라 유럽이 선택된 상태 — 파생
    // 체크가 켜져 보이므로, 누르는 의도는 해제다.
    const manual: RhqToggleState = { nav: [], geography: ["DE", "FR", "GB"] };
    const out = toggleRhqRegion("hyundai-europe", manual, MAP);
    expect(out.nav).toEqual([]);
    expect(out.geography).toEqual([]);
  });
});

describe("isRegionSelected — 권역 체크 표시의 파생 규칙 (2단계)", () => {
  it("측정 국가가 하나라도 선택돼 있으면 true", () => {
    expect(isRegionSelected("hyundai-europe", ["DE", "FR", "GB"], MAP)).toBe(true);
    expect(isRegionSelected("hyundai-europe", ["DE", "FR"], MAP)).toBe(true);
    expect(isRegionSelected("hyundai-europe", ["GB"], MAP)).toBe(true);
    expect(isRegionSelected("hyundai-europe", [], MAP)).toBe(false);
  });

  it("다른 권역 국가만 선택돼 있으면 false", () => {
    expect(isRegionSelected("hyundai-europe", ["KR", "AU"], MAP)).toBe(false);
  });

  it("측정 국가가 없는 권역은 항상 false", () => {
    expect(isRegionSelected("hyundai-africa", ["DE"], MAP)).toBe(false);
  });
});
