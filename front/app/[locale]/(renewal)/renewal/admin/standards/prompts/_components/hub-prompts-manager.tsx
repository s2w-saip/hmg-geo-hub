"use client";

// Renewal Admin › Global prompts (2026-10-27): the top-level administrator manages the HUB catalog's Global
// prompts. HUB-owned ones are created, edited, archived and restored; Gold-imported ones are shown read-only
// (the Gold import would overwrite a change). Every change is a new version; the drawer shows the history.
// Reads and writes go through /api/hub/global-prompts (hub-prompts-api.ts); the BFF checks every call.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Archive, ChevronLeft, ChevronRight, Loader2, Plus, RotateCcw } from "lucide-react";
import {
  RnButton,
  RnCard,
  RnCardHeader,
  RnDrawer,
  RnEmpty,
  RnIconButton,
  RnNote,
  RnPageHeader,
  RnSearchField,
  RnSegmented,
  RnSelect,
  RnTag,
  RnToastProvider,
  cx,
  useRnToast,
} from "@/components/renewal-ui";
import { RnPageFrame } from "../../../../_components/filter-split";
import {
  HubRequestError,
  LABEL_FIELDS,
  PAGE_SIZE,
  draftOf,
  hubApi,
  type Draft,
  type HubHistoryEvent,
  type HubOptions,
  type HubPrompt,
  type HubPromptDetail,
  type HubPromptPage,
  type ListQuery,
} from "./hub-prompts-api";

const INPUT =
  "h-[34px] w-full rounded-rn-control border border-rn-line-2 bg-rn-surface px-2.5 text-rn-13 text-rn-ink outline-none placeholder:text-rn-muted focus:border-rn-navy focus:ring-3 focus:ring-rn-navy/12 disabled:bg-rn-page disabled:text-rn-ink-2";
const FIELD_LABELS = ["text", "kind", "language", "regions", ...LABEL_FIELDS] as const;

type Editing = { mode: "create" } | { mode: "open"; id: string };

export function HubPromptsManager(props: { initial: HubPromptPage; options: HubOptions; loginHref: string }) {
  return (
    <RnToastProvider>
      <Manager {...props} />
    </RnToastProvider>
  );
}

