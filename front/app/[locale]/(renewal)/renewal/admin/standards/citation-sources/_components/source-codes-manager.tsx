"use client";

// Admin › 인용 출처 분류 › 코드표 (2026-10-30): the HUB owns the source code table (admin-todo decision 코드표): the 13
// source categories (Gold's dim_category projects it; a category's number is its answer_fact.cit_c<k> column) and the
// 6 classification layers (dim_source.category_src, the number is the priority). Names, descriptions and the category
// order change here; adding or removing a category does not (Gold's columns). Each category shows whether Gold's
// dim_category has the HUB's name and order yet (back/bff/hub_stores/source_lists.py). The names go to the external
// API list; HUB screen labels do not use them yet.

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, Pencil } from "lucide-react";
import { RnButton, RnCard, RnCardHeader, RnDrawer, RnIconButton, RnNote, RnPageHeader, RnToastProvider, cx, useRnToast, useRnTruncTip } from "@/components/renewal-ui";
import { RnPageFrame } from "../../../../_components/filter-split";
import { LIST_TD as TD, RnDetailField } from "../../../../_components/prompt-list";
import { INPUT, Row } from "../../prompts/_components/hub-prompt-form";
import { codeApi, type CategoryCodeRow, type CodeKind, type CodeListing, type CodeRow } from "./source-lists-api";
import { HistorySection, LIST_TH_PLAIN, ListPills, StateMark, useListError } from "./source-lists-kit";
import { DESCRIPTION_MAX, NAME_MAX, codeProblems, moveCode, type CodeProblem } from "./source-lists-model";

export function SourceCodesManager({ initial, tabs }: { initial: CodeListing; tabs?: ReactNode }) {
  return (
    <RnToastProvider>
      <Manager initial={initial} tabs={tabs} />
    </RnToastProvider>
  );
}

