"use client";

// Project › Prompt (2026-11-03): the editing parts of the page — a tag value in place, the add sheet (one draft per line),
// the tag columns sheet and a prompt's history. Every write goes to the HUB (project-prompts-api.ts) and the page reads its
// data again; Gold is never written.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Loader2, Plus } from "lucide-react";
import { RnButton, RnDrawer, RnNote, cx, useRnToast } from "@/components/renewal-ui";
import { languageName } from "@/lib/geo-catalog/language-name";
import { RnTimeline } from "../../_components/prompt-list";
import { StateMark } from "../../admin/standards/citation-sources/_components/source-lists-kit";
import { errorCode, projectPromptApi, type PromptHistoryEvent } from "./project-prompts-api";

export interface ProjectPromptField {
  id: string;
  label: string;
  archived: boolean;
  /** The BFF's comparison with Gold; only `upstream` (only Gold has it, so it cannot be changed) is used: no screen says whether an input reached the numbers (user 2026-11-06). */
  state: "applied" | "pending" | "upstream";
}

/** The error text of a refused write. */
export function useWriteError() {
  const t = useTranslations("renewal.projects.prompts.errors");
  return (e: unknown) => t(errorCode(e));
}

/**
 * A tag value in an input: Enter or leaving the field saves a changed value, Escape gives up. An empty value clears the tag.
 * `options` are the values the column already has (a datalist), so the same spelling is easy to keep.
 */
export function TagInput({
  value,
  options,
  label,
  onSave,
  onDone,
  className,
}: {
  value: string | null;
  options: readonly string[];
  label: string;
  onSave: (value: string | null) => Promise<void>;
  onDone?: () => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);
  const settled = useRef(false);
  const listId = useRef(`rn-tag-${Math.random().toString(36).slice(2)}`).current;
  useEffect(() => setDraft(value ?? ""), [value]);
  async function commit() {
    if (settled.current) return;
    const next = draft.trim() || null;
    if (next === (value ?? null)) {
      settled.current = true;
      onDone?.();
      return;
    }
    settled.current = true;
    setSaving(true);
    try {
      await onSave(next);
    } catch {
      settled.current = false;
      setDraft(value ?? "");
    } finally {
      setSaving(false);
      onDone?.();
    }
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      settled.current = true;
      setDraft(value ?? "");
      onDone?.();
    }
  }
  return (
    <span className={cx("relative flex min-w-0 items-center", className)}>
      <input
        aria-label={label}
        list={listId}
        value={draft}
        maxLength={500}
        disabled={saving}
        autoFocus={!!onDone}
        onFocus={() => (settled.current = false)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => void commit()}
        onClick={(e) => e.stopPropagation()}
        data-rn-tag-input=""
        className="h-7 w-full min-w-0 rounded-md border border-rn-line-2 bg-rn-surface px-2 text-rn-12 text-rn-ink outline-none focus:border-rn-navy focus:ring-3 focus:ring-rn-navy/12"
      />
      {saving ? <Loader2 aria-hidden className="absolute right-1.5 size-3.5 animate-spin text-rn-muted" /> : null}
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </span>
  );
}

