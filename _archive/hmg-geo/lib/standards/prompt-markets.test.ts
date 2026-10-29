import { describe, it, expect } from "vitest";
import {
  isPseudoRegion,
  isGeoFilterable,
  pseudoRegionLabelKey,
  splitMarkets,
  isMarketUnset,
  marketFilterOptions,
  matchesMarket,
} from "./prompt-markets";

describe("prompt-markets — 대상 시장 표시 규약", () => {
  it("`x:` 접두만 의사코드로 본다 (ME/EU 는 실국가 자리)", () => {
    expect(isPseudoRegion("x:WW")).toBe(true);
    expect(isPseudoRegion("x:NBRAND")).toBe(true);
    expect(isPseudoRegion("ME")).toBe(false);
    expect(isPseudoRegion("EU")).toBe(false);
    expect(isPseudoRegion("KR")).toBe(false);
  });

  it("의사코드 5종에 라벨 키가 있고, 미등록 코드는 null", () => {
    for (const c of ["x:WW", "x:EU", "x:ME", "x:NBRAND", "x:CPO"]) {
      expect(pseudoRegionLabelKey(c)).toBeTruthy();
    }
    expect(pseudoRegionLabelKey("x:ZZ")).toBeNull();
  });

  it("splitMarkets 는 실국가/의사코드를 가르고 각각 정렬한다", () => {
    expect(splitMarkets(["x:WW", "US", "KR", "x:CPO"])).toEqual({
      real: ["KR", "US"],
      pseudo: ["x:CPO", "x:WW"],
    });
  });

  it("NULL 과 빈 배열은 같게 '미지정'이다 (빈칸 아님)", () => {
    expect(isMarketUnset(null)).toBe(true);
    expect(isMarketUnset([])).toBe(true);
    expect(isMarketUnset(["  "])).toBe(true);
    expect(isMarketUnset(["KR"])).toBe(false);
    expect(isMarketUnset(["x:WW"])).toBe(false);
  });

  it("시장 필터 옵션은 실국가 + 지리 의사코드만 — NBRAND·CPO 제외 (D10)", () => {
    const opts = marketFilterOptions([
      ["KR", "x:WW"],
      ["US", "x:NBRAND"],
      ["KR", "x:CPO", "x:ME"],
      null,
    ]);
    expect(opts).toEqual(["KR", "US", "x:ME", "x:WW"]);
    expect(isGeoFilterable("x:NBRAND")).toBe(false);
    expect(isGeoFilterable("x:CPO")).toBe(false);
    expect(isGeoFilterable("x:EU")).toBe(true);
    expect(isGeoFilterable("KR")).toBe(true);
  });

  it("matchesMarket 는 정확 일치 (미지정 행은 어떤 시장에도 안 걸린다)", () => {
    expect(matchesMarket(["KR", "US"], "KR")).toBe(true);
    expect(matchesMarket(["KR"], "US")).toBe(false);
    expect(matchesMarket(null, "KR")).toBe(false);
  });
});

// ── 2026-08-29 검증 라운드에서 나온 결함 3종의 회귀 방어 ────────────────────
// (1) 렌더 실측: 의사코드가 `+N` 접힘에 묻혀 D4 가 무력화됐다 → MarketCell 쪽
//     회귀는 render 테스트가 잡는다. 여기서는 그 전제인 split 순서를 고정한다.
// (2) 적대적 검증: 옵션 목록(trim)과 필터 술어(raw)의 정규화가 갈려
//     "드롭다운에 뜨는데 고르면 0행"이 되는 반례가 실행으로 확보됐다.
// (3) 적대적 검증: 지리 필터가 제외목록이라 미등록 비지리 슬롯이 추가되면
//     D10 이 조용히 뚫린다 → 허용목록으로 전환.
describe("2026-08-29 검증 라운드 회귀", () => {
  it("옵션 목록과 필터 술어가 같은 정규화를 쓴다", () => {
    // 공백·소문자·대문자 접두 — 셋 다 옵션에 뜨면 술어도 걸려야 한다.
    for (const raw of [" KR ", "kr", "KR"]) {
      expect(marketFilterOptions([[raw]])).toEqual(["KR"]);
      expect(matchesMarket([raw], "KR")).toBe(true);
      expect(matchesMarket(["KR"], raw)).toBe(true);
    }
    expect(marketFilterOptions([["X:ww"]])).toEqual(["x:WW"]);
    expect(matchesMarket(["X:ww"], "x:WW")).toBe(true);
  });

  it("중복 코드는 배지를 두 번 만들지 않는다 (React key 충돌 방지)", () => {
    expect(splitMarkets(["KR", "KR", " kr "])).toEqual({ real: ["KR"], pseudo: [] });
    expect(splitMarkets(["x:WW", "X:WW"])).toEqual({ real: [], pseudo: ["x:WW"] });
  });

  it("지리 필터는 허용목록 — 미등록 의사코드는 옵션에 들어오지 않는다", () => {
    // 등록된 지리 의사코드만 통과.
    expect(isGeoFilterable("x:WW")).toBe(true);
    expect(isGeoFilterable("x:EU")).toBe(true);
    expect(isGeoFilterable("x:ME")).toBe(true);
    // D10: 비지리 슬롯.
    expect(isGeoFilterable("x:NBRAND")).toBe(false);
    expect(isGeoFilterable("x:CPO")).toBe(false);
    // 미래에 추가될 미등록 슬롯도 기본 차단(제외목록이었다면 통과했을 것).
    expect(isGeoFilterable("x:FLEET")).toBe(false);
    expect(marketFilterOptions([["KR", "x:FLEET", "x:NBRAND", "x:WW"]])).toEqual([
      "KR",
      "x:WW",
    ]);
    // 실국가는 언제나 통과.
    expect(isGeoFilterable("KR")).toBe(true);
    // 접두 없는 ME/EU 는 실국가(몬테네그로/ISO 예약) — 의사코드로 오인 금지.
    expect(isPseudoRegion("ME")).toBe(false);
    expect(isGeoFilterable("ME")).toBe(true);
  });

  it("실국가가 많아도 의사코드는 배지에서 밀려나지 않는다 (split 계약)", () => {
    const many = ["AU", "CA", "GB", "ID", "IN", "MY", "PH", "SA", "TH", "US"];
    const { real, pseudo } = splitMarkets([...many, "x:EU", "x:ME", "x:NBRAND", "x:WW"]);
    expect(real).toHaveLength(10);
    // MarketCell 은 real 만 접고 pseudo 는 전량 렌더한다 — 그 전제.
    expect(pseudo).toEqual(["x:EU", "x:ME", "x:NBRAND", "x:WW"]);
  });
});
