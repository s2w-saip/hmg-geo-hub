"use client";

// The create / edit form of Admin › Global prompts (2026-10-28), in the detail sheet. It is laid out like
// the sheet's 속성 list (same labels, same order, a 112px label column), and every code is picked from
// the options the BFF serves (the codes the catalog uses, Gold's taxonomy), so a save is not refused for
// an unknown or misspelt code.
//   text      one line (line breaks become spaces), a counter, ⌘/Ctrl+Enter saves; an active prompt with
//             the same text and language is flagged while typing (the BFF refuses it on save)
//   language  the catalog's languages by name; the text's script suggests one (Hangul → 한국어)
//   taxonomy  Depth1 → Depth2 → Depth3 along Gold's tree (catalog_editor.check_taxonomy_path)
//   markets   a checklist by continent with a search, picks as chips; none = 전체 (inherited)
//   create    "만들고 계속 추가" keeps the attributes for the next prompt; the manager keeps an unfinished
//             draft when the sheet closes

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronDown, Loader2, Plus } from "lucide-react";
import { RnButton, RnCheckRow, RnGroupHeader, RnNote, RnSearchField, RnSegmented, RnTextButton, RnToken, cx } from "@/components/renewal-ui";
import { geoLocateByCode } from "@/lib/geo-catalog";
import { languageName } from "@/lib/geo-catalog/language-name";
import { isPseudoRegion } from "@/lib/standards/prompt-markets";
import { RnMarketList, useRnMarketLabel } from "../../../../_components/prompt-list";
import { HubRequestError, draftOf, hubApi, type Draft, type HubOptions, type HubPrompt } from "./hub-prompts-api";

const TEXT_MAX = 2000;
const INPUT =
  "h-[34px] w-full rounded-rn-control border border-rn-line-2 bg-rn-surface px-2.5 text-rn-13 text-rn-ink outline-none placeholder:text-rn-muted focus:border-rn-navy focus:ring-3 focus:ring-rn-navy/12 disabled:cursor-not-allowed disabled:bg-rn-page disabled:text-rn-muted aria-invalid:border-rn-down";
// a catalog field's label = the Global prompts list's name for the same attribute
const FIELD_KEYS = {
  text: "textLabel",
  kind: "kindLabel",
  language: "langLabel",
  regions: "marketLabel",
  region: "marketLabel",
  funnel: "funnelLabel",
  brandPresence: "presenceLabel",
  listType: "filterListType",
  depth1: "filterDepth1",
  depth2: "filterDepth2",
  depth3: "filterDepth3",
  depth4: "filterDepth4",
} as const;
// catalog continents (lib/geo-catalog) -> dashboard.geo.regions keys, in the list's order
const CONTINENTS: Record<string, string> = {
  Asia: "asia",
  Europe: "europe",
  "North America": "northAmerica",
  "Latin America": "latinAmerica",
  "Middle East": "middleEast",
  Africa: "africa",
  Oceania: "oceania",
};
// a script only one language writes (suggested, never applied by itself); Japanese before Chinese (kana + Han)
const SCRIPTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[가-힯]/, "ko"],
  [/[぀-ヿ]/, "ja"],
  [/[一-鿿]/, "zh"],
  [/[฀-๿]/, "th"],
  [/[Ͱ-Ͽ]/, "el"],
  [/[֐-׿]/, "he"],
  [/[؀-ۿ]/, "ar"],
];
const natural = new Intl.Collator(undefined, { numeric: true }).compare;
// the known codes in their own order (the funnel's stages, 포함 before 미포함); others after, by use
const CHOICE_ORDER: Record<"brandPresence" | "funnel", readonly string[]> = {
  brandPresence: ["branded", "unbranded"],
  funnel: ["인지/탐색", "비교/검증", "구매/사후관리"],
};

export function useFieldLabel() {
  const tv = useTranslations("standardPromptsView");
  return useCallback((field: string) => (field in FIELD_KEYS ? tv(FIELD_KEYS[field as keyof typeof FIELD_KEYS]) : field), [tv]);
}

