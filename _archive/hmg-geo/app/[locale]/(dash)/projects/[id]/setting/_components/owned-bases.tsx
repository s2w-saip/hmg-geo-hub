"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Globe, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  addProjectOwnedBaseAction,
  removeProjectOwnedBaseAction,
} from "../_actions";

export type OwnedBaseRow = {
  id: string;
  baseUrl: string;
  label: string | null;
};

export function OwnedBasesPanel({
  projectId,
  rows,
  legacyDomain,
  disabled,
}: {
  projectId: string;
  rows: OwnedBaseRow[];
  legacyDomain?: string | null;
  disabled?: boolean;
}) {
  const t = useTranslations("projectDetail.setting.ownedBases");
  const [baseUrl, setBaseUrl] = useState("");
  const [label, setLabel] = useState("");
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!baseUrl.trim()) return;
    startTransition(async () => {
      const r = await addProjectOwnedBaseAction(projectId, {
        baseUrl,
        label: label || null,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("added"));
      setBaseUrl("");
      setLabel("");
    });
  }

  function onRemove(id: string) {
    startTransition(async () => {
      const r = await removeProjectOwnedBaseAction(projectId, id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("removed"));
    });
  }

  const showMultiBaseHint = rows.length >= 2;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-muted/30 p-3 text-[12.5px] text-muted-foreground">
        <p>{t("hint")}</p>
        {rows.length === 0 && legacyDomain ? (
          <p className="mt-2">{t("legacyHint", { domain: legacyDomain })}</p>
        ) : null}
        {showMultiBaseHint ? (
          <p className="mt-2 text-amber-700">{t("multiBaseHint")}</p>
        ) : null}
      </div>

      {disabled ? null : (
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
        >
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto]">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="owned-base-url" className="text-[11px]">
                {t("baseLabel")}
              </Label>
              <Input
                id="owned-base-url"
                type="url"
                placeholder={t("basePlaceholder")}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="owned-base-label" className="text-[11px]">
                {t("memoLabel")}
              </Label>
              <Input
                id="owned-base-label"
                type="text"
                placeholder={t("memoPlaceholder")}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <Button type="submit" size="sm" disabled={pending} className="self-end">
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {t("add")}
            </Button>
          </div>
        </form>
      )}

      {rows.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((row, index) => (
            <li
              key={row.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2"
            >
              <div className="flex min-w-0 items-start gap-2">
                <Globe className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-xs font-medium text-foreground">
                    {row.baseUrl}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {row.label || (index === 0 ? t("primaryFallback") : t("secondaryFallback"))}
                  </span>
                </div>
              </div>
              {disabled ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onRemove(row.id)}
                  disabled={pending}
                  aria-label={t("remove")}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
