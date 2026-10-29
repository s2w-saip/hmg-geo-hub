"use client";

// Admin › 사용자 관리 (2026-10-29): the create / edit form of one account, in the sheet. The scope follows the role
// (admin none, hq brands, region + RHQ regions, country + countries) as a brand > region > country cascade: the
// regions offered are the chosen brands', the countries the chosen regions'; narrowing an upper axis drops the
// lower picks it no longer covers. The login ID is set once. The roles offered are those below the signed-in
// account's own (the BFF's list; it refuses the others too), so no administrator is made here.

import { useMemo, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { RnButton, RnCheckRow, RnGroupHeader, RnNote, RnSearchField, RnSegmented, cx } from "@/components/renewal-ui";
import { countryName } from "@/lib/geo-catalog/country-name";
import { rhqLabel, rhqRegionsForBrand } from "@/lib/rhq";
import { INPUT, Row } from "../standards/prompts/_components/hub-prompt-form";
import {
  AccountRequestError,
  HUB_BRANDS,
  accountsApi,
  axesOf,
  draftOf,
  missingFields,
  type AccountDraft,
  type HubAccount,
  type HubRole,
} from "./hub-accounts-api";

const regionsOf = (brand: string) => rhqRegionsForBrand(brand);
const brandOfRegion = (id: string) => HUB_BRANDS.find((b) => regionsOf(b).some((r) => r.id === id)) ?? null;
const countriesOf = (regionIds: string[]) => new Set(regionIds.flatMap((id) => HUB_BRANDS.flatMap((b) => regionsOf(b)).find((r) => r.id === id)?.countries ?? []));

/** The draft with the lower axes kept inside the upper ones. */
function cascade(d: AccountDraft): AccountDraft {
  const regions = d.regions.filter((r) => d.brands.includes(brandOfRegion(r) ?? ""));
  const inside = countriesOf(regions);
  return { ...d, regions, countries: d.countries.filter((c) => inside.has(c)) };
}

export function AccountErrorNote({ error, className }: { error: AccountRequestError; className?: string }) {
  const t = useTranslations("hubAccounts");
  const known = ["login_taken", "invalid_value", "version_conflict", "rank", "unauthorized", "forbidden", "source_unavailable", "not_found"];
  const fields = (error.details?.fields ?? []).map((f) => t(`field.${f}` as "field.login")).join(", ");
  return (
    <p role="alert" data-hub-account-error={error.code} className={cx("m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-ink-2", className)}>
      {t(`error.${known.includes(error.code) ? error.code : "failed"}`, { fields: fields || "—" })}
    </p>
  );
}

export function HubAccountForm({
  item,
  roles,
  onSaved,
  onCancel,
  onConflict,
}: {
  item: HubAccount | null;
  /** the roles the signed-in account hands out */
  roles: readonly HubRole[];
  onSaved: (item: HubAccount, temporaryPassword?: string) => void;
  onCancel: () => void;
  onConflict?: () => void;
}) {
  const t = useTranslations("hubAccounts");
  const tRoles = useTranslations("roles");
  const locale = useLocale();
  const lang = locale === "en" ? "en" : "ko";
  const [draft, setDraft] = useState<AccountDraft>(() => draftOf(item));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<AccountRequestError | null>(null);
  const [tried, setTried] = useState(false);
  const [q, setQ] = useState("");
  const creating = item == null;
  const axes = axesOf(draft.role);
  const missing = missingFields(draft, creating);
  const shown = (field: string) => tried && missing.includes(field);
  const set = (patch: Partial<AccountDraft>) => setDraft((d) => cascade({ ...d, ...patch }));
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const countryGroups = useMemo(() => {
    const query = q.trim().toLowerCase();
    return draft.regions.map((id) => {
      const region = HUB_BRANDS.flatMap((b) => regionsOf(b)).find((r) => r.id === id);
      const codes = (region?.countries ?? [])
        .filter((c) => !query || c.toLowerCase().includes(query) || countryName(c, locale).toLowerCase().includes(query))
        .sort((a, b) => countryName(a, locale).localeCompare(countryName(b, locale), locale));
      return { id, label: rhqLabel(id, lang) ?? id, codes };
    });
  }, [draft.regions, q, locale, lang]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (pending || missing.length) return;
    setPending(true);
    setFailure(null);
    try {
      if (item) {
        onSaved((await accountsApi.update(item, draft)).item);
      } else {
        const out = await accountsApi.create(draft);
        onSaved(out.item, out.temporaryPassword);
      }
    } catch (err) {
      const error = err instanceof AccountRequestError ? err : new AccountRequestError(0, "failed");
      setFailure(error);
      if (error.code === "version_conflict") onConflict?.();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-hub-account-form={creating ? "create" : "edit"} noValidate>
      <Row label={t("field.login")} htmlFor="hub-account-login" invalid={shown("login")}>
        {creating ? (
          <>
            <input
              id="hub-account-login"
              className={INPUT}
              value={draft.login}
              onChange={(e) => set({ login: e.target.value })}
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              aria-invalid={shown("login") || undefined}
              placeholder={t("form.loginPlaceholder")}
              autoFocus
            />
            <p className="m-0 mt-1 text-rn-11 text-rn-muted">{t("form.loginHint")}</p>
          </>
        ) : (
          <span className="text-rn-13 text-rn-ink">{item.login}</span>
        )}
      </Row>
      <Row label={t("field.displayName")} htmlFor="hub-account-name">
        <input id="hub-account-name" className={INPUT} value={draft.displayName} onChange={(e) => set({ displayName: e.target.value })} maxLength={100} placeholder={t("form.optional")} />
      </Row>
      <Row label={t("field.email")} htmlFor="hub-account-email" invalid={shown("email")}>
        <input
          id="hub-account-email"
          type="email"
          className={INPUT}
          value={draft.email}
          onChange={(e) => set({ email: e.target.value })}
          maxLength={254}
          aria-invalid={shown("email") || undefined}
          placeholder={t("form.optional")}
        />
      </Row>
      <Row label={t("field.role")} top>
        <div className="flex flex-col gap-1.5">
          <RnSegmented<HubRole> label={t("field.role")} value={draft.role} onChange={(role) => set({ role })} items={roles.map((r) => ({ value: r, label: tRoles(r) }))} />
          <p className="m-0 text-rn-12 text-rn-muted" data-hub-role-hint={draft.role}>
            {t(`roleHint.${draft.role}`)}
          </p>
        </div>
      </Row>
      {axes.brands ? (
        <Row label={t("field.brands")} top invalid={shown("brands")}>
          <div role="group" aria-label={t("field.brands")} className="-mx-2 flex flex-wrap gap-x-2" data-hub-account-brands="">
            {HUB_BRANDS.map((b) => (
              <RnCheckRow key={b} checked={draft.brands.includes(b)} label={b} onToggle={() => set({ brands: toggle(draft.brands, b) })} />
            ))}
          </div>
        </Row>
      ) : null}
      {axes.regions ? (
        <Row label={t("field.regions")} top invalid={shown("regions")}>
          {draft.brands.length ? (
            <div role="group" aria-label={t("field.regions")} className="rounded-rn-control border border-rn-line-2 p-1" data-hub-account-regions="">
              {HUB_BRANDS.filter((b) => draft.brands.includes(b)).map((b) => (
                <div key={b}>
                  <RnGroupHeader
                    label={b}
                    active={regionsOf(b).some((r) => draft.regions.includes(r.id))}
                    title={b}
                    onToggle={() => {
                      const ids = regionsOf(b).map((r) => r.id);
                      const anyIn = ids.some((id) => draft.regions.includes(id));
                      set({ regions: anyIn ? draft.regions.filter((id) => !ids.includes(id)) : [...draft.regions, ...ids.filter((id) => !draft.regions.includes(id))] });
                    }}
                  />
                  {regionsOf(b).map((r) => (
                    <RnCheckRow
                      key={r.id}
                      checked={draft.regions.includes(r.id)}
                      label={rhqLabel(r.id, lang) ?? r.id}
                      meta={t("form.countryCount", { n: r.countries.length })}
                      onToggle={() => set({ regions: toggle(draft.regions, r.id) })}
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <p className="m-0 pt-1 text-rn-12 text-rn-muted">{t("form.brandsFirst")}</p>
          )}
        </Row>
      ) : null}
      {axes.countries ? (
        <Row label={t("field.countries")} top invalid={shown("countries")}>
          {draft.regions.length ? (
            <div className="flex flex-col gap-1.5">
              {draft.countries.length ? (
                <p className="m-0 text-rn-12 text-rn-ink-2" data-hub-account-picked-countries="">
                  {draft.countries.map((c) => countryName(c, locale)).join(", ")}
                </p>
              ) : null}
              <div className="rounded-rn-control border border-rn-line-2">
                <div className="border-b border-rn-line p-1.5">
                  <RnSearchField value={q} onChange={setQ} placeholder={t("form.countrySearch")} label={t("form.countrySearch")} />
                </div>
                <div role="group" aria-label={t("field.countries")} className="max-h-[232px] overflow-y-auto overscroll-contain p-1" data-hub-account-countries="">
                  {countryGroups.map((g) =>
                    g.codes.length ? (
                      <div key={g.id}>
                        <RnGroupHeader
                          label={g.label}
                          active={g.codes.some((c) => draft.countries.includes(c))}
                          title={g.label}
                          onToggle={() => {
                            const anyIn = g.codes.some((c) => draft.countries.includes(c));
                            set({ countries: anyIn ? draft.countries.filter((c) => !g.codes.includes(c)) : [...draft.countries, ...g.codes.filter((c) => !draft.countries.includes(c))] });
                          }}
                        />
                        {g.codes.map((c) => (
                          <RnCheckRow key={`${g.id}:${c}`} checked={draft.countries.includes(c)} label={countryName(c, locale)} meta={c} onToggle={() => set({ countries: toggle(draft.countries, c) })} />
                        ))}
                      </div>
                    ) : null,
                  )}
                </div>
              </div>
            </div>
          ) : (
            <p className="m-0 pt-1 text-rn-12 text-rn-muted">{t("form.regionsFirst")}</p>
          )}
        </Row>
      ) : null}
      {creating ? <RnNote>{t("form.passwordNote")}</RnNote> : null}
      {tried && missing.length ? (
        <p role="alert" className="m-0 text-rn-12 text-rn-danger-ink">
          {t("form.missing", { fields: missing.map((f) => t(`field.${f}` as "field.login")).join(", ") })}
        </p>
      ) : null}
      {failure ? <AccountErrorNote error={failure} /> : null}
      {/* the actions stay at the sheet's bottom edge while the form scrolls (as the prompt form) */}
      <div className="sticky -bottom-5 z-[1] -mx-6 -mt-2 -mb-5 flex flex-wrap items-center gap-2 border-t border-rn-line bg-rn-surface px-6 py-3">
        <RnButton type="submit" variant="primary" disabled={pending} data-hub-account-save="">
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
