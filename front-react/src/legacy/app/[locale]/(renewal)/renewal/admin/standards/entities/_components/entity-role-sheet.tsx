"use client";

// Admin › 엔티티 카탈로그 (2026-11-02): one entity's sheet. The role form on top of what Gold has to judge it by (display brand,
// numbers, observed surfaces, mention samples with their context) and the row's history. A change of who is own asks for a
// confirmation first: it moves every KPI's 당사 side (the original draft's L2 confirmation). There is no
// preview: the HUB does not recompute KPIs.

import { useEffect, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "use-intl";
import { Loader2 } from "lucide-react";
import { RnButton, RnCheckRow, RnTag, cx } from "@/components/renewal-ui";
import { formatAsOfDate } from "@/lib/as-of-date";
import { RnDetailField } from "../../../../_components/prompt-list";
import { HistorySection } from "../../citation-sources/_components/source-lists-kit";
import { SourceRequestError } from "../../citation-sources/_components/source-overrides-api";
import { INPUT, Row } from "../../prompts/_components/hub-prompt-form";
import { ENTITY_ROLES, OWN_BRANDS, entityRoleApi, type EntityMentions, type EntityRole, type EntityRow, type OwnBrand } from "./entity-roles-api";
import { NOTE_MAX, changesOwn, draftChanged, draftNeedsWrite, highlightParts, initialDraft, roleProblems, type RoleDraft } from "./entity-roles-model";

const KNOWN = ["invalid_value", "not_found", "unauthorized", "forbidden", "source_unavailable"];

export function useEntityError() {
  const t = useTranslations("hubEntities");
  return (e: unknown) => {
    const err = e instanceof SourceRequestError ? e : new SourceRequestError(0, "failed");
    return t(`error.${KNOWN.includes(err.code) ? (err.code as "failed") : "failed"}`, { fields: (err.details?.fields ?? []).join(", ") || "—" });
  };
}

/** 자사 · Hyundai / 경쟁사 / 제외 */
export function useRoleLabel() {
  const t = useTranslations("hubEntities");
  return (role: EntityRole | "own" | "excluded", brand?: string | null) => (role === "own" && brand ? `${t("role.own")} · ${brand}` : t(`role.${role}`));
}

export function EntityRoleForm({ row, onSaved }: { row: EntityRow; onSaved: () => void | Promise<void> }) {
  const t = useTranslations("hubEntities");
  const errorText = useEntityError();
  const locale = useLocale();
  const nf = new Intl.NumberFormat(locale);
  const [draft, setDraft] = useState<RoleDraft>(() => initialDraft(row));
  const [confirmed, setConfirmed] = useState(false);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const problems = roleProblems(draft);
  const askConfirm = changesOwn(row, draft);
  const changed = draftChanged(row, draft) && draftNeedsWrite(row, draft);
  const set = (patch: Partial<RoleDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setConfirmed(false);
    setFailure(null);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (pending || !changed || problems.length || (askConfirm && !confirmed)) return;
    setPending(true);
    setFailure(null);
    try {
      if (draft.role === "competitor") await entityRoleApi.clear(row.entityId);
      else await entityRoleApi.set({ entityId: row.entityId, role: draft.role, brand: draft.role === "own" ? draft.brand : null, note: draft.note.trim() || null });
      await onSaved();
    } catch (err) {
      setFailure(errorText(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-hub-entity-form="" noValidate>
      <Row label={t("field.role")} top>
        <div role="radiogroup" aria-label={t("field.role")} data-hub-entity-roles="">
          {ENTITY_ROLES.map((r) => (
            <RnCheckRow key={r} radio checked={draft.role === r} label={t(`role.${r}`)} meta={r === "competitor" ? t("roleDefault") : undefined} onToggle={() => set({ role: r })} />
          ))}
        </div>
      </Row>
      {draft.role === "own" ? (
        <Row label={t("field.brand")} invalid={tried && problems.includes("brand")} top>
          <div role="radiogroup" aria-label={t("field.brand")} data-hub-entity-brands="">
            {OWN_BRANDS.map((b) => (
              <RnCheckRow key={b} radio checked={draft.brand === b} label={b} onToggle={() => set({ brand: b as OwnBrand })} />
            ))}
          </div>
          {tried && problems.includes("brand") ? (
            <p className="m-0 mt-1 text-rn-11 text-rn-danger-ink" data-hub-entity-problem="brand">
              {t("problem.brand")}
            </p>
          ) : null}
        </Row>
      ) : null}
      {draft.role !== "competitor" ? (
        <Row label={t("field.note")} htmlFor="hub-entity-note" invalid={tried && problems.includes("note")} top>
          <textarea id="hub-entity-note" className={cx(INPUT, "h-16 py-2")} value={draft.note} onChange={(e) => set({ note: e.target.value })} placeholder={t("notePlaceholder")} maxLength={NOTE_MAX + 20} data-hub-entity-note="" />
          {tried && problems.includes("note") ? <p className="m-0 mt-1 text-rn-11 text-rn-danger-ink">{t("problem.note")}</p> : null}
        </Row>
      ) : null}
      {askConfirm && changed ? (
        <div className="rounded-[10px] bg-rn-page p-2" data-hub-entity-confirm="">
          <RnCheckRow checked={confirmed} label={t("confirmOwn", { answers: nf.format(row.answers), mentions: nf.format(row.mentions) })} onToggle={() => setConfirmed((c) => !c)} />
          {tried && !confirmed ? <p className="m-0 mt-1 px-2 text-rn-11 text-rn-danger-ink">{t("problem.confirm")}</p> : null}
        </div>
      ) : null}
      {failure ? (
        <p role="alert" className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-danger-ink">
          {failure}
        </p>
      ) : null}
      <div className="flex justify-end">
        <RnButton type="submit" variant="primary" disabled={pending || !changed}>
          {t("save")}
        </RnButton>
      </div>
    </form>
  );
}

function MentionsSection({ entityId }: { entityId: string }) {
  const t = useTranslations("hubEntities");
  const errorText = useEntityError();
  const [data, setData] = useState<EntityMentions | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    entityRoleApi.mentions(entityId).then(
      (d) => live && setData(d),
      (e) => live && setError(e ?? new Error("failed")),
    );
    return () => {
      live = false;
    };
  }, [entityId]);

  if (error) {
    return (
      <p role="alert" className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-ink-2">
        {errorText(error)}
      </p>
    );
  }
  if (!data) {
    return (
      <p className="flex items-center gap-2 text-rn-13 text-rn-muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-5" data-hub-entity-mentions={data.samples.length}>
      <section>
        <h3 className="m-0 mb-2 text-rn-13 font-bold text-rn-ink">{t("surfaces")}</h3>
        {data.surfaces.length ? (
          <div className="flex flex-wrap gap-1.5" data-hub-entity-surfaces={data.surfaces.length}>
            {data.surfaces.map((s) => (
              <RnTag key={s.surface}>{t("surfaceMonths", { surface: s.surface, months: s.months })}</RnTag>
            ))}
          </div>
        ) : (
          <p className="m-0 text-rn-12 text-rn-muted">{t("noSurfaces")}</p>
        )}
      </section>
      <section>
        <h3 className="m-0 mb-1 text-rn-13 font-bold text-rn-ink">{t("samples")}</h3>
        <p className="m-0 mb-2 text-rn-11 text-rn-muted">{t("samplesHint", { rounds: data.rounds })}</p>
        {data.samples.length ? (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {data.samples.map((s) => {
              const parts = highlightParts(s.context, s.surface);
              return (
                <li key={s.answerKey} className="rounded-[10px] bg-rn-page p-3 text-rn-12 leading-relaxed text-rn-ink-2" data-hub-entity-sample={s.answerKey}>
                  <p className="m-0 mb-1 text-rn-11 text-rn-muted tabular-nums">{s.round}</p>
                  <p className="m-0 break-words">
                    {parts ? (
                      <>
                        {parts.before}
                        <mark className="rounded-[3px] bg-rn-navy-25 font-semibold text-rn-ink">{parts.match}</mark>
                        {parts.after}
                      </>
                    ) : (
                      s.context
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="m-0 text-rn-12 text-rn-muted">{t("noSamples")}</p>
        )}
      </section>
    </div>
  );
}

export function EntitySheet({ row, onSaved }: { row: EntityRow; onSaved: () => void | Promise<void> }) {
  const t = useTranslations("hubEntities");
  const locale = useLocale();
  const errorText = useEntityError();
  const roleLabel = useRoleLabel();
  const nf = new Intl.NumberFormat(locale);
  const value = (field: string, v: unknown): string | null => {
    if (v == null) return null;
    if (field === "role") return t(`role.${v as "own"}`);
    if (field === "status") return t(`status.${v as "active"}`);
    return String(v);
  };
  return (
    <div className="flex flex-col gap-6" data-hub-entity-detail={row.entityId}>
      <section className="flex flex-col gap-3">
        <b className="min-w-0 truncate text-rn-16 text-rn-ink">{row.name}</b>
        <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2 text-rn-13">
          <RnDetailField label={t("field.displayBrand")}>{row.displayBrand}</RnDetailField>
          <RnDetailField label={t("field.kind")}>{row.kind ? t(`kind.${row.kind}`) : null}</RnDetailField>
          <RnDetailField label={t("field.type")}>{row.type}</RnDetailField>
          <RnDetailField label={t("field.numbers")}>
            <span className="tabular-nums">{t("numbers", { answers: nf.format(row.answers), mentions: nf.format(row.mentions) })}</span>
          </RnDetailField>
          {/* Gold's timestamp on the KST calendar (its first 10 characters are the UTC day) */}
          <RnDetailField label={t("field.firstSeen")}>{row.firstSeen ? formatAsOfDate(row.firstSeen) : null}</RnDetailField>
          <RnDetailField label={t("field.goldRole")}>{row.gold ? roleLabel(row.gold.role ?? "competitor", row.gold.brand) : null}</RnDetailField>
          <RnDetailField label={t("field.origin")}>{row.hub ? t(`origin.${row.hub.origin}`) : null}</RnDetailField>
        </dl>
      </section>
      <EntityRoleForm key={`${row.entityId}:${row.hub?.updatedAt ?? ""}`} row={row} onSaved={onSaved} />
      <MentionsSection entityId={row.entityId} />
      <HistorySection load={() => entityRoleApi.history(row.entityId)} version={`${row.entityId}:${row.hub?.updatedAt ?? ""}`} eventLabel={(a) => t(`event.${a as "set"}`)} fieldLabel={(f) => t(`field.${f as "role"}`)} value={value} errorText={errorText} />
    </div>
  );
}
