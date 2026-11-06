"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ExternalLink } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { RnCard, RnEmpty, RnNote, RnSearchField, RnSegmented, cx } from "@/components/renewal-ui";
import { countryName } from "@/lib/geo-catalog/country-name";
import { languageName } from "@/lib/geo-catalog/language-name";
import { aiEngineLabel } from "@/lib/scope/engines";
import { LIST_TD as TD, LIST_TH, RnListPager, RnSortHead } from "../../_components/prompt-list";
import {
  PROJECT_TAB,
  answersMatch,
  projectHref,
  projectMatches,
  projectLabel,
  sortProjects,
  type AnswersFilter,
  type ProjectRow,
  type ProjectSortKey,
} from "./project-model";

const PAGE_SIZES = [20, 50, 100] as const;

/** The Project list (menu option D): every row opens its project in the project tab, the link and the row alike. */
export function RnProjectList({ rows }: { rows: ProjectRow[] }) {
  const t = useTranslations("renewal.projects");
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const [answers, setAnswers] = useState<AnswersFilter>("all");
  const [sort, setSort] = useState<{ key: ProjectSortKey; asc: boolean }>({ key: "last", asc: false });
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  const [page, setPage] = useState(1);
  const countryLabel = (code: string) => countryName(code, locale);
  const num = (n: number) => n.toLocaleString(locale);

  const searched = useMemo(() => rows.filter((r) => projectMatches(r, query, (c) => countryName(c, locale))), [rows, query, locale]);
  const counts = { all: searched.length, measured: searched.filter((r) => r.answers > 0).length };
  const listed = useMemo(() => sortProjects(searched.filter((r) => answersMatch(r, answers)), sort), [searched, answers, sort]);
  const pages = Math.max(1, Math.ceil(listed.length / pageSize));
  const current = Math.min(page, pages);
  const shown = listed.slice((current - 1) * pageSize, current * pageSize);
  const onSort = (key: ProjectSortKey) => {
    setSort((s) => (s.key === key ? { key, asc: !s.asc } : { key, asc: false }));
    setPage(1);
  };
  const open = (id: string) => window.open(`/${locale}${projectHref(id)}`, PROJECT_TAB);
  const none = <span className="text-rn-faint">—</span>;
  const NUM = cx(TD, "text-right tabular-nums text-rn-ink-2");

  return (
    <div className="flex flex-col gap-4">
      <RnCard data-rn-project-list="">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-rn-line px-5 py-3">
          <RnSearchField
            id="rn-project-search"
            className="w-full max-w-[340px] min-w-[200px] flex-1"
            value={query}
            onChange={(v) => {
              setQuery(v);
              setPage(1);
            }}
            placeholder={t("searchPlaceholder")}
            label={t("searchLabel")}
          />
          <RnSegmented<AnswersFilter>
            label={t("answersFilter")}
            value={answers}
            onChange={(v) => {
              setAnswers(v);
              setPage(1);
            }}
            items={[
              { value: "all", label: t("answersAll", { count: num(counts.all) }) },
              { value: "measured", label: t("answersMeasured", { count: num(counts.measured) }) },
              { value: "unmeasured", label: t("answersUnmeasured", { count: num(counts.all - counts.measured) }) },
            ]}
          />
          <span className="ml-auto text-rn-12 text-rn-muted tabular-nums" data-rn-project-count="">
            {t("count", { count: num(listed.length) })}
          </span>
        </div>
        {listed.length === 0 ? (
          <RnEmpty className="m-5">{rows.length ? t("emptyFiltered") : t("empty")}</RnEmpty>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13" data-rn-project-table="">
                <colgroup>
                  <col />
                  <col className="w-[150px]" />
                  <col className="w-[96px]" />
                  <col className="w-[150px]" />
                  <col className="w-[92px]" />
                  <col className="w-[92px]" />
                  <col className="w-[76px]" />
                  <col className="w-[112px]" />
                  <col className="w-[100px]" />
                </colgroup>
                <thead>
                  <tr className="text-left text-rn-12 text-rn-muted">
                    <th scope="col" className={cx(LIST_TH, "pl-5")}>{t("column.project")}</th>
                    <th scope="col" className={LIST_TH}>{t("column.countries")}</th>
                    <th scope="col" className={LIST_TH}>{t("column.languages")}</th>
                    <th scope="col" className={LIST_TH}>{t("column.engines")}</th>
                    <RnSortHead sortKey="prompts" label={t("column.prompts")} sort={sort} onSort={onSort} className="text-right" />
                    <RnSortHead sortKey="answers" label={t("column.answers")} sort={sort} onSort={onSort} className="text-right" />
                    <RnSortHead sortKey="rounds" label={t("column.rounds")} sort={sort} onSort={onSort} className="text-right" />
                    <RnSortHead sortKey="last" label={t("column.last")} sort={sort} onSort={onSort} className="text-right" />
                    <th scope="col" className={cx(LIST_TH, "pr-5 text-right")}>{t("column.customFields")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr
                      key={r.id}
                      data-rn-project-row={r.id}
                      className="group/row cursor-pointer hover:bg-rn-navy-25/60"
                      // the whole row opens the project tab; the link inside is the keyboard's and the new-tab click's
                      onClick={(e) => {
                        if (!(e.target as HTMLElement).closest("a")) open(r.id);
                      }}
                    >
                      <td className={cx(TD, "h-auto py-2 pl-5")}>
                        <Link
                          prefetch={false}
                          href={projectHref(r.id)}
                          target={PROJECT_TAB}
                          title={`${r.id} · ${t("newTab")}`}
                          className="inline-flex items-center gap-1.5 rounded-[3px] font-mono text-rn-13 font-bold text-rn-ink no-underline group-hover/row:text-rn-navy focus-visible:outline-2 focus-visible:outline-rn-navy"
                        >
                          {projectLabel(r)}
                          <ExternalLink className="size-3.5 text-rn-muted group-hover/row:text-rn-navy" aria-label={t("newTab")} />
                        </Link>
                        <span title={r.first_prompt ?? undefined} className={cx("mt-px block truncate text-rn-12", r.first_prompt ? "text-rn-muted" : "text-rn-faint")}>
                          {r.first_prompt ?? t("noPrompt")}
                        </span>
                      </td>
                      <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>
                        <span className="block truncate">{r.countries.length ? r.countries.map(countryLabel).join(" · ") : none}</span>
                      </td>
                      <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>
                        <span className="block truncate">{r.languages.length ? r.languages.map((l) => languageName(l, locale)).join(" · ") : none}</span>
                      </td>
                      <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>
                        <span className="block truncate">{r.engines.length ? r.engines.map(aiEngineLabel).join(" · ") : none}</span>
                      </td>
                      <td className={NUM}>{num(r.prompts)}</td>
                      <td className={NUM}>{r.answers ? num(r.answers) : none}</td>
                      <td className={NUM}>{r.rounds ? num(r.rounds) : none}</td>
                      <td className={NUM}>{r.last_measured_day ?? none}</td>
                      <td className={cx(NUM, "pr-5")}>{r.custom_fields ? num(r.custom_fields) : none}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <RnListPager
              rangeFrom={(current - 1) * pageSize + 1}
              rangeTo={(current - 1) * pageSize + shown.length}
              total={listed.length}
              page={current}
              pages={pages}
              pageSize={pageSize}
              pageSizes={PAGE_SIZES}
              onPageSize={(n) => {
                setPageSize(n);
                setPage(1);
              }}
              onPage={setPage}
            />
          </>
        )}
      </RnCard>
      <RnNote>
        <b className="text-rn-ink">{t("noteTitle")}</b>
        <span>{t("note")}</span>
      </RnNote>
    </div>
  );
}
