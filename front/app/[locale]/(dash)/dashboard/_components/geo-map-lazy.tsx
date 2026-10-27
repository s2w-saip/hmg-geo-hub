"use client";

import dynamic from "next/dynamic";
import type { GeoView } from "../_data/screen-types";
import type { OverviewKpiKey } from "../_data/overview-metrics";

// GeoMap 지연 로더.
//
// 왜 필요한가: geo-map.tsx는 world-atlas TopoJSON을 **정적 import**한다.
// 정적 import는 showsGeoMap 게이트와 무관하게 라우트 청크에 들어가므로, 지도를 볼
// 권한이 없는 국가 스코프 사용자까지 지도 데이터를 내려받았다. 여기서 잘라내면 TopoJSON과
// d3-geo가 별도 청크로 빠지고, 지도가 실제로 렌더될 때만 받는다.
//
// ssr:false인 이유: 지도는 폴드 아래의 순수 시각화라 LCP 후보가 아니고, 서버에서
// TopoJSON을 디코드해 봐야 HTML만 무거워진다. (ssr:false는 서버 컴포넌트에서 직접
// 쓸 수 없어 이 클라이언트 래퍼가 필요하다.)
//
// loading 자리표시자는 실제 지도와 같은 720:400 비율 — 지도가 붙을 때 CLS가 없다.
const GeoMap = dynamic(() => import("./geo-map").then((m) => m.GeoMap), {
  ssr: false,
  loading: () => (
    <div
      aria-hidden
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="aspect-[720/400] w-full animate-pulse rounded bg-bg-soft" />
    </div>
  ),
});

export function GeoMapLazy({
  geo,
  metric,
  metricLabel,
  bare,
  level,
  domain,
  activeCountry,
  onCountryHover,
}: {
  geo: GeoView;
  metric?: OverviewKpiKey;
  metricLabel?: string;
  bare?: boolean;
  level?: "region" | "country";
  domain?: readonly [number, number];
  activeCountry?: string | null;
  onCountryHover?: (code: string | null) => void;
}) {
  return <GeoMap geo={geo} metric={metric} metricLabel={metricLabel} bare={bare} level={level} domain={domain} activeCountry={activeCountry} onCountryHover={onCountryHover} />;
}
