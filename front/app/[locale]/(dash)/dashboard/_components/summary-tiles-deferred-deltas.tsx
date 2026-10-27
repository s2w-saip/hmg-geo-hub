"use client";

import { Suspense, use } from "react";
import { SummaryTilesView } from "./summary-tiles";
import type { TilesView } from "../_data/screen-types";

/**
 * 카드는 즉시 그리고, 늦게 오는 타일 필드(변화량 Δ 칩·엔진 일관성 배지)는 그 뒤에 채운다.
 *
 * 왜: /website 카드(website/summary)는 집계층 속도로 오는데 Δ(추이)와 배지(엔진별 행)는 더 늦다.
 * 둘을 한 await 에 묶으면 카드가 그 속도에 묶인다(2026-09-06 실측). 그래서 서버 섹션은 Δ·배지가
 * 병합된 타일(website/summary-deferred)을 **프로미스**로 넘기고, 여기서 `use()` 로 풀되 그 경계의
 * 폴백을 "Δ 없는 같은 타일" 로 둔다 — 사용자는 값이 먼저, 화살표가 나중.
 * 폴백과 본체가 같은 SummaryTilesView 라 레이아웃 점프가 없다(칩 자리만 채워진다).
 */
export function SummaryTilesDeferredDeltas({
  tiles,
  deferred,
}: {
  /** The tiles at card speed (no Δ, no badge). */
  tiles: TilesView;
  /** The same tiles with the Δ and the engine badge merged in (or `tiles` again when that read failed). */
  deferred: Promise<TilesView>;
}) {
  return (
    <Suspense fallback={<SummaryTilesView view={tiles} />}>
      <TilesWithDeltas deferred={deferred} />
    </Suspense>
  );
}

function TilesWithDeltas({ deferred }: { deferred: Promise<TilesView> }) {
  return <SummaryTilesView view={use(deferred)} />;
}