function Manager({ initial, tabs }: { initial: CodeListing; tabs?: ReactNode }) {
  const tc = useTranslations("hubSourceLists.codes");
  const to = useTranslations("hubSourceOverrides");
  const tp = useTranslations("renewal.prompts");
  const toast = useRnToast();
  const tip = useRnTruncTip();
  const errorText = useListError();
  const [listing, setListing] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [sheet, setSheet] = useState<{ kind: CodeKind; code: string } | null>(null);

  const categories = useMemo(() => [...listing.categories].sort((a, b) => a.ord - b.ord || a.number - b.number), [listing.categories]);
  const layers = useMemo(() => [...listing.layers].sort((a, b) => a.number - b.number), [listing.layers]);
  const reload = () => codeApi.list().then(setListing, (e) => toast(errorText(e)));

  const move = async (code: string, dir: "up" | "down") => {
    const now = categories.map((c) => c.code);
    const next = moveCode(now, code, dir);
    if (next.join() === now.join()) return;
    setSaving(true);
    try {
      await codeApi.order(next);
      toast(tc("toast.ordered"));
      await reload();
    } catch (e) {
      toast(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const sheetRow: CodeRow | CategoryCodeRow | null = sheet
    ? (sheet.kind === "category" ? listing.categories : listing.layers).find((r) => r.code === sheet.code) ?? null
    : null;

  const names = (r: CodeRow) => (
    <>
      <td className={cx(TD, "text-rn-ink")}>
        <span data-rn-tip="" className="block truncate font-semibold">
          {r.nameKo}
        </span>
      </td>
      <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>
        <span data-rn-tip="" className="block truncate">
          {r.nameEn}
        </span>
      </td>
      <td className={cx(TD, "text-rn-12 text-rn-muted")}>
        <span data-rn-tip="" className="block truncate">
          {r.description ?? ""}
        </span>
      </td>
    </>
  );
  const editButton = (kind: CodeKind, r: CodeRow) => (
    <RnIconButton label={tc("edit", { name: r.nameKo })} disabled={saving} onClick={() => setSheet({ kind, code: r.code })} data-hub-code-edit={`${kind}:${r.code}`}>
      <Pencil className="size-4" aria-hidden />
    </RnIconButton>
  );

  return (
    <div className="flex flex-col gap-4">
      <RnPageFrame
        header={
          <RnPageHeader
            title={to("title")}
            meta={
              <>
                <ListPills family="source_code" published={listing.published} />
                <span>{tc("description")}</span>
              </>
            }
            actions={tabs}
          />
        }
      >
        <RnNote>
          <b className="text-rn-ink">{tc("noteTitle")}</b>
          <span data-hub-code-note="">{tc("note")}</span>
        </RnNote>
        <div {...tip.bind} className="flex flex-col gap-4">
          <RnCard aria-label={tc("categories")}>
            <RnCardHeader title={tc("categories")} hint={tc("count", { n: categories.length })} />
            <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13" data-hub-code-table="category">
              <colgroup>
                <col className="w-[96px]" />
                <col className="w-[64px]" />
                <col className="w-[180px]" />
                <col className="w-[180px]" />
                <col className="w-[200px]" />
                <col />
                <col className="w-[220px]" />
                <col className="w-[112px]" />
                <col className="w-[72px]" />
              </colgroup>
              <thead>
                <tr className="text-left text-rn-12 text-rn-muted">
                  <th className={cx(LIST_TH_PLAIN, "pl-5")}>{tc("column.order")}</th>
                  <th className={cx(LIST_TH_PLAIN, "text-right")}>{tc("column.number")}</th>
                  <th className={LIST_TH_PLAIN}>{tc("column.code")}</th>
                  <th className={LIST_TH_PLAIN}>{tc("column.nameKo")}</th>
                  <th className={LIST_TH_PLAIN}>{tc("column.nameEn")}</th>
                  <th className={LIST_TH_PLAIN}>{tc("column.description")}</th>
                  <th className={LIST_TH_PLAIN}>{tc("column.gold")}</th>
                  <th className={LIST_TH_PLAIN}>{tc("column.state")}</th>
                  <th className={cx(LIST_TH_PLAIN, "pr-5 text-right")}>{tc("column.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((r, i) => (
                  <tr key={r.code} data-hub-code-row={`category:${r.code}`} className="hover:bg-rn-navy-25/60">
                    <td className={cx(TD, "pl-5")}>
                      <span className="flex items-center gap-0.5">
                        <span className="w-6 text-rn-12 text-rn-muted tabular-nums">{r.ord}</span>
                        <RnIconButton label={tc("moveUp", { name: r.nameKo })} disabled={saving || i === 0} onClick={() => void move(r.code, "up")} data-hub-code-up={r.code}>
                          <ArrowUp className="size-3.5" aria-hidden />
                        </RnIconButton>
                        <RnIconButton label={tc("moveDown", { name: r.nameKo })} disabled={saving || i === categories.length - 1} onClick={() => void move(r.code, "down")} data-hub-code-down={r.code}>
                          <ArrowDown className="size-3.5" aria-hidden />
                        </RnIconButton>
                      </span>
                    </td>
                    <td className={cx(TD, "text-right text-rn-12 text-rn-ink-2 tabular-nums")}>{r.number}</td>
                    <td className={cx(TD, "font-mono text-rn-12 text-rn-ink-2")}>
                      <span data-rn-tip="" className="block truncate">
                        {r.code}
                      </span>
                    </td>
                    {names(r)}
                    <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>
                      <span data-rn-tip="" className="block truncate">
                        {r.gold ? tc("goldValue", { name: r.gold.name, ord: r.gold.ord }) : tc("goldNone")}
                      </span>
                    </td>
                    <td className={TD}>
                      <CodeState row={r} />
                    </td>
                    <td className={cx(TD, "pr-5")}>
                      <span className="flex justify-end">{editButton("category", r)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </RnCard>
          <RnCard aria-label={tc("layers")}>
            <RnCardHeader title={tc("layers")} hint={tc("layersHint")} />
            <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13" data-hub-code-table="layer">
              <colgroup>
                <col className="w-[96px]" />
                <col className="w-[180px]" />
                <col className="w-[180px]" />
                <col className="w-[200px]" />
                <col />
                <col className="w-[72px]" />
              </colgroup>
              <thead>
                <tr className="text-left text-rn-12 text-rn-muted">
                  <th className={cx(LIST_TH_PLAIN, "pl-5")}>{tc("column.number")}</th>
                  <th className={LIST_TH_PLAIN}>{tc("column.code")}</th>
                  <th className={LIST_TH_PLAIN}>{tc("column.nameKo")}</th>
                  <th className={LIST_TH_PLAIN}>{tc("column.nameEn")}</th>
                  <th className={LIST_TH_PLAIN}>{tc("column.description")}</th>
                  <th className={cx(LIST_TH_PLAIN, "pr-5 text-right")}>{tc("column.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {layers.map((r) => (
                  <tr key={r.code} data-hub-code-row={`layer:${r.code}`} className="hover:bg-rn-navy-25/60">
                    <td className={cx(TD, "pl-5 text-rn-12 text-rn-ink-2 tabular-nums")}>{r.number}</td>
                    <td className={cx(TD, "font-mono text-rn-12 text-rn-ink-2")}>{r.code}</td>
                    {names(r)}
                    <td className={cx(TD, "pr-5")}>
                      <span className="flex justify-end">{editButton("layer", r)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </RnCard>
          {tip.tip}
        </div>
      </RnPageFrame>
      <RnDrawer open={sheetRow != null} onClose={() => setSheet(null)} title={tc("detailTitle")} closeLabel={tp("close")}>
        {sheet && sheetRow ? (
          <div className="flex flex-col gap-6" data-hub-code-detail={`${sheet.kind}:${sheet.code}`}>
            <CodeForm
              key={`${sheet.kind}:${sheet.code}:${sheetRow.updatedAt ?? ""}`}
              kind={sheet.kind}
              row={sheetRow}
              onSaved={async (name) => {
                toast(tc("toast.saved", { name }));
                await reload();
              }}
              onCancel={() => setSheet(null)}
            />
            <HistorySection
              load={() => codeApi.history(sheet.kind, sheet.code)}
              version={`${sheet.kind}:${sheet.code}:${sheetRow.updatedAt ?? ""}`}
              eventLabel={(a) => tc(`event.${a as "set"}`)}
              fieldLabel={(f) => tc(`field.${f as "nameKo"}`)}
              value={(_, v) => (v == null ? null : String(v))}
            />
          </div>
        ) : null}
      </RnDrawer>
    </div>
  );
}

/** 반영됨 / 반영 대기: Gold's dim_category against the HUB's name and order. */
export function CodeState({ row }: { row: CategoryCodeRow }) {
  const tc = useTranslations("hubSourceLists.codes");
  return <StateMark state={row.state} attr="data-hub-code-state" label={row.state ? tc(`state.${row.state}`) : "—"} tip={row.state ? tc(`stateTip.${row.state}`) : tc("goldNone")} />;
}

export function CodeForm({
  kind,
  row,
  onSaved,
  onCancel,
}: {
  kind: CodeKind;
  row: CodeRow;
  onSaved: (name: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations("hubSourceLists");
  const tc = useTranslations("hubSourceLists.codes");
  const errorText = useListError();
  const [nameKo, setNameKo] = useState(row.nameKo);
  const [nameEn, setNameEn] = useState(row.nameEn);
  const [description, setDescription] = useState(row.description ?? "");
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const problems = codeProblems({ nameKo, nameEn, description });
  const shown = (p: CodeProblem) => tried && problems.includes(p);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (pending || problems.length) return;
    setPending(true);
    setFailure(null);
    try {
      await codeApi.set(kind, row.code, { nameKo: nameKo.trim(), nameEn: nameEn.trim(), description: description.trim() || null });
      await onSaved(nameKo.trim());
    } catch (err) {
      setFailure(errorText(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-hub-code-form={`${kind}:${row.code}`} noValidate>
      <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-rn-13">
        <RnDetailField label={tc("field.kind")}>{tc(`kind.${kind}`)}</RnDetailField>
        <RnDetailField label={tc("field.code")}>
          <span className="font-mono">{row.code}</span>
        </RnDetailField>
        <RnDetailField label={tc("field.number")}>
          <span className="tabular-nums">{row.number}</span>
        </RnDetailField>
        {"gold" in row ? (
          <>
            <RnDetailField label={tc("field.gold")}>{(row as CategoryCodeRow).gold ? tc("goldValue", { name: (row as CategoryCodeRow).gold!.name, ord: (row as CategoryCodeRow).gold!.ord }) : tc("goldNone")}</RnDetailField>
            <RnDetailField label={tc("field.state")}>
              <CodeState row={row as CategoryCodeRow} />
            </RnDetailField>
          </>
        ) : null}
      </dl>
      <Row label={tc("form.nameKo")} htmlFor="hub-code-name-ko" invalid={shown("nameKo")}>
        <input id="hub-code-name-ko" className={INPUT} value={nameKo} onChange={(e) => setNameKo(e.target.value)} maxLength={NAME_MAX + 20} aria-invalid={shown("nameKo") || undefined} data-hub-code-name-ko="" />
        {shown("nameKo") ? <p className="m-0 mt-1 text-rn-11 text-rn-danger-ink">{tc("form.problem.nameKo")}</p> : null}
      </Row>
      <Row label={tc("form.nameEn")} htmlFor="hub-code-name-en" invalid={shown("nameEn")}>
        <input id="hub-code-name-en" className={INPUT} value={nameEn} onChange={(e) => setNameEn(e.target.value)} maxLength={NAME_MAX + 20} aria-invalid={shown("nameEn") || undefined} data-hub-code-name-en="" />
        {shown("nameEn") ? <p className="m-0 mt-1 text-rn-11 text-rn-danger-ink">{tc("form.problem.nameEn")}</p> : null}
      </Row>
      <Row label={tc("form.description")} htmlFor="hub-code-description" invalid={shown("description")} top>
        <textarea
          id="hub-code-description"
          className={cx(INPUT, "h-auto min-h-[72px] py-2")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={tc("form.descriptionPlaceholder")}
          maxLength={DESCRIPTION_MAX + 50}
          aria-invalid={shown("description") || undefined}
          data-hub-code-description=""
        />
        {shown("description") ? <p className="m-0 mt-1 text-rn-11 text-rn-danger-ink">{tc("form.problem.description")}</p> : null}
      </Row>
      {failure ? (
        <p role="alert" className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-danger-ink">
          {failure}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <RnButton onClick={onCancel}>{t("cancel")}</RnButton>
        <RnButton type="submit" variant="primary" disabled={pending} data-hub-code-save="">
          {t("save")}
        </RnButton>
      </div>
    </form>
  );
}
