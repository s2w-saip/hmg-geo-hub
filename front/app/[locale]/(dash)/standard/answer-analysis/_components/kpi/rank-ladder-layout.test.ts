import { describe, expect, it } from "vitest";
import { ladderLabelTops } from "./rank-ladder-layout";

// 2026-09-11 제품 책임자 지적(프로덕션 스크린샷): "순위별 보기" 사다리에서 값 라벨("18.3위")이
// 브랜드 라벨("Hyundai 1위 상위 10%")과 **겹쳐 찍히고**, 트랙 양 끝에서는 라벨이
// 경계 밖으로 나갔다. 좌/우 칸 분리는 마크업이 막고, **세로 겹침·경계 이탈은 이 함수**가
// 막는다. 화면으로는 "그럴듯하게" 보이는 결함이라 수치로 고정한다.

const TRACK = 375;
const LABEL = 26;
const GAP = 2;
const opts = { trackPx: TRACK, labelPx: LABEL, gapPx: GAP };
const maxTop = TRACK - LABEL;

/** 정렬된 top 배열의 최소 간격. */
function minGap(tops: number[]): number {
  const s = [...tops].sort((a, b) => a - b);
  return s.slice(1).reduce((m, v, i) => Math.min(m, v - s[i]), Infinity);
}

describe("ladderLabelTops", () => {
  it("빈 입력은 빈 배열", () => {
    expect(ladderLabelTops([], opts)).toEqual([]);
  });

  it("트랙 양 끝(0%·100%)에서 라벨이 경계를 넘지 않는다", () => {
    // 종전 결함: top = calc(0% - 2px) → 라벨 절반이 트랙 위로 나갔다.
    expect(ladderLabelTops([0, 100], opts)).toEqual([0, maxTop]);
  });

  it("단독 마커는 자기 위치에 중심이 온다", () => {
    expect(ladderLabelTops([50], opts)).toEqual([50 * (TRACK / 100) - LABEL / 2]);
  });

  it("같은 위치의 라벨을 최소 간격만큼 떼어 놓는다", () => {
    const tops = ladderLabelTops([50, 50, 50], opts);
    expect(minGap(tops)).toBeGreaterThanOrEqual(LABEL + GAP);
    for (const t of tops) expect(t).toBeGreaterThanOrEqual(0);
    for (const t of tops) expect(t).toBeLessThanOrEqual(maxTop);
  });

  it("스크린샷 4브랜드(18.3·19.7·20.0·21.0위)에서 어느 라벨도 겹치지 않는다", () => {
    // rankLadder 정규화: (v - 18.3) / (21.0 - 18.3) * 100
    const offsets = [18.3, 19.7, 20.0, 21.0].map((v) => ((v - 18.3) / 2.7) * 100);
    const tops = ladderLabelTops(offsets, opts);
    expect(minGap(tops)).toBeGreaterThanOrEqual(LABEL + GAP);
    expect(tops[0]).toBe(0);
    expect(tops[3]).toBe(maxTop);
  });

  it("입력 순서(=마커 순서)를 유지한 채 값만 돌려준다", () => {
    // 정렬은 내부에서만 — 반환 인덱스가 밀리면 라벨이 남의 마커에 붙는다.
    const tops = ladderLabelTops([100, 0, 50], opts);
    expect(tops[0]).toBe(maxTop);
    expect(tops[1]).toBe(0);
    expect(tops[2]).toBeGreaterThan(tops[1]);
    expect(tops[2]).toBeLessThan(tops[0]);
  });

  it("트랙이 모자라면 겹침을 허용하되 경계는 지킨다", () => {
    // 라벨 10개 × 26px 은 60px 트랙에 못 들어간다 — 카드 밖으로 나가는 것보다 낫다.
    const tops = ladderLabelTops([0, 10, 20, 30, 40, 50, 60, 70, 80, 90], { trackPx: 60, labelPx: LABEL });
    for (const t of tops) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(60 - LABEL);
    }
    // 순서는 유지된다(오름차순 입력 → 비감소 출력).
    for (let i = 1; i < tops.length; i++) expect(tops[i]).toBeGreaterThanOrEqual(tops[i - 1]);
  });

  it("비정상 offset(NaN·Infinity)도 트랙 안에 둔다", () => {
    const tops = ladderLabelTops([Number.NaN, Infinity, 200, -50], opts);
    for (const t of tops) {
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(maxTop);
    }
  });
});
