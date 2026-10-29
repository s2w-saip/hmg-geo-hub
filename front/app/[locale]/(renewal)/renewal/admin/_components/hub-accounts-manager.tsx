"use client";

// Renewal Admin › 사용자 관리 (2026-10-29): the top-level administrator manages the HUB accounts — role (관리자 ·
// HQ · 권역 · 국가) and data scope (brands, RHQ regions, countries), 사용 중지 / 다시 사용, and a temporary
// password (new account, reset) shown once, which the account replaces at its next sign-in. Reads and writes go
// through /api/hub/accounts (hub-accounts-api.ts); the BFF checks every call and keeps every change as the
// account's history. The layout is Admin › Global prompts' (hub-prompts-manager.tsx, prompt-list.tsx): the left
// filter panel with saved filters, picks applied at once, one line per account with sortable column heads, and
// a row opens the detail sheet. Accounts are few, so the list is read once and filtered here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Ban, Copy, KeyRound, Loader2, Pencil, Plus, RotateCcw, Users } from "lucide-react";
import {
  RnButton,
  RnCard,
  RnDrawer,
  RnEmpty,
  RnIconButton,
  RnNote,
  RnPageHeader,
  RnPill,
  RnSearchField,
  RnSelect,
  RnTag,
  RnToastProvider,
  RnToken,
  cx,
  useRnToast,
  useRnTruncTip,
} from "@/components/renewal-ui";
import { countryName } from "@/lib/geo-catalog/country-name";
import { rhqLabel } from "@/lib/rhq";
import { RnFilterSplit } from "../../_components/filter-split";
import { LIST_TD as TD, RnDetailField, RnFilterPanel, RnFilterRail, RnRadioAxis, RnSortHead, RnTimeline } from "../../_components/prompt-list";
import { RnSavedFiltersSection, useSavedFilters, type SavedFilter, type SavedFiltersSource } from "../../_components/saved-filters";
import { AccountErrorNote, HubAccountForm } from "./hub-account-form";
import { AccountRequestError, accountsApi, type AccountAction, type HubAccount, type HubAccountDetail, type HubRole } from "./hub-accounts-api";
import {
  ACCOUNT_AXES,
  ACCOUNT_SORTS,
  ALL,
  AXIS_OPTIONS,
  DEFAULT_FILTER,
  DEFAULT_SORT,
  NO_ROLE,
  filterToQuery,
  firstAsc,
  matches,
  pickedAxes,
  queryToFilter,
  sortAccounts,
  stateOf,
  type AccountAxis,
  type AccountFilter,
  type AccountSort,
  type AccountState,
} from "./hub-account-filter-model";

type Sheet = { mode: "create" } | { mode: "open"; id: string } | { mode: "issued"; item: HubAccount; password: string; kind: "create" | "reset" };

export interface HubAccountsManagerProps {
  initial: HubAccount[];
  /** the roles the signed-in account hands out: those below its own */
  roles: HubRole[];
  savedFilters: SavedFiltersSource;
}

export function HubAccountsManager(props: HubAccountsManagerProps) {
  return (
    <RnToastProvider>
      <Manager {...props} />
    </RnToastProvider>
  );
}

