"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Download, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  upsertGa4Mapping,
  verifyGa4Mapping,
  removeGa4Mapping,
  importLegacyMapping,
} from "../_actions";
import { Ga4EventsDialog } from "@/components/dash/ga4-events-dialog";

export interface Ga4Row {
  id: string;
  brand: string;
  countryCode: string;
  propertyId: string | null;
  status: string;
  verifiedAt: string | null;
}

// 레거시 env 매핑(아직 DB 미등록) — 권한은 이미 있으나 레지스트리에 없는 시장.
export interface LegacyRow {
  brand: string;
  countryCode: string;
  propertyId: string | null;
}

// 프로젝트별 오버라이드 — projects.ga4PropertyId로 표준 매핑을 우회하는 프로젝트.
export interface OverrideRow {
  id: string;
  name: string;
  brand: string | null;
  country: string;
  propertyId: string;
}

const STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700",
  pending_grant: "bg-amber-100 text-amber-700",
  unmapped: "bg-muted text-muted-foreground",
};

export function Ga4RegistryClient({
  rows,
  legacy,
  overrides,
}: {
  rows: Ga4Row[];
  legacy: LegacyRow[];
  overrides: OverrideRow[];
}) {
  const t = useTranslations("adminGa4");
  const [pending, startTransition] = useTransition();
  const [brand, setBrand] = useState("");
  const [country, setCountry] = useState("");
  const [propertyId, setPropertyId] = useState("");

  function onAdd() {
    startTransition(async () => {
      const r = await upsertGa4Mapping({ brand, countryCode: country, propertyId });
      if (r.ok) {
        toast.success(t("addSuccess"));
        setBrand("");
        setCountry("");
        setPropertyId("");
      } else {
        toast.error(r.error);
      }
    });
  }

  function onVerify(row: Ga4Row) {
    startTransition(async () => {
      const r = await verifyGa4Mapping(row.id, row.propertyId ?? "");
      if (r.ok) toast.success(t("verified"));
      else toast.error(r.error);
    });
  }

  function onRemove(id: string) {
    startTransition(async () => {
      const r = await removeGa4Mapping(id);
      if (r.ok) toast.success(t("removeSuccess"));
      else toast.error(r.error);
    });
  }

  function onImport(row: LegacyRow) {
    startTransition(async () => {
      const r = await importLegacyMapping(row.brand, row.countryCode);
      if (r.ok) toast.success(t("importSuccess"));
      else toast.error(r.error);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[11px] text-muted-foreground">{t("hint")}</p>

      {/* 추가 폼 */}
      <div className="flex flex-wrap items-end gap-2">
        <Input
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          placeholder={t("form.brand")}
          className="h-8 w-32 text-xs"
        />
        <Input
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          placeholder={t("form.country")}
          className="h-8 w-24 text-xs"
        />
        <Input
          value={propertyId}
          onChange={(e) => setPropertyId(e.target.value)}
          placeholder={t("form.propertyId")}
          className="h-8 w-40 text-xs"
        />
        <Button
          type="button"
          size="sm"
          disabled={pending || !brand.trim() || !country.trim()}
          onClick={onAdd}
        >
          <Plus className="h-4 w-4" aria-hidden />
          {t("form.add")}
        </Button>
      </div>

      {/* 목록 */}
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t("table.brand")}</th>
                <th className="px-3 py-2 font-medium">{t("table.country")}</th>
                <th className="px-3 py-2 font-medium">{t("table.propertyId")}</th>
                <th className="px-3 py-2 font-medium">{t("table.status")}</th>
                <th className="px-3 py-2 font-medium">{t("table.verifiedAt")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 font-medium text-foreground">{r.brand}</td>
                  <td className="px-3 py-2">{r.countryCode}</td>
                  <td className="px-3 py-2 font-mono">{r.propertyId ?? "—"}</td>
                  <td className="px-3 py-2">
                    <Badge
                      variant="secondary"
                      className={`font-normal ${STATUS_STYLE[r.status] ?? ""}`}
                    >
                      {t(`status.${r.status}`)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.verifiedAt ? r.verifiedAt.slice(0, 10) : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {r.propertyId ? (
                        <Ga4EventsDialog
                          propertyId={r.propertyId}
                          title={`${r.brand} · ${r.countryCode}`}
                        />
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pending || !r.propertyId}
                        onClick={() => onVerify(r)}
                        className="h-7 text-xs"
                      >
                        <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                        {t("verify")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={pending}
                        onClick={() => onRemove(r.id)}
                        aria-label={t("remove")}
                        className="text-muted-foreground hover:text-destructive"
                      >
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

      {/* 레거시 env 매핑 — 권한은 이미 있으나 레지스트리 미등록. "가져오기"로 등록. */}
      {legacy.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <h4 className="text-xs font-semibold text-foreground">{t("legacy.title")}</h4>
            <p className="text-[11px] text-muted-foreground">{t("legacy.description")}</p>
          </div>
          <div className="overflow-x-auto rounded-md border border-dashed border-border">
            <table className="w-full text-xs">
              <tbody>
                {legacy.map((r) => (
                  <tr
                    key={`${r.brand}-${r.countryCode}`}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-3 py-2 font-medium text-foreground">{r.brand}</td>
                    <td className="px-3 py-2">{r.countryCode}</td>
                    <td className="px-3 py-2 font-mono">{r.propertyId ?? "—"}</td>
                    <td className="px-3 py-2">
                      <Badge variant="secondary" className="bg-sky-100 font-normal text-sky-700">
                        {t("legacy.source")}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={pending || !r.propertyId}
                          onClick={() => onImport(r)}
                          className="h-7 text-xs"
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden />
                          {t("legacy.import")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* 프로젝트별 오버라이드 — projects.ga4PropertyId가 표준 매핑을 우회. 읽기 전용. */}
      {overrides.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <h4 className="text-xs font-semibold text-foreground">{t("override.title")}</h4>
            <p className="text-[11px] text-muted-foreground">{t("override.description")}</p>
          </div>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">{t("override.project")}</th>
                  <th className="px-3 py-2 font-medium">{t("table.brand")}</th>
                  <th className="px-3 py-2 font-medium">{t("table.country")}</th>
                  <th className="px-3 py-2 font-medium">{t("override.propertyId")}</th>
                </tr>
              </thead>
              <tbody>
                {overrides.map((o) => (
                  <tr key={o.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-medium text-foreground">{o.name}</td>
                    <td className="px-3 py-2">{o.brand ?? "—"}</td>
                    <td className="px-3 py-2">{o.country}</td>
                    <td className="px-3 py-2 font-mono">{o.propertyId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
