export type HideCycleReason = "collection_error" | "operator";
/** 숨김 범위(0071). NULL/미지정 = `all`. */
export type HideCycleScope = "all" | "citations";

export interface HideCycleWarningInput {
  cycleWeek: string;
  remainingVisibleCyclesInWeek: number;
  newerVisibleCycles: number;
  reason: HideCycleReason;
  /** 생략 = `all`(종전 동작). */
  scope?: HideCycleScope;
}

/** 숨김 직후 운영자에게 보여 줄 축 변화 안내. DB·환경에 의존하지 않는 순수 계산이다. */
export function hideCycleWarnings(input: HideCycleWarningInput): string[] {
  const {
    cycleWeek,
    remainingVisibleCyclesInWeek: rest,
    newerVisibleCycles,
    reason,
    scope = "all",
  } = input;

  // 범위 안내는 **축 안내보다 먼저**다(0071). 축이 어떻게 변하든, "무엇이 내려가는가"
  // 를 먼저 못 박지 않으면 운영자가 언급까지 내려간 줄 안다.
  const scopeNote =
    scope === "citations"
      ? [
          "\n범위 = **citations** → 인용 계열만 내려간다(인용 화면 추이·인용 점유율·인용 도메인/카테고리·인용 정확도).\n" +
            "   언급 계열(노출률·점유율·우호도·우선 노출도·브랜드 언급 추이·ACR)은 **값을 그대로 낸다**.\n" +
            "   회차 **집합** 판정(집계층 창·스냅샷 픽·측정 기준일)은 범위와 무관하게 종전대로 이 회차를 뺀다.",
        ]
      : [];

  // 같은 주에 값이 하나라도 남으면 주 키가 이미 축에 있다. 갭은 "값 없는 주"만
  // 삽입하므로 최신 회차인지와 무관하게 이 분기로 끝낸다.
  if (rest > 0) {
    return [
      ...scopeNote,
      `\n같은 주(${cycleWeek})에 숨기지 않은 회차가 ${rest}개 남아 있다 → **갭 슬롯은 안 생기고 주 축은 유지된다**(그 주의 값이 남으므로).\n` +
        "   회차 축에서는 숨긴 회차 하나만 빠진다.",
    ];
  }

  // trendGapKeyInAxis 는 strict 비교다. 최신 경계 키는 collection_error 여도 축 안쪽이
  // 아니므로 갭을 만들 수 없다. 이때만 주 축과 회차 축이 함께 짧아진다.
  if (newerVisibleCycles === 0) {
    return [
      ...scopeNote,
      `\n같은 주(${cycleWeek})에 남는 회차가 없고 이것이 **가장 최근 회차**였다 → ` +
        "갭 슬롯이 생기지 않는다(갭은 축 안쪽에만 끼운다).\n" +
        "   주 축과 회차 축이 각각 한 칸 짧아지고 화면의 \"측정 기준일\"이 직전 비숨김 회차로 물러난다 — 음영·툴팁 없이 조용히 바뀐다.",
    ];
  }

  if (reason === "collection_error") {
    return [
      ...scopeNote,
      `\n같은 주(${cycleWeek})에 남는 회차가 없지만 더 최신 비숨김 회차가 ${newerVisibleCycles}개 있다 → ` +
        "축 안쪽이므로 **갭 슬롯이 생겨 주 축은 유지된다**. 회차 축에서는 숨긴 회차 하나가 빠진다.",
    ];
  }

  return [
    ...scopeNote,
    `\n같은 주(${cycleWeek})에 남는 회차가 없고 사유가 operator 다 → 갭 슬롯은 생기지 않는다. ` +
      "주 축에서는 그 주의 측정점이 빠지고, 회차 축에서는 숨긴 회차 하나가 빠진다.",
  ];
}
