"use client";

import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { addCustomField, deleteCustomFieldHard } from "../_actions";

export type CustomFieldRow = {
  id: string;
  label: string;
  archived: boolean;
  // 서버가 센 프로젝트 전체 값 수(API 원천만). 목록은 한 번에 200행만 들고 있어
  // 완전삭제 확인은 이 값을 함께 본다. legacy 원천은 없음(undefined) → 로드된 행만.
  valueCount?: number;
};

export type CustomFieldValueRow = {
  promptId: string;
  fieldId: string;
  value: string;
};

export function CustomFieldsPanel({
  projectId,
  fields,
  values,
  disabled,
}: {
  projectId: string;
  fields: CustomFieldRow[];
  values: CustomFieldValueRow[];
  disabled?: boolean;
}) {
  const t = useTranslations("projectDetail.prompt.customFields");
  const [pending, startTransition] = useTransition();
  const [formOpen, setFormOpen] = useState(false);
  const [label, setLabel] = useState("");

  // fieldId -> total prompts currently tagged with it (any value).
  const usage = useMemo(() => {
    const total = new Map<string, number>();
    for (const v of values) total.set(v.fieldId, (total.get(v.fieldId) ?? 0) + 1);
    return total;
  }, [values]);

  function resetForm() {
    setLabel("");
    setFormOpen(false);
  }

  function onCreateField() {
    const trimmed = label.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const r = await addCustomField(projectId, { label: trimmed });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("created"));
      resetForm();
    });
  }

  function onDeleteHard(fieldId: string) {
    startTransition(async () => {
      const r = await deleteCustomFieldHard(projectId, fieldId);
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(t("deletedToast"));
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {fields.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {fields.map((f) => {
            const total = usage.get(f.id) ?? 0;
            return (
              <li
                key={f.id}
                className={`flex items-center gap-1.5 rounded-full border border-border py-1 pr-1.5 pl-3 text-sm ${f.archived ? "bg-muted/40 opacity-70" : "bg-card"}`}
              >
                <span className="font-medium text-foreground">{f.label}</span>
                {f.archived ? (
                  <Badge variant="secondary" className="text-[10px]">
                    {t("archived")}
                  </Badge>
                ) : null}
                {!disabled ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={pending || total > 0}
                    title={total > 0 ? t("deleteDisabledHint") : t("deleteButton")}
                    onClick={() => onDeleteHard(f.id)}
                    aria-label={t("deleteButton")}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {!disabled ? (
        <div>
          {!formOpen ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setFormOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t("openButton")}
            </Button>
          ) : (
            <div className="flex flex-col gap-3 rounded-md border border-dashed border-border p-3 sm:flex-row sm:items-end">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="cf-label">{t("labelLabel")}</Label>
                <Input
                  id="cf-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={t("labelPlaceholder")}
                  disabled={pending}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onCreateField();
                    }
                  }}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={resetForm}>
                  {t("cancel")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={pending || !label.trim()}
                  onClick={onCreateField}
                >
                  {t("create")}
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
