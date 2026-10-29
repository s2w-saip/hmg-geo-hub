"use client";

// Admin › GA4 연동 (2026-10-29): the create / edit form of one GA4 property, in the sheet. The property ID is set
// once. The countries offered are the chosen brand's, grouped by its RHQ regions. With the listed-events basis the
// events come from what the collector already stored for the property (its last 90 collected days); a property not
// collected yet, or an event not seen in those days, is typed by name. The BFF never calls GA4, so nothing here
// checks the property against GA4: the collector's next run does, and the list shows its result.

import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Loader2, Plus, X } from "lucide-react";
import { RnButton, RnCheckRow, RnNote, RnSegmented, RnTag, cx } from "@/components/renewal-ui";
import { countryName } from "@/lib/geo-catalog/country-name";
import { rhqLabel, rhqRegionsForBrand } from "@/lib/rhq";
import { INPUT, Row } from "../../standards/prompts/_components/hub-prompt-form";
import {
  EVENT_PATTERN,
  GA4_BASES,
  GA4_BRANDS,
  Ga4RequestError,
  draftOf,
  ga4Api,
  missingFields,
  type Ga4Basis,
  type Ga4Draft,
  type Ga4Property,
  type Ga4StoredEvents,
} from "./ga4-registry-api";

export function Ga4ErrorNote({ error, className }: { error: Ga4RequestError; className?: string }) {
  const t = useTranslations("hubGa4");
  const known = ["property_taken", "market_taken", "invalid_value", "version_conflict", "unauthorized", "forbidden", "source_unavailable", "not_found"];
  const fields = (error.details?.fields ?? []).map((f) => t(`field.${f}` as "field.brand")).join(", ");
  return (
    <p role="alert" data-hub-ga4-error={error.code} className={cx("m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-ink-2", className)}>
      {t(`error.${known.includes(error.code) ? error.code : "failed"}`, { fields: fields || "—", propertyId: error.details?.propertyId ?? "—" })}
    </p>
  );
}

