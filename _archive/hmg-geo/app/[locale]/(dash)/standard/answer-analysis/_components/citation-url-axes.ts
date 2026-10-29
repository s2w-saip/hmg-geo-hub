"use client";

// 인용 화면이 URL 에서 읽는 두 축 — 출처 카테고리(`?source=`)와 경쟁사(`?competitor=`).
//
// 2026-09-10 QA 2차 #2·#5: 두 축의 **입력 UI** 는 필터 패널(DimensionFilterPanel)로
// 돌아갔고(칩 제거), 화면은 여기서 **읽기만** 한다. 패널이 `적용` 한 번으로 두 축을
// 함께 커밋하므로 클릭마다 RSC 왕복이 나던 종전 칩 경로가 사라진다.
//
// 값 계약은 그대로다 — 도넛 조각 클릭(useSourceToggle)·도메인 표·카테고리 재계산이
// 전부 같은 URL 축 하나를 본다.

import { useSearchParams } from "next/navigation";
import { splitFilterValues } from "@/components/dash/filter-encoding";

export function useActiveCitationCategories(): string[] {
  const sp = useSearchParams();
  return splitFilterValues(sp.get("source"));
}

/** 선택된 경쟁사 도메인(`?competitor=`) — 카테고리 현황·도메인 표가 같은 축을 본다. */
export function useActiveCompetitors(): string[] {
  const sp = useSearchParams();
  return splitFilterValues(sp.get("competitor"));
}
