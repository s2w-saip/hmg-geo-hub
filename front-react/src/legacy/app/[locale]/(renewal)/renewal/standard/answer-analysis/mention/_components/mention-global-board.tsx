"use client";

import { use, useDeferredValue, useMemo, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "use-intl";
import { ChevronRight, Eye, MessageSquare, PieChart, Search, Smile, Trophy, Users, X } from "lucide-react";
import { RnCardHead, RnEmpty, RnSegmented, RnSparkline, RnTag, RnTextButton, cx } from "@/components/renewal-ui";
import { NON_AUTO_GROUP, OWN_KEY, TREEMAP_FOLD, type RankingRow, type RankingSortKey } from "../_data/screen-types";
import { MentionCardActions, OWN_COLOR, numTxt, pctTxt, posTxt, useCompare, useMention } from "./mention-context";
import { DeltaChip, InfoTip } from "./mention-kit";
import { BumpView, RANK_TABLE_STEP, Treemap, rankTableRows, rowsInOrder, useBumpCsv } from "./mention-brands";
import { KPI_KEY } from "./mention-global-trends";

// 경쟁 비교 tab, 브랜드 비교 (2026-11-05 Mention 개편): one card for the brand standings, opening on 순위 변화 (the weekly rank
// chart), with the table that merges the original's 경쟁사 분석(노출률 · 점유율) · 우선 노출도 순위표 · 브랜드 언급 순위 (every
// column of each, plus 우호도), the treemap (a compare brand's parent group ringed in its colour) and 순위별 보기 (the rank
// table as a ladder). Every value is a BFF value; the sorts are the API's orders (우호도: the drawer rows' positive share).

type View = "bump" | "table" | "map" | "ladder";
type SortKey = RankingSortKey | "fav";
const ASC: readonly SortKey[] = ["rank", "brand", "avgPosition"];

export function GlobalBrandBoard() {
  const { input, openDrawer } = useMention();
  const { compare, colorOf } = useCompare();
  const t = useTranslations("renewal.mention");
  const tTm = useTranslations("renewal.mention.treemap");
  const ranking = use(input.ranking);
  const hero = use(input.rateHero);
  const bump = use(input.bump);
  const [view, setView] = useState<View>("bump");
  const [group, setGroup] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const bumpCsv = useBumpCsv();
  const tableCsv = useTableCsv();
  const rankCsv = useRankCsv();
  const groupName = (g: string, several = false) => (g === NON_AUTO_GROUP ? tTm("nonAuto") : g === TREEMAP_FOLD ? tTm("fold") : several && g !== "HMG" ? tTm("groupName", { name: g }) : g);
  // the original board's chips: snapshot or period, and the trend axis's unmeasured rounds (2026-11-05)
  const b = hero.sov.board;
  const unmeasured = b.axis.length - b.measuredCycles;
  const trend = unmeasured > 0 ? t("board.chipTrendGaps", { n: b.axis.length, m: b.measuredCycles, u: unmeasured }) : t("board.chipTrend", { n: b.measuredCycles });
  return (
    <>
      <RnCardHead
        icon={<Users />}
        title={t("g.boardTitle")}
        info={<InfoTip label={t("g.boardTitle")} items={[[t("g.boardTitle"), t("g.boardInfo")]]} />}
        chips={
          <span className="text-rn-12 text-rn-muted">
            {view === "bump" ? t("bump.chip", { n: bump.data?.x.length ?? 0 }) : t("g.boardNote", { n: numTxt(ranking.count), basis: t(input.period ? "board.chipPeriod" : "board.chipSnapshot"), trend })}
          </span>
        }
        controls={
          <>
            {view === "table" ? (
              <label className="inline-flex h-9 w-[230px] items-center gap-2 rounded-[10px] px-3 text-rn-12 text-rn-muted shadow-[inset_0_0_0_1px_var(--color-rn-line)] focus-within:shadow-[inset_0_0_0_1.5px_var(--color-rn-navy-300)]">
                <Search className="size-3.5" aria-hidden />
                <input value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("g.search")} placeholder={t("g.searchPlaceholder")} className="min-w-0 flex-1 bg-transparent text-rn-ink outline-none placeholder:text-rn-muted" />
              </label>
            ) : null}
            <RnSegmented
              label={t("g.boardView")}
              value={view}
              onChange={setView}
              items={[
                { value: "bump", label: t("g.viewBump") },
                { value: "table", label: t("g.viewTable") },
                { value: "map", label: t("g.viewMap") },
                { value: "ladder", label: t("g.viewLadder") },
              ]}
            />
          </>
        }
        actions={<MentionCardActions tableId={view === "bump" ? "bump" : undefined} section="sec-g-board" csv={view === "bump" ? bumpCsv : view === "ladder" ? rankCsv : tableCsv} />}
      />
      {view === "bump" ? (
        <div className="px-5 pb-5">
          <BumpView />
        </div>
      ) : view === "map" ? (
        <Treemap
          groups={ranking.treemap.off}
          multi={false}
          groupName={groupName}
          onBrand={(b) => openDrawer({ kind: "brand", brand: b })}
          onGroupTable={(g) => {
            setGroup(g);
            setView("table");
          }}
          ringOf={(brands) => {
            const b = compare.find((x) => brands.includes(x));
            return b ? colorOf(b) : null;
          }}
        />
      ) : view === "ladder" ? (
        <Ladder />
      ) : (
        <BoardTable query={q} group={group} groupName={groupName} onClearGroup={() => setGroup(null)} />
      )}
    </>
  );
}

