// "순위별 보기"(래더) 라벨의 세로 배치 — 순수 함수(렌더 없음).
//
// 왜 따로 계산하는가 (2026-09-11 제품 책임자 지적, 프로덕션 스크린샷):
//   종전 래더는 ① 마커 라벨을 `top: calc(offsetPct% - 2px)` 로 그대로 놓고
//   ② 평균 순위 값은 트랙 **오른쪽 별도 칸**에 min/max 두 개만 그렸다.
//   그 둘이 정확히 같은 y(0% = min, 100% = max)에 놓여 최상·최하 브랜드에서
//   "Hyundai 1위 상위 10%" 와 "18.3위" 가 겹쳐 찍혔고, 양 끝 라벨은 라벨 높이의
//   절반만큼 트랙 밖으로 흘러나갔다.
//
// 규칙:
//   ① 원하는 위치 = 마커 중심 − 라벨 높이/2 (라벨의 세로 중심이 마커에 온다)
//   ② 트랙 안으로 클램프 — [0, trackPx − labelPx]
//   ③ 인접 라벨은 최소 간격(labelPx + gapPx) 확보. 아래로 밀고, 바닥에 닿으면
//      위로 되민다.
//   ④ 트랙이 라벨 전부를 담지 못하면 **경계를 지키고 겹침을 허용**한다 —
//      카드 밖으로 삐져나가는 것보다 낫다. 순서(입력 offset 오름차순)는 유지.
//
// 마커(색 막대) 자체는 데이터 위치에 그대로 둔다. 미는 것은 라벨뿐이다.

export interface LadderLabelLayout {
  /** 트랙 높이(px). */
  trackPx: number;
  /** 라벨 한 덩어리의 높이(px) — 이 값이 곧 최소 간격의 기준. */
  labelPx: number;
  /** 라벨 사이 추가 여백(px). 기본 2. */
  gapPx?: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 마커 offset(0~100%) 배열을 받아 **입력 순서 그대로** 라벨의 top(px) 을 돌려준다.
 * 반환값은 항상 `0 <= top <= trackPx - labelPx` 를 만족한다.
 */
export function ladderLabelTops(
  offsetPcts: number[],
  { trackPx, labelPx, gapPx = 2 }: LadderLabelLayout,
): number[] {
  if (offsetPcts.length === 0) return [];
  const maxTop = Math.max(0, trackPx - labelPx);
  const step = labelPx + gapPx;
  const items = offsetPcts.map((pct, index) => ({
    index,
    // NaN·Infinity 는 0% 로 —— 집계가 이상해도 라벨이 화면 밖으로 날아가지 않는다.
    top: clamp((((Number.isFinite(pct) ? pct : 0) / 100) * trackPx) - labelPx / 2, 0, maxTop),
  }));
  // 위→아래 순서로 처리(동률이면 입력 순서).
  items.sort((a, b) => a.top - b.top || a.index - b.index);

  // ③-a 아래로 밀기.
  for (let i = 1; i < items.length; i++) {
    items[i].top = Math.max(items[i].top, items[i - 1].top + step);
  }
  // ③-b 바닥을 넘었으면 위로 되밀기.
  for (let i = items.length - 1; i >= 0; i--) {
    const ceiling = i === items.length - 1 ? maxTop : items[i + 1].top - step;
    items[i].top = Math.min(items[i].top, ceiling);
  }
  // ④ 되밀다 트랙 위로 나갔으면(공간 부족) 경계만 지키고 순서를 유지한다.
  let floor = 0;
  for (const it of items) {
    it.top = clamp(Math.max(it.top, floor), 0, maxTop);
    floor = it.top;
  }

  const out = new Array<number>(offsetPcts.length);
  for (const it of items) out[it.index] = it.top;
  return out;
}
