"use client";

import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { Feature, Geometry } from "geojson";
import worldTopo from "world-atlas/countries-110m.json";
import { GEO_COUNTRY_NUMERIC } from "@/lib/geo-catalog";
import { rhqLabel, countriesForRhq } from "@/lib/rhq";
import { cn } from "@/lib/utils";
import type { GeoRegionRow, LiveGeo } from "../_data/live";
import { metricValue, type OverviewKpiKey } from "../_data/overview-metrics";

// 시장 지도 — live.geo 의 (RHQ 권역, HMG 점유율) 집계를 world-atlas TopoJSON 폴리곤에
// 칠하는 코로플레스. 단위는 국가가 아니라 **권역**: 한 권역에 속한 모든 국가 폴리곤을
// 그 권역의 합산 HMG 점유율(marketStats)로 동일하게 칠한다(권역 블록). 색이 진할수록
// (브랜드 톤 fill-opacity) HMG 점유율이 높다. 투영(geoNaturalEarth1)은 "측정된 in-scope
// 국가" 집합에 fitExtent 되므로 — 데이터가 이미 서버에서 사용자 스코프로 좁혀져 오기
// 때문에 — HQ/admin 은 사실상 전 세계, 권역(RHQ) 사용자는 자기 권역으로 자동 줌된다.
// 측정 데이터 없는 국가는 bg-soft 회색 배경. 페어 컴포넌트인 GeoSnapshot 테이블과 동일
// 데이터(권역 행 = m.hmgSov).
//
// 색·테두리는 globals.css 토큰만 사용(컴포넌트 내 hex 금지): fill 은 brand-700,
// 강도는 fill-opacity 로만 표현.

const W = 720;
const H = 400;
const PAD = 8;
const ANTARCTICA = "010"; // 표시 안 함 (HMG 시장 아님 + 투영 하단 잡음)

type WorldFeature = Feature<Geometry, { name: string }>;

// 폴리곤(numeric ISO)마다 그 국가가 속한 **권역**의 집계행을 붙인다 — 색·툴팁 모두
// 권역 단위. label 은 지역화된 권역명(rhqLabel).
interface RegionDatum {
  market: GeoRegionRow;
  label: string;
}