// ── the merged table ───────────────────────────────────────────────────────────

interface Cells {
  exp: number | null;
  expD: number | null;
  share: number | null;
  shareD: number | null;
  shareCovered: boolean;
  pos: number | null;
  posD: number | null;
  fav: number | null;
  mentions: number | null;
  prompts: number | null;
  spark: { exp: (number | null)[]; share: (number | null)[]; pos: (number | null)[] };
}

/** The values of a ranking row and of 당사's row, from the screens that hold them (BFF values, none computed here). */
function useCells() {
  const { input, drawer } = useMention();
  const hero = use(input.rateHero);
  const rank = use(input.rank);
  const value = use(input.rateValue);
  const favor = use(input.favorHero);
  const expBy = new Map(hero.exposure.board.rows.map((r) => [r.key, r]));
  const sovBy = new Map(hero.sov.board.rows.map((r) => [r.key, r]));
  const rankBy = new Map(rank.rows.map((r) => [r.key, r]));
  const favOf = (r: RankingRow) => (drawer.find((d) => d.brand === r.brand) ?? r.drawer)?.sentimentPct?.positive ?? null;
  const ofRow = (r: RankingRow): Cells => ({
    exp: r.off.mentionRate,
    expD: expBy.get(r.brand)?.delta ?? null,
    share: r.off.share,
    shareD: r.off.delta,
    shareCovered: r.off.covered,
    pos: r.avgPosition,
    posD: rankBy.get(r.brand)?.delta ?? null,
    fav: favOf(r),
    mentions: r.off.mentions,
    prompts: r.off.prompts,
    spark: { exp: expBy.get(r.brand)?.spark ?? [], share: sovBy.get(r.brand)?.spark ?? [], pos: rankBy.get(r.brand)?.spark ?? [] },
  });
  const own: Cells = {
    exp: value.exposure.pct,
    expD: hero.exposure.delta.value,
    share: value.sov.pct,
    shareD: hero.sov.delta.value,
    shareCovered: true,
    pos: rank.hero.avgPosition,
    posD: rank.hero.delta.value,
    fav: favor.positivePct,
    // 당사 브랜드 언급 수 (the share's numerator)
    mentions: value.sov.numerator,
    prompts: null,
    spark: { exp: expBy.get(OWN_KEY)?.spark ?? [], share: sovBy.get(OWN_KEY)?.spark ?? [], pos: rankBy.get(OWN_KEY)?.spark ?? [] },
  };
  return { ofRow, own, favOf };
}

