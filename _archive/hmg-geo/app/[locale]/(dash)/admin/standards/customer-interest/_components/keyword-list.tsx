"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Power, PowerOff, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { BrandSelect, brandSelectValueToDb } from "@/components/dash/brand-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSortableTable } from "@/hooks/use-sortable-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import {
  createStandardKeyword,
  toggleStandardKeywordEnabled,
  deleteStandardKeyword,
} from "../../_actions";
import type { StandardKeywordSource } from "@/lib/db/repositories/standards";

type SortKey = "term" | "source" | "brand" | "notes" | "enabled";

export type StandardKeywordRow = {
  id: string;
  term: string;
  sourceType: StandardKeywordSource;
  brand: string | null;
  notes: string | null;
  enabled: boolean;
};

const SOURCES: StandardKeywordSource[] = ["google_keyword", "community_voc"];

export function StandardKeywordList({ rows }: { rows: StandardKeywordRow[] }) {
  const t = useTranslations("adminStandardCustomerInterest.list");
  const [pending, startTransition] = useTransition();
  const { sorted, headerProps } = useSortableTable<StandardKeywordRow, SortKey>(
    rows,
    {
      term: (r) => r.term,
      source: (r) => r.sourceType,
      brand: (r) => r.brand ?? "",
      notes: (r) => r.notes ?? "",
      enabled: (r) => (r.enabled ? 1 : 0),
    },
    {
      defaultKey: "term",
      defaultAsc: true,
      ascByDefault: ["term", "source", "brand", "notes"],
    },
  );

  const [term, setTerm] = useState("");
  const [sourceType, setSourceType] = useState<StandardKeywordSource>("google_keyword");
  const [brand, setBrand] = useState("");
  const [notes, setNotes] = useState("");

  function onAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!term.trim()) return;
    startTransition(async () => {
      const r = await createStandardKeyword({
        term,
        sourceType,
        brand: brandSelectValueToDb(brand),
        notes: notes || null,
      });
      if (r.ok) {
        toast.success(t("addSuccess"));
        setTerm("");
        setBrand("");
        setNotes("");
      } else {
        toast.error(r.error);
      }
    });
  }

  function onToggle(id: string, enabled: boolean) {
    startTransition(async () => {
      const r = await toggleStandardKeywordEnabled(id, !enabled);
      if (r.ok) toast.success(t(enabled ? "disableSuccess" : "enableSuccess"));
      else toast.error(r.error);
    });
  }

  function onDelete(id: string) {
    startTransition(async () => {
      const r = await deleteStandardKeyword(id);
      if (r.ok) toast.success(t("deleteSuccess"));
      else toast.error(r.error);
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <form
        onSubmit={onAdd}
        className="grid gap-3 rounded-md border border-border bg-muted/20 p-3 sm:grid-cols-2 lg:grid-cols-[1fr_160px_160px_1fr_auto]"
      >
        <Field id="sk-term" label={t("termLabel")} required>
          <Input
            id="sk-term"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={t("termPlaceholder")}
            disabled={pending}
            required
          />
        </Field>
        <Field id="sk-source" label={t("sourceLabel")}>
          <Select
            value={sourceType}
            onValueChange={(v) => setSourceType(v as StandardKeywordSource)}
            disabled={pending}
          >
            <SelectTrigger id="sk-source" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`source.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="sk-brand" label={t("brandLabel")}>
          <BrandSelect
            id="sk-brand"
            value={brand}
            onChange={setBrand}
            disabled={pending}
          />
        </Field>
        <Field id="sk-notes" label={t("notesLabel")}>
          <Input
            id="sk-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("notesPlaceholder")}
            disabled={pending}
          />
        </Field>
        <div className="flex items-end">
          <Button type="submit" disabled={pending || !term.trim()} className="w-full sm:w-auto">
            <Plus className="h-4 w-4" aria-hidden />
            {t("add")}
          </Button>
        </div>
      </form>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                <th className="px-3 py-2"><SortableHeader {...headerProps("term")}>{t("termLabel")}</SortableHeader></th>
                <th className="px-3 py-2 w-32"><SortableHeader {...headerProps("source")}>{t("sourceLabel")}</SortableHeader></th>
                <th className="px-3 py-2 w-24"><SortableHeader {...headerProps("brand")}>{t("brandLabel")}</SortableHeader></th>
                <th className="px-3 py-2"><SortableHeader {...headerProps("notes")}>{t("notesLabel")}</SortableHeader></th>
                <th className="px-3 py-2 w-20"><SortableHeader {...headerProps("enabled")} align="right">{t("enable")}</SortableHeader></th>
                <th className="px-3 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id} className="border-t border-border first:border-t-0 align-top">
                  <td className="px-3 py-3 text-sm font-medium text-foreground">{r.term}</td>
                  <td className="px-3 py-3">
                    <Badge variant="secondary" className="text-[10px]">{t(`source.${r.sourceType}`)}</Badge>
                  </td>
                  <td className="px-3 py-3">
                    {r.brand ? (
                      <Badge variant="outline" className="text-[10px]">{r.brand}</Badge>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">{r.notes ?? "—"}</td>
                  <td className="px-3 py-3 text-right">
                    {r.enabled ? (
                      <Badge variant="secondary" className="text-[10px]">{t("enable")}</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">{t("disabled")}</Badge>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => onToggle(r.id, r.enabled)} className="text-muted-foreground hover:text-foreground" title={r.enabled ? t("disable") : t("enable")}>
                        {r.enabled ? <PowerOff className="h-4 w-4" aria-hidden /> : <Power className="h-4 w-4" aria-hidden />}
                      </Button>
                      <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => onDelete(r.id)} className="text-muted-foreground hover:text-destructive" title={t("delete")}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Field({
  id,
  label,
  required,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
        {required ? " *" : null}
      </Label>
      {children}
    </div>
  );
}
