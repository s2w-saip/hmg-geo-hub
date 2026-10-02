"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Lock, Plus, RefreshCw, Tag, Target, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  addTrackedCompetitor,
  removeTrackedCompetitor,
  addTrackedVehicle,
  removeTrackedVehicle,
  setTargetCompetitor,
  triggerReprocess,
  updateProject,
} from "../_actions";

export type CompetitorRow = {
  id: string;
  brandName: string;
  aliases: string[];
  notes: string | null;
  // KPI #16 비교 기준 브랜드 지정 여부 — 프로젝트당 최대 1개. 미지정이면 외부
  // 브랜드 SOV 1위 자동.
  isTarget: boolean;
};

export type VehicleRow = {
  id: string;
  brand: string;
  model: string;
  segment: string | null;
  aliases: string[];
};

function parseAliases(raw: string): string[] {
  return [...new Set(raw.split(",").map((v) => v.trim()).filter(Boolean))];
}

// 추적 대상 — 자사/경쟁사 2영역 (2026-07-08 UI 분리, 데이터 모델 불변).
// 분류는 project.brand 문자열 비교뿐: 자사 영역 = 고정 브랜드 + 별칭(tracked_
// brands, updateProject 경유) + 자사 모델(tracked_vehicles), 경쟁사 영역 =
// 그 외 브랜드/모델 + KPI #16 비교 기준 지정. 당사/경쟁 "판정"의 정본은 전사
// 엔티티 카탈로그이며 여기 입력은 표기 인식(별칭 사전)·강조 지정용이라는 정책
// 그대로다. 프로젝트 브랜드 미설정 시엔 기존 단일 폼/목록으로 폴백.
export function TrackedEntitiesPanel({
  projectId,
  projectBrand,
  ownBrandAliases = [],
  brands,
  vehicles,
  disabled,
}: {
  projectId: string;
  /** 일반 설정의 프로젝트 브랜드 — 자사 영역의 고정 기준. null이면 단일 폴백. */
  projectBrand?: string | null;
  /** 자사 브랜드 별칭(tracked_brands) — 자사 영역 칩 에디터 초기값. */
  ownBrandAliases?: string[];
  brands: CompetitorRow[];
  vehicles: VehicleRow[];
  disabled?: boolean;
}) {
  const [reprocessCount, setReprocessCount] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const t = useTranslations("projectDetail.setting.tracked");

  function offerReprocess(count: number) {
    if (count > 0) setReprocessCount(count);
  }

  function confirmReprocess() {
    startTransition(async () => {
      const r = await triggerReprocess(projectId);
      if (r.ok) {
        toast.success(t("reprocess.queued", { count: r.value.flagged }));
        setReprocessCount(null);
      } else {
        toast.error(r.error);
      }
    });
  }

  function onRemoveBrand(id: string) {
    startTransition(async () => {
      const r = await removeTrackedCompetitor(projectId, id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("form.brandRemoved"));
      offerReprocess(r.value.reprocessable);
    });
  }

  // KPI #16 비교 기준 브랜드 토글 — 이미 활성화돼 있으면 해제(자동 선택 폴백),
  // 아니면 교체 지정.
  function onToggleTarget(row: CompetitorRow) {
    startTransition(async () => {
      const r = await setTargetCompetitor(projectId, row.isTarget ? null : row.id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(row.isTarget ? t("target.cleared") : t("target.updated", { brand: row.brandName }));
    });
  }

  function onRemoveVehicle(id: string) {
    startTransition(async () => {
      const r = await removeTrackedVehicle(projectId, id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("form.vehicleRemoved"));
      offerReprocess(r.value.reprocessable);
    });
  }

  const own = projectBrand?.trim() || null;
  const isOwnBrand = (name: string) =>
    own != null && name.trim().toLowerCase() === own.toLowerCase();

  return (
    <>
      {own ? (
        <div className="grid gap-4">
          <OwnArea
            projectId={projectId}
            projectBrand={own}
            initialAliases={ownBrandAliases}
            // 레거시로 자사 브랜드가 경쟁사 테이블에 남아 있으면 자사 영역에서
            // 정리할 수 있게 노출(별칭 사전 역할은 카탈로그 sync가 병합하므로
            // 중복 — 삭제 유도).
            duplicateOwnRows={brands.filter((b) => isOwnBrand(b.brandName))}
            ownVehicles={vehicles.filter((v) => isOwnBrand(v.brand))}
            onRemoveBrand={onRemoveBrand}
            onRemoveVehicle={onRemoveVehicle}
            offerReprocess={offerReprocess}
            disabled={disabled}
            pending={pending}
            startTransition={startTransition}
          />
          <CompetitorArea
            projectId={projectId}
            projectBrand={own}
            competitorBrands={brands.filter((b) => !isOwnBrand(b.brandName))}
            competitorVehicles={vehicles.filter((v) => !isOwnBrand(v.brand))}
            onRemoveBrand={onRemoveBrand}
            onRemoveVehicle={onRemoveVehicle}
            onToggleTarget={onToggleTarget}
            offerReprocess={offerReprocess}
            disabled={disabled}
            pending={pending}
            startTransition={startTransition}
          />
        </div>
      ) : (
        <UnifiedFallback
          projectId={projectId}
          brands={brands}
          vehicles={vehicles}
          onRemoveBrand={onRemoveBrand}
          onRemoveVehicle={onRemoveVehicle}
          onToggleTarget={onToggleTarget}
          offerReprocess={offerReprocess}
          disabled={disabled}
          pending={pending}
          startTransition={startTransition}
        />
      )}

      <Dialog
        open={reprocessCount !== null}
        onOpenChange={(open) => {
          if (!open) setReprocessCount(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("reprocess.title")}</DialogTitle>
            <DialogDescription>
              {t("reprocess.description", { count: reprocessCount ?? 0 })}
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">{t("reprocess.hint")}</p>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setReprocessCount(null)}
              disabled={pending}
            >
              {t("reprocess.skip")}
            </Button>
            <Button type="button" onClick={confirmReprocess} disabled={pending}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              {t("reprocess.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type SharedHandlers = {
  projectId: string;
  onRemoveBrand: (id: string) => void;
  onRemoveVehicle: (id: string) => void;
  offerReprocess: (count: number) => void;
  disabled?: boolean;
  pending: boolean;
  startTransition: (cb: () => Promise<void>) => void;
};

// ─── 자사 영역 ──────────────────────────────────────────────────────────────
// 브랜드는 일반 설정의 프로젝트 브랜드를 따르는 고정 표시(입력 불가), 그 아래
// 별칭 칩 에디터(tracked_brands — updateProject 경유, 즉시 저장)와 자사 모델
// 목록/추가 폼. 여기 입력은 표기 인식용 — KPI 판정 기준은 바꾸지 않는다.
function OwnArea({
  projectId,
  projectBrand,
  initialAliases,
  duplicateOwnRows,
  ownVehicles,
  onRemoveBrand,
  onRemoveVehicle,
  offerReprocess,
  disabled,
  pending,
  startTransition,
}: SharedHandlers & {
  projectBrand: string;
  initialAliases: string[];
  duplicateOwnRows: CompetitorRow[];
  ownVehicles: VehicleRow[];
}) {
  const t = useTranslations("projectDetail.setting.tracked");
  const [aliases, setAliases] = useState<string[]>(initialAliases);
  const [aliasInput, setAliasInput] = useState("");
  const [model, setModel] = useState("");
  const [modelAliases, setModelAliases] = useState("");

  function saveAliases(next: string[]) {
    const prev = aliases;
    setAliases(next);
    startTransition(async () => {
      const r = await updateProject(projectId, {
        brandAliases: next,
        brandAliasesBrand: projectBrand,
      });
      if (!r.ok) {
        setAliases(prev);
        toast.error(r.error);
        return;
      }
      toast.success(t("own.aliasesSaved"));
      offerReprocess(r.value.reprocessable);
    });
  }

  function onAddAlias() {
    const added = parseAliases(aliasInput).filter((a) => !aliases.includes(a));
    if (added.length === 0) return;
    setAliasInput("");
    saveAliases([...aliases, ...added]);
  }

  function onSubmitModel(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!model.trim()) return;
    startTransition(async () => {
      const r = await addTrackedVehicle(projectId, {
        brand: projectBrand,
        model,
        aliases: parseAliases(modelAliases),
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("form.vehicleAdded"));
      setModel("");
      setModelAliases("");
      offerReprocess(r.value.reprocessable);
    });
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">
          {t("own.title")}
        </h3>
        <p className="text-xs text-muted-foreground">{t("own.description")}</p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-sm font-semibold text-foreground">
          {projectBrand}
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
            <Lock className="h-3 w-3" aria-hidden />
            {t("own.brandLock")}
          </span>
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            {t("own.aliasesLabel")}
          </span>
          {aliases.map((alias) => (
            <Badge key={alias} variant="outline" className="gap-1 text-[10px]">
              <Tag className="h-3 w-3" aria-hidden />
              {alias}
              {!disabled ? (
                <button
                  type="button"
                  onClick={() => saveAliases(aliases.filter((a) => a !== alias))}
                  disabled={pending}
                  aria-label={t("own.aliasRemove", { alias })}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              ) : null}
            </Badge>
          ))}
          {!disabled ? (
            <span className="inline-flex items-center gap-1">
              <Input
                value={aliasInput}
                onChange={(e) => setAliasInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onAddAlias();
                  }
                }}
                placeholder={t("own.aliasPlaceholder")}
                disabled={pending}
                className="h-7 w-36 text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onAddAlias}
                disabled={pending || !aliasInput.trim()}
                aria-label={t("own.aliasAdd")}
                title={t("own.aliasAdd")}
                className="text-muted-foreground"
              >
                <Plus className="h-4 w-4" aria-hidden />
              </Button>
            </span>
          ) : null}
        </div>
      </div>

      {duplicateOwnRows.length > 0 ? (
        <div className="mt-3 rounded-md border border-dashed border-border px-3 py-2">
          <p className="text-[11px] text-muted-foreground">{t("own.duplicateHint")}</p>
          {duplicateOwnRows.map((row) => (
            <div key={row.id} className="mt-1 flex items-center justify-between gap-2">
              <span className="text-xs text-foreground">
                {row.brandName}
                {row.aliases.length > 0 ? (
                  <span className="text-muted-foreground"> · {row.aliases.join(", ")}</span>
                ) : null}
              </span>
              {!disabled ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={pending}
                  onClick={() => onRemoveBrand(row.id)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-4">
        <EntityList
          title={t("own.modelsTitle")}
          description={t("own.modelsDescription")}
          empty={t("own.modelsEmpty")}
          rows={ownVehicles.map((row) => ({
            id: row.id,
            title: row.model,
            subtitle: row.segment,
            aliases: row.aliases,
            onRemove: () => onRemoveVehicle(row.id),
          }))}
          disabled={disabled}
          pending={pending}
        />
      </div>

      {!disabled ? (
        <form onSubmit={onSubmitModel} className="mt-3 flex flex-wrap items-end gap-2">
          <Field
            id="own-model"
            label={t("form.modelLabel")}
            value={model}
            onChange={setModel}
            placeholder={t("own.modelPlaceholder")}
            required
            disabled={pending}
          />
          <div className="min-w-48 flex-1">
            <Field
              id="own-model-aliases"
              label={t("form.aliasesLabel")}
              value={modelAliases}
              onChange={setModelAliases}
              placeholder={t("own.modelAliasPlaceholder")}
              disabled={pending}
            />
          </div>
          <Button type="submit" variant="outline" disabled={pending || !model.trim()}>
            <Plus className="h-4 w-4" aria-hidden />
            {t("own.addModel")}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

// ─── 경쟁사 영역 ────────────────────────────────────────────────────────────
function CompetitorArea({
  projectId,
  projectBrand,
  competitorBrands,
  competitorVehicles,
  onRemoveBrand,
  onRemoveVehicle,
  onToggleTarget,
  offerReprocess,
  disabled,
  pending,
  startTransition,
}: SharedHandlers & {
  projectBrand: string;
  competitorBrands: CompetitorRow[];
  competitorVehicles: VehicleRow[];
  onToggleTarget: (row: CompetitorRow) => void;
}) {
  const t = useTranslations("projectDetail.setting.tracked");
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [aliases, setAliases] = useState("");
  const [notes, setNotes] = useState("");

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!brand.trim()) return;
    // 자사 브랜드를 브랜드 단위로 등록하려는 경우 — 자사 영역에서 관리하도록
    // 안내(모델까지 입력했다면 정상 등록되고 자사 영역에 표시된다).
    if (
      !model.trim() &&
      brand.trim().toLowerCase() === projectBrand.toLowerCase()
    ) {
      toast.error(t("competitor.ownBrandError", { brand: projectBrand }));
      return;
    }
    const aliasList = parseAliases(aliases);
    const isOwnModel =
      !!model.trim() && brand.trim().toLowerCase() === projectBrand.toLowerCase();
    startTransition(async () => {
      const result = model.trim()
        ? await addTrackedVehicle(projectId, { brand, model, aliases: aliasList })
        : await addTrackedCompetitor(projectId, {
            brandName: brand,
            aliases: aliasList,
            notes: notes || null,
          });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(
        isOwnModel
          ? t("competitor.ownModelRedirected", { brand: projectBrand })
          : model.trim()
            ? t("form.vehicleAdded")
            : t("form.brandAdded"),
      );
      setBrand("");
      setModel("");
      setAliases("");
      setNotes("");
      offerReprocess(result.value.reprocessable);
    });
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">
          {t("competitor.title")}
        </h3>
        <p className="text-xs text-muted-foreground">{t("competitor.description")}</p>
      </div>

      {!disabled ? (
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id="tracked-brand"
              label={t("form.brandLabel")}
              value={brand}
              onChange={setBrand}
              placeholder={t("form.brandPlaceholder")}
              required
              disabled={pending}
            />
            <Field
              id="tracked-model"
              label={t("form.modelLabel")}
              value={model}
              onChange={setModel}
              placeholder={t("form.modelPlaceholder")}
              disabled={pending}
              hint={t("form.modelHint")}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id="tracked-aliases"
              label={t("form.aliasesLabel")}
              value={aliases}
              onChange={setAliases}
              placeholder={t("form.aliasesPlaceholder")}
              disabled={pending}
              hint={t("form.aliasesHint")}
            />
            <Field
              id="tracked-notes"
              label={t("form.notesLabel")}
              value={notes}
              onChange={setNotes}
              placeholder={t("form.notesPlaceholder")}
              disabled={pending || !!model.trim()}
              hint={model.trim() ? t("form.notesDisabledHint") : t("form.notesHint")}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              {t("competitor.ownRedirectHint", { brand: projectBrand })}
            </p>
            <Button type="submit" disabled={pending || !brand.trim()}>
              <Plus className="h-4 w-4" aria-hidden />
              {model.trim() ? t("form.addVehicle") : t("form.addBrand")}
            </Button>
          </div>
        </form>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <EntityList
          title={t("competitor.brandsTitle")}
          description={t("competitor.brandsDescription")}
          empty={t("competitor.brandsEmpty")}
          rows={competitorBrands.map((row) => ({
            id: row.id,
            title: row.brandName,
            subtitle: row.notes,
            aliases: row.aliases,
            onRemove: () => onRemoveBrand(row.id),
            // KPI #16 — 비교 기준 브랜드 배지 + 지정/해제 토글 (경쟁사 전용).
            target: {
              active: row.isTarget,
              badgeLabel: t("target.badge"),
              toggleLabel: row.isTarget ? t("target.unset") : t("target.set"),
              onToggle: () => onToggleTarget(row),
            },
          }))}
          disabled={disabled}
          pending={pending}
          plain
        />
        <EntityList
          title={t("competitor.modelsTitle")}
          description={t("competitor.modelsDescription")}
          empty={t("competitor.modelsEmpty")}
          rows={competitorVehicles.map((row) => ({
            id: row.id,
            title: `${row.brand} / ${row.model}`,
            subtitle: row.segment,
            aliases: row.aliases,
            onRemove: () => onRemoveVehicle(row.id),
          }))}
          disabled={disabled}
          pending={pending}
          plain
        />
      </div>
    </div>
  );
}

// ─── 폴백 — 프로젝트 브랜드 미설정 시 기존 단일 폼/목록 ─────────────────────
function UnifiedFallback({
  projectId,
  brands,
  vehicles,
  onRemoveBrand,
  onRemoveVehicle,
  onToggleTarget,
  offerReprocess,
  disabled,
  pending,
  startTransition,
}: SharedHandlers & {
  brands: CompetitorRow[];
  vehicles: VehicleRow[];
  onToggleTarget: (row: CompetitorRow) => void;
}) {
  const t = useTranslations("projectDetail.setting.tracked");
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [aliases, setAliases] = useState("");
  const [notes, setNotes] = useState("");

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!brand.trim()) return;
    const aliasList = parseAliases(aliases);
    startTransition(async () => {
      const result = model.trim()
        ? await addTrackedVehicle(projectId, { brand, model, aliases: aliasList })
        : await addTrackedCompetitor(projectId, {
            brandName: brand,
            aliases: aliasList,
            notes: notes || null,
          });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(model.trim() ? t("form.vehicleAdded") : t("form.brandAdded"));
      setBrand("");
      setModel("");
      setAliases("");
      setNotes("");
      offerReprocess(result.value.reprocessable);
    });
  }

  return (
    <div className="grid gap-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold tracking-tight text-foreground">
            {t("form.title")}
          </h3>
          <p className="text-xs text-muted-foreground">{t("form.description")}</p>
        </div>

        {!disabled ? (
          <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                id="tracked-brand"
                label={t("form.brandLabel")}
                value={brand}
                onChange={setBrand}
                placeholder={t("form.brandPlaceholder")}
                required
                disabled={pending}
              />
              <Field
                id="tracked-model"
                label={t("form.modelLabel")}
                value={model}
                onChange={setModel}
                placeholder={t("form.modelPlaceholder")}
                disabled={pending}
                hint={t("form.modelHint")}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                id="tracked-aliases"
                label={t("form.aliasesLabel")}
                value={aliases}
                onChange={setAliases}
                placeholder={t("form.aliasesPlaceholder")}
                disabled={pending}
                hint={t("form.aliasesHint")}
              />
              <Field
                id="tracked-notes"
                label={t("form.notesLabel")}
                value={notes}
                onChange={setNotes}
                placeholder={t("form.notesPlaceholder")}
                disabled={pending || !!model.trim()}
                hint={model.trim() ? t("form.notesDisabledHint") : t("form.notesHint")}
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={pending || !brand.trim()}>
                <Plus className="h-4 w-4" aria-hidden />
                {model.trim() ? t("form.addVehicle") : t("form.addBrand")}
              </Button>
            </div>
          </form>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <EntityList
          title={t("brands.title")}
          description={t("brands.description")}
          empty={t("brands.empty")}
          rows={brands.map((row) => ({
            id: row.id,
            title: row.brandName,
            subtitle: row.notes,
            aliases: row.aliases,
            onRemove: () => onRemoveBrand(row.id),
            target: {
              active: row.isTarget,
              badgeLabel: t("target.badge"),
              toggleLabel: row.isTarget ? t("target.unset") : t("target.set"),
              onToggle: () => onToggleTarget(row),
            },
          }))}
          disabled={disabled}
          pending={pending}
        />
        <EntityList
          title={t("models.title")}
          description={t("models.description")}
          empty={t("models.empty")}
          rows={vehicles.map((row) => ({
            id: row.id,
            title: `${row.brand} / ${row.model}`,
            subtitle: row.segment,
            aliases: row.aliases,
            onRemove: () => onRemoveVehicle(row.id),
          }))}
          disabled={disabled}
          pending={pending}
        />
      </div>
    </div>
  );
}

function EntityList({
  title,
  description,
  empty,
  rows,
  disabled,
  pending,
  plain,
}: {
  title: string;
  description: string;
  empty: string;
  rows: Array<{
    id: string;
    title: string;
    subtitle: string | null;
    aliases: string[];
    onRemove: () => void;
    // KPI #16 비교 기준 브랜드 — active 행은 배지, 버튼으로 토글.
    target?: {
      active: boolean;
      badgeLabel: string;
      toggleLabel: string;
      onToggle: () => void;
    };
  }>;
  disabled?: boolean;
  pending: boolean;
  /** true = 부모 카드 안에 중첩될 때 (자사/경쟁사 영역) — 자체 테두리 카드 생략. */
  plain?: boolean;
}) {
  return (
    <div
      className={
        plain
          ? "flex flex-col gap-3"
          : "flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
      }
    >
      <header className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </header>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {empty}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-card">
          {rows.map((row) => (
            <li key={row.id} className="flex items-start justify-between gap-2 px-3 py-2">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  {row.title}
                  {row.target?.active ? (
                    <Badge className="gap-1 bg-brand-700 text-[10px] text-white">
                      <Target className="h-3 w-3" aria-hidden />
                      {row.target.badgeLabel}
                    </Badge>
                  ) : null}
                </span>
                {row.subtitle ? (
                  <span className="text-[11px] text-muted-foreground">{row.subtitle}</span>
                ) : null}
                {row.aliases.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {row.aliases.map((alias) => (
                      <Badge key={alias} variant="outline" className="gap-1 text-[10px]">
                        <Tag className="h-3 w-3" aria-hidden />
                        {alias}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </div>
              {!disabled ? (
                <div className="flex shrink-0 items-center">
                  {row.target ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={row.target.onToggle}
                      title={row.target.toggleLabel}
                      aria-label={row.target.toggleLabel}
                      className={
                        row.target.active
                          ? "text-brand-700"
                          : "text-muted-foreground hover:text-brand-700"
                      }
                    >
                      <Target className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={row.onRemove}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  required,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
      />
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