/** Labels of an account's values, shared by the list, the sheet and the history. */
function useAccountLabels() {
  const t = useTranslations("hubAccounts");
  const tRoles = useTranslations("roles");
  const locale = useLocale();
  const lang = locale === "en" ? "en" : "ko";
  return useMemo(() => {
    const region = (id: string) => rhqLabel(id, lang) ?? id;
    const country = (c: string) => countryName(c, locale);
    const role = (r: string | null) => (r ? tRoles(r as "admin") : t("noRole"));
    /** 전체 for the administrator; else the narrowest axis the role keeps, after its brands. */
    const scope = (a: Pick<HubAccount, "role" | "brands" | "regions" | "countries">) => {
      if (a.role === "admin") return t("scopeAll");
      if (!a.role) return "—";
      const lower = a.role === "country" ? a.countries.map(country) : a.role === "region" ? a.regions.map(region) : [];
      return [a.brands.join(", "), ...(lower.length ? [lower.join(", ")] : [])].join(" · ");
    };
    const value = (field: string, v: unknown): string | null => {
      if (v == null || (Array.isArray(v) && !v.length)) return null;
      if (field === "role") return role(String(v));
      if (field === "status") return t(`status.${v as "active"}`);
      if (field === "regions") return (v as string[]).map(region).join(", ");
      if (field === "countries") return (v as string[]).map(country).join(", ");
      return Array.isArray(v) ? v.join(", ") : String(v);
    };
    return { region, country, role, scope, value };
  }, [lang, locale, t, tRoles]);
}

