"use client";

import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { Feature, Geometry } from "geojson";
import worldTopo from "world-atlas/countries-50m.json";
import { countryName } from "@/lib/geo-catalog";
import { rhqLabel } from "@/lib/rhq";
import { cn } from "@/lib/utils";
import type { GeoCountryView, GeoRegionView, GeoView } from "../_data/screen-types";
import type { OverviewKpiKey } from "../_data/overview-metrics";

// 시장 지도 — live.geo 의 (RHQ 권역, HMG 점유율) 집계를 world-atlas TopoJSON 폴리곤에
// 칠하는 코로플레스. 단위는 국가가 아니라 **권역**: 한 권역에 속한 모든 국가 폴리곤을
// 그 권역의 합산 HMG 점유율(marketStats)로 동일하게 칠한다(권역 블록). 색이 진할수록
// (브랜드 톤 fill-opacity) HMG 점유율이 높다. 투영(geoNaturalEarth1)은 "측정된 in-scope
// 국가" 집합에 fitExtent 되므로 — 데이터가 이미 서버에서 사용자 스코프로 좁혀져 오기
// 때문에 — HQ/admin 은 사실상 전 세계, 권역(RHQ) 사용자는 자기 권역으로 자동 줌된다.
// 측정 데이터 없는 국가는 bg-soft 회색 배경. 페어 컴포넌트인 GeoSnapshot 테이블과 동일
// 데이터(권역 행 = m.hmgSov). 행의 KPI 값·최대 경쟁사, 폴리곤 바인딩(국가 numeric id, 권역 행의
// 소속국)과 국가 단위 색 범위는 API(overview/geo · website/geo)가 계산해 온다.
//
// 색·테두리는 globals.css 토큰만 사용(컴포넌트 내 hex 금지): fill 은 brand-700,
// 강도는 fill-opacity 로만 표현.

const W = 720;
const H = 400;
const PAD = 8;
const ANTARCTICA = "010"; // 표시 안 함 (HMG 시장 아님 + 투영 하단 잡음)

export type WorldFeature = Feature<Geometry, { name: string }>;

// 폴리곤(numeric ISO)마다 그 국가가 속한 **권역**의 집계행을 붙인다 — 색·툴팁 모두
// 권역 단위. label 은 지역화된 권역명(rhqLabel).
export interface RegionDatum {
  market: GeoRegionView | GeoCountryView;
  label: string;
  code?: string;
}

/** Bind polygons to measured Gold countries; geography never supplies KPI values. */
export function countryMapData(geo: GeoView, locale: string): Map<string, RegionDatum> {
  const data = new Map<string, RegionDatum>();
  for (const region of geo.markets) {
    for (const country of region.countries) {
      const numeric = country.numeric;
      if (numeric) data.set(numeric, { market: country, label: countryName(country.code, locale), code: country.code });
    }
  }
  return data;
}

// 미리 투영된 폴리곤 1개. id 는 React key: feature id(numeric ISO), 없으면 인덱스 기반.
export interface GeoShape {
  id: string;
  d: string;
  datum: RegionDatum | undefined;
}

/**
 * features -> 투영된 폴리곤. world-atlas 에는 id 가 없는 feature 가 있다(N. Cyprus,
 * Somaliland, Kosovo): String(f.id) 는 셋 다 "undefined" 라 key 가 겹친다. id 가 null·undefined
 * 인 feature 는 인덱스 기반 key 를 쓰고(숫자 ISO 와 겹치지 않는 접두사), 권역 데이터 조회는
 * 종전처럼 id 가 있을 때만 한다(그 셋은 원래도 조회가 비었다).
 */
export function buildGeoShapes(
  features: readonly WorldFeature[],
  project: (f: WorldFeature) => string | null,
  dataByNumeric: ReadonlyMap<string, RegionDatum>,
): GeoShape[] {
  const usedIds = new Set<string>();
  return features
    .map((f, i) => {
      const hasId = f.id !== null && f.id !== undefined;
      const countryId = hasId ? String(f.id) : `noid-${i}`;
      const id = usedIds.has(countryId) ? `${countryId}-${i}` : countryId;
      usedIds.add(id);
      return { id, d: project(f), datum: hasId ? dataByNumeric.get(countryId) : undefined };
    })
    .filter((s): s is GeoShape => Boolean(s.d));
}

