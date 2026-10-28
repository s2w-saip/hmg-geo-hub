"use client";

// Overview "국가별 GEO 현황"(디자인 611:135, 2026-09-02) — KPI 칩 5 · 국가 선택(다중·검색,
// 디자이너 주석) · 시장 지도(선택 KPI 로 채색) · 권역/국가 트리표(값 막대 + 최대 경쟁사).
// 데이터는 overview/geo 의 GeoView: 권역→국가 행마다 KPI 값·최대 경쟁사가 계산돼 오고, 국가 메뉴의
// 순서(현지화 이름순)·권역 묶음, 지도 바인딩과 색 범위도 API 가 낸다. 국가 선택·검색은 화면 상태라
// 여기서 좁힌다 — 권역 행 값은 그대로(권역 합계), 국가 행만 선택된 것으로 줄어든다(선택이 있을 때만
// 지도 색 범위를 보이는 국가로 다시 잡는다).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronDown, Search, SquareMinus, SquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { countryName } from "@/lib/geo-catalog";
import { rhqLabel } from "@/lib/rhq";
import type { GeoCountryView, GeoRegionView, GeoView } from "../_data/screen-types";
import { OVERVIEW_KPI_KEYS, type OverviewKpiKey } from "../_data/overview-metrics";
import { GeoMapLazy } from "./geo-map-lazy";

// "빈 집합 = 전체" 는 내부 의미(및 있다면 URL 파라미터)의 정본이라 바꾸지 않는다
// (QA #9). 다만 사용자가 **명시적으로 전부 해제**했다는 상태는 빈 집합으로 표현할
// 수 없다(빈 집합은 이미 "전체"를 뜻하므로) — 실제 국가 코드가 아닌 sentinel 하나를
// 넣어 그 상태만 구분한다. `picked.has(c.code)`/`filteredGeo` 는 실제 코드만 보므로
// 이 값이 섞여 있어도 필터링 동작은 그대로다(전부 해제 시 자연히 모든 국가가 걸러짐).
const NONE_SENTINEL = "__none__";

// 국가 드롭다운 상태 산식 — 컴포넌트 본문과 유닛 테스트가 같은 정본을 쓴다(렌더
// 테스트가 Portal 기반 드롭다운 내용을 정적 렌더로 볼 수 없어, 로직은 여기서
// export 해 직접 검증한다).

/** sentinel 을 뺀 "실제로 체크된 국가 수". */
export function realPickedCount(picked: Set<string>): number {
  return picked.size === 1 && picked.has(NONE_SENTINEL) ? 0 : picked.size;
}

/** 트리거 라벨·헤더 트라이스테이트가 공유하는 "전체 선택됨" 판정. */
export function countryMenuAllChecked(picked: Set<string>, countries: { code: string }[]): boolean {
  return picked.size === 0 || (countries.length > 0 && realPickedCount(picked) === countries.length);
}

/** 개별 국가 항목의 체크 여부(빈 집합=전체 의미 반영). */
export function isCountryChecked(picked: Set<string>, code: string): boolean {
  return picked.size === 0 ? true : picked.has(code);
}

/** 상단 "전체 선택"/"전체 선택 해제" 토글. */
export function toggleAllCountries(picked: Set<string>, countries: { code: string }[]): Set<string> {
  return countryMenuAllChecked(picked, countries) ? new Set([NONE_SENTINEL]) : new Set();
}

// 아래 두 토글은 "빈 집합=전체" 를 먼저 전체 코드로 구체화한 뒤 mutate 하고,
// 결과가 다시 빈 집합이 되면 그 빈 집합이 "전체"로 오독되지 않도록 NONE_SENTINEL
// 로 되접는다 — 마지막 국가/권역 하나를 해제해도 "전부 해제됨"이 유지된다.

/** 국가 하나를 선택/해제. */
export function toggleSingleCountry(picked: Set<string>, countries: { code: string }[], code: string, select: boolean): Set<string> {
  const next = picked.size === 0 ? new Set(countries.map((c) => c.code)) : new Set(picked);
  next.delete(NONE_SENTINEL);
  if (select) next.add(code);
  else next.delete(code);
  return next.size === 0 ? new Set([NONE_SENTINEL]) : next;
}