function useTableCsv() {
  const { input, ownLabel } = useMention();
  const t = useTranslations("renewal.mention");
  const tT = useTranslations("answerAnalysis.mentions.table");
  const tName = useTranslations("dashboard.kpi.name");
  const ranking = use(input.ranking);
  const { ofRow, own } = useCells();
  return () => ({
    name: "brand-mentions",
    rows: [
      // the original columns first (#, 브랜드, 언급 수, 점유율, 증감, 평균 위치, 프롬프트, 언급률), then the merged boards'
      ["#", tT("col.brand"), tT("col.mentions"), tT("col.share"), t("brands.colDelta"), tT("col.position"), tT("col.prompts"), tT("col.rate"), `${tName(KPI_KEY.exposure)} ${t("brands.colDelta")}`, `${tName(KPI_KEY["first-rank"])} ${t("brands.colDelta")}`, tName(KPI_KEY.favorability)],
      ["", ownLabel, own.mentions, own.share, own.shareD, own.pos, own.prompts, own.exp, own.expD, own.posD, own.fav],
      ...ranking.rows.map((r) => {
        const c = ofRow(r);
        return [r.rank, r.brand, c.mentions, c.share, c.shareD, c.pos, c.prompts, c.exp, c.expD, c.posD, c.fav];
      }),
    ],
  });
}

function useRankCsv() {
  const { input, ownLabel } = useMention();
  const t = useTranslations("renewal.mention");
  const rank = use(input.rank);
  return () => ({
    name: "mention-first-position",
    rows: [["#", t("board.colBrand"), t("rank.colAvg"), t("rank.colWow"), t("rank.colGap")], ...rank.rows.map((r, i) => [i + 1, r.key === OWN_KEY ? ownLabel : r.key, r.avgPosition, r.delta, r.gap])],
  });
}

