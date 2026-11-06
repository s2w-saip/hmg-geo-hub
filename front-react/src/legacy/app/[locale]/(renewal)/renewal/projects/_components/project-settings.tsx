import { CONNECTED } from "~/api/client";
import type { ReactNode } from "react";
import { useLocale, useTranslations } from "use-intl";
import { aiEngineLabel } from "@/lib/scope/engines";
import { countryName } from "@/lib/geo-catalog/country-name";
import { languageName } from "@/lib/geo-catalog/language-name";
import { RnCard, RnCardHeader, RnNote } from "@/components/renewal-ui";
import { RnProjectMeasurement, type MeasurementView } from "./project-measurement";

// Renewal Project › Setting › General and Member (2026-11-03): the original sections in order, each with what Gold holds (screen
// projects/settings) or 데이터 없음 where only the original operations DB has it. The measurement settings (2026-11-06) are the input
// store's, and this page edits them (project-measurement.tsx).

/** projects/settings */
export interface ProjectSettingsView {
  identity: { projectId: string | null; scopeProjectId: string | null; regions: string[] | null };
  measured: {
    countries: string[];
    engines: string[];
    languages: string[];
    rounds: number;
    prompts: number;
    answers: number;
    lastMeasuredDay: string | null;
  } | null;
  fields: { id: string; label: string; values: string[]; prompts: number }[];
  /** prompts naming a target URL */
  targets: number;
  /** the input store's settings; null when it is not there or does not hold the project yet */
  measurement: MeasurementView | null;
}

function Rows({ children }: { children: ReactNode }) {
  return <dl className="m-0 grid grid-cols-[200px_minmax(0,1fr)] gap-x-6 gap-y-0 px-6 pb-4 text-rn-13">{children}</dl>;
}

function Row({ label, children, missing }: { label: string; children?: ReactNode; missing?: string }) {
  return (
    <>
      <dt className="border-t border-rn-line py-2.5 text-rn-12 font-semibold text-rn-muted">{label}</dt>
      <dd className="m-0 min-w-0 border-t border-rn-line py-2.5 break-words text-rn-ink">
        {missing ? <span className="text-rn-faint">{missing}</span> : children}
      </dd>
    </>
  );
}

export function RnProjectGeneral({ view }: { view: ProjectSettingsView }) {
  const t = useTranslations("renewal.projects.setting");
  const locale = useLocale();
  const none = t("noData");
  const m = view.measured;
  const list = (items: string[], label: (v: string) => string) => (items.length ? items.map(label).join(", ") : t("none"));
  const settings = view.measurement;
  return (
    <div className="flex flex-col gap-4" data-rn-project-setting="">
      {settings && (view.identity.projectId || !CONNECTED) ? <RnProjectMeasurement projectId={view.identity.projectId ?? ""} view={settings} /> : <RnNote>{t("measurement.unavailable")}</RnNote>}
      <RnCard aria-label={t("general.title")}>
        <RnCardHeader title={t("general.title")} hint={t("general.hint")} />
        <Rows>
          {(["name", "description", "created", "owner"] as const).map((k) => (
            <Row key={k} label={t(`general.${k}`)} missing={none} />
          ))}
        </Rows>
      </RnCard>
      <RnCard aria-label={t("scope.title")}>
        <RnCardHeader title={t("scope.title")} hint={t("scope.hint")} />
        <Rows>
          <Row label={t("scope.projectId")}>
            <code className="font-mono text-rn-12">{view.identity.projectId ?? "—"}</code>
          </Row>
          <Row label={t("scope.scopeProjectId")}>
            <code className="font-mono text-rn-12">{view.identity.scopeProjectId ?? "—"}</code>
          </Row>
          <Row label={t("scope.regions")}>{view.identity.regions?.length ? view.identity.regions.join(", ") : <span className="text-rn-muted">{t("scope.regionsNone")}</span>}</Row>
          <Row label={t("scope.countries")}>{m ? list(m.countries, (c) => `${countryName(c, locale)} (${c})`) : null}</Row>
          <Row label={t("scope.languages")}>{m ? list(m.languages, (l) => languageName(l, locale)) : null}</Row>
          <Row label={t("scope.measured")}>
            {m ? t("scope.measuredValue", { prompts: m.prompts.toLocaleString(locale), answers: m.answers.toLocaleString(locale), rounds: m.rounds, last: m.lastMeasuredDay ?? "—" }) : null}
          </Row>
        </Rows>
      </RnCard>
      <RnCard aria-label={t("engines.title")}>
        <RnCardHeader title={t("engines.title")} hint={t("engines.hint")} />
        <Rows>
          <Row label={t("engines.measured")}>{m ? list(m.engines, aiEngineLabel) : null}</Row>
        </Rows>
      </RnCard>
      <RnCard aria-label={t("tracked.title")}>
        <RnCardHeader title={t("tracked.title")} hint={t("tracked.hint")} />
        <Rows>
          <Row label={t("tracked.targets")}>{t("tracked.targetsValue", { count: view.targets })}</Row>
        </Rows>
      </RnCard>
      <RnCard aria-label={t("tags.title")} data-rn-project-tags="">
        <RnCardHeader title={t("tags.title")} hint={t("tags.hint")} />
        {view.fields.length ? (
          <Rows>
            {view.fields.map((f) => (
              <Row key={f.id} label={f.label}>
                <span className="flex flex-col gap-1">
                  <span className="flex flex-wrap gap-1">
                    {f.values.map((v) => (
                      <span key={v} className="rounded-md bg-rn-navy/8 px-1.5 py-px text-rn-12 font-semibold text-rn-navy">
                        {v}
                      </span>
                    ))}
                  </span>
                  <span className="text-rn-12 text-rn-muted tabular-nums">{t("tags.count", { values: f.values.length, prompts: f.prompts })}</span>
                </span>
              </Row>
            ))}
          </Rows>
        ) : (
          <p className="m-0 px-6 pb-5 text-rn-13 text-rn-muted">{t("tags.none")}</p>
        )}
      </RnCard>
      <RnNote>{t("note")}</RnNote>
    </div>
  );
}

export function RnProjectMember() {
  const t = useTranslations("renewal.projects.member");
  const none = t("noData");
  return (
    <div className="flex flex-col gap-4" data-rn-project-member="">
      <RnCard aria-label={t("title")}>
        <RnCardHeader title={t("title")} hint={t("hint")} />
        <Rows>
          {(["list", "roles", "invite", "audit"] as const).map((k) => (
            <Row key={k} label={t(k)} missing={none} />
          ))}
        </Rows>
      </RnCard>
      <RnNote>{t("note")}</RnNote>
    </div>
  );
}