export function ErrorNote({ code, fields, loginHref, className }: { code: string; fields?: string[]; loginHref: string; className?: string }) {
  const t = useTranslations("hubPrompts");
  const fieldLabel = useFieldLabel();
  const known = ["version_conflict", "duplicate", "unknown_code", "invalid_value", "invalid_taxonomy", "archived", "gold_owned", "unauthorized", "source_unavailable", "not_found"];
  const names = (fields ?? []).map(fieldLabel).join(", ");
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

/** The language a text's script points to, when the catalog has it. */
export function suggestLanguage(text: string, languages: readonly string[]): string | null {
  const hit = SCRIPTS.find(([re]) => re.test(text));
  return hit && languages.includes(hit[1]) ? hit[1] : null;
}

/** The depth codes that can follow `parents` (null = a parent is not picked yet). */
export function depthOptions(options: HubOptions, field: "depth1" | "depth2" | "depth3", parents: string[]): string[] | null {
  // no recorded taxonomy yet: the codes the catalog uses (the BFF has no tree to check against either)
  if (options.taxonomy.length === 0) return options[field].map((o) => o.value);
  if (parents.some((p) => !p)) return null;
  const codes = options.taxonomy.filter((x) => x.field === field && x.path.length === parents.length && x.path.every((p, i) => p === parents[i])).map((x) => x.code);
  return [...new Set(codes)].sort(natural);
}

export const isBlankDraft = (d: Draft) => JSON.stringify(d) === JSON.stringify(draftOf(null));

export function HubPromptForm({
  item,
  initial,
  options,
  loginHref,
  onDraft,
  onSaved,
  onConflict,
  onCancel,
}: {
  item: HubPrompt | null;
  /** create: the unfinished draft the manager kept */
  initial?: Draft;
  options: HubOptions;
  loginHref: string;
  /** create: every change, for the manager to keep */
  onDraft?: (draft: Draft) => void;
  /** `another` = 만들고 계속 추가 (the form stays, its text emptied) */
  onSaved: (item: HubPrompt, another: boolean) => void;
  onConflict?: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("hubPrompts");
  const tf = useTranslations("hubPrompts.form");
  const tv = useTranslations("standardPromptsView");
  const tVal = useTranslations("dashboard.filters.value");
  const tp = useTranslations("renewal.prompts");
  const locale = useLocale();
  const fieldLabel = useFieldLabel();
  const [draft, setDraftState] = useState<Draft>(() => initial ?? draftOf(item));
  const [restored, setRestored] = useState(() => initial != null && !isBlankDraft(initial));
  const [pending, setPending] = useState<"save" | "another" | null>(null);
  const [failure, setFailure] = useState<HubRequestError | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const setDraft = (next: Draft) => {
    setDraftState(next);
    onDraft?.(next);
  };
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft({ ...draft, [key]: value });
  // a parent pick empties the levels under it
  const setDepth = (level: 1 | 2 | 3, code: string) =>
    setDraft({ ...draft, [`depth${level}`]: code, ...(level < 2 ? { depth2: "" } : {}), ...(level < 3 ? { depth3: "" } : {}) });
  const invalid = (field: string) => failure?.details?.fields?.includes(field) || undefined;

  // the sheet focuses itself when it opens; the text field takes the focus after it
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = textRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // active prompts with the same text, read 400 ms after typing stops (the BFF's duplicate rule: text + language)
  const text = draft.text.trim();
  const [same, setSame] = useState<HubPrompt[]>([]);
  useEffect(() => {
    if (text.length < 2) {
      setSame([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ status: "active", origin: "all", q: text.slice(0, 200), limit: "50", offset: "0" });
      hubApi.list(query.toString()).then(
        (page) => live && setSame(page.items.filter((p) => p.text === text && p.id !== item?.id)),
        () => live && setSame([]),
      );
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, item?.id]);
  const lang = draft.language.trim().toLowerCase();
  const duplicate = same.some((p) => (p.language ?? "") === lang);
  const otherLanguages = [...new Set(same.map((p) => p.language ?? "").filter((l) => l !== lang))];
  const languageCodes = useMemo(() => options.language.map((o) => o.value), [options.language]);
  const suggested = suggestLanguage(text, languageCodes);

  async function submit(mode: "save" | "another") {
    if (pending || !text || duplicate) return;
    setPending(mode);
    setFailure(null);
    try {
      const out = await (item ? hubApi.update(item.id, item.version, draft) : hubApi.create(draft));
      if (!out.changed) {
        onCancel();
        return;
      }
      if (mode === "another") {
        setDraft({ ...draft, text: "" });
        textRef.current?.focus();
      }
      onSaved(out.item, mode === "another");
    } catch (e) {
      const err = e instanceof HubRequestError ? e : new HubRequestError(0, "failed");
      setFailure(err);
      if (err.code === "version_conflict") onConflict?.();
    } finally {
      setPending(null);
    }
  }

  const labelOf = (field: "brandPresence" | "funnel", v: string) => (field === "brandPresence" && (v === "branded" || v === "unbranded") ? tVal(v) : v);
  const choice = (field: "brandPresence" | "funnel") => {
    const rank = (v: string) => (CHOICE_ORDER[field].indexOf(v) + 1 || CHOICE_ORDER[field].length + 1);
    const values = withValue(options[field].map((o) => o.value), draft[field]).sort((a, b) => rank(a) - rank(b));
    // a few short values side by side (as the panel's segmented controls); more in a list
    return values.length <= 3 ? (
      <RnSegmented
        label={fieldLabel(field)}
        value={draft[field]}
        onChange={(v) => set(field, v)}
        items={[{ value: "", label: tf("unset") }, ...values.map((v) => ({ value: v, label: labelOf(field, v) }))]}
      />
    ) : (
      <FormSelect id={`hub-${field}`} value={draft[field]} onChange={(v) => set(field, v)} placeholder={tf("unset")} invalid={invalid(field)} options={values.map((v) => ({ value: v, label: labelOf(field, v) }))} />
    );
  };
  const depth = (level: 1 | 2 | 3) => {
    const field = `depth${level}` as const;
    const parents = [draft.depth1, draft.depth2].slice(0, level - 1);
    const codes = depthOptions(options, field, parents);
    return (
      <FormSelect
        id={`hub-${field}`}
        value={draft[field]}
        onChange={(v) => setDepth(level, v)}
        disabled={codes === null || (codes.length === 0 && !draft[field])}
        placeholder={codes === null ? tf("pickParentFirst", { parent: fieldLabel(`depth${level - 1}`) }) : codes.length === 0 ? tf("noChildren") : tf("unset")}
        invalid={invalid(field)}
        options={withValue(codes ?? [], draft[field]).map((v) => ({ value: v, label: v }))}
      />
    );
  };

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        void submit("save");
      }}
    >
      {restored ? (
        <RnNote>
          <span>{tf("restored")}</span>
          <RnTextButton
            onClick={() => {
              setDraft(draftOf(null));
              setRestored(false);
              textRef.current?.focus();
            }}
          >
            {tf("startOver")}
          </RnTextButton>
        </RnNote>
      ) : null}
      <section className="flex flex-col gap-2">
        <label htmlFor="hub-text" className="text-rn-13 font-bold text-rn-ink">
          {fieldLabel("text")}
        </label>
        <textarea
          ref={textRef}
          id="hub-text"
          required
          rows={2}
          maxLength={TEXT_MAX}
          value={draft.text}
          placeholder={tf("textPlaceholder")}
          aria-invalid={invalid("text") ?? (duplicate || undefined)}
          aria-describedby="hub-text-hint"
          // one line: the catalog refuses line breaks (a pasted one becomes a space)
          onChange={(e) => set("text", e.target.value.replace(/[\r\n]+/g, " "))}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (e.metaKey || e.ctrlKey) void submit("save");
          }}
          className="max-h-[220px] min-h-[76px] w-full resize-none rounded-xl border border-rn-line-2 bg-rn-surface px-4 py-3 text-rn-15 leading-relaxed break-words text-rn-ink outline-none field-sizing-content placeholder:text-rn-muted focus:border-rn-navy focus:ring-3 focus:ring-rn-navy/12 aria-invalid:border-rn-down"
        />
        <div id="hub-text-hint" className="flex items-start justify-between gap-3 text-rn-11 text-rn-muted">
          <span>{tf("textHint")}</span>
          <span className="shrink-0 tabular-nums">
            {draft.text.length.toLocaleString(locale)} / {TEXT_MAX.toLocaleString(locale)}
          </span>
        </div>
        {duplicate ? (
          <p role="alert" data-hub-duplicate="" className="m-0 text-rn-12 text-rn-danger-ink">
            {tf("duplicate")}
          </p>
        ) : otherLanguages.length ? (
          <p className="m-0 text-rn-12 text-rn-muted">{tf("sameTextOtherLanguage", { languages: otherLanguages.map((l) => (l ? languageName(l, locale) : tf("unset"))).join(", ") })}</p>
        ) : null}
      </section>
      <section className="flex flex-col gap-3">
        <h3 className="m-0 text-rn-13 font-bold text-rn-ink">{tp("detail.attributes")}</h3>
        <Row label={fieldLabel("brandPresence")} invalid={invalid("brandPresence")}>
          {choice("brandPresence")}
        </Row>
        <Row label={fieldLabel("language")} htmlFor="hub-language" invalid={invalid("language")}>
          <FormSelect
            id="hub-language"
            value={draft.language}
            onChange={(v) => set("language", v)}
            placeholder={tf("unset")}
            invalid={invalid("language")}
            options={withValue(languageCodes, draft.language)
              .map((code) => ({ value: code, label: `${languageName(code, locale)} (${code.toUpperCase()})` }))
              .sort((a, b) => a.label.localeCompare(b.label, locale))}
          />
          {suggested && suggested !== lang ? (
            <p className="m-0 mt-1.5 flex items-center gap-1.5 text-rn-12 text-rn-muted">
              {tf("languageSuggest", { language: languageName(suggested, locale) })}
              <RnTextButton onClick={() => set("language", suggested)} data-hub-language-suggest="">
                {tf("apply")}
              </RnTextButton>
            </p>
          ) : null}
        </Row>
        <Row label={fieldLabel("listType")} htmlFor="hub-listType" invalid={invalid("listType")}>
          <FormSelect
            id="hub-listType"
            value={draft.listType}
            onChange={(v) => set("listType", v)}
            placeholder={tf("unset")}
            invalid={invalid("listType")}
            options={withValue(options.listType.map((o) => o.value), draft.listType).map((v) => ({ value: v, label: v }))}
          />
        </Row>
        <Row label={fieldLabel("depth1")} htmlFor="hub-depth1" invalid={invalid("depth1")}>
          {depth(1)}
        </Row>
        <Row label={fieldLabel("depth2")} htmlFor="hub-depth2" invalid={invalid("depth2")}>
          {depth(2)}
        </Row>
        <Row label={fieldLabel("depth3")} htmlFor="hub-depth3" invalid={invalid("depth3")}>
          {depth(3)}
        </Row>
        {options.depth4.length || draft.depth4 ? (
          <Row label={fieldLabel("depth4")} htmlFor="hub-depth4" invalid={invalid("depth4")}>
            <FormSelect
              id="hub-depth4"
              value={draft.depth4}
              onChange={(v) => set("depth4", v)}
              placeholder={tf("unset")}
              invalid={invalid("depth4")}
              options={withValue(options.depth4.map((o) => o.value), draft.depth4).map((v) => ({ value: v, label: v }))}
            />
          </Row>
        ) : null}
        <Row label={fieldLabel("funnel")} invalid={invalid("funnel")}>
          {choice("funnel")}
        </Row>
        <Row label={fieldLabel("regions")} invalid={invalid("regions")} top>
          <MarketPicker value={draft.regions} onChange={(v) => set("regions", v)} codes={options.regions.map((o) => o.value)} />
        </Row>
        <Row label={fieldLabel("kind")} invalid={invalid("kind")}>
          <RnSegmented label={fieldLabel("kind")} value={draft.kind} onChange={(v) => set("kind", v)} items={options.kinds.map((k) => ({ value: k, label: k === "acr" ? tv("kindAcr") : tv("kindSingle") }))} />
        </Row>
      </section>
      {failure ? <ErrorNote code={failure.code} fields={failure.details?.fields} loginHref={loginHref} /> : null}
      {/* the actions stay at the sheet's bottom edge while the form scrolls (-bottom-5 / -mb-5: over the sheet's bottom padding) */}
      <div className="sticky -bottom-5 z-[1] -mx-6 -mt-2 -mb-5 flex flex-wrap items-center gap-2 border-t border-rn-line bg-rn-surface px-6 py-3">
        <RnButton type="submit" variant="primary" disabled={pending != null || !text || duplicate} data-hub-save="">
          {pending === "save" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          {item ? t("save") : t("createSubmit")}
        </RnButton>
        {item ? null : (
          <RnButton disabled={pending != null || !text || duplicate} onClick={() => void submit("another")} data-hub-save-another="">
            {pending === "another" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
            {tf("createAnother")}
          </RnButton>
        )}
        <span className="text-rn-11 text-rn-muted">{tf("saveShortcut")}</span>
        <RnButton className="ml-auto" onClick={onCancel}>
          {t("cancel")}
        </RnButton>
      </div>
    </form>
  );
}