// 폴리곤 레이어를 memo로 떼어 hover 상태에서 격리한다. hover는 마우스무브마다
// 바뀌지만 shapes/onHover/onLeave는 안정적이므로 이 서브트리는 리렌더되지 않고,
// 툴팁만 갱신된다. (memo 없이 부모에 인라인하면 폴리곤 ~170개가 마우스무브마다
// 재조정된다.)
const GeoShapes = memo(function GeoShapes({
  shapes,
  metric,
  onHover,
  onLeave,
  domain,
  activeCountry,
}: {
  shapes: readonly GeoShape[];
  metric: OverviewKpiKey;
  onHover: (datum: RegionDatum, clientX: number, clientY: number) => void;
  onLeave: () => void;
  domain?: readonly [number, number];
  activeCountry?: string | null;
}) {
  return (
    <>
      {shapes.map((s) => (
        <path
          key={s.id}
          data-geo-country={s.datum?.code}
          tabIndex={s.datum ? 0 : undefined}
          aria-label={s.datum?.label}
          d={s.d}
          className={cn(
            "transition-[fill-opacity,stroke-width] focus-visible:outline-none",
            s.datum?.code && s.datum.code === activeCountry
              ? "stroke-[var(--color-accent-gold)]"
              : "stroke-[var(--color-card)]",
            s.datum
              ? "cursor-pointer fill-[var(--color-brand-700)]"
              : "fill-[var(--color-bg-soft)]",
          )}
          data-highlighted={s.datum?.code && s.datum.code === activeCountry ? "true" : undefined}
          strokeWidth={s.datum?.code && s.datum.code === activeCountry ? 1.8 : 0.4}
          fillOpacity={s.datum?.code && s.datum.code === activeCountry ? 1 : s.datum ? metricOpacity(s.datum.market, metric, domain) : 1}
          onMouseMove={
            s.datum ? (e) => onHover(s.datum!, e.clientX, e.clientY) : undefined
          }
          onMouseLeave={s.datum ? onLeave : undefined}
          onFocus={s.datum ? (e) => {
            const box = e.currentTarget.getBoundingClientRect();
            onHover(s.datum!, box.x + box.width / 2, box.y + box.height / 2);
          } : undefined}
          onBlur={s.datum ? onLeave : undefined}
        />
      ))}
    </>
  );
});