function Manager({ initial, roles, savedFilters }: HubAccountsManagerProps) {
  const t = useTranslations("hubAccounts");
  const tv = useTranslations("standardPromptsView");
  const tp = useTranslations("renewal.prompts");
  const tr = useTranslations("renewal.filters");
  const ts = useTranslations("renewal.saved");
  const locale = useLocale();
  const toast = useRnToast();
  const sp = useSearchParams();
  const labels = useAccountLabels();
  const tip = useRnTruncTip();
  const fromUrl = useMemo(() => queryToFilter(sp), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [items, setItems] = useState(initial);
  const [filters, setFilters] = useState<AccountFilter>(fromUrl.filters);
  const [search, setSearch] = useState(fromUrl.search);
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [listError, setListError] = useState<AccountRequestError | null>(null);
  const [open, setOpen] = useState<Partial<Record<AccountAxis, boolean>>>({ role: true, state: true, brand: true });

  const reload = useCallback(() => {
    accountsApi.list().then(
      (res) => {
        setItems(res.items);
        setListError(null);
      },
      (e: unknown) => setListError(e instanceof AccountRequestError ? e : new AccountRequestError(0, "failed")),
    );
  }, []);

  // URL mirrors the picks (shareable, restorable); shallow — no server round trip.
  useEffect(() => {
    const qs = filterToQuery(filters, search);
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, [filters, search]);

  const axisLabel = useCallback((a: AccountAxis) => t(`axis.${a}`), [t]);
  const valueLabel = useCallback(
    (a: AccountAxis, v: string) => (v === ALL ? tv("filterAll") : a === "role" ? labels.role(v === NO_ROLE ? null : v) : a === "state" ? t(`state.${v as AccountState}`) : v),
    [labels, t, tv],
  );
  const setAll = (next: AccountFilter, nextSearch: string) => {
    setFilters(next);
    setSearch(nextSearch);
  };

  // ── saved filters ──
  const saved = useSavedFilters(savedFilters);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openedWith, setOpenedWith] = useState<string | null>(null);
  const auto = useRef(false);
  useEffect(() => {
    if (!saved.ready || auto.current) return;
    auto.current = true;
    if (filterToQuery(fromUrl.filters, fromUrl.search)) return;
    const star = saved.items.find((p) => p.isDefault);
    if (!star) return;
    const q = queryToFilter(star.query);
    setAll(q.filters, q.search);
    setActiveId(star.id);
    setOpenedWith(star.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.ready]);
  const summarize = useCallback(
    (q: string) => {
      const { filters: f, search: s } = queryToFilter(q);
      return [...pickedAxes(f).map((a) => valueLabel(a, f[a])), ...(s ? [`“${s}”`] : [])].join(" · ");
    },
    [valueLabel],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey) return;
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      e.preventDefault();
      document.querySelector<HTMLInputElement>("#rn-hub-account-search")?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const picked = pickedAxes(filters);
  const shown = useMemo(() => sortAccounts(items.filter((a) => matches(a, filters, search)), sort.key, sort.asc), [items, filters, search, sort]);
  const sortLabel = (k: AccountSort) => t(`column.${k}`);
  const head = (key: AccountSort, className?: string) => (
    <RnSortHead sortKey={key} label={sortLabel(key)} sort={sort} className={className} onSort={(k) => setSort((s) => (s.key === k ? { key: k, asc: !s.asc } : { key: k, asc: firstAsc(k) }))} />
  );

  const changed = (item: HubAccount, message: string) => {
    toast(message);
    reload();
    setSheet({ mode: "open", id: item.id });
  };
  const issued = (item: HubAccount, password: string, kind: "create" | "reset") => {
    reload();
    setSheet({ mode: "issued", item, password, kind });
  };

  const panel = (
    <RnFilterPanel
      count={picked.length}
      onReset={() => {
        const before = { f: filters, s: search };
        setAll(DEFAULT_FILTER, "");
        toast(tr("resetDone"), { undoLabel: tr("undo"), undo: () => setAll(before.f, before.s) });
      }}
      saved={
        <RnSavedFiltersSection
          saved={saved}
          activeId={activeId}
          onActivate={(item: SavedFilter | null) => {
            if (!item) {
              setActiveId(null);
              return;
            }
            const q = queryToFilter(item.query);
            setAll(q.filters, q.search);
            setActiveId(item.id);
            setOpenedWith(null);
          }}
          currentQuery={filterToQuery(filters, search)}
          summarize={summarize}
          hrefOf={(q) => `${window.location.origin}${window.location.pathname}${q ? `?${q}` : ""}`}
        />
      }
    >
      {ACCOUNT_AXES.map((a) => (
        <RnRadioAxis
          key={a}
          axis={a}
          label={axisLabel(a)}
          value={filters[a]}
          options={AXIS_OPTIONS[a]}
          valueLabel={(v) => valueLabel(a, v)}
          allLabel={tv("filterAll")}
          open={open[a] ?? false}
          onToggle={() => setOpen((o) => ({ ...o, [a]: !(o[a] ?? false) }))}
          onPick={(v) => {
            setFilters((f) => ({ ...f, [a]: v }));
            setOpenedWith(null);
          }}
        />
      ))}
    </RnFilterPanel>
  );

  return (
    <div className="flex flex-col gap-4">
      <RnFilterSplit
        header={
          <RnPageHeader
            title={t("title")}
            meta={
              <>
                <RnPill>
                  <Users className="size-3 text-rn-muted" aria-hidden />
                  {t("storePill")}
                </RnPill>
                <span>{t("description")}</span>
              </>
            }
            actions={
              <RnButton variant="primary" onClick={() => setSheet({ mode: "create" })} data-hub-account-create="">
                <Plus className="size-3.5" aria-hidden />
                {t("create")}
              </RnButton>
            }
          />
        }
        panel={panel}
        rail={<RnFilterRail count={picked.length} />}
      >
        <RnNote>
          <b className="text-rn-ink">{t("scopeNoteTitle")}</b>
          <span>{t("scopeNote")}</span>
        </RnNote>
        {picked.length || search ? (
          <div aria-live="polite" className="flex min-h-7 flex-wrap items-center gap-2">
            {picked.map((a) => (
              <RnToken key={a} label={axisLabel(a)} value={valueLabel(a, filters[a])} removeLabel={tr("removeToken", { label: axisLabel(a) })} onRemove={() => setFilters((f) => ({ ...f, [a]: ALL }))} />
            ))}
            {search ? <RnToken label={t("searchLabel")} value={`“${search}”`} removeLabel={tr("removeToken", { label: t("searchLabel") })} onRemove={() => setSearch("")} /> : null}
          </div>
        ) : null}
        {openedWith ? (
          <RnNote>
            <span>{ts("openedWithDefault", { name: openedWith })}</span>
            <button
              type="button"
              className="cursor-pointer font-semibold text-rn-navy underline-offset-4 hover:underline"
              onClick={() => {
                setOpenedWith(null);
                setAll(DEFAULT_FILTER, "");
              }}
            >
              {ts("viewWithout")}
            </button>
          </RnNote>
        ) : null}
        <RnCard aria-label={t("listLabel")}>
          <div className="flex flex-wrap items-center gap-2 border-b border-rn-line px-5 py-3">
            <RnSearchField
              id="rn-hub-account-search"
              className="w-full max-w-[280px] min-w-[180px] flex-1"
              value={search}
              onChange={setSearch}
              placeholder={t("searchPlaceholder")}
              label={t("searchLabel")}
            />
            <RnSelect
              label={tp("sortLabel")}
              value={sort.key}
              onChange={(e) => {
                const key = e.target.value as AccountSort;
                setSort({ key, asc: firstAsc(key) });
              }}
              options={ACCOUNT_SORTS.map((k) => ({ value: k, label: sortLabel(k) }))}
            />
            <RnIconButton label={sort.asc ? tp("sortAsc") : tp("sortDesc")} onClick={() => setSort((s) => ({ key: s.key, asc: !s.asc }))}>
              {sort.asc ? <ArrowUpNarrowWide className="size-4" aria-hidden /> : <ArrowDownWideNarrow className="size-4" aria-hidden />}
            </RnIconButton>
            <span className="ml-auto text-rn-12 text-rn-muted tabular-nums">{t("count", { shown: shown.length, total: items.length })}</span>
          </div>
          {listError ? (
            <AccountErrorNote error={listError} className="m-5" />
          ) : shown.length === 0 ? (
            <RnEmpty className="m-5">{items.length ? t("emptyFiltered") : t("empty")}</RnEmpty>
          ) : (
            <div {...tip.bind}>
              <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13" data-hub-account-table="">
                <colgroup>
                  <col className="w-[280px]" />
                  <col className="w-[112px]" />
                  <col />
                  <col className="w-[128px]" />
                  <col className="w-[152px]" />
                  <col className="w-[120px]" />
                </colgroup>
                <thead>
                  <tr className="text-left text-rn-12 text-rn-muted">
                    {head("login", "pl-5")}
                    {head("role")}
                    <th className={cx(LIST_TH_PLAIN)}>{t("column.scope")}</th>
                    {head("state")}
                    {head("lastSignIn")}
                    {head("created", "pr-5")}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((a) => (
                    <tr
                      key={a.id}
                      data-hub-account-row={a.login}
                      onClick={() => !window.getSelection()?.toString() && setSheet({ mode: "open", id: a.id })}
                      className="cursor-pointer hover:bg-rn-navy-25/60"
                    >
                      <td className={cx(TD, "pl-5")}>
                        <span className="flex min-w-0 items-center gap-2">
                          <button type="button" data-rn-tip="" className={cx("min-w-0 shrink cursor-pointer truncate text-left font-semibold focus-visible:outline-2 focus-visible:outline-rn-navy", a.status === "active" ? "text-rn-ink" : "text-rn-muted")}>
                            {a.login}
                          </button>
                          {a.displayName ? <span className="min-w-0 truncate text-rn-12 text-rn-muted">{a.displayName}</span> : null}
                          {a.self ? <RnTag className="shrink-0">{t("me")}</RnTag> : null}
                        </span>
                      </td>
                      <td className={cx(TD, "text-rn-12", a.role ? "text-rn-ink-2" : "text-rn-muted")}>{labels.role(a.role)}</td>
                      <td className={TD}>
                        <span data-rn-tip="" className="block truncate text-rn-12 text-rn-ink-2">
                          {labels.scope(a)}
                        </span>
                      </td>
                      <td className={TD}>
                        <StateMark state={stateOf(a)} />
                      </td>
                      <td className={cx(TD, "text-rn-12 text-rn-muted tabular-nums")}>
                        {a.lastSignInAt ? <span data-rn-tip={formatTime(a.lastSignInAt, locale)}>{formatTime(a.lastSignInAt, locale)}</span> : t("neverSignedIn")}
                      </td>
                      <td className={cx(TD, "pr-5 text-rn-12 text-rn-muted tabular-nums")}>{formatDate(a.createdAt, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {tip.tip}
            </div>
          )}
        </RnCard>
      </RnFilterSplit>
      <RnDrawer
        open={sheet != null}
        onClose={() => setSheet(null)}
        title={sheet?.mode === "create" ? t("createTitle") : sheet?.mode === "issued" ? t("issued.title") : t("detailTitle")}
        subtitle={sheet?.mode === "create" ? t("createHint") : undefined}
        closeLabel={tp("close")}
      >
        {sheet?.mode === "create" ? (
          <HubAccountForm key="create" item={null} roles={roles} onSaved={(item, password) => issued(item, password ?? "", "create")} onCancel={() => setSheet(null)} />
        ) : sheet?.mode === "issued" ? (
          <Issued item={sheet.item} password={sheet.password} kind={sheet.kind} onDone={() => setSheet({ mode: "open", id: sheet.item.id })} />
        ) : sheet ? (
          <Detail key={sheet.id} id={sheet.id} roles={roles} onChanged={changed} onIssued={(item, password) => issued(item, password, "reset")} />
        ) : null}
      </RnDrawer>
    </div>
  );
}

// the scope column cannot sort (a mixed list of brands, regions and countries); same head as the sortable ones
const LIST_TH_PLAIN = "sticky -top-1 z-[1] h-[38px] border-b border-rn-line-2 bg-rn-surface px-3 font-semibold";

/** 사용 중 = a filled navy dot; 첫 로그인 전 = a navy ring; 사용 중지 = a dashed one, muted. */
function StateMark({ state }: { state: AccountState }) {
  const t = useTranslations("hubAccounts");
  return (
    <span className={cx("inline-flex max-w-full items-center gap-1.5 text-rn-12", state === "disabled" ? "text-rn-muted" : "text-rn-ink")} data-hub-account-state={state}>
      <i
        aria-hidden
        className={cx(
          "inline-block size-2 shrink-0 rounded-full",
          state === "active" ? "bg-rn-navy" : state === "pending" ? "border-[1.5px] border-rn-navy" : "border border-dashed border-rn-muted",
        )}
      />
      <span className="truncate">{t(`state.${state}`)}</span>
    </span>
  );
}

function formatTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
}

// ─── sheet: the temporary password, shown once ───────────────────────────────

function Issued({ item, password, kind, onDone }: { item: HubAccount; password: string; kind: "create" | "reset"; onDone: () => void }) {
  const t = useTranslations("hubAccounts");
  const toast = useRnToast();
  return (
    <div className="flex flex-col gap-5" data-hub-account-issued={kind}>
      <p className="m-0 text-rn-13 text-rn-ink">{t(kind === "create" ? "issued.created" : "issued.reset", { login: item.login })}</p>
      <div className="flex flex-col gap-2 rounded-[10px] border border-rn-line-2 bg-rn-page p-4">
        <span className="text-rn-12 font-semibold text-rn-muted">{t("issued.label")}</span>
        <div className="flex items-center gap-3">
          <code className="text-rn-20 font-bold tracking-wide text-rn-ink select-all" data-hub-temporary-password="">
            {password}
          </code>
          <RnButton
            size="sm"
            className="ml-auto"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(password);
                toast(t("issued.copied"));
              } catch {
                toast(t("issued.copyFailed"));
              }
            }}
          >
            <Copy className="size-3.5" aria-hidden />
            {t("issued.copy")}
          </RnButton>
        </div>
      </div>
      <RnNote>{t("issued.hint")}</RnNote>
      <div className="flex">
        <RnButton variant="primary" onClick={onDone} data-hub-account-issued-done="">
          {t("issued.done")}
        </RnButton>
      </div>
    </div>
  );
}

// ─── sheet: an existing account ──────────────────────────────────────────────

function Detail({
  id,
  roles,
  onChanged,
  onIssued,
}: {
  id: string;
  roles: HubRole[];
  onChanged: (item: HubAccount, message: string) => void;
  onIssued: (item: HubAccount, password: string) => void;
}) {
  const t = useTranslations("hubAccounts");
  const locale = useLocale();
  const labels = useAccountLabels();
  const [detail, setDetail] = useState<HubAccountDetail | null>(null);
  const [error, setError] = useState<AccountRequestError | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<AccountAction | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<AccountRequestError | null>(null);
  const [conflict, setConflict] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    accountsApi.detail(id).then(
      (d) => live && (setDetail(d), setError(null)),
      (e) => live && setError(e instanceof AccountRequestError ? e : new AccountRequestError(0, "failed")),
    );
    return () => {
      live = false;
    };
  }, [id, nonce]);

  if (error) return <AccountErrorNote error={error} />;
  if (!detail) {
    return (
      <p className="flex items-center gap-2 text-rn-13 text-rn-muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </p>
    );
  }
  const { item, history } = detail;
  const state = stateOf(item);

  const act = async (action: AccountAction) => {
    setPending(true);
    setFailure(null);
    try {
      const out = await accountsApi.act(item.id, action);
      setConfirm(null);
      if (action === "reset-password" && out.temporaryPassword) onIssued(out.item, out.temporaryPassword);
      else onChanged(out.item, t(action === "disable" ? "toast.disabled" : "toast.enabled"));
      setNonce((n) => n + 1);
    } catch (e) {
      setFailure(e instanceof AccountRequestError ? e : new AccountRequestError(0, "failed"));
    } finally {
      setPending(false);
    }
  };

  const events = history.map((e) => ({
    key: String(e.id),
    label: t(`event.${e.action.replace(".", "_")}` as "event.account_create"),
    at: e.at,
    actor: e.actor ? e.actor.displayName || e.actor.login : t("byCommand"),
    changes: Object.fromEntries(Object.entries(e.changes).map(([field, [before, after]]) => [field, { old: labels.value(field, before), new: labels.value(field, after) }])),
    note: t(`eventNote.${e.action.replace(".", "_")}` as "eventNote.account_create"),
  }));

  return (
    <div className="flex flex-col gap-6" data-hub-account-detail={item.login}>
      {state === "disabled" ? <RnNote>{t("note.disabled")}</RnNote> : state === "pending" ? <RnNote>{t("note.pending")}</RnNote> : null}
      {!item.role ? <RnNote>{t("note.noRole")}</RnNote> : null}
      {conflict ? <AccountErrorNote error={new AccountRequestError(409, "version_conflict")} /> : null}
      {editing ? (
        <HubAccountForm
          key={`${item.id}:${item.version}`}
          item={item}
          roles={roles}
          onSaved={(next) => {
            setEditing(false);
            setConflict(false);
            setNonce((n) => n + 1);
            onChanged(next, t("toast.updated"));
          }}
          onConflict={() => {
            setConflict(true);
            setNonce((n) => n + 1);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <div className="flex min-w-0 items-baseline gap-2">
              <b className="min-w-0 truncate text-rn-16 text-rn-ink">{item.login}</b>
              {item.displayName ? <span className="min-w-0 truncate text-rn-13 text-rn-muted">{item.displayName}</span> : null}
              {item.self ? <RnTag className="shrink-0">{t("me")}</RnTag> : null}
            </div>
            {item.manageable ? (
              <div className="flex flex-wrap items-center gap-2">
                <RnButton size="sm" onClick={() => setEditing(true)} data-hub-account-edit="">
                  <Pencil className="size-3.5" aria-hidden />
                  {t("edit")}
                </RnButton>
                <RnButton size="sm" disabled={pending} onClick={() => setConfirm("reset-password")} data-hub-account-reset="">
                  <KeyRound className="size-3.5" aria-hidden />
                  {t("resetPassword")}
                </RnButton>
                {item.status === "active" ? (
                  <RnButton size="sm" className="ml-auto" disabled={pending} onClick={() => setConfirm("disable")} data-hub-account-disable="">
                    <Ban className="size-3.5" aria-hidden />
                    {t("disable")}
                  </RnButton>
                ) : (
                  <RnButton size="sm" variant="primary" className="ml-auto" disabled={pending} onClick={() => void act("enable")} data-hub-account-enable="">
                    <RotateCcw className="size-3.5" aria-hidden />
                    {t("enable")}
                  </RnButton>
                )}
              </div>
            ) : (
              <p className="m-0 text-rn-12 text-rn-muted" data-hub-account-locked="">
                {t(item.self ? "selfNote" : "rankNote")}
              </p>
            )}
            {confirm ? (
              <div role="alertdialog" aria-label={t(`confirm.${confirm === "reset-password" ? "reset" : "disable"}Title`)} className="flex flex-col gap-3 rounded-[10px] border border-rn-line-2 bg-rn-page p-4" data-hub-account-confirm={confirm}>
                <p className="m-0 text-rn-13 text-rn-ink">{t(`confirm.${confirm === "reset-password" ? "reset" : "disable"}`, { login: item.login })}</p>
                <div className="flex gap-2">
                  <RnButton size="sm" variant="primary" disabled={pending} onClick={() => void act(confirm)} data-hub-account-confirm-ok="">
                    {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                    {t(`confirm.${confirm === "reset-password" ? "reset" : "disable"}Action`)}
                  </RnButton>
                  <RnButton size="sm" disabled={pending} onClick={() => setConfirm(null)}>
                    {t("form.cancel")}
                  </RnButton>
                </div>
              </div>
            ) : null}
            {failure ? <AccountErrorNote error={failure} /> : null}
          </section>
          <section>
            <h3 className="m-0 mb-2 text-rn-13 font-bold text-rn-ink">{t("attributes")}</h3>
            <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-rn-13">
              <RnDetailField label={t("field.email")}>{item.email}</RnDetailField>
              <RnDetailField label={t("field.role")}>{labels.role(item.role)}</RnDetailField>
              {item.role && item.role !== "admin" ? <RnDetailField label={t("field.brands")}>{labels.value("brands", item.brands)}</RnDetailField> : null}
              {item.role === "region" || item.role === "country" ? <RnDetailField label={t("field.regions")}>{labels.value("regions", item.regions)}</RnDetailField> : null}
              {item.role === "country" ? <RnDetailField label={t("field.countries")}>{labels.value("countries", item.countries)}</RnDetailField> : null}
              {item.role === "admin" ? <RnDetailField label={t("column.scope")}>{labels.scope(item)}</RnDetailField> : null}
              <RnDetailField label={t("column.state")}>
                <StateMark state={state} />
              </RnDetailField>
              <RnDetailField label={t("column.lastSignIn")}>
                <span className="tabular-nums">{item.lastSignInAt ? formatTime(item.lastSignInAt, locale) : t("neverSignedIn")}</span>
              </RnDetailField>
              <RnDetailField label={t("passwordChangedAt")}>{item.passwordChangedAt ? <span className="tabular-nums">{formatTime(item.passwordChangedAt, locale)}</span> : null}</RnDetailField>
              <RnDetailField label={t("column.created")}>
                <span className="tabular-nums">{formatTime(item.createdAt, locale)}</span>
              </RnDetailField>
            </dl>
          </section>
        </>
      )}
      <section data-hub-account-history="">
        <h3 className="m-0 mb-3 text-rn-13 font-bold text-rn-ink">{t("history")}</h3>
        {events.length ? <RnTimeline events={events} fieldLabel={(f) => t(`field.${f}` as "field.login")} /> : <p className="m-0 text-rn-12 text-rn-muted">{t("noHistory")}</p>}
      </section>
    </div>
  );
}