/** A value the list does not offer (an older code) stays pickable. */
function withValue(values: readonly string[], value: string): string[] {
  return value && !values.includes(value) ? [value, ...values] : [...values];
}

/** One attribute row: the sheet's 112px label column, then the control. */
function Row({ label, htmlFor, invalid, top, children }: { label: string; htmlFor?: string; invalid?: boolean; top?: boolean; children: ReactNode }) {
  const cls = cx("text-rn-12 font-semibold", top && "pt-1", invalid ? "text-rn-danger-ink" : "text-rn-muted");
  return (
    <div className={cx("grid grid-cols-[112px_minmax(0,1fr)] gap-x-4", top ? "items-start" : "items-center")}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className={cls}>
          {label}
        </label>
      ) : (
        <span className={cls}>{label}</span>
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A native select in the form's input size ("" = the placeholder, unset). */
function FormSelect({
  id,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <span className="relative block">
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-invalid={invalid}
        onChange={(e) => onChange(e.target.value)}
        className={cx(INPUT, "cursor-pointer appearance-none pr-8", !value && "text-rn-muted")}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value} className="text-rn-ink">
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-rn-muted" />
    </span>
  );
}

/**
 * The markets as the filter panel picks them: a search, the catalog's markets by continent (a continent's
 * head picks or clears its markets), the picks as chips. None picked = 전체 (inherited from the scope).
 */
function MarketPicker({ value, onChange, codes }: { value: string[]; onChange: (v: string[]) => void; codes: string[] }) {
  const tf = useTranslations("hubPrompts.form");
  const tv = useTranslations("standardPromptsView");
  const tGeo = useTranslations("dashboard.geo.regions");
  const tFilters = useTranslations("dashboard.filters");
  const tr = useTranslations("renewal.filters");
  const locale = useLocale();
  const labelOf = useRnMarketLabel();
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const groups = useMemo(() => {
    const keyOf = (code: string) => (isPseudoRegion(code) ? "globalHub" : (CONTINENTS[geoLocateByCode(code)?.region ?? ""] ?? ""));
    const order = ["globalHub", ...Object.values(CONTINENTS), ""];
    const shown = codes.filter((c) => !query || c.toLowerCase().includes(query) || labelOf(c).toLowerCase().includes(query));
    return order
      .map((key) => ({ key, codes: shown.filter((c) => keyOf(c) === key).sort((a, b) => labelOf(a).localeCompare(labelOf(b), locale)) }))
      .filter((g) => g.codes.length);
  }, [codes, query, labelOf, locale]);
  const toggle = (code: string) => onChange(value.includes(code) ? value.filter((c) => c !== code) : [...value, code]);
  return (
    <div className="flex flex-col gap-2">
      {value.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {value.map((code) => (
            <RnToken key={code} label={code} value={labelOf(code)} removeLabel={tf("removeMarket", { market: labelOf(code) })} onRemove={() => toggle(code)} />
          ))}
          <RnTextButton className="ml-1" onClick={() => onChange([])}>
            {tFilters("clearAxis")}
          </RnTextButton>
        </div>
      ) : (
        <RnMarketList codes={[]} labelOf={labelOf} allLabel={tv("marketAll")} allHint={tv("marketAllHint")} />
      )}
      <div className="rounded-rn-control border border-rn-line-2">
        <div className="border-b border-rn-line p-1.5">
          <RnSearchField value={q} onChange={setQ} placeholder={tf("marketSearch")} label={tf("marketSearch")} />
        </div>
        <div role="group" aria-label={tv("marketLabel")} className="max-h-[232px] overflow-y-auto overscroll-contain p-1" data-hub-markets="">
          {groups.length === 0 ? <p className="m-0 px-2.5 py-2 text-rn-12 text-rn-muted">—</p> : null}
          {groups.map((g) => {
            const anyIn = g.codes.some((c) => value.includes(c));
            return (
              <div key={g.key || "other"}>
                {g.key ? (
                  <RnGroupHeader
                    label={g.key === "globalHub" ? tFilters("group.globalHub") : tGeo(g.key as "asia")}
                    active={anyIn}
                    title={anyIn ? tr("groupClear") : tr("groupSelectAll")}
                    onToggle={() => onChange(anyIn ? value.filter((c) => !g.codes.includes(c)) : [...value, ...g.codes.filter((c) => !value.includes(c))])}
                  />
                ) : null}
                {g.codes.map((code) => (
                  <RnCheckRow key={code} checked={value.includes(code)} label={labelOf(code)} meta={code} onToggle={() => toggle(code)} />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