export function GeoMap({
  geo,
  metric = "shareOfVoice",
  metricLabel,
  bare = false,
  level = "region",
  domain,
  activeCountry,
  onCountryHover,
}: {
  geo: GeoView;
  /** Overview KPI 칩(2026-09-02) — 색 강도·툴팁 값이 이 지표를 따른다. 기본 = 점유율(종전). */
  metric?: OverviewKpiKey;
  /** 지표 표시명(호출부 번역). 미지정 = 종전 "{brand} 점유율". */
  metricLabel?: string;
  /** 테두리·제목 없이 지도만(Overview GEO 섹션 안에 삽입, 피그마 611:135). */
  bare?: boolean;
  level?: "region" | "country";
  /** Country level: the colour range of the shown countries (API, or the picked countries). */
  domain?: readonly [number, number];
  activeCountry?: string | null;
  onCountryHover?: (code: string | null) => void;
}) {
  const t = useTranslations("dashboard.geo");
  const tOv = useTranslations("dashboard.overview");
  const locale = useLocale();
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<
    { datum: RegionDatum; x: number; y: number } | null
  >(null);

  // TopoJSON → GeoJSON features (모듈 1회 디코드). Antarctica 제외.
  const features = useMemo<WorldFeature[]>(() => {
    const topo = worldTopo as unknown as Topology;
    const fc = feature(topo, topo.objects.countries as GeometryCollection) as unknown as {
      features: WorldFeature[];
    };
    return fc.features.filter((f) => String(f.id) !== ANTARCTICA);
  }, []);

  // numeric ISO → 그 국가가 속한 권역의 집계행. 권역 단위는 권역 정본의 **모든** 소속 국가
  // (API 의 `numerics`)를 같은 RegionDatum 으로 칠해 권역 전체가 한 블록으로 동일 색이 된다.
  const dataByNumeric = useMemo(() => {
    if (level === "country") return countryMapData(geo, locale);
    const map = new Map<string, RegionDatum>();
    for (const m of geo.markets) {
      const datum: RegionDatum = {
        market: m,
        label: rhqLabel(m.region, locale === "en" ? "en" : "ko") ?? m.region,
      };
      for (const num of m.numerics) map.set(num, datum);
    }
    return map;
  }, [geo, locale, level]);

  // 투영을 "측정된 국가" 집합에 맞춰 줌(권역 담당은 자기 권역으로 자동 줌). 측정값이
  // 없으면 전 세계로 폴백.
  const path = useMemo(() => {
    const focus = features.filter((f) => dataByNumeric.has(String(f.id)));
    const fitTarget = {
      type: "FeatureCollection" as const,
      features: focus.length > 0 ? focus : features,
    };
    const projection = geoNaturalEarth1().fitExtent(
      [
        [PAD, PAD],
        [W - PAD, H - PAD],
      ],
      fitTarget,
    );
    return geoPath(projection);
  }, [features, dataByNumeric]);

  // 폴리곤 d 문자열을 미리 계산해 둔다. 이전에는 렌더 본문의 features.map 안에서
  // path(f)를 호출해, hover(마우스무브마다 setState)가 리렌더를 유발할 때마다 약
  // 170개 폴리곤을 **매번 재투영**했다 — INP 병목. 투영은 [features, path]에만
  // 의존하므로 hover와 무관하게 1회면 충분하다.
  const shapes = useMemo(() => buildGeoShapes(features, path, dataByNumeric), [features, path, dataByNumeric]);

  // 안정적인 아이덴티티 — GeoShapes(memo)가 hover 리렌더에 딸려 들어가지 않도록.
  const handleHover = useCallback((datum: RegionDatum, clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    setHover({ datum, x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) });
    onCountryHover?.(datum.code ?? null);
  }, [onCountryHover]);
  const handleLeave = useCallback(() => {
    setHover(null);
    onCountryHover?.(null);
  }, [onCountryHover]);

  if (geo.markets.length === 0) return null;

  return (
    <div className={bare ? "flex flex-col gap-3" : "flex flex-col gap-3 rounded-lg border border-border bg-card p-4"}>
      {/* Overview(피그마 611:135)는 지도를 GEO 섹션 안에 맨몸으로 넣는다(bare) — 자체 제목·테두리 없음. */}
      {bare ? null : (
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">
          {t("map.title")}
        </h3>
        <span className="text-[11px] text-muted-foreground">
          {metricLabel
            ? tOv(metric === "position" ? "geo.mapCaptionRank" : "geo.mapCaption", { label: metricLabel })
            : t("map.caption", { brand: geo.ourLabel })}
        </span>
      </div>
      )}

      <div ref={containerRef} className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          role="img"
          aria-label={t("map.title")}
          onMouseLeave={handleLeave}
        >
          <GeoShapes shapes={shapes} metric={metric} domain={domain} activeCountry={activeCountry} onHover={handleHover} onLeave={handleLeave} />
        </svg>

        {hover ? (
          <GeoTooltip
            datum={hover.datum}
            ourLabel={geo.ourLabel}
            metric={metric}
            metricLabel={metricLabel}
            x={hover.x}
            y={hover.y}
          />
        ) : null}
      </div>

      <Legend ourLabel={geo.ourLabel} metric={metric} metricLabel={metricLabel} domain={domain} />
    </div>
  );
}

// HMG 점유율(0~100%) → fill-opacity 0.16~1.0. 60%+ = 최대 강도(시장 대부분 시장에서
// 점유율이 그보다 낮아 대비가 살아난다). 토큰 fill(brand-700) 위에 강도만 변조.
function sovOpacity(sov: number): number {
  const t = Math.max(0, Math.min(1, sov / 60));
  return 0.16 + t * 0.84;
}

// KPI 별 색 강도(2026-09-02). 비율 지표는 점유율과 같은 60% 천장, 우선 노출도는
// 낮을수록 좋으므로 뒤집는다(1위 = 최대 강도, 30위+ = 최소). 값 없음 = 최소 강도.
export function metricOpacity(m: GeoRegionView | GeoCountryView, metric: OverviewKpiKey, domain?: readonly [number, number]): number {
  const v = m.values[metric];
  if (v == null) return 0.16;
  if (domain) return scaleOpacity(v, metric, domain);
  if (metric === "position") {
    const t = Math.max(0, Math.min(1, (30 - v) / 29));
    return 0.16 + t * 0.84;
  }
  return sovOpacity(v);
}

function scaleOpacity(value: number, metric: OverviewKpiKey, [low, high]: readonly [number, number]) {
  const t = high === low ? 0.5 : Math.max(0, Math.min(1, (value - low) / (high - low)));
  return 0.16 + (metric === "position" ? 1 - t : t) * 0.84;
}

/**
 * 지도 툴팁의 값 표기. 우선 노출도만 단위가 언어마다 달라(ko "3.0번째" · en "#3.0")
 * 호출부가 넘긴 포맷터를 탄다. 단위 문자열 정본은 `metricUnit.position` 한 곳이다.
 */
function formatMetric(
  v: number | null,
  metric: OverviewKpiKey,
  positionUnit: (n: string) => string,
): string {
  if (v == null) return "—";
  return metric === "position" ? positionUnit(v.toFixed(1)) : `${v.toFixed(1)}%`;
}

