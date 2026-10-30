"use client";

// Admin › 인용 출처 분류 › 공식 소셜 (2026-10-30): the HUB owns the official (HMG) social accounts (admin-todo decision G).
// An account is a display key (`<domain>/<path>`, Gold's casing) and the URL prefixes that fold a citation into it;
// its category is always Official (HMG). Add, edit the matchers, stop and resume save at once and keep the history;
// each row shows whether Gold applies the account yet (back/bff/hub_stores/source_lists.py). Gold accounts the HUB
// lacks are listed as upstream rows to take over.

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { History, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import {
  RnButton,
  RnCard,
  RnDrawer,
  RnEmpty,
  RnIconButton,
  RnNote,
  RnPageHeader,
  RnTag,
  RnToastProvider,
  cx,
  useRnToast,
  useRnTruncTip,
} from "@/components/renewal-ui";
import { RnPageFrame } from "../../../../_components/filter-split";
import { LIST_TD as TD, RnDetailField } from "../../../../_components/prompt-list";
import { INPUT, Row } from "../../prompts/_components/hub-prompt-form";
import { socialApi, type SocialListing, type SocialMatcher, type SocialRow } from "./source-lists-api";
import { HistorySection, LIST_TH_PLAIN, ListPills, StateMark, useListError } from "./source-lists-kit";
import { defaultMatcher, socialProblems, type SocialProblem } from "./source-lists-model";

type Sheet = { mode: "add"; key: string; matchers: SocialMatcher[] } | { mode: "edit"; key: string } | { mode: "detail"; key: string };

export function SourceSocialsManager({ initial, tabs }: { initial: SocialListing; tabs?: ReactNode }) {
  return (
    <RnToastProvider>
      <Manager initial={initial} tabs={tabs} />
    </RnToastProvider>
  );
}

function Manager({ initial, tabs }: { initial: SocialListing; tabs?: ReactNode }) {
  const t = useTranslations("hubSourceLists");
  const ts = useTranslations("hubSourceLists.social");
  const to = useTranslations("hubSourceOverrides");
  const tp = useTranslations("renewal.prompts");
  const locale = useLocale();
  const toast = useRnToast();
  const tip = useRnTruncTip();
  const errorText = useListError();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const [listing, setListing] = useState(initial);
  const [saving, setSaving] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);

  const reload = () => socialApi.list().then(setListing, (e) => toast(errorText(e)));
  const items = useMemo(() => [...listing.items].sort((a, b) => (b.gold?.citations ?? 0) - (a.gold?.citations ?? 0) || a.accountKey.localeCompare(b.accountKey)), [listing.items]);
  const counts = {
    total: items.length,
    active: items.filter((r) => r.status === "active").length,
    stopped: items.filter((r) => r.status === "stopped").length,
    pending: items.filter((r) => r.state === "pending").length,
  };

  const toggle = async (row: SocialRow) => {
    const stopping = row.status === "active";
    setSaving(row.accountKey);
    try {
      await (stopping ? socialApi.stop(row.key) : socialApi.resume(row.key));
      toast(ts(stopping ? "toast.stopped" : "toast.resumed", { key: row.key }));
      await reload();
    } catch (e) {
      toast(errorText(e));
    } finally {
      setSaving(null);
    }
  };
  const sheetRow = sheet && sheet.mode !== "add" ? listing.items.find((r) => r.key === sheet.key) ?? null : null;
  const sheetTitle = sheet?.mode === "add" ? ts("form.titleAdd") : sheet?.mode === "edit" ? ts("form.titleEdit") : ts("detailTitle");

  return (
    <div className="flex flex-col gap-4">
      <RnPageFrame
        header={
          <RnPageHeader
            title={to("title")}
            meta={
              <>
                <ListPills family="source_social" published={listing.published} />
                <span>{ts("description")}</span>
              </>
            }
            actions={tabs}
          />
        }
      >
        <RnNote>
          <b className="text-rn-ink">{t("flowNoteTitle")}</b>
          <span>{ts("flowNote")}</span>
        </RnNote>
        <RnCard aria-label={ts("listLabel")}>
          <div className="flex flex-wrap items-center gap-2 border-b border-rn-line px-5 py-3">
            <RnButton size="sm" variant="primary" disabled={saving != null} onClick={() => setSheet({ mode: "add", key: "", matchers: [] })} data-hub-social-add="">
              <Plus className="size-3.5" aria-hidden />
              {ts("add")}
            </RnButton>
            <span className="ml-auto text-rn-12 text-rn-muted tabular-nums" data-hub-social-count="">
              {ts("count", { total: nf.format(counts.total), active: nf.format(counts.active), stopped: nf.format(counts.stopped), pending: nf.format(counts.pending) })}
            </span>
          </div>
          {items.length === 0 ? (
            <RnEmpty className="m-5">{ts("empty")}</RnEmpty>
          ) : (
            <div {...tip.bind}>
              <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13" data-hub-social-table="">
                <colgroup>
                  <col className="w-[300px]" />
                  <col className="w-[132px]" />
                  <col />
                  <col className="w-[132px]" />
                  <col className="w-[88px]" />
                  <col className="w-[120px]" />
                  <col className="w-[84px]" />
                  <col className="w-[176px]" />
                </colgroup>
                <thead>
                  <tr className="text-left text-rn-12 text-rn-muted">
                    <th className={cx(LIST_TH_PLAIN, "pl-5")}>{ts("column.key")}</th>
                    <th className={LIST_TH_PLAIN}>{ts("column.domain")}</th>
                    <th className={LIST_TH_PLAIN}>{ts("column.matchers")}</th>
                    <th className={LIST_TH_PLAIN}>{ts("column.category")}</th>
                    <th className={cx(LIST_TH_PLAIN, "text-right")}>{ts("column.citations")}</th>
                    <th className={LIST_TH_PLAIN}>{ts("column.state")}</th>
                    <th className={LIST_TH_PLAIN}>{ts("column.status")}</th>
                    <th className={cx(LIST_TH_PLAIN, "pr-5 text-right")}>{ts("column.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => {
                    const busy = saving != null;
                    const hub = row.status != null;
                    return (
                      <tr key={row.accountKey} data-hub-social-row={row.accountKey} className="hover:bg-rn-navy-25/60">
                        <td className={cx(TD, "pl-5")}>
                          <span data-rn-tip="" className={cx("block min-w-0 truncate font-semibold", row.status === "stopped" ? "text-rn-muted line-through" : "text-rn-ink")}>
                            {row.key}
                          </span>
                        </td>
                        <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>{row.domain}</td>
                        <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>
                          <span data-rn-tip="" className="block truncate font-mono" data-hub-social-matchers={row.matchers.length}>
                            {matchersSummary(row.matchers, ts)}
                          </span>
                        </td>
                        <td className={TD}>
                          <span data-rn-tip={ts("categoryFixedTip")} className="inline-flex">
                            <RnTag>{ts("categoryFixed")}</RnTag>
                          </span>
                        </td>
                        <td className={cx(TD, "text-right text-rn-12 text-rn-ink-2 tabular-nums")}>{nf.format(row.gold?.citations ?? 0)}</td>
                        <td className={TD}>
                          <SocialState row={row} />
                        </td>
                        <td className={cx(TD, "text-rn-12")}>{row.status ? ts(`status.${row.status}`) : <span className="text-rn-faint">—</span>}</td>
                        <td className={cx(TD, "pr-5")}>
                          <span className="flex items-center justify-end gap-1">
                            {hub ? (
                              <>
                                <RnIconButton label={`${ts("edit")} · ${row.key}`} disabled={busy} onClick={() => setSheet({ mode: "edit", key: row.key })} data-hub-social-edit={row.accountKey}>
                                  <Pencil className="size-4" aria-hidden />
                                </RnIconButton>
                                <RnButton size="sm" disabled={busy} onClick={() => void toggle(row)} data-hub-social-toggle={row.accountKey}>
                                  {row.status === "active" ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
                                  {ts(row.status === "active" ? "stop" : "resume")}
                                </RnButton>
                                <RnIconButton label={t("historyOpen", { name: row.key })} onClick={() => setSheet({ mode: "detail", key: row.key })} data-hub-social-history={row.accountKey}>
                                  <History className="size-4" aria-hidden />
                                </RnIconButton>
                              </>
                            ) : (
                              <RnButton size="sm" disabled={busy} onClick={() => setSheet({ mode: "add", key: row.key, matchers: [defaultMatcher(row.key)] })} data-hub-social-adopt={row.accountKey}>
                                <Plus className="size-3.5" aria-hidden />
                                {ts("addAsAccount")}
                              </RnButton>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {tip.tip}
            </div>
          )}
        </RnCard>
      </RnPageFrame>
      <RnDrawer open={sheet != null} onClose={() => setSheet(null)} title={sheetTitle} closeLabel={tp("close")}>
        {sheet?.mode === "add" ? (
          <SocialForm
            key={`add:${sheet.key}`}
            initialKey={sheet.key}
            initialMatchers={sheet.matchers}
            editing={false}
            onSaved={async (key) => {
              setSheet(null);
              toast(ts("toast.saved", { key }));
              await reload();
            }}
            onCancel={() => setSheet(null)}
          />
        ) : sheet?.mode === "edit" && sheetRow ? (
          <SocialForm
            key={`edit:${sheetRow.accountKey}:${sheetRow.updatedAt ?? ""}`}
            initialKey={sheetRow.key}
            initialMatchers={sheetRow.matchers}
            editing
            onSaved={async (key) => {
              setSheet(null);
              toast(ts("toast.saved", { key }));
              await reload();
            }}
            onCancel={() => setSheet(null)}
          />
        ) : sheet?.mode === "detail" && sheetRow ? (
          <SocialDetail key={sheetRow.accountKey} row={sheetRow} />
        ) : null}
      </RnDrawer>
    </div>
  );
}

function matchersSummary(matchers: readonly SocialMatcher[], ts: ReturnType<typeof useTranslations<"hubSourceLists.social">>): string {
  if (!matchers.length) return "—";
  const first = `${matchers[0].prefix}${matchers[0].boundary ? "" : "…"}`;
  return matchers.length === 1 ? first : ts("matchersMore", { first, more: matchers.length - 1 });
}

/** 반영됨 / 반영 대기 (중지 대기) / 업스트림 계정 / — (Gold has no such account). */
export function SocialState({ row }: { row: SocialRow }) {
  const ts = useTranslations("hubSourceLists.social");
  const stopping = row.state === "pending" && row.status === "stopped";
  const key = stopping ? "pendingStop" : row.state;
  return <StateMark state={row.state} attr="data-hub-social-state" label={key ? ts(`state.${key}`) : "—"} tip={ts(`stateTip.${key ?? "none"}`)} />;
}

export function SocialForm({
  initialKey,
  initialMatchers,
  editing,
  onSaved,
  onCancel,
}: {
  initialKey: string;
  initialMatchers: readonly SocialMatcher[];
  editing: boolean;
  onSaved: (key: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations("hubSourceLists");
  const ts = useTranslations("hubSourceLists.social");
  const errorText = useListError();
  const [key, setKey] = useState(initialKey);
  const [matchers, setMatchers] = useState<SocialMatcher[]>(initialMatchers.length ? initialMatchers.map((m) => ({ ...m })) : [{ prefix: "", boundary: true }]);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const problems = socialProblems(key, matchers);
  const shown = (p: SocialProblem) => tried && problems.includes(p);

  const setMatcher = (i: number, patch: Partial<SocialMatcher>) => setMatchers((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (pending || problems.length) return;
    setPending(true);
    setFailure(null);
    try {
      const out = await socialApi.set(key.trim(), matchers.map((m) => ({ prefix: m.prefix.trim(), boundary: m.boundary })));
      await onSaved(out.key);
    } catch (err) {
      setFailure(errorText(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-hub-social-form={editing ? "edit" : "add"} noValidate>
      <Row label={ts("form.key")} htmlFor="hub-social-key" invalid={shown("key")}>
        {editing ? (
          <span className="font-mono text-rn-13 text-rn-ink">{key}</span>
        ) : (
          <>
            <input
              id="hub-social-key"
              className={cx(INPUT, "font-mono")}
              value={key}
              onChange={(e) => {
                const next = e.target.value;
                // the first matcher follows the key while it is the key itself (lower case)
                setMatchers((ms) => (ms.length === 1 && (ms[0].prefix === "" || ms[0].prefix === key.trim().toLowerCase()) ? [{ ...ms[0], prefix: next.trim().toLowerCase() }] : ms));
                setKey(next);
              }}
              placeholder={ts("form.keyPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              maxLength={300}
              aria-invalid={shown("key") || undefined}
              data-hub-social-key=""
              autoFocus
            />
            <p className="m-0 mt-1 text-rn-11 text-rn-muted">{ts("form.keyHint")}</p>
          </>
        )}
        {shown("key") ? <p className="m-0 mt-1 text-rn-11 text-rn-danger-ink">{ts("form.problem.key")}</p> : null}
      </Row>
      <Row label={ts("column.category")}>
        <span title={ts("categoryFixedTip")} className="inline-flex">
          <RnTag>{ts("categoryFixed")}</RnTag>
        </span>
      </Row>
      <Row label={ts("form.matchers")} invalid={shown("matchers") || shown("prefix") || shown("duplicate")} top>
        <div className="flex flex-col gap-2" data-hub-social-matchers-editor="">
          <p className="m-0 text-rn-11 text-rn-muted">{ts("form.matchersHint")}</p>
          {matchers.map((m, i) => (
            <div key={i} className="flex items-center gap-2" data-hub-social-matcher={i}>
              <input
                className={cx(INPUT, "min-w-0 flex-1 font-mono")}
                value={m.prefix}
                onChange={(e) => setMatcher(i, { prefix: e.target.value })}
                aria-label={`${ts("form.prefix")} ${i + 1}`}
                aria-invalid={(tried && (problems.includes("prefix") || problems.includes("duplicate"))) || undefined}
                autoComplete="off"
                spellCheck={false}
                maxLength={300}
              />
              <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-rn-12 text-rn-ink-2" title={ts("form.boundaryHint")}>
                <input type="checkbox" className="size-3.5 cursor-pointer accent-rn-navy" checked={m.boundary} onChange={(e) => setMatcher(i, { boundary: e.target.checked })} />
                {ts("form.boundary")}
              </label>
              <RnIconButton label={ts("form.removeMatcher", { n: i + 1 })} disabled={matchers.length <= 1} onClick={() => setMatchers((ms) => ms.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" aria-hidden />
              </RnIconButton>
            </div>
          ))}
          <div>
            <RnButton size="sm" disabled={matchers.length >= 10} onClick={() => setMatchers((ms) => [...ms, { prefix: `${key.trim().split("/")[0].toLowerCase()}/`, boundary: true }])} data-hub-social-add-matcher="">
              <Plus className="size-3.5" aria-hidden />
              {ts("form.addMatcher")}
            </RnButton>
          </div>
          {(["matchers", "prefix", "duplicate"] as const).map((p) =>
            shown(p) ? (
              <p key={p} className="m-0 text-rn-11 text-rn-danger-ink" data-hub-social-problem={p}>
                {ts(`form.problem.${p}`)}
              </p>
            ) : null,
          )}
        </div>
      </Row>
      {failure ? (
        <p role="alert" className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-danger-ink">
          {failure}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <RnButton onClick={onCancel}>{t("cancel")}</RnButton>
        <RnButton type="submit" variant="primary" disabled={pending}>
          {t("save")}
        </RnButton>
      </div>
    </form>
  );
}

function SocialDetail({ row }: { row: SocialRow }) {
  const t = useTranslations("hubSourceLists");
  const ts = useTranslations("hubSourceLists.social");
  const to = useTranslations("hubSourceOverrides");
  const locale = useLocale();
  const value = (field: string, v: unknown): string | null => {
    if (v == null) return null;
    if (field === "status") return ts(`status.${v as "active"}`);
    if (field === "matchers" && Array.isArray(v)) return (v as SocialMatcher[]).map((m) => `${m.prefix}${m.boundary ? "" : "…"}`).join(", ");
    return String(v);
  };
  return (
    <div className="flex flex-col gap-6" data-hub-social-detail={row.accountKey}>
      <section className="flex flex-col gap-3">
        <b className="min-w-0 truncate font-mono text-rn-16 text-rn-ink">{row.key}</b>
        <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-rn-13">
          <RnDetailField label={ts("field.domain")}>{row.domain}</RnDetailField>
          <RnDetailField label={ts("field.matchers")}>
            <ul className="m-0 flex list-none flex-col gap-1 p-0 font-mono text-rn-12">
              {row.matchers.map((m) => (
                <li key={m.prefix}>
                  {m.prefix} <span className="text-rn-muted">· {ts(m.boundary ? "boundaryOn" : "boundaryOff")}</span>
                </li>
              ))}
            </ul>
          </RnDetailField>
          <RnDetailField label={ts("field.citations")}>
            <span className="tabular-nums">{new Intl.NumberFormat(locale).format(row.gold?.citations ?? 0)}</span>
          </RnDetailField>
          <RnDetailField label={ts("field.status")}>{row.status ? ts(`status.${row.status}`) : null}</RnDetailField>
          <RnDetailField label={ts("field.origin")}>{row.origin ? t(`origin.${row.origin}`) : null}</RnDetailField>
          <RnDetailField label={ts("field.gold")}>{row.gold ? (row.gold.source ? to(`source.${row.gold.source}`) : "—") : ts("goldNone")}</RnDetailField>
          <RnDetailField label={ts("field.state")}>
            <SocialState row={row} />
          </RnDetailField>
          <RnDetailField label={ts("field.note")}>{row.note}</RnDetailField>
        </dl>
      </section>
      <HistorySection
        load={() => socialApi.history(row.key)}
        version={`${row.accountKey}:${row.updatedAt ?? ""}`}
        eventLabel={(a) => ts(`event.${a as "add"}`)}
        fieldLabel={(f) => ts(`field.${f as "matchers"}`)}
        value={value}
      />
    </div>
  );
}