/** The original's manual add: one prompt per line, every one a draft. */
export function AddPromptsSheet({ pid, open, onClose, onDone }: { pid: string; open: boolean; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("renewal.projects.prompts");
  const tp = useTranslations("renewal.prompts");
  const writeError = useWriteError();
  const toast = useRnToast();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
  async function submit() {
    setSaving(true);
    setFailure(null);
    try {
      const out = await projectPromptApi.add(pid, text);
      toast(out.skipped.length ? t("addedSkipped", { created: out.created.length, skipped: out.skipped.length }) : t("added", { created: out.created.length }));
      setText("");
      onDone();
      onClose();
    } catch (e) {
      setFailure(writeError(e));
    } finally {
      setSaving(false);
    }
  }
  if (!open) return null;
  return (
    <RnDrawer open onClose={onClose} title={t("addTitle")} closeLabel={tp("close")}>
      <div className="flex flex-col gap-3" data-rn-project-prompt-add="">
        <p className="m-0 text-rn-13 text-rn-ink-2">{t("addHint")}</p>
        <textarea
          aria-label={t("addTitle")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={14}
          placeholder={t("addPlaceholder")}
          className="w-full resize-y rounded-[10px] border border-rn-line-2 bg-rn-surface p-3 text-rn-13 leading-relaxed text-rn-ink outline-none focus:border-rn-navy focus:ring-3 focus:ring-rn-navy/12"
        />
        {failure ? (
          <p role="alert" className="m-0 text-rn-12 text-rn-danger-ink">
            {failure}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <span className="text-rn-12 text-rn-muted tabular-nums">{t("addLines", { count: lines })}</span>
          <RnButton className="ml-auto" onClick={onClose} disabled={saving}>
            {t("cancel")}
          </RnButton>
          <RnButton variant="primary" onClick={submit} disabled={saving || lines === 0} data-rn-project-prompt-add-submit="">
            {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
            {t("addSubmit")}
          </RnButton>
        </div>
      </div>
    </RnDrawer>
  );
}

/** The project's tag columns: add one, archive or restore one (its values stay), each against Gold. */
export function TagFieldsSheet({
  pid,
  fields,
  editable,
  open,
  onClose,
  onDone,
}: {
  pid: string;
  fields: readonly ProjectPromptField[];
  editable: boolean;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("renewal.projects.prompts");
  const tp = useTranslations("renewal.prompts");
  const writeError = useWriteError();
  const toast = useRnToast();
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  async function run(key: string, work: () => Promise<unknown>, done: string) {
    setSaving(key);
    setFailure(null);
    try {
      await work();
      toast(done);
      onDone();
      return true;
    } catch (e) {
      setFailure(writeError(e));
      return false;
    } finally {
      setSaving(null);
    }
  }
  if (!open) return null;
  return (
    <RnDrawer open onClose={onClose} title={t("tagsTitle")} closeLabel={tp("close")}>
      <div className="flex flex-col gap-4" data-rn-project-tag-fields="">
        <p className="m-0 text-rn-13 text-rn-ink-2">{t("tagsHint")}</p>
        {editable ? (
          <form
            className="flex items-center gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run("add", () => projectPromptApi.addField(pid, label), t("tagAdded", { label: label.trim() }))) setLabel("");
            }}
          >
            <input
              aria-label={t("tagAddLabel")}
              value={label}
              maxLength={100}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("tagAddPlaceholder")}
              className="h-[30px] min-w-0 flex-1 rounded-md border border-rn-line-2 bg-rn-surface px-2.5 text-rn-13 text-rn-ink outline-none focus:border-rn-navy focus:ring-3 focus:ring-rn-navy/12"
            />
            <RnButton type="submit" variant="primary" disabled={!label.trim() || saving !== null} data-rn-tag-field-add="">
              {saving === "add" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
              {t("tagAdd")}
            </RnButton>
          </form>
        ) : null}
        {failure ? (
          <p role="alert" className="m-0 text-rn-12 text-rn-danger-ink">
            {failure}
          </p>
        ) : null}
        {fields.length ? (
          <ul className="m-0 flex list-none flex-col p-0">
            {fields.map((f) => (
              <li key={f.id} className="flex items-center gap-3 border-t border-rn-line py-2.5 text-rn-13" data-rn-tag-field={f.id}>
                <span className={cx("min-w-0 flex-1 truncate font-semibold", f.archived ? "text-rn-muted line-through" : "text-rn-ink")}>{f.label}</span>
                {f.archived ? <span className="text-rn-12 text-rn-muted">{t("tagArchived")}</span> : null}
                {f.state === "upstream" ? <StateMark state="upstream" label={t("state.upstream")} tip={t("fieldStateTip.upstream")} attr="data-rn-tag-field-state" /> : null}
                {editable && f.state !== "upstream" ? (
                  <RnButton
                    size="sm"
                    disabled={saving !== null}
                    onClick={() => run(f.id, () => projectPromptApi.fieldStatus(pid, f.id, !f.archived), f.archived ? t("tagRestored", { label: f.label }) : t("tagArchivedToast", { label: f.label }))}
                    data-rn-tag-field-toggle={f.archived ? "restore" : "archive"}
                  >
                    {saving === f.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                    {f.archived ? t("tagRestore") : t("tagArchive")}
                  </RnButton>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-rn-13 text-rn-muted">{t("tagsNone")}</p>
        )}
        <RnNote>{t("tagsNote")}</RnNote>
      </div>
    </RnDrawer>
  );
}

/** A prompt's revisions, newest first; loads again when the prompt changed (its version). */
export function PromptHistory({ pid, id, version, fieldLabel }: { pid: string; id: string; version: number; fieldLabel: (field: string) => string }) {
  const t = useTranslations("renewal.projects.prompts");
  const locale = useLocale();
  const writeError = useWriteError();
  const [events, setEvents] = useState<PromptHistoryEvent[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    projectPromptApi.history(pid, id).then(
      (d) => live && (setEvents(d.history), setFailure(null)),
      (e) => live && setFailure(writeError(e)),
    );
    return () => {
      live = false;
    };
  }, [pid, id, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (v: string | null, field: string) => (v && field === "lang" ? languageName(v, locale) : v);
  return (
    <section data-rn-project-prompt-history="">
      <h3 className="m-0 mb-3 text-rn-13 font-bold text-rn-ink">{t("history.title")}</h3>
      {failure ? (
        <p role="alert" className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-ink-2">
          {failure}
        </p>
      ) : !events ? (
        <p className="flex items-center gap-2 text-rn-13 text-rn-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("history.loading")}
        </p>
      ) : (
        <RnTimeline
          fieldLabel={fieldLabel}
          events={events.map((e) => ({
            key: String(e.version),
            label: t(`history.${e.event}`),
            at: e.recordedAt,
            actor: e.actor ? e.actor.displayName || e.actor.login : e.recordedBy ? "—" : t("history.gold"),
            marks: [`v${e.version}`],
            changes: Object.fromEntries(Object.entries(e.changes).map(([f, c]) => [f, { old: shown(c.old, f), new: shown(c.new, f) }])),
            note: e.event === "updated" ? t("history.noValueChange") : undefined,
          }))}
        />
      )}
    </section>
  );
}
