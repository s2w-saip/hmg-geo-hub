"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Bookmark, MoreHorizontal } from "lucide-react";
import { RnButton, RnMenu, RnMenuItem, RnSkeleton, RnTextButton, cx, useRnToast } from "@/components/renewal-ui";

// Saved filters ("프리셋") of the renewal pages — per account, kept in the HUB operations DB
// (2026-10-28, back/bff/hub_stores/saved_filters.py) through /api/hub/saved-filters, so every browser
// shows the same list. The page reads the list with its first render (saved-filters-server.ts). A change
// shows at once and is then replaced by the list the server answers; a refused change is undone with a
// toast. A list this browser kept in localStorage before (rn:saved-filters:v1:<page>:<user>) moves to the
// account on the first visit and leaves the browser.
export type SavedFilterPage = "overview" | "mention" | "citation" | "acr" | "visibility" | "conversion" | "prompts" | "hub-prompts";

export interface SavedFilter {
  id: string;
  name: string;
  /** Opens automatically when the page is opened without filters (at most one per page). */
  isDefault: boolean;
  /** The page's own filter query (URLSearchParams string, filter params only). */
  query: string;
}

export interface SavedFiltersSource {
  page: SavedFilterPage;
  /** The signed-in account: names this browser's earlier (localStorage) list of the page. */
  userId: string;
  /** The list read with the page; null when it could not be read then (asked again here). */
  initial: SavedFilter[] | null;
}

// The server's limits (saved_filters.py NAME_MAX, QUERY_MAX, PER_PAGE_MAX).
const NAME_MAX = 40;
const QUERY_MAX = 4000;
const PER_PAGE_MAX = 50;

type Answer = { item?: SavedFilter; items: SavedFilter[]; imported?: number };
type Draft = { name: string; query: string; isDefault: boolean };

class SavedFilterError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function call(path: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET", body?: unknown): Promise<Answer> {
  const res = await fetch(`/api/hub/saved-filters${path}`, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { data?: Answer; error?: { code?: string } } | null;
  if (!res.ok || !json?.data) throw new SavedFilterError(res.status, json?.error?.code ?? "failed");
  return json.data;
}

const hasControl = (s: string) => [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/** This browser's earlier list of the page as the server takes it; null when there is none. */
function readLegacy(key: string): Draft[] | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const list = JSON.parse(raw) as unknown;
    return (Array.isArray(list) ? list : [])
      .filter((x): x is { name: string; query: string; star?: unknown } => !!x && typeof x.name === "string" && typeof x.query === "string")
      .map((x) => ({ name: x.name.trim().slice(0, NAME_MAX), query: x.query, isDefault: x.star === true }))
      .filter((x) => x.name && !hasControl(x.name) && x.query.length <= QUERY_MAX && !hasControl(x.query))
      .slice(0, PER_PAGE_MAX);
  } catch {
    return null;
  }
}

function dropLegacy(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* storage unavailable: nothing to drop */
  }
}

