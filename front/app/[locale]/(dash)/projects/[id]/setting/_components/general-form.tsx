"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { RefreshCw, Save } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BrandSelect, brandSelectValueToDb } from "@/components/dash/brand-select";
import { triggerReprocess, updateProject } from "../_actions";

export type GeneralFormProps = {
  projectId: string;
  initial: {
    name: string;
    description: string | null;
    brand: string | null;
    // 읽기 전용 표시 — 국가는 측정 모집단의 기준이라 생성 후 변경 불가(정책).
    // 필드가 아예 없어 "변경 불가인지 누락인지" 알 수 없다는 고객 피드백
    // (2026-08-06)으로 안내 문구와 함께 노출한다.
    country: string | null;
    ga4PropertyId: string | null;
  };
  disabled?: boolean;
};

// 브랜드 별칭 입력은 "추적 대상 > 자사" 영역으로 이동(2026-07-08 자사/경쟁사
// 분리) — 자사 관련 입력(별칭 + 자사 모델)이 한 곳에 모이도록.
export function GeneralForm({ projectId, initial, disabled }: GeneralFormProps) {
  const t = useTranslations("projectDetail.setting.general");
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [brand, setBrand] = useState(initial.brand ?? "");
  const [ga4PropertyId, setGa4PropertyId] = useState(initial.ga4PropertyId ?? "");
  const [reprocessCount, setReprocessCount] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty =
    name !== initial.name ||
    description !== (initial.description ?? "") ||
    brand !== (initial.brand ?? "") ||
    ga4PropertyId !== (initial.ga4PropertyId ?? "");

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!dirty) return;
    startTransition(async () => {
      const result = await updateProject(projectId, {
        name,
        description,
        brand: brandSelectValueToDb(brand),
        ga4PropertyId,
      });
      if (result.ok) {
        toast.success(t("saveSuccess"));
        if (result.value.reprocessable > 0) {
          setReprocessCount(result.value.reprocessable);
        }
      } else {
        toast.error(result.error);
      }
    });
  }

  function confirmReprocess() {
    startTransition(async () => {
      const r = await triggerReprocess(projectId);
      if (r.ok) {
        toast.success(t("reprocessQueued", { count: r.value.flagged }));
        setReprocessCount(null);
      } else {
        toast.error(r.error);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="setting-name"
          label={t("nameLabel")}
          value={name}
          onChange={setName}
          required
          disabled={disabled || pending}
        />
        <Field
          id="setting-description"
          label={t("descriptionLabel")}
          value={description}
          onChange={setDescription}
          disabled={disabled || pending}
        />
        <div className="flex flex-col gap-2">
          <Label htmlFor="setting-brand">{t("brandLabel")}</Label>
          <BrandSelect
            id="setting-brand"
            value={brand}
            onChange={setBrand}
            disabled={disabled || pending}
          />
          <p className="text-[11px] text-muted-foreground">{t("brandHint")}</p>
        </div>
        <Field
          id="setting-country"
          label={t("countryLabel")}
          value={initial.country ?? "—"}
          onChange={() => {}}
          disabled
          hint={t("countryHint")}
        />
        <Field
          id="setting-ga4"
          label={t("ga4Label")}
          value={ga4PropertyId}
          onChange={setGa4PropertyId}
          disabled={disabled || pending}
          hint={t("ga4Hint")}
          inputMode="numeric"
          placeholder="469542848"
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={disabled || pending || !dirty}>
          <Save className="h-4 w-4" aria-hidden />
          {t("save")}
        </Button>
      </div>

      <Dialog
        open={reprocessCount !== null}
        onOpenChange={(open) => {
          if (!open) setReprocessCount(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("reprocessTitle")}</DialogTitle>
            <DialogDescription>
              {t("reprocessDescription", { count: reprocessCount ?? 0 })}
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">{t("reprocessHint")}</p>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setReprocessCount(null)}
              disabled={pending}
            >
              {t("reprocessSkip")}
            </Button>
            <Button type="button" onClick={confirmReprocess} disabled={pending}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              {t("reprocessConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  required,
  disabled,
  hint,
  inputMode,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  disabled?: boolean;
  hint?: string;
  inputMode?: "numeric" | "text";
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        disabled={disabled}
        inputMode={inputMode}
        placeholder={placeholder}
      />
      {hint ? (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
