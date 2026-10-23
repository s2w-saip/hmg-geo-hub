"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Bookmark, MoreHorizontal } from "lucide-react";
import { RnButton, RnMenu, RnMenuItem, RnTextButton, cx, useRnToast } from "@/components/renewal-ui";

// Saved filters ("프리셋") of the renewal pages — per browser and per account
// (the storage key carries the user id), kept in localStorage. Nothing here is
// shared or sent to the server; when storage is unavailable (private window,
// blocked site data) the list is simply empty and saving is a no-op.
export interface SavedFilter {
  id: string;
  name: string;
  /** Opens automatically when the page is opened without filters. */
  star: boolean;
  /** The page's own filter query (URLSearchParams string, filter params only). */
  query: string;
}

const read = (key: string): SavedFilter[] => {
  try {
    const raw = window.localStorage.getItem(key);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list)
      ? list.filter((x): x is SavedFilter => !!x && typeof x.id === "string" && typeof x.name === "string" && typeof x.query === "string").map((x) => ({ ...x, star: x.star === true }))
      : [];
  } catch {
    return [];
  }
};
const write = (key: string, list: SavedFilter[]) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* storage unavailable: keep the in-memory list for this visit */
  }
};

export function useSavedFilters(storageKey: string) {
  const [items, setItems] = useState<SavedFilter[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setItems(read(storageKey));
    setReady(true);
  }, [storageKey]);
  const update = useCallback(
    (fn: (cur: SavedFilter[]) => SavedFilter[]) =>
      setItems((cur) => {
        const next = fn(cur);
        write(storageKey, next);
        return next;
      }),
    [storageKey],
  );
  return { items, ready, update };
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
  const { items, update } = saved;
  const active = items.find((p) => p.id === activeId) ?? null;
  const dirty = !!active && !sameQuery(active.query, currentQuery);
  const canSave = currentQuery.length > 0;
  const startSave = () => {
    if (!canSave) return;
    setSaving(summarize(currentQuery).slice(0, 28));
  };
  const submitSave = (name: string) => {
    const item: SavedFilter = { id: `p${Date.now().toString(36)}`, name: name.trim() || summarize(currentQuery).slice(0, 28), star: false, query: currentQuery };
    update((cur) => [...cur, item]);
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
        <SaveForm initial={saving} label={t("nameLabel")} submitLabel={t("save")} cancelLabel={t("cancel")} onSubmit={submitSave} onCancel={() => setSaving(null)} />
      ) : null}
      {items.length === 0 && saving === null ? <p className="m-0 px-4.5 pb-1 text-rn-12 text-rn-muted">{t("empty")}</p> : null}
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
                  update((cur) => cur.map((x) => (x.id === p.id ? { ...x, name: name.trim() || x.name } : x)));
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
                  {p.star ? (
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
                    const was = p.star;
                    update((cur) => cur.map((x) => ({ ...x, star: !was && x.id === p.id })));
                    setMenuId(null);
                    toast(was ? t("unstarToast") : t("starToast"));
                  }}
                >
                  {p.star ? t("unstar") : t("star")}
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
                    const index = items.findIndex((x) => x.id === p.id);
                    update((cur) => cur.filter((x) => x.id !== p.id));
                    setMenuId(null);
                    if (p.id === activeId) onActivate(null);
                    toast(t("deletedToast", { name: p.name }), {
                      undoLabel: t("undo"),
                      undo: () => update((cur) => [...cur.slice(0, index), p, ...cur.slice(index)]),
                    });
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
                update((cur) => cur.map((x) => (x.id === active.id ? { ...x, query: currentQuery } : x)));
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
  cancelLabel,
  onSubmit,
  onCancel,
}: {
  initial: string;
  label: string;
  submitLabel: string;
  cancelLabel: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <form
      className="flex gap-1.5 px-2.5 pb-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(name);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <input
        autoFocus
        value={name}
        maxLength={40}
        aria-label={label}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        className="h-[30px] min-w-0 flex-1 rounded-md border border-rn-navy px-2 text-rn-13 outline-none focus:ring-3 focus:ring-rn-navy/12"
      />
      <RnButton type="submit" variant="primary" size="sm">
        {submitLabel}
      </RnButton>
      <RnButton variant="ghost" size="sm" onClick={onCancel}>
        {cancelLabel}
      </RnButton>
    </form>
  );
}