export function useSavedFilters({ page, userId, initial }: SavedFiltersSource) {
  const t = useTranslations("renewal.saved");
  const toast = useRnToast();
  const [items, setItems] = useState<SavedFilter[]>(initial ?? []);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">(initial ? "ready" : "loading");
  // The first list is in (and this browser's earlier one moved over): a default filter may open.
  const [ready, setReady] = useState(false);
  const itemsRef = useRef(items);
  const put = useCallback((next: SavedFilter[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);
  // Only the latest request's answer replaces the list (an older one may land after it).
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const d = await call(`?${new URLSearchParams({ page })}`);
      if (my === seq.current) {
        put(d.items);
        setStatus("ready");
      }
      return true;
    } catch {
      if (my === seq.current) setStatus((s) => (s === "ready" ? s : "unavailable"));
      return false;
    }
  }, [page, put]);

  useEffect(() => {
    let live = true;
    const key = `rn:saved-filters:v1:${page}:${userId}`;
    void (async () => {
      if (initial !== null || (await load())) {
        const legacy = readLegacy(key);
        if (legacy && !legacy.length) dropLegacy(key);
        if (legacy?.length) {
          const my = ++seq.current;
          try {
            const d = await call("/import", "POST", { page, items: legacy });
            dropLegacy(key);
            if (my === seq.current) put(d.items);
            if (d.imported) toast(t("importedToast", { count: d.imported }));
          } catch {
            /* stays in this browser; tried again on the next visit */
          }
        }
      }
      if (live) setReady(true);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mutate = useCallback(
    async (optimistic: ((cur: SavedFilter[]) => SavedFilter[]) | null, send: () => Promise<Answer>): Promise<Answer | null> => {
      const my = ++seq.current;
      const before = itemsRef.current;
      if (optimistic) put(optimistic(before));
      try {
        const d = await send();
        if (my === seq.current) put(d.items);
        return d;
      } catch (e) {
        // A later request is on its way and its answer brings the server's list; otherwise go back.
        if (my === seq.current) {
          put(before);
          void load();
        }
        toast(e instanceof SavedFilterError && e.code === "limit" ? t("limitToast", { max: PER_PAGE_MAX }) : t("failedToast"));
        return null;
      }
    },
    [load, put, t, toast],
  );

  const patch = useCallback(
    (id: string, change: Partial<Omit<SavedFilter, "id">>, optimistic: (cur: SavedFilter[]) => SavedFilter[]) =>
      void mutate(optimistic, () => call(`/${id}`, "PATCH", change)),
    [mutate],
  );
  return {
    items,
    status,
    ready,
    reload: load,
    /** Waits for the server: resolves to the saved filter, or null when it was refused (toast shown). */
    create: async (name: string, query: string) => (await mutate(null, () => call("", "POST", { page, name, query })))?.item ?? null,
    rename: (id: string, name: string) => patch(id, { name }, (cur) => cur.map((x) => (x.id === id ? { ...x, name } : x))),
    overwrite: (id: string, query: string) => patch(id, { query }, (cur) => cur.map((x) => (x.id === id ? { ...x, query } : x))),
    setDefault: (id: string, on: boolean) =>
      patch(id, { isDefault: on }, (cur) => cur.map((x) => ({ ...x, isDefault: x.id === id ? on : on ? false : x.isDefault }))),
    /** Deletes; the returned undo puts it back in its place (in front of the filter that followed it). */
    remove: (item: SavedFilter) => {
      const index = itemsRef.current.findIndex((x) => x.id === item.id);
      const before = itemsRef.current[index + 1]?.id ?? null;
      void mutate((cur) => cur.filter((x) => x.id !== item.id), () => call(`/${item.id}`, "DELETE"));
      return () =>
        void mutate(
          (cur) => [...cur.slice(0, index), item, ...cur.slice(index)],
          () => call("", "POST", { page, name: item.name, query: item.query, isDefault: item.isDefault, before }),
        );
    },
  };
}

/** Same filters regardless of parameter order. */
export function sameQuery(a: string, b: string): boolean {
  const norm = (q: string) => [...new URLSearchParams(q).entries()].map(([k, v]) => `${k}=${v}`).sort().join("&");
  return norm(a) === norm(b);
}

export function RnSavedFiltersSection({
  saved,
  activeId,
  onActivate,
  currentQuery,
  summarize,
  hrefOf,
}: {
  saved: ReturnType<typeof useSavedFilters>;
  activeId: string | null;
  /** Load a saved filter (null = the active one was deleted). */
  onActivate: (item: SavedFilter | null) => void;
  currentQuery: string;
  /** One-line description of a query (applied conditions). */
  summarize: (query: string) => string;
  /** Absolute link that opens the page with a query. */
  hrefOf: (query: string) => string;
}) {
  const t = useTranslations("renewal.saved");
  const toast = useRnToast();
  const [saving, setSaving] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const { items, status } = saved;
  const active = items.find((p) => p.id === activeId) ?? null;
  const dirty = !!active && !sameQuery(active.query, currentQuery);
  const canSave = currentQuery.length > 0 && status === "ready";
  const startSave = () => {
    if (!canSave) return;
    setSaving(summarize(currentQuery).slice(0, 28));
  };
  const submitSave = async (name: string) => {
    const query = currentQuery;
    const item = await saved.create(name.trim() || summarize(query).slice(0, 28), query);
    if (!item) return; // the form stays open; the toast says why
    setSaving(null);
    onActivate(item);
    toast(t("savedToast", { name: item.name }));
  };
  const copy = async (query: string) => {
    try {
      await navigator.clipboard.writeText(hrefOf(query));
      toast(t("linkToast"));
    } catch {
      toast(t("linkFailed"));
    }
  };
  return (
    <section className="border-b border-rn-line bg-[linear-gradient(var(--color-rn-navy-25),var(--color-rn-surface)_70%)] pb-2.5">
      <div className="flex items-center gap-2 pt-3 pr-3.5 pb-2 pl-4.5 text-rn-13 font-bold text-rn-ink">
        <Bookmark className="size-3.5" aria-hidden />
        {t("title")}
        <RnTextButton className="ml-auto" aria-disabled={!canSave || undefined} onClick={startSave}>
          {t("saveCurrent")}
        </RnTextButton>
      </div>
      {saving !== null ? (
        <SaveForm
          initial={saving}
          label={t("nameLabel")}
          submitLabel={t("save")}
          pendingLabel={t("saving")}
          cancelLabel={t("cancel")}
          onSubmit={submitSave}
          onCancel={() => setSaving(null)}
        />
      ) : null}
      {status === "loading" ? (
        <div role="status" aria-label={t("loading")} className="flex flex-col gap-2 px-4.5 pt-1 pb-1.5">
          <RnSkeleton className="h-3.5 w-3/5" />
          <RnSkeleton className="h-3 w-4/5" />
        </div>
      ) : null}
      {status === "unavailable" ? (
        <p className="m-0 flex flex-wrap items-center gap-x-2 px-4.5 pb-1 text-rn-12 text-rn-muted">
          {t("unavailable")}
          <RnTextButton onClick={() => void saved.reload()}>{t("retry")}</RnTextButton>
        </p>
      ) : null}
      {status === "ready" && items.length === 0 && saving === null ? <p className="m-0 px-4.5 pb-1 text-rn-12 text-rn-muted">{t("empty")}</p> : null}
      <ul className="m-0 flex list-none flex-col gap-0.5 px-2 py-0">
        {items.map((p) => (
          <li
            key={p.id}
            className={cx(
              "relative grid grid-cols-[minmax(0,1fr)_30px] items-center gap-1 rounded-rn-control",
              p.id === activeId ? "bg-rn-surface shadow-[inset_0_0_0_1.5px_var(--color-rn-navy)]" : "hover:bg-rn-surface hover:shadow-[inset_0_0_0_1px_var(--color-rn-line-2)]",
            )}
          >
            {renamingId === p.id ? (
              <SaveForm
                initial={p.name}
                label={t("renameLabel")}
                submitLabel={t("confirm")}
                cancelLabel={t("cancel")}
                onSubmit={(name) => {
                  const next = name.trim();
                  if (next && next !== p.name) saved.rename(p.id, next);
                  setRenamingId(null);
                }}
                onCancel={() => setRenamingId(null)}
              />
            ) : (
              <button
                type="button"
                data-fk={`p:${p.id}`}
                aria-pressed={p.id === activeId}
                onClick={() => onActivate(p)}
                className="flex min-w-0 cursor-pointer flex-col gap-px py-2 pr-1 pl-2.5 text-left focus-visible:outline-2 focus-visible:outline-rn-navy"
              >
                <span className="text-rn-13 font-semibold text-rn-ink">
                  {p.isDefault ? (
                    <span className="mr-1 text-rn-12 text-rn-navy" title={t("defaultMark")}>
                      ★
                    </span>
                  ) : null}
                  {p.name}
                </span>
                <span className="text-rn-12 break-words text-rn-muted">{summarize(p.query) || t("noConditions")}</span>
              </button>
            )}
            <button
              type="button"
              aria-label={t("menu", { name: p.name })}
              aria-expanded={menuId === p.id}
              onClick={(e) => {
                e.stopPropagation();
                setMenuId((cur) => (cur === p.id ? null : p.id));
              }}
              className="grid size-[26px] cursor-pointer place-items-center rounded-md text-rn-muted hover:bg-rn-inset hover:text-rn-ink focus-visible:outline-2 focus-visible:outline-rn-navy"
            >
              <MoreHorizontal className="size-3.5" aria-hidden />
            </button>
            {menuId === p.id ? (
              <RnMenu onClose={() => setMenuId(null)}>
                <RnMenuItem
                  onSelect={() => {
                    saved.setDefault(p.id, !p.isDefault);
                    setMenuId(null);
                    toast(p.isDefault ? t("unstarToast") : t("starToast"));
                  }}
                >
                  {p.isDefault ? t("unstar") : t("star")}
                </RnMenuItem>
                <RnMenuItem
                  onSelect={() => {
                    setRenamingId(p.id);
                    setMenuId(null);
                  }}
                >
                  {t("rename")}
                </RnMenuItem>
                <RnMenuItem
                  onSelect={() => {
                    setMenuId(null);
                    void copy(p.query);
                  }}
                >
                  {t("copyLink")}
                </RnMenuItem>
                <RnMenuItem
                  danger
                  onSelect={() => {
                    const undo = saved.remove(p);
                    setMenuId(null);
                    if (p.id === activeId) onActivate(null);
                    toast(t("deletedToast", { name: p.name }), { undoLabel: t("undo"), undo });
                  }}
                >
                  {t("delete")}
                </RnMenuItem>
              </RnMenu>
            ) : null}
          </li>
        ))}
      </ul>
      {dirty && active ? (
        <div className="mx-2.5 mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-rn-control border border-dashed border-rn-navy-300 bg-rn-surface px-2.5 py-2 text-rn-12 text-rn-ink-2">
          <span>{t("changed", { name: active.name })}</span>
          <span className="ml-auto flex gap-2.5">
            <RnTextButton
              onClick={() => {
                saved.overwrite(active.id, currentQuery);
                toast(t("overwrittenToast", { name: active.name }));
              }}
            >
              {t("overwrite")}
            </RnTextButton>
            <RnTextButton onClick={startSave}>{t("saveNew")}</RnTextButton>
          </span>
        </div>
      ) : null}
    </section>
  );
}

function SaveForm({
  initial,
  label,
  submitLabel,
  pendingLabel,
  cancelLabel,
  onSubmit,
  onCancel,
}: {
  initial: string;
  label: string;
  submitLabel: string;
  /** Shown on the submit button while `onSubmit` waits for the server. */
  pendingLabel?: string;
  cancelLabel: string;
  onSubmit: (name: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const [pending, setPending] = useState(false);
  return (
    <form
      className="flex gap-1.5 px-2.5 pb-2"
      aria-busy={pending || undefined}
      onSubmit={async (e) => {
        e.preventDefault();
        if (pending) return;
        setPending(true);
        try {
          await onSubmit(name);
        } finally {
          setPending(false);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <input
        autoFocus
        value={name}
        maxLength={NAME_MAX}
        aria-label={label}
        readOnly={pending}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        className="h-[30px] min-w-0 flex-1 rounded-md border border-rn-navy px-2 text-rn-13 outline-none focus:ring-3 focus:ring-rn-navy/12"
      />
      <RnButton type="submit" variant="primary" size="sm" disabled={pending}>
        {pending && pendingLabel ? pendingLabel : submitLabel}
      </RnButton>
      <RnButton variant="ghost" size="sm" onClick={onCancel}>
        {cancelLabel}
      </RnButton>
    </form>
  );
}