// 미리 투영된 폴리곤 1개.
interface GeoShape {
  id: string;
  d: string;
  datum: RegionDatum | undefined;
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
}: {
  shapes: readonly GeoShape[];
  metric: OverviewKpiKey;
  onHover: (datum: RegionDatum, clientX: number, clientY: number) => void;
  onLeave: () => void;
}) {
  return (
    <>
      {shapes.map((s) => (
        <path
          key={s.id}
          d={s.d}
          className={cn(
            "stroke-[var(--color-card)] transition-[fill-opacity]",
            s.datum
              ? "cursor-pointer fill-[var(--color-brand-700)]"
              : "fill-[var(--color-bg-soft)]",
          )}
          strokeWidth={0.4}
          fillOpacity={s.datum ? metricOpacity(s.datum.market, metric) : 1}
          onMouseMove={
            s.datum ? (e) => onHover(s.datum!, e.clientX, e.clientY) : undefined
          }
          onMouseLeave={s.datum ? onLeave : undefined}
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
}: {
  geo: LiveGeo;
  /** Overview KPI 칩(2026-09-02) — 색 강도·툴팁 값이 이 지표를 따른다. 기본 = 점유율(종전). */
  metric?: OverviewKpiKey;
  /** 지표 표시명(호출부 번역). 미지정 = 종전 "{brand} 점유율". */
  metricLabel?: string;
  /** 테두리·제목 없이 지도만(Overview GEO 섹션 안에 삽입, 피그마 611:135). */
  bare?: boolean;
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

  // numeric ISO → 그 국가가 속한 권역의 집계행. 측정된 국가만이 아니라 권역 정본
  // (countriesForRhq)의 **모든** 소속 국가를 같은 RegionDatum 으로 칠해, 지도에서
  // 권역 전체가 한 블록으로 동일 색이 되게 한다(단위 = 권역). 측정값 없는 소속국도
  // 권역 집계 색을 공유한다.
  const dataByNumeric = useMemo(() => {
    const map = new Map<string, RegionDatum>();
    for (const m of geo.markets) {
      const datum: RegionDatum = {
        market: m,
        label: rhqLabel(m.region, locale === "en" ? "en" : "ko") ?? m.region,
      };
      for (const iso of countriesForRhq(m.region)) {
        const num = GEO_COUNTRY_NUMERIC[iso];
        if (num) map.set(num, datum);
      }
    }
    return map;
  }, [geo, locale]);

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
  const shapes = useMemo(
    () =>
      features
        .map((f) => {
          const id = String(f.id);
          return { id, d: path(f), datum: dataByNumeric.get(id) };
        })
        .filter((s): s is GeoShape => Boolean(s.d)),
    [features, path, dataByNumeric],
  );

  // 안정적인 아이덴티티 — GeoShapes(memo)가 hover 리렌더에 딸려 들어가지 않도록.
  const handleHover = useCallback((datum: RegionDatum, clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    setHover({ datum, x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) });
  }, []);
  const handleLeave = useCallback(() => setHover(null), []);

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
          <GeoShapes shapes={shapes} metric={metric} onHover={handleHover} onLeave={handleLeave} />
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

      <Legend ourLabel={geo.ourLabel} metric={metric} metricLabel={metricLabel} />
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
export function metricOpacity(m: GeoRegionRow, metric: OverviewKpiKey): number {
  const v = metricValue(m, metric);
  if (v == null) return 0.16;
  if (metric === "position") {
    const t = Math.max(0, Math.min(1, (30 - v) / 29));
    return 0.16 + t * 0.84;
  }
  return sovOpacity(v);
}

function formatMetric(v: number | null, metric: OverviewKpiKey, rankUnit: string): string {
  if (v == null) return "—";
  return metric === "position" ? rankUnit.replace("{n}", v.toFixed(1)) : `${v.toFixed(1)}%`;
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
  const tOv = useTranslations("dashboard.overview");
  const { market, label } = datum;
  const rival = market.metrics?.[metric]?.rival;
  // 커서 오른쪽 위. 우측 가장자리에서 잘리지 않게 translate 로 좌측 전환.
  const flipX = x > W * 0.6;
  // 선두(lead) 줄은 헤드라인과 중복일 때(단일 보유 브랜드 = 라벨과 동일) 숨긴다.
  // admin(라벨 "HMG", 합산)에서는 최강 단일 브랜드라 의미가 있어 노출.
  const showLead = market.topBrand && market.topBrand.name !== ourLabel;
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
          value={formatMetric(metricValue(market, metric), metric, tOv("rankUnit"))}
          strong
        />
        {metric === "shareOfVoice" && showLead && market.topBrand ? (
          <Stat
            label={t("lead")}
            value={`${market.topBrand.name} ${market.topBrand.sov.toFixed(1)}%`}
          />
        ) : null}
        {rival ? (
          <Stat label={t("rival")} value={`${rival.name} ${formatMetric(rival.value, metric, tOv("rankUnit"))}`} />
        ) : metric === "shareOfVoice" && market.topRival ? (
          <Stat
            label={t("rival")}
            value={`${market.topRival.name} ${market.topRival.sov.toFixed(1)}%`}
          />
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
function Legend({ ourLabel, metric, metricLabel }: { ourLabel: string; metric: OverviewKpiKey; metricLabel?: string }) {
  const t = useTranslations("dashboard.geo");
  // 우선 노출도는 방향이 반대(낮을수록 진함) — 범례 스텝도 뒤집는다.
  const steps = metric === "position" ? [25, 19, 13, 7, 1] : [10, 25, 40, 55, 70];
  return (
    <div className="flex items-center gap-2 border-t border-border pt-3 text-[11px] text-muted-foreground">
      <span>{t("map.legendLow")}</span>
      <div className="flex h-3 overflow-hidden rounded-sm">
        {steps.map((s) => (
          <span
            key={s}
            className="block h-3 w-6 bg-[var(--color-brand-700)]"
            style={{ opacity: metric === "position" ? 0.16 + Math.max(0, Math.min(1, (30 - s) / 29)) * 0.84 : sovOpacity(s) }}
          />
        ))}
      </div>
      <span>{t("map.legendHigh")}</span>
      <span className="ml-1">· {metricLabel ?? t("map.share", { brand: ourLabel })}</span>
    </div>
  );
}