export function Ga4PropertyForm({
  item,
  onSaved,
  onCancel,
  onConflict,
}: {
  item: Ga4Property | null;
  onSaved: (item: Ga4Property) => void;
  onCancel: () => void;
  onConflict?: () => void;
}) {
  const t = useTranslations("hubGa4");
  const locale = useLocale();
  const lang = locale === "en" ? "en" : "ko";
  const [draft, setDraft] = useState<Ga4Draft>(() => draftOf(item));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Ga4RequestError | null>(null);
  const [tried, setTried] = useState(false);
  const [typed, setTyped] = useState("");
  const [typedBad, setTypedBad] = useState(false);
  const [stored, setStored] = useState<Ga4StoredEvents | null>(null);
  const creating = item == null;
  const missing = missingFields(draft, creating);
  const shown = (field: string) => tried && missing.includes(field);
  const set = (patch: Partial<Ga4Draft>) => setDraft((d) => ({ ...d, ...patch }));

  // the stored events of an existing property, read once when the listed-events basis is first shown
  const wantsEvents = !creating && draft.basis === "events";
  useEffect(() => {
    if (!wantsEvents || stored || !item) return;
    let live = true;
    ga4Api.events(item.propertyId).then(
      (s) => live && setStored(s),
      () => live && setStored({ days: 90, to: null, events: [] }),
    );
    return () => {
      live = false;
    };
  }, [wantsEvents, stored, item]);

  const groups = useMemo(
    () =>
      rhqRegionsForBrand(draft.brand).map((r) => ({
        id: r.id,
        label: rhqLabel(r.id, lang) ?? r.id,
        codes: [...r.countries].sort((a, b) => countryName(a, locale).localeCompare(countryName(b, locale), locale)),
      })),
    [draft.brand, lang, locale],
  );
  const offered = new Set(groups.flatMap((g) => g.codes));
  // a stored country outside the brand's RHQ list stays choosable (the BFF takes any ISO-2 code)
  const extra = draft.country && !offered.has(draft.country) ? draft.country : null;

  const toggleEvent = (name: string) => set({ events: draft.events.includes(name) ? draft.events.filter((e) => e !== name) : [...draft.events, name] });
  const addTyped = () => {
    const name = typed.trim();
    if (!name) return;
    if (!EVENT_PATTERN.test(name)) {
      setTypedBad(true);
      return;
    }
    if (!draft.events.includes(name)) set({ events: [...draft.events, name] });
    setTyped("");
    setTypedBad(false);
  };
  const storedNames = new Set(stored?.events.map((e) => e.name) ?? []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (pending || missing.length) return;
    setPending(true);
    setFailure(null);
    try {
      onSaved((item ? await ga4Api.update(item, draft) : await ga4Api.create(draft)).item);
    } catch (err) {
      const error = err instanceof Ga4RequestError ? err : new Ga4RequestError(0, "failed");
      setFailure(error);
      if (error.code === "version_conflict") onConflict?.();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-hub-ga4-form={creating ? "create" : "edit"} noValidate>
      <Row label={t("field.propertyId")} htmlFor="hub-ga4-property" invalid={shown("propertyId")}>
        {creating ? (
          <>
            <input
              id="hub-ga4-property"
              className={cx(INPUT, "font-mono tabular-nums")}
              value={draft.propertyId}
              onChange={(e) => set({ propertyId: e.target.value })}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              maxLength={20}
              aria-invalid={shown("propertyId") || undefined}
              placeholder="469542848"
              autoFocus
            />
            <p className="m-0 mt-1 text-rn-11 text-rn-muted">{t("form.propertyHint")}</p>
          </>
        ) : (
          <span className="font-mono text-rn-13 text-rn-ink tabular-nums">{item.propertyId}</span>
        )}
      </Row>
      <Row label={t("field.brand")} invalid={shown("brand")}>
        <RnSegmented<string>
          label={t("field.brand")}
          value={draft.brand}
          onChange={(brand) => set({ brand, country: rhqRegionsForBrand(brand).some((r) => r.countries.includes(draft.country)) ? draft.country : "" })}
          items={GA4_BRANDS.map((b) => ({ value: b, label: b }))}
        />
      </Row>
      <Row label={t("field.country")} htmlFor="hub-ga4-country" invalid={shown("country")}>
        {draft.brand ? (
          <select
            id="hub-ga4-country"
            className={cx(INPUT, "cursor-pointer")}
            value={draft.country}
            onChange={(e) => set({ country: e.target.value })}
            aria-invalid={shown("country") || undefined}
            data-hub-ga4-country=""
          >
            <option value="">{t("form.countryPlaceholder")}</option>
            {extra ? (
              <option value={extra}>
                {countryName(extra, locale)} ({extra})
              </option>
            ) : null}
            {groups.map((g) => (
              <optgroup key={g.id} label={g.label}>
                {g.codes.map((c) => (
                  <option key={`${g.id}:${c}`} value={c}>
                    {countryName(c, locale)} ({c})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        ) : (
          <p className="m-0 pt-1 text-rn-12 text-rn-muted">{t("form.brandFirst")}</p>
        )}
      </Row>
      <Row label={t("field.basis")} top>
        <div className="flex flex-col gap-1.5">
          <RnSegmented<Ga4Basis> label={t("field.basis")} value={draft.basis} onChange={(basis) => set({ basis })} items={GA4_BASES.map((b) => ({ value: b, label: t(`basis.${b}`) }))} />
          <p className="m-0 text-rn-12 text-rn-muted" data-hub-ga4-basis-hint={draft.basis}>
            {t(`basisHint.${draft.basis}`)}
          </p>
        </div>
      </Row>
      {draft.basis === "events" ? (
        <Row label={t("field.events")} top invalid={shown("events")}>
          <div className="flex flex-col gap-2" data-hub-ga4-events="">
            {draft.events.length ? (
              <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label={t("form.picked")}>
                {draft.events.map((name) => (
                  <li key={name} className="inline-flex items-center gap-1 rounded-full border border-rn-line-2 bg-rn-page py-0.5 pr-1 pl-2.5 font-mono text-rn-12 text-rn-ink" data-hub-ga4-picked={name}>
                    {name}
                    <button type="button" onClick={() => toggleEvent(name)} aria-label={t("form.removeEvent", { name })} className="inline-flex size-5 cursor-pointer items-center justify-center rounded-full text-rn-muted hover:bg-rn-line hover:text-rn-ink">
                      <X className="size-3" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex gap-2">
              <input
                className={cx(INPUT, "font-mono")}
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value);
                  setTypedBad(false);
                }}
                onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTyped();
                  }
                }}
                maxLength={40}
                spellCheck={false}
                aria-label={t("form.typeEvent")}
                aria-invalid={typedBad || undefined}
                placeholder={t("form.typeEvent")}
                data-hub-ga4-event-input=""
              />
              <RnButton onClick={addTyped} disabled={!typed.trim()}>
                <Plus className="size-3.5" aria-hidden />
                {t("form.addEvent")}
              </RnButton>
            </div>
            {typedBad ? <p className="m-0 text-rn-12 text-rn-danger-ink">{t("form.eventRule")}</p> : null}
            {creating ? (
              <p className="m-0 text-rn-12 text-rn-muted">{t("form.noStoredYet")}</p>
            ) : !stored ? (
              <p className="m-0 flex items-center gap-2 text-rn-12 text-rn-muted">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                {t("loading")}
              </p>
            ) : stored.events.length ? (
              <div className="rounded-rn-control border border-rn-line-2">
                <p className="m-0 border-b border-rn-line px-3 py-2 text-rn-12 text-rn-muted">{t("form.storedCaption", { days: stored.days, to: stored.to ?? "—" })}</p>
                <div role="group" aria-label={t("field.events")} className="max-h-[260px] overflow-y-auto overscroll-contain p-1" data-hub-ga4-stored="">
                  {stored.events.map((ev) => (
                    <RnCheckRow
                      key={ev.name}
                      checked={draft.events.includes(ev.name)}
                      label={<span className="font-mono">{ev.name}</span>}
                      meta={
                        <span className="inline-flex items-center gap-1.5 tabular-nums">
                          {ev.keyEvent ? <RnTag>{t("keyEvent")}</RnTag> : null}
                          {new Intl.NumberFormat(locale).format(ev.count)}
                        </span>
                      }
                      onToggle={() => toggleEvent(ev.name)}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <p className="m-0 text-rn-12 text-rn-muted">{t("form.noStored")}</p>
            )}
            {draft.events.some((e) => stored && !storedNames.has(e)) ? <p className="m-0 text-rn-12 text-rn-muted">{t("form.unseenEvents")}</p> : null}
          </div>
        </Row>
      ) : null}
      <RnNote>{t(creating ? "form.createNote" : "form.editNote")}</RnNote>
      {tried && missing.length ? (
        <p role="alert" className="m-0 text-rn-12 text-rn-danger-ink">
          {t("form.missing", { fields: missing.map((f) => t(`field.${f}` as "field.brand")).join(", ") })}
        </p>
      ) : null}
      {failure ? <Ga4ErrorNote error={failure} /> : null}
      {/* the actions stay at the sheet's bottom edge while the form scrolls (as the account form) */}
      <div className="sticky -bottom-5 z-[1] -mx-6 -mt-2 -mb-5 flex flex-wrap items-center gap-2 border-t border-rn-line bg-rn-surface px-6 py-3">
        <RnButton type="submit" variant="primary" disabled={pending} data-hub-ga4-save="">
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          {creating ? t("form.create") : t("form.save")}
        </RnButton>
        <RnButton className="ml-auto" onClick={onCancel}>
          {t("form.cancel")}
        </RnButton>
      </div>
    </form>
  );
}