function GeoTooltip({
  datum,
  ourLabel,
  metric,
  metricLabel,
  x,
  y,
}: {
  datum: RegionDatum;
  ourLabel: string;
  metric: OverviewKpiKey;
  metricLabel?: string;
  x: number;
  y: number;
}) {
  const t = useTranslations("dashboard.geo");
  const tUnit = useTranslations("metricUnit");
  const positionUnit = (n: string) => tUnit("position", { n });
  const { market, label } = datum;
  // 그 KPI 의 최대 경쟁사(점유율은 없으면 SoV 최대 경쟁사) — API 가 고른다.
  const rival = market.rivals[metric];
  // 커서 오른쪽 위. 우측 가장자리에서 잘리지 않게 translate 로 좌측 전환.
  const flipX = x > W * 0.6;
  // 선두(lead) 줄은 헤드라인과 중복일 때(단일 보유 브랜드 = 라벨과 동일) 숨긴다(API 의 showLead).
  const showLead = market.showLead;
  return (
    <div
      className={cn(
        "pointer-events-none absolute z-10 w-max max-w-56 rounded-md border border-border bg-popover p-2.5 text-popover-foreground shadow-md",
        flipX ? "-translate-x-full" : "",
      )}
      style={{ left: x + (flipX ? -10 : 10), top: y - 10 }}
    >
      <div className="flex items-center gap-2">
        <RankBadge rank={market.hmgRank} />
        <span className="text-xs font-semibold text-foreground">{label}</span>
      </div>
      <dl className="mt-1.5 flex flex-col gap-0.5 text-[11px]">
        <Stat
          label={metricLabel ?? t("map.share", { brand: ourLabel })}
          value={formatMetric(market.values[metric], metric, positionUnit)}
          strong
        />
        {metric === "shareOfVoice" && showLead && market.topBrand ? (
          <Stat
            label={t("lead")}
            value={`${market.topBrand.name} ${market.topBrand.sov.toFixed(1)}%`}
          />
        ) : null}
        {rival ? (
          <Stat label={t("rival")} value={`${rival.name} ${formatMetric(rival.value, metric, positionUnit)}`} />
        ) : null}
      </dl>
    </div>
  );
}

function Stat({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "tabular-nums",
          strong ? "font-semibold text-foreground" : "text-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

// 시장 내 HMG 순위 — GeoSnapshot 과 동일 규칙(1위=브랜드 톤, 그 외=골드).
function RankBadge({ rank }: { rank: number }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 w-7 shrink-0 items-center justify-center rounded text-[9px] font-bold tabular-nums text-white",
        rank === 1
          ? "bg-[var(--color-brand-700)]"
          : "bg-[var(--color-accent-gold)]",
      )}
    >
      #{rank}
    </span>
  );
}

// 점유율 색강도 범례 — 낮음 → 높음.
function Legend({ ourLabel, metric, metricLabel, domain }: { ourLabel: string; metric: OverviewKpiKey; metricLabel?: string; domain?: readonly [number, number] }) {
  const t = useTranslations("dashboard.geo");
  const tUnit = useTranslations("metricUnit");
  // 우선 노출도는 방향이 반대(낮을수록 진함) — 범례 스텝도 뒤집는다.
  const steps = domain
    ? [0, 0.25, 0.5, 0.75, 1].map(n => domain[0] + (domain[1] - domain[0]) * (metric === "position" ? 1 - n : n))
    : metric === "position" ? [25, 19, 13, 7, 1] : [10, 25, 40, 55, 70];
  const fmt = (v: number) => formatMetric(v, metric, n => tUnit("position", { n }));
  return (
    <div className="flex items-center gap-2 border-t border-border pt-3 text-[11px] text-muted-foreground">
      <span>{domain ? fmt(steps[0]) : t("map.legendLow")}</span>
      <div className="flex h-3 overflow-hidden rounded-sm">
        {steps.map((s, i) => (
          <span
            key={i}
            className="block h-3 w-6 bg-[var(--color-brand-700)]"
            style={{ opacity: domain ? scaleOpacity(s, metric, domain) : metric === "position" ? 0.16 + Math.max(0, Math.min(1, (30 - s) / 29)) * 0.84 : sovOpacity(s) }}
          />
        ))}
      </div>
      <span>{domain ? fmt(steps[4]) : t("map.legendHigh")}</span>
      <span className="ml-1">· {metricLabel ?? t("map.share", { brand: ourLabel })}</span>
    </div>
  );
}