/** 권역 헤더의 트라이스테이트(checked/indeterminate/unchecked) — regionCodes 는 그 권역의(검색 필터 적용된) 국가 코드. */
export function regionCheckState(picked: Set<string>, regionCodes: string[]): boolean | "indeterminate" {
  if (regionCodes.length === 0) return false;
  const checkedCount = regionCodes.filter((code) => isCountryChecked(picked, code)).length;
  if (checkedCount === 0) return false;
  if (checkedCount === regionCodes.length) return true;
  return "indeterminate";
}

/** 권역 헤더 클릭 = 그 권역(현재 검색으로 보이는 항목)을 일괄 선택/해제. */
export function toggleRegionCountries(picked: Set<string>, countries: { code: string }[], regionCodes: string[], select: boolean): Set<string> {
  const next = picked.size === 0 ? new Set(countries.map((c) => c.code)) : new Set(picked);
  next.delete(NONE_SENTINEL);
  regionCodes.forEach((code) => (select ? next.add(code) : next.delete(code)));
  return next.size === 0 ? new Set([NONE_SENTINEL]) : next;
}

export function GeoOverview({
  geo,
  initialMetric = "visibility",
  initialCountries,
  title,
  renewal = false,
}: {
  geo: GeoView;
  /** 렌더 테스트 seam. */
  initialMetric?: OverviewKpiKey;
  initialCountries?: string[];
  title?: string;
  /** 리뉴얼 Overview(2026-10-28): 리뉴얼 카드 틀·카드 제목 크기(rn 토큰), 위아래 여백을 줄인다. */
  renewal?: boolean;
}) {
  const t = useTranslations("dashboard.overview");
  const tKpi = useTranslations("dashboard.kpi.name");
  const tUnit = useTranslations("metricUnit");
  const locale = useLocale();
  const [metric, setMetric] = useState<OverviewKpiKey>(initialMetric);
  const [picked, setPicked] = useState<Set<string>>(new Set(initialCountries ?? []));
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set(geo.markets.map((m) => m.region)));
  const [activeCountry, setActiveCountry] = useState<string | null>(null);
  const countryListRef = useRef<HTMLDivElement>(null);
  const hoverSource = useRef<"map" | "list">("list");

  // 국가 메뉴 — API 가 정한 순서(현지화 이름순)·권역 묶음에 표시명만 붙인다.
  const countries = useMemo(
    () => geo.countryOrder.map((code) => ({ code, name: countryName(code, locale) })),
    [geo, locale],
  );
  const regionOfCountry = useMemo(
    () => new Map(geo.countryGroups.flatMap((g) => g.codes.map((code) => [code, g.region] as const))),
    [geo],
  );
  const hoverCountryFromMap = useCallback((code: string | null) => {
    hoverSource.current = "map";
    setActiveCountry(code);
    const region = code ? regionOfCountry.get(code) : undefined;
    if (region !== undefined) setOpen(current => current.has(region) ? current : new Set([...current, region]));
  }, [regionOfCountry]);
  const hoverCountryFromList = useCallback((code: string | null) => {
    hoverSource.current = "list";
    setActiveCountry(code);
  }, []);
  useEffect(() => {
    if (!activeCountry || hoverSource.current !== "map") return;
    const list = countryListRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-geo-country="${CSS.escape(activeCountry)}"]`);
    if (!list || !row) return;
    const box = list.getBoundingClientRect();
    const target = row.getBoundingClientRect();
    const header = list.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    // Scroll the list only. A map hover must never move the page itself.
    if (target.top < box.top + header) list.scrollTop -= box.top + header - target.top;
    else if (target.bottom > box.bottom) list.scrollTop += target.bottom - box.bottom;
  }, [activeCountry, open]);
  const filteredGeo: GeoView = useMemo(() => {
    if (picked.size === 0) return geo;
    const markets = geo.markets
      .map((m) => ({ ...m, countries: m.countries.filter((c) => picked.has(c.code)) }))
      .filter((m) => m.countries.length > 0);
    return { ...geo, markets };
  }, [geo, picked]);
  // 지도 색 범위 — 선택이 없으면 API 의 범위, 국가를 골랐으면 보이는 국가들로 다시 잡는다(화면 상태 의존).
  const mapDomain = picked.size === 0 ? geo.domains[metric] : pickedDomain(filteredGeo, metric);
  const label = (regionId: string) => regionId ? rhqLabel(regionId, locale === "en" ? "en" : "ko") ?? regionId : t("geo.unassignedRegion");
  const metricLabel = tKpi(metric);
  // QA #9 — 화면 기본값(빈 집합)은 "전체"를 뜻하지만, 기존엔 이 상태에서 드롭다운
  // 체크박스가 전부 비어 보였다(내부 의미와 표시가 불일치). realPickedCount 는
  // sentinel 을 뺀 "실제로 체크된 국가 수" — 트리거 라벨·"전체 선택" 판정 모두 이걸 쓴다.
  const pickedCount = realPickedCount(picked);
  const allChecked = countryMenuAllChecked(picked, countries);
  const filteredCountries = countries.filter((c) => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase()));
  // 드롭다운은 국가를 권역별로 묶어 보여준다(11) — 순서는 geo.markets 순서, 헤더는
  // 트라이스테이트 체크(전부/일부/없음)로 그 권역 국가를 일괄 토글한다.
  const shown = new Set(filteredCountries.map((c) => c.code));
  const groupedCountries = geo.countryGroups
    .map((g) => ({ region: g.region, items: g.codes.filter((code) => shown.has(code)).map((code) => ({ code, name: countryName(code, locale) })) }))
    .filter((g) => g.items.length > 0);
  // 우선 노출도 단위는 지면 공통 정본(`metricUnit.position`)이다. Overview KPI 카드·
  // 답변분석 탭·지도 툴팁이 같은 키를 쓴다(표기 드리프트 방지).
  const fmt = (v: number | null) => (v == null ? "—" : metric === "position" ? tUnit("position", { n: v.toFixed(1) }) : `${v.toFixed(1)}%`);
  // 막대 길이 — 비율은 값 그대로, 순위는 (30 − 값)/29 로 뒤집는다(낮을수록 길게).
  const barPct = (v: number | null) => (v == null ? 0 : metric === "position" ? Math.max(4, Math.min(100, ((30 - v) / 29) * 100)) : Math.max(0, Math.min(100, v)));

  if (geo.markets.length === 0) {
    return (
      <section className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{t("geo.title")}</h3>
        <p className="mt-2 text-xs text-muted-foreground">{t("geo.brandRequired")}</p>
      </section>
    );
  }

  return (
    // 피그마 611:135 GEO 섹션: px-6 py-8·gap-5, 제목 20px, 국가 선택은 칩 행 우측.
    <section
      className={renewal ? "flex flex-col gap-4 rounded-rn-card bg-rn-surface px-6 pt-[18px] pb-6 shadow-rn-card" : "flex flex-col gap-5 rounded-lg border border-border bg-card px-6 py-8"}
      aria-labelledby="geo-overview-heading"
    >
      <header className="flex">
        <h3 id="geo-overview-heading" className={renewal ? "m-0 text-rn-16 font-bold tracking-[-0.01em] text-rn-ink" : "text-xl font-semibold tracking-tight text-foreground/80"}>
          {title ?? t("geo.title")}
        </h3>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label={t("geo.kpiSelector")}>
        {OVERVIEW_KPI_KEYS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={metric === k}
            onClick={() => setMetric(k)}
            className={cn(
              // QA #10 — "기본 AI 노출률/AI 점유율" 칩과 비슷한 크기로(기존 min-w-[100px]
              // text-sm 은 과도하게 컸다). 나머지 앱의 소형 pill(EngineChip/TypeChip)과 동일 크기.
              "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
              metric === k ? "border-brand-700 bg-brand-700 text-primary-foreground" : "border-ink-300 bg-card text-ink-500 hover:text-foreground",
            )}
          >
            {tKpi(k)}
          </button>
        ))}
      </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="h-8 w-32 justify-between rounded-md pl-2.5 pr-2 text-xs font-medium text-foreground">
              {allChecked ? t("geo.countryAll") : t("geo.selected", { n: pickedCount })}
              <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <div className="relative px-2 py-1.5">
              <Search className="pointer-events-none absolute top-1/2 left-4 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("geo.countrySearch")} aria-label={t("geo.countrySearch")} className="h-8 pl-8 text-xs" onKeyDown={(e) => e.stopPropagation()} />
            </div>
            {/* QA #9 — 전체가 선택된 상태에서는 "전체 선택"이 아니라 "전체 선택 해제"로
                읽혀야 하고, 누르면 실제로 전부 해제된다(NONE_SENTINEL). 내부 "빈 집합=전체"
                의미는 그대로다 — 다시 "전체 선택"을 누르면 빈 집합으로 돌아간다. */}
            <DropdownMenuItem onSelect={() => setPicked(toggleAllCountries(picked, countries))}>
              {allChecked ? t("geo.deselectAll") : t("geo.selectAll")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <div className="max-h-64 overflow-y-auto">
              {groupedCountries.map((g) => {
                const regionCodes = g.items.map((c) => c.code);
                const regionState = regionCheckState(picked, regionCodes);
                return (
                  <div key={g.region}>
                    {/* 권역 헤더 — 전부/일부/없음 = checked/indeterminate/unchecked
                        (11). 항목과 같은 DropdownMenuCheckboxItem 을 재사용해 체크
                        UI 를 일관되게 유지한다(indeterminate 지원은 components/ui/
                        dropdown-menu.tsx 의 MinusIcon 분기). */}
                    <DropdownMenuCheckboxItem
                      checked={regionState}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(v) => setPicked(toggleRegionCountries(picked, countries, regionCodes, !!v))}
                      className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase data-[state=checked]:text-brand-700 data-[state=indeterminate]:text-brand-700"
                    >
                      {label(g.region)}
                    </DropdownMenuCheckboxItem>
                    {g.items.map((c) => (
                      <DropdownMenuCheckboxItem
                        key={c.code}
                        // 화면 기본값(빈 집합=전체)에서도 체크박스는 전부 체크로 보여야 한다
                        // (QA #9) — 내부 판정(isCountryChecked)은 개별 해제 후에도 그대로 쓴다.
                        checked={isCountryChecked(picked, c.code)}
                        onSelect={(e) => e.preventDefault()}
                        onCheckedChange={(v) => setPicked(toggleSingleCountry(picked, countries, c.code, !!v))}
                        className="pl-10"
                      >
                        {c.name}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </div>
                );
              })}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <GeoMapLazy geo={filteredGeo} metric={metric} metricLabel={metricLabel} bare level="country" domain={mapDomain ?? undefined} activeCountry={activeCountry} onCountryHover={hoverCountryFromMap} />
        <div className="min-h-0 lg:relative" data-geo-list-frame>
        <div ref={countryListRef} role="region" aria-label={t("geo.countryList")} tabIndex={0} className="max-h-[360px] overflow-auto overscroll-contain [scrollbar-gutter:stable] lg:absolute lg:inset-0 lg:max-h-none" data-geo-country-list>
          <table className="w-full text-xs" data-geo-table>
            <thead className="sticky top-0 z-10">
              <tr className="h-[30px] border-b border-border bg-bg-soft text-left text-[11px] text-foreground">
                <th scope="col" className="px-5 font-medium">{t("geo.colRegion")}</th>
                <th scope="col" className="px-5 font-medium">{metricLabel}</th>
                <th scope="col" className="px-5 font-medium text-right">{t("geo.colRival")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredGeo.markets.map((m) => (
                <RegionRows
                  key={m.region}
                  market={m}
                  label={label(m.region)}
                  open={open.has(m.region)}
                  onToggle={() => setOpen((cur) => { const n = new Set(cur); if (n.has(m.region)) n.delete(m.region); else n.add(m.region); return n; })}
                  metric={metric}
                  fmt={fmt}
                  barPct={barPct}
                  countryLabel={(code) => countryName(code, locale)}
                  activeCountry={activeCountry}
                  onCountryHover={hoverCountryFromList}
                />
              ))}
            </tbody>
          </table>
        </div>
        </div>
      </div>
    </section>
  );
}

/** 국가를 고른 화면의 지도 색 범위 — 보이는 국가(지도 폴리곤 id 기준, 뒤의 행이 이긴다)의 값 최소·최대. */
function pickedDomain(geo: GeoView, metric: OverviewKpiKey): [number, number] | null {
  const byNumeric = new Map<string, GeoCountryView>();
  for (const m of geo.markets) for (const c of m.countries) if (c.numeric) byNumeric.set(c.numeric, c);
  const values = [...byNumeric.values()].map((c) => c.values[metric]).filter((v): v is number => v != null);
  return values.length ? [Math.min(...values), Math.max(...values)] : null;
}

function RivalCell({ m, metric, fmt }: { m: GeoRegionView | GeoCountryView; metric: OverviewKpiKey; fmt: (v: number | null) => string }) {
  const t = useTranslations("dashboard.overview");
  const rival = m.rivals[metric];
  if (!rival) return <span className="text-muted-foreground">{t("geo.noRival")}</span>;
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-medium text-foreground">{rival.name}</span>
      <span className="tabular-nums text-muted-foreground">{fmt(rival.value)}</span>
    </span>
  );
}

function ValueCell({ v, fmt, barPct, strong }: { v: number | null; fmt: (v: number | null) => string; barPct: (v: number | null) => number; strong?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span className={cn("w-14 shrink-0 tabular-nums", strong ? "font-semibold text-foreground" : "text-foreground")}>{fmt(v)}</span>
      <span className={cn("flex-1 overflow-hidden rounded-full bg-muted", strong ? "h-2.5" : "h-2")}>
        <span className={cn("block h-full rounded-full", strong ? "bg-brand-700" : "bg-brand-300")} style={{ width: `${barPct(v)}%` }} />
      </span>
    </span>
  );
}

function RegionRows({ market, label, open, onToggle, metric, fmt, barPct, countryLabel, activeCountry, onCountryHover }: {
  market: GeoRegionView; label: string; open: boolean; onToggle: () => void; metric: OverviewKpiKey;
  fmt: (v: number | null) => string; barPct: (v: number | null) => number; countryLabel: (code: string) => string;
  activeCountry: string | null;
  onCountryHover: (code: string | null) => void;
}) {
  return (
    <>
      <tr className="h-[38px] border-b border-border/60 bg-brand-50/60">
        <th scope="row" className="px-5 text-left font-semibold text-foreground">
          <button type="button" onClick={onToggle} aria-expanded={open} className="inline-flex items-center gap-1.5">
            {/* 피그마: ⊟ / ⊞ 트리 토글 */}
            {open ? <SquareMinus className="h-3 w-3" aria-hidden /> : <SquarePlus className="h-3 w-3" aria-hidden />}
            {label}
          </button>
        </th>
        <td className="px-5"><ValueCell v={market.values[metric]} fmt={fmt} barPct={barPct} strong /></td>
        <td className="px-5 text-right"><RivalCell m={market} metric={metric} fmt={fmt} /></td>
      </tr>
      {open ? market.countries.map((c) => (
        <tr key={c.code} tabIndex={0} data-highlighted={activeCountry === c.code ? "true" : undefined}
          onMouseEnter={() => onCountryHover(c.code)} onMouseLeave={() => onCountryHover(null)}
          onFocus={() => onCountryHover(c.code)} onBlur={() => onCountryHover(null)}
          className={cn("h-[38px] border-b border-border/60 transition-colors focus-visible:outline-2 focus-visible:outline-brand-700", activeCountry === c.code && "bg-brand-50 ring-1 ring-inset ring-brand-300")} data-geo-country={c.code}>
          <th scope="row" className="px-5 pl-10 text-left font-normal text-foreground">{countryLabel(c.code)}</th>
          <td className="px-5"><ValueCell v={c.values[metric]} fmt={fmt} barPct={barPct} /></td>
          <td className="px-5 text-right"><RivalCell m={c} metric={metric} fmt={fmt} /></td>
        </tr>
      )) : null}
    </>
  );
}