function BoardTable({ query, group, groupName, onClearGroup }: { query: string; group: string | null; groupName: (g: string, several?: boolean) => string; onClearGroup: () => void }) {
  const { input, ownLabel, openDrawer, lit, hover } = useMention();
  const { compare, covered, colorOf, toggle } = useCompare();
  const t = useTranslations("renewal.mention");
  const tT = useTranslations("answerAnalysis.mentions.table");
  const tName = useTranslations("dashboard.kpi.name");
  const tD = useTranslations("dashboard.filters");
  const tTr = useTranslations("answerAnalysis.mentions.kpi.overview.unmeasuredDialog");
  const locale = useLocale();
  const ranking = use(input.ranking);
  const { ofRow, own, favOf } = useCells();
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "rank", dir: "asc" });
  const [ownOpen, setOwnOpen] = useState(true);
  const dq = useDeferredValue(query);
  const listKey = `${dq.trim().toLowerCase()}\u0000${group ?? ""}`;
  const [more, setMore] = useState({ key: listKey, limit: RANK_TABLE_STEP });
  const limit = more.key === listKey ? more.limit : RANK_TABLE_STEP;
  const ownRows = useMemo(() => ranking.rows.filter((r) => r.own), [ranking.rows]);
  const ordered = useMemo(() => {
    // the API's orders index the whole row list: order first, then leave the own brands out (they sit under 당사's row)
    if (sort.key !== "fav") return rowsInOrder(ranking.rows, ranking.orders.off, sort.key, sort.dir).filter((r) => !r.own);
    const list = ranking.rows.filter((r) => !r.own);
    // 우호도 has no API order: the drawer rows' positive share, high first (a missing share last), ties in rank order
    return [...list].sort((a, b) => {
      const fa = favOf(a);
      const fb = favOf(b);
      if (fa == null || fb == null) return fa == null ? (fb == null ? a.rank - b.rank : 1) : -1;
      return (sort.dir === "asc" ? fa - fb : fb - fa) || a.rank - b.rank;
    });
  }, [ranking.rows, ranking.orders.off, sort, favOf]);
  const { rows, matched } = rankTableRows(ordered, dq, group, limit);
  // the cut note counts the list being cut: every rival (the backend's count if it cut the list), or the matches
  const listTotal = !dq.trim() && !group && ranking.total !== undefined && ranking.total > ranking.count ? ranking.total - ownRows.length : matched;
  const trendOf = (c: Cells) => (sort.key === "mentionRate" ? c.spark.exp : sort.key === "avgPosition" ? c.spark.pos : c.spark.share);
  const trendLabel = sort.key === "mentionRate" ? tName(KPI_KEY.exposure) : sort.key === "avgPosition" ? tName(KPI_KEY["first-rank"]) : tName(KPI_KEY.sov);
  const onSort = (k: SortKey) => setSort((s) => (s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: ASC.includes(k) ? "asc" : "desc" }));
  const tB = (k: string) => t(`brands.${k}`);
  const def = (d: string, f?: string): ReadonlyArray<[string, string]> => (f ? [[tB("defLabel"), d], [tB("formulaLabel"), f]] : [[tB("defLabel"), d]]);
  const info: Partial<Record<SortKey, ReadonlyArray<[string, string]>>> = {
    rank: def(tT("colDefinition.rank")),
    mentionRate: def(tT("colDefinition.rate"), tT("colFormula.rate")),
    share: def(tT("colDefinition.share"), tT("colFormula.share")),
    delta: def(tB(input.period ? "deltaInfoPeriod" : "deltaInfo")),
    avgPosition: def(tT("colDefinition.position")),
    fav: def(t("g.colFavDef")),
    mentions: def(tT("colDefinition.mentions")),
    prompts: def(tT("colDefinition.prompts")),
  };
  const ICONS: Partial<Record<SortKey, ReactNode>> = { mentionRate: <Eye />, share: <PieChart />, avgPosition: <Trophy />, fav: <Smile />, mentions: <MessageSquare /> };
  const head = (k: SortKey, label: string, right = true) => (
    <span className={cx("inline-flex min-w-0 items-center gap-1", right && "justify-end")}>
      <button
        type="button"
        onClick={() => onSort(k)}
        aria-sort={sort.key === k ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
        className={cx("inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap hover:text-rn-ink [&_svg]:size-3.5", sort.key === k ? "font-semibold text-rn-ink" : "font-medium text-rn-muted")}
      >
        {ICONS[k] ? <span aria-hidden className="text-rn-muted">{ICONS[k]}</span> : null}
        {label}
        {sort.key === k ? <span aria-hidden>{sort.dir === "asc" ? "↑" : "↓"}</span> : null}
      </button>
      {info[k] ? <InfoTip label={label} align={right ? "end" : undefined} items={info[k]} /> : null}
    </span>
  );
  const COLS = "grid-cols-[44px_40px_minmax(150px,1.3fr)_minmax(128px,1fr)_minmax(128px,1fr)_minmax(132px,1fr)_96px_96px_82px_96px_14px]";
  const cell = (v: string, d: ReactNode, on: boolean) => (
    <span className={cx("inline-flex items-center justify-end gap-1.5 tabular-nums", on ? "font-semibold text-rn-ink" : "text-rn-ink-2")}>
      {v}
      {d}
    </span>
  );
  const small = (v: number | null, rank: boolean, ownRow: boolean) => (v == null ? null : <span className={cx("text-rn-11", ownRow ? "" : "text-rn-muted")}><DeltaChip value={v} rank={rank} neutral={!ownRow} /></span>);
  const line = (c: Cells, kind: "own" | "sub" | "rival", name: ReactNode, key: string, extra: { rank?: number; picked?: boolean; canPick?: boolean; brand?: string; drawer?: RankingRow["drawer"] }) => {
    const on = lit.includes(key);
    const ownRow = kind !== "rival";
    const trend = trendOf(c);
    return (
      <div
        key={`${kind}-${key}`}
        role="row"
        data-rn-b={key}
        data-rn-row={kind}
        title={kind === "own" ? undefined : t("brands.rowTip")}
        onPointerEnter={() => hover(key)}
        onPointerLeave={() => hover(null)}
        onClick={kind === "own" ? undefined : () => openDrawer({ kind: "brand", brand: extra.brand!, row: extra.drawer })}
        className={cx(
          "grid w-full items-center gap-2.5 border-b border-rn-line px-5 text-left text-rn-13",
          COLS,
          kind === "sub" ? "min-h-11 bg-rn-page/50" : "min-h-[54px]",
          kind === "own" ? "bg-rn-navy-25/40" : "cursor-pointer hover:bg-rn-page",
          on && "bg-rn-navy-25",
        )}
      >
        <span>
          {kind === "rival" ? (
            <button
              type="button"
              role="checkbox"
              aria-checked={!!extra.picked}
              aria-label={t("g.pick", { brand: String(extra.brand) })}
              disabled={!extra.canPick}
              title={extra.canPick ? undefined : t(input.period ? "board.noPrevPeriodTip" : "board.noTrendTip")}
              onClick={(e) => {
                e.stopPropagation();
                toggle(extra.brand!);
              }}
              className="grid size-[18px] cursor-pointer place-items-center rounded-[6px] shadow-[inset_0_0_0_1.5px_var(--color-rn-faint)] hover:shadow-[inset_0_0_0_1.5px_var(--color-rn-navy-300)] disabled:cursor-default disabled:opacity-40"
              style={extra.picked ? { background: colorOf(extra.brand!), boxShadow: "none" } : undefined}
            >
              {extra.picked ? <span aria-hidden className="h-1 w-2 -translate-y-px -rotate-45 border-b-2 border-l-2 border-white" /> : null}
            </button>
          ) : kind === "own" ? (
            <i aria-hidden className="ml-1 inline-block size-2.5 rounded-full" style={{ background: OWN_COLOR }} />
          ) : null}
        </span>
        <span className="text-rn-12 text-rn-muted tabular-nums">{extra.rank ?? ""}</span>
        <span className="flex min-w-0 items-center gap-2.5">{name}</span>
        {cell(pctTxt(c.exp), small(c.expD, false, ownRow), sort.key === "mentionRate")}
        {cell(
          pctTxt(c.share),
          c.shareCovered ? (
            small(c.shareD, false, ownRow)
          ) : (
            <span className="text-rn-11 text-rn-muted" title={t(input.period ? "board.noPrevPeriodTip" : "board.noTrendTip")}>
              {t(input.period ? "board.noPrevPeriod" : "board.noTrend")}
            </span>
          ),
          sort.key === "share" || sort.key === "delta",
        )}
        {cell(posTxt(c.pos), small(c.posD, true, ownRow), sort.key === "avgPosition")}
        {cell(pctTxt(c.fav), null, sort.key === "fav")}
        {cell(numTxt(c.mentions, locale), null, sort.key === "mentions")}
        {cell(numTxt(c.prompts, locale), null, sort.key === "prompts")}
        <span className="justify-self-end">
          {trend.some((v) => v != null) ? (
            <span className="block w-[88px]">
              <RnSparkline values={trend} invert={sort.key === "avgPosition"} className="h-7" />
            </span>
          ) : (
            <span className="text-rn-11 text-rn-muted">—</span>
          )}
        </span>
        <span className="text-rn-faint">{kind === "own" ? "" : <ChevronRight className="size-3.5" aria-hidden />}</span>
      </div>
    );
  };
  const avatar = (brand: string, color: string | null, ownTint = false) => (
    <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full text-rn-12 font-semibold" style={color ? { background: `color-mix(in srgb, ${color} 14%, #fff)`, color: ownTint ? OWN_COLOR : "var(--color-rn-ink-2)" } : { background: "var(--color-rn-track)", color: "var(--color-rn-muted)" }}>
      {brand.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1).toUpperCase()}
    </span>
  );
  return (
    <div role="table" aria-label={t("g.boardTitle")} className="flex flex-col">
      {group || dq.trim() ? (
        <div className="flex flex-wrap items-center gap-2 px-5 pb-2.5 text-rn-12 text-rn-muted">
          {dq.trim() ? <span>{tD("searchResultCount", { matched, total: ordered.length })}</span> : null}
          {group ? (
            <span className="inline-flex h-7 items-center gap-1 rounded-full bg-rn-navy-25 pr-1 pl-2.5 font-semibold text-rn-navy">
              {t("brands.groupOnly", { group: groupName(group, true) })}
              <button type="button" aria-label={t("brands.clearGroup")} onClick={onClearGroup} className="grid size-5 cursor-pointer place-items-center rounded-full hover:bg-rn-navy/10">
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="min-w-[1080px]">
        <div role="row" className={cx("sticky top-10 z-[5] grid h-[42px] items-center gap-2.5 border-y border-rn-line bg-rn-page px-5 text-rn-12", COLS)}>
          <span className="text-rn-muted">{t("g.colPick")}</span>
          {head("rank", "#", false)}
          {head("brand", tT("col.brand"), false)}
          {head("mentionRate", tName(KPI_KEY.exposure))}
          <span className="flex min-w-0 items-center justify-end gap-2">
            {head("share", tName(KPI_KEY.sov))}
            {head("delta", t("brands.colDelta"))}
          </span>
          {head("avgPosition", tName(KPI_KEY["first-rank"]))}
          {head("fav", tName(KPI_KEY.favorability))}
          {head("mentions", tT("col.mentions"))}
          {head("prompts", tT("col.prompts"))}
          <span className="text-right font-medium text-rn-muted">{t("g.colTrend", { metric: trendLabel })}</span>
          <span />
        </div>
        {line(
          own,
          "own",
          <>
            <button type="button" aria-expanded={ownOpen} aria-label={t(ownOpen ? "g.ownCollapse" : "g.ownExpand")} onClick={() => setOwnOpen((o) => !o)} className={cx("grid size-5 cursor-pointer place-items-center rounded-[6px] text-rn-muted transition-transform hover:bg-rn-track", ownOpen && "rotate-90")}>
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
            {avatar(ownLabel, OWN_COLOR, true)}
            <b className="truncate font-semibold text-rn-navy">{ownLabel}</b>
            <RnTag>{t("board.own")}</RnTag>
          </>,
          OWN_KEY,
          {},
        )}
        {ownOpen
          ? ownRows.map((r) =>
              line(
                ofRow(r),
                "sub",
                <>
                  <span aria-hidden className="w-5" />
                  {avatar(r.brand, OWN_COLOR, true)}
                  <b className="truncate font-medium text-rn-ink-2">{r.brand}</b>
                </>,
                r.brand,
                { rank: r.rank, brand: r.brand, drawer: r.drawer },
              ),
            )
          : null}
        {!rows.length ? (
          <RnEmpty className="m-5">{tT("empty")}</RnEmpty>
        ) : (
          rows.map((r) => {
            const picked = compare.includes(r.brand);
            return line(
              ofRow(r),
              "rival",
              <>
                {avatar(r.brand, picked ? colorOf(r.brand) : null)}
                <b className="truncate font-semibold text-rn-ink">{r.brand}</b>
                {r.grouped ? <span className="inline-flex h-[22px] items-center rounded-[7px] px-2 text-rn-11 whitespace-nowrap text-rn-muted shadow-[inset_0_0_0_1px_var(--color-rn-line)]">{groupName(r.group, true)}</span> : null}
              </>,
              r.brand,
              { rank: r.rank, picked, canPick: covered.includes(r.brand), brand: r.brand, drawer: r.drawer },
            );
          })
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3.5 px-5 pt-3 pb-4 text-rn-12 text-rn-muted">
        {rows.length < listTotal ? <span>{tTr("truncated", { shown: numTxt(rows.length, locale), total: numTxt(listTotal, locale) })}</span> : null}
        {matched > rows.length ? (
          <RnTextButton onClick={() => setMore({ key: listKey, limit: limit + RANK_TABLE_STEP })}>{t("g.more", { n: Math.min(RANK_TABLE_STEP, matched - rows.length), total: numTxt(matched, locale) })}</RnTextButton>
        ) : null}
        <span>{t("g.ownNote", { own: ownLabel, brands: ownRows.map((r) => r.brand).join(" + ") })}</span>
      </div>
    </div>
  );
}

// ── 순위별 보기: the rank table as a ladder (1번째 on top) ─────────────────────────

function Ladder() {
  const { input, ownLabel, openDrawer } = useMention();
  const { colorOf, compare } = useCompare();
  const t = useTranslations("renewal.mention");
  const rank = use(input.rank);
  const rows = rank.rows.filter((r) => r.avgPosition != null).sort((a, b) => a.avgPosition! - b.avgPosition!);
  if (!rows.length) return <RnEmpty className="mx-5 mb-5">{t("g.ladderNoteNone")}</RnEmpty>;
  const W = 1000;
  const H = 400;
  const top = 16;
  const bottom = 16;
  const lo = 1;
  const hi = Math.max(6, Math.ceil(Math.max(...rows.map((r) => r.avgPosition!))));
  const y = (v: number) => top + ((v - lo) / (hi - lo)) * (H - top - bottom);
  const cx0 = W / 2;
  const sides: Record<"L" | "R", typeof rows> = { L: [], R: [] };
  rows.forEach((r, i) => sides[i % 2 ? "L" : "R"].push(r));
  return (
    <div className="px-5 pb-4">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t("g.ladderAria")} className="h-[400px] w-full">
        {Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).map((v) => (
          <g key={v}>
            <line x1={56} x2={W - 16} y1={y(v)} y2={y(v)} stroke="var(--color-rn-line)" strokeDasharray="3 4" />
            <text x={48} y={y(v) + 4} textAnchor="end" fontSize={11} fill="var(--color-rn-muted)">
              {t("rank.unit", { n: v })}
            </text>
          </g>
        ))}
        <line x1={cx0} x2={cx0} y1={top} y2={H - bottom} stroke="var(--color-rn-line)" strokeWidth={2} />
        {(["L", "R"] as const).flatMap((k) => {
          let prev = -99;
          return sides[k].map((r) => {
            const yy = y(r.avgPosition!);
            const ly = Math.max(yy, prev + 16);
            prev = ly;
            const own = r.own;
            const color = own ? OWN_COLOR : compare.includes(r.key) ? colorOf(r.key) : "#9a9ca1";
            const lx = k === "R" ? cx0 + 70 : cx0 - 70;
            const name = own ? ownLabel : r.key;
            return (
              <g key={r.key} className={own ? undefined : "cursor-pointer"} onClick={own ? undefined : () => openDrawer({ kind: "brand", brand: r.key })}>
                <path d={`M${cx0},${yy} L${k === "R" ? cx0 + 60 : cx0 - 60},${ly}`} stroke="var(--color-rn-line)" fill="none" />
                <circle cx={cx0} cy={yy} r={own ? 7 : 5.5} fill={color} stroke="#fff" strokeWidth={2} />
                <text x={lx} y={ly + 4} fontSize={12} fontWeight={own || compare.includes(r.key) ? 650 : 500} textAnchor={k === "R" ? "start" : "end"} fill={own ? OWN_COLOR : "var(--color-rn-ink-2)"}>
                  {name} <tspan fill="var(--color-rn-muted)" fontWeight={500}>{posTxt(r.avgPosition)}</tspan>
                </text>
              </g>
            );
          });
        })}
      </svg>
      <p className="m-0 text-rn-12 text-rn-muted">{rank.standing ? t("g.ladderNote", { n: rank.standing.total, rank: rank.standing.rank, top: rank.standing.topPct }) : t("g.ladderNoteNone")}</p>
    </div>
  );
}