function Manager({ initial, options, loginHref }: { initial: HubPromptPage; options: HubOptions; loginHref: string }) {
  const t = useTranslations("hubPrompts");
  const locale = useLocale();
  const toast = useRnToast();
  const [query, setQuery] = useState<ListQuery>({ q: "", status: "active", origin: "all", offset: 0 });
  const [search, setSearch] = useState("");
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const seq = useRef(0);
  const first = useRef(true);

  const reload = useCallback(async (q: ListQuery) => {
    const id = ++seq.current;
    setBusy(true);
    try {
      const page = await hubApi.list(q);
      if (id === seq.current) {
        setData(page);
        setListError(null);
      }
    } catch (e) {
      if (id === seq.current) setListError(e instanceof HubRequestError ? e.code : "failed");
    } finally {
      if (id === seq.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void reload(query);
  }, [query, reload]);

  // the search applies 300 ms after typing stops, from the first page
  useEffect(() => {
    const timer = setTimeout(() => setQuery((q) => (q.q === search ? q : { ...q, q: search, offset: 0 })), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { total } = data.page;
  const from = total === 0 ? 0 : query.offset + 1;
  const to = Math.min(query.offset + PAGE_SIZE, total);
  const fmt = (n: number) => n.toLocaleString(locale);

  const changed = (item: HubPrompt, message: string) => {
    toast(message);
    void reload(query);
    setEditing({ mode: "open", id: item.id });
  };

  return (
    <RnPageFrame
      header={
        <RnPageHeader
          title={t("title")}
          meta={<span>{t("description")}</span>}
          actions={
            <RnButton variant="primary" onClick={() => setEditing({ mode: "create" })} data-hub-create="">
              <Plus className="size-3.5" aria-hidden />
              {t("create")}
            </RnButton>
          }
        />
      }
    >
      <RnNote>
        <b className="text-rn-ink">{t("notMeasuredTitle")}</b>
        <span>{t("notMeasured")}</span>
      </RnNote>
      <RnCard busy={busy} aria-label={t("listLabel")}>
        <RnCardHeader
          title={t("listTitle")}
          hint={t("counts", { total: fmt(data.counts.total), hub: fmt(data.counts.hub), gold: fmt(data.counts.gold), archived: fmt(data.counts.archived), removed: fmt(data.counts.removed ?? 0) })}
        />
        <div className="flex flex-wrap items-center gap-2.5 px-6 pb-3">
          <RnSearchField className="w-[280px] max-w-full" value={search} onChange={setSearch} placeholder={t("searchPlaceholder")} label={t("searchLabel")} />
          <RnSegmented
            label={t("statusLabel")}
            value={query.status}
            onChange={(status) => setQuery((q) => ({ ...q, status, offset: 0 }))}
            items={[
              { value: "active", label: t("status.active") },
              { value: "archived", label: t("status.archived") },
              { value: "removed", label: t("status.removed") },
              { value: "all", label: t("all") },
            ]}
          />
          <RnSegmented
            label={t("originLabel")}
            value={query.origin}
            onChange={(origin) => setQuery((q) => ({ ...q, origin, offset: 0 }))}
            items={[
              { value: "all", label: t("all") },
              { value: "hub", label: t("origin.hub") },
              { value: "gold", label: t("origin.gold") },
            ]}
          />
        </div>
        {listError ? (
          <ErrorNote code={listError} loginHref={loginHref} className="mx-6 mb-5" />
        ) : data.items.length === 0 ? (
          <RnEmpty className="mx-6 mb-5">{t("empty")}</RnEmpty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13" data-hub-prompt-table="">
              <colgroup>
                <col />
                <col className="w-[200px]" />
                <col className="w-[92px]" />
                <col className="w-[150px]" />
              </colgroup>
              <thead>
                <tr className="text-left text-rn-12 font-semibold text-rn-muted">
                  <th scope="col" className="h-[38px] border-b border-rn-line-2 pr-3 pl-6 font-semibold">{t("field.text")}</th>
                  <th scope="col" className="h-[38px] border-b border-rn-line-2 px-3 font-semibold">{t("columnTaxonomy")}</th>
                  <th scope="col" className="h-[38px] border-b border-rn-line-2 px-3 font-semibold">{t("columnStatus")}</th>
                  <th scope="col" className="h-[38px] border-b border-rn-line-2 pr-6 pl-3 font-semibold">{t("columnChanged")}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id} data-hub-prompt-row={p.id} className="cursor-pointer align-top hover:bg-rn-navy-25/60" onClick={() => setEditing({ mode: "open", id: p.id })}>
                    <td className="border-b border-rn-line py-3 pr-3 pl-6">
                      <button
                        type="button"
                        className="cursor-pointer text-left leading-snug text-rn-ink hover:text-rn-navy focus-visible:outline-2 focus-visible:outline-rn-navy"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing({ mode: "open", id: p.id });
                        }}
                      >
                        {p.text}
                      </button>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-rn-12 text-rn-muted">
                        <OriginTag origin={p.origin} />
                        <span>{t(`kind.${p.kind}`)}</span>
                        {p.language ? <span>· {p.language}</span> : null}
                        {p.regions.length ? <span>· {p.regions.join(", ")}</span> : null}
                      </div>
                    </td>
                    <td className="border-b border-rn-line px-3 py-3 text-rn-12 text-rn-ink-2">
                      {[p.listType, p.depth1, p.depth2, p.depth3, p.depth4].filter(Boolean).join(" › ") || "—"}
                      {p.funnel ? <div className="mt-1 text-rn-muted">{p.funnel}</div> : null}
                    </td>
                    <td className="border-b border-rn-line px-3 py-3 text-rn-12">
                      <span className={p.status !== "active" ? "text-rn-muted" : "font-semibold text-rn-ink"}>{t(`status.${p.status}`)}</span>
                    </td>
                    <td className="border-b border-rn-line py-3 pr-6 pl-3 text-rn-12 text-rn-muted tabular-nums">
                      v{p.version} · {formatTime(p.recordedAt, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-end gap-2 px-6 py-3 text-rn-12 text-rn-muted tabular-nums">
          <span>{t("range", { from: fmt(from), to: fmt(to), total: fmt(total) })}</span>
          <RnIconButton label={t("prev")} disabled={query.offset === 0} onClick={() => setQuery((q) => ({ ...q, offset: Math.max(0, q.offset - PAGE_SIZE) }))}>
            <ChevronLeft className="size-4" aria-hidden />
          </RnIconButton>
          <RnIconButton label={t("next")} disabled={to >= total} onClick={() => setQuery((q) => ({ ...q, offset: q.offset + PAGE_SIZE }))}>
            <ChevronRight className="size-4" aria-hidden />
          </RnIconButton>
        </div>
      </RnCard>
      <RnDrawer
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing?.mode === "create" ? t("createTitle") : t("detailTitle")}
        subtitle={editing?.mode === "create" ? t("createHint") : undefined}
        closeLabel={t("close")}
      >
        {editing?.mode === "create" ? (
          <Editor key="create" item={null} options={options} loginHref={loginHref} onSaved={(item) => changed(item, t("toast.created"))} onCancel={() => setEditing(null)} />
        ) : editing ? (
          <Detail key={editing.id} id={editing.id} options={options} loginHref={loginHref} onChanged={changed} onCancel={() => setEditing(null)} />
        ) : null}
      </RnDrawer>
    </RnPageFrame>
  );
}

function OriginTag({ origin }: { origin: HubPrompt["origin"] }) {
  const t = useTranslations("hubPrompts");
  return <RnTag className={origin === "gold" ? "bg-rn-inset text-rn-ink-2" : undefined}>{t(`origin.${origin}`)}</RnTag>;
}

function formatTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function ErrorNote({ code, fields, loginHref, className }: { code: string; fields?: string[]; loginHref: string; className?: string }) {
  const t = useTranslations("hubPrompts");
  const known = ["version_conflict", "duplicate", "unknown_code", "invalid_value", "archived", "gold_owned", "unauthorized", "source_unavailable", "not_found"];
  const names = (fields ?? []).map((f) => ((FIELD_LABELS as readonly string[]).includes(f) ? t(`field.${f}`) : f)).join(", ");
  return (
    <p role="alert" data-hub-error={code} className={cx("m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-ink-2", className)}>
      {t(`error.${known.includes(code) ? code : "failed"}`, { fields: names || "—" })}
      {code === "unauthorized" ? (
        <>
          {" "}
          <a href={loginHref} className="font-semibold text-rn-navy underline-offset-4 hover:underline">
            {t("login")}
          </a>
        </>
      ) : null}
    </p>
  );
}

// ─── drawer: an existing prompt ─────────────────────────────────────────────

function Detail({
  id,
  options,
  loginHref,
  onChanged,
  onCancel,
}: {
  id: string;
  options: HubOptions;
  loginHref: string;
  onChanged: (item: HubPrompt, message: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("hubPrompts");
  const [detail, setDetail] = useState<HubPromptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // kept here: a version conflict reloads the prompt, which re-mounts the form with the latest version
  const [conflict, setConflict] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    hubApi.detail(id).then(
      (d) => live && (setDetail(d), setError(null)),
      (e) => live && setError(e instanceof HubRequestError ? e.code : "failed"),
    );
    return () => {
      live = false;
    };
  }, [id, nonce]);

  if (error) return <ErrorNote code={error} loginHref={loginHref} />;
  if (!detail) {
    return (
      <p className="flex items-center gap-2 text-rn-13 text-rn-muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </p>
    );
  }
  const { item, history } = detail;
  const done = (next: HubPrompt, message: string) => {
    setConflict(false);
    setNonce((n) => n + 1);
    onChanged(next, message);
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2 text-rn-12 text-rn-muted">
        <OriginTag origin={item.origin} />
        <span className={item.status !== "active" ? undefined : "font-semibold text-rn-ink"}>{t(`status.${item.status}`)}</span>
        <span className="tabular-nums">· v{item.version}</span>
      </div>
      {item.status === "removed" ? <RnNote>{t("removedNote")}</RnNote> : !item.editable ? <RnNote>{t("goldReadOnly")}</RnNote> : item.status === "archived" ? <RnNote>{t("archivedNote")}</RnNote> : null}
      {conflict ? <ErrorNote code="version_conflict" loginHref={loginHref} /> : null}
      <Editor
        key={`${item.id}:${item.version}`}
        item={item}
        options={options}
        loginHref={loginHref}
        onSaved={(next) => done(next, t("toast.updated"))}
        onStatus={(next, action) => done(next, t(action === "archive" ? "toast.archived" : "toast.restored"))}
        onConflict={() => {
          setConflict(true);
          setNonce((n) => n + 1);
        }}
        onCancel={onCancel}
      />
      <History events={history} />
    </div>
  );
}

// ─── drawer: the form (create, edit, archive / restore) ─────────────────────

function Editor({
  item,
  options,
  loginHref,
  onSaved,
  onStatus,
  onConflict,
  onCancel,
}: {
  item: HubPrompt | null;
  options: HubOptions;
  loginHref: string;
  onSaved: (item: HubPrompt) => void;
  onStatus?: (item: HubPrompt, action: "archive" | "restore") => void;
  onConflict?: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("hubPrompts");
  const [draft, setDraft] = useState<Draft>(() => draftOf(item));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<HubRequestError | null>(null);
  const readOnly = item != null && (!item.editable || item.status === "archived");
  const set = (key: keyof Draft, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  async function run(action: () => Promise<{ item: HubPrompt; changed: boolean }>, after: (next: HubPrompt, changed: boolean) => void) {
    setPending(true);
    setFailure(null);
    try {
      const out = await action();
      after(out.item, out.changed);
    } catch (e) {
      const err = e instanceof HubRequestError ? e : new HubRequestError(0, "failed");
      setFailure(err);
      if (err.code === "version_conflict") onConflict?.();
    } finally {
      setPending(false);
    }
  }

  const save = () =>
    run(
      () => (item ? hubApi.update(item.id, item.version, draft) : hubApi.create(draft)),
      (next, changed) => (changed ? onSaved(next) : onCancel()),
    );
  const setStatus = (action: "archive" | "restore") =>
    item && run(() => hubApi.setStatus(item.id, item.version, action), (next) => onStatus?.(next, action));

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!readOnly) void save();
      }}
    >
      <Field label={t("field.text")} htmlFor="hub-text">
        <textarea
          id="hub-text"
          required
          rows={3}
          maxLength={2000}
          disabled={readOnly}
          value={draft.text}
          // one line: the catalog refuses line breaks
          onChange={(e) => set("text", e.target.value.replace(/[\r\n]+/g, " "))}
          className={cx(INPUT, "h-auto resize-y py-2 leading-snug")}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("field.kind")} htmlFor="hub-kind">
          <RnSelect
            id="hub-kind"
            label={t("field.kind")}
            disabled={readOnly}
            value={draft.kind}
            onChange={(e) => set("kind", e.target.value)}
            options={options.kinds.map((k) => ({ value: k, label: t(`kind.${k}`) }))}
          />
        </Field>
        <CodeField id="hub-language" label={t("field.language")} value={draft.language} onChange={(v) => set("language", v)} options={options.language} disabled={readOnly} />
      </div>
      <Field label={t("field.regions")} htmlFor="hub-regions" hint={t("regionsHint")}>
        <input id="hub-regions" disabled={readOnly} value={draft.regions} onChange={(e) => set("regions", e.target.value)} list="hub-regions-list" className={INPUT} />
        <datalist id="hub-regions-list">
          {options.regions.map((o) => (
            <option key={o.value} value={o.value} />
          ))}
        </datalist>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        {LABEL_FIELDS.map((f) => (
          <CodeField key={f} id={`hub-${f}`} label={t(`field.${f}`)} value={draft[f]} onChange={(v) => set(f, v)} options={options[f]} disabled={readOnly} />
        ))}
      </div>
      {failure ? <ErrorNote code={failure.code} fields={failure.details?.fields} loginHref={loginHref} /> : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-rn-line pt-4">
        {!readOnly ? (
          <RnButton type="submit" variant="primary" disabled={pending} data-hub-save="">
            {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            {item ? t("save") : t("createSubmit")}
          </RnButton>
        ) : null}
        <RnButton onClick={onCancel}>{t("close")}</RnButton>
        {item?.editable && item.status === "active" ? (
          <RnButton className="ml-auto" disabled={pending} onClick={() => void setStatus("archive")} data-hub-archive="">
            <Archive className="size-3.5" aria-hidden />
            {t("archive")}
          </RnButton>
        ) : null}
        {item?.editable && item.status === "archived" ? (
          <RnButton className="ml-auto" variant="primary" disabled={pending} onClick={() => void setStatus("restore")} data-hub-restore="">
            <RotateCcw className="size-3.5" aria-hidden />
            {t("restore")}
          </RnButton>
        ) : null}
      </div>
    </form>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-rn-12 font-semibold text-rn-ink-2">
        {label}
      </label>
      {children}
      {hint ? <p className="m-0 text-rn-11 text-rn-muted">{hint}</p> : null}
    </div>
  );
}

/** A code typed or picked from the codes the Global catalog already uses (the BFF refuses others). */
function CodeField({
  id,
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; count: number }[];
  disabled: boolean;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <input id={id} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} list={`${id}-list`} className={INPUT} />
      <datalist id={`${id}-list`}>
        {options.map((o) => (
          <option key={o.value} value={o.value} />
        ))}
      </datalist>
    </Field>
  );
}

// ─── drawer: change history ─────────────────────────────────────────────────

function History({ events }: { events: HubHistoryEvent[] }) {
  const t = useTranslations("hubPrompts");
  const locale = useLocale();
  const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") || "—" : v == null || v === "" ? "—" : String(v));
  return (
    <section aria-label={t("historyTitle")} className="flex flex-col gap-3 border-t border-rn-line pt-5">
      <h3 className="m-0 text-rn-14 font-bold text-rn-ink">{t("historyTitle")}</h3>
      <ol className="m-0 flex list-none flex-col gap-3 p-0" data-hub-history="">
        {events.map((e) => {
          const fields = Object.entries(e.changes);
          return (
            <li key={e.version} className="rounded-[10px] bg-rn-page px-3.5 py-2.5 text-rn-12">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-rn-muted">
                <b className="text-rn-ink">{t(`event.${e.event}`)}</b>
                <span className="tabular-nums">v{e.version} · {formatTime(e.recordedAt, locale)}</span>
                <span>· {e.actor ? e.actor.displayName || e.actor.login : e.recordedBy ? e.recordedBy : t("goldSync")}</span>
              </div>
              {fields.length ? (
                <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0 text-rn-ink-2">
                  {fields.map(([field, c]) => (
                    <li key={field} className="break-words">
                      <span className="font-semibold">{(FIELD_LABELS as readonly string[]).includes(field) ? t(`field.${field}`) : field}</span>: {show(c.old)} → {show(c.new)}
                    </li>
                  ))}
                </ul>
              ) : e.event === "updated" ? (
                <p className="m-0 mt-1.5 text-rn-muted">{t("goldOnlyChange")}</p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
