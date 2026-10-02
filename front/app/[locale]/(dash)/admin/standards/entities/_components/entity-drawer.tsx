"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Ban, Plus, Trash2 } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GEO_BRANDS } from "@/lib/geo-catalog";
import { ECAT_ROLES } from "@/lib/hgh/ecat-model";
import type {
  EcatRole,
  ManagedEntityRow,
  MentionSamplesView,
  SurfaceView,
} from "@/lib/hgh/adapters/admin-entities";
import {
  addDraftSurfaceAction,
  deleteDraftEntityAction,
  deleteDraftSurfaceAction,
  entityMentionsAction,
  putDraftEntityAction,
} from "../_ecat-actions";
import { fmtInt, Highlighted, Notice, OwnLineageBadge, RoleBadge } from "./ecat-shared";
import { EntityPicker, type PickerOption } from "./entity-picker";

// Entity detail (design 7절 엔티티 상세): role and relations edited into the draft, surfaces
// added / blocked for this entity, merge sources, observed surfaces and mention samples with
// context. Every save writes the draft only; the KPIs change after an apply.

export function EntityDrawer({
  row,
  rows,
  activeVer,
  draftVer,
  draftSurfaces,
  onClose,
  onOpen,
}: {
  row: ManagedEntityRow | null;
  rows: ManagedEntityRow[];
  activeVer: number;
  draftVer: number | null;
  draftSurfaces: SurfaceView[];
  onClose: () => void;
  onOpen: (entityId: string) => void;
}) {
  const t = useTranslations("adminEcat.detail");
  return (
    <Dialog open={!!row} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" data-testid="ecat-entity-drawer">
        {row ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                {row.name}
                <RoleBadge role={row.activeRole} />
                {row.activeOwnBrand && row.activeRole !== "own" ? <OwnLineageBadge brand={row.activeOwnBrand} /> : null}
                {row.draftChanged && row.draftRole ? (
                  <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
                    {t("draftRole", { ver: draftVer ?? 0 })}
                    <RoleBadge role={row.draftRole} />
                  </span>
                ) : null}
              </DialogTitle>
              <DialogDescription>
                {t("summary", {
                  type: row.entityType ?? "",
                  brand: row.brandName ?? "",
                  answers: fmtInt(row.answers),
                  mentions: fmtInt(row.mentions),
                })}
                {row.origin === "hub" ? <span className="ml-2">{t("hubOrigin")}</span> : null}
              </DialogDescription>
            </DialogHeader>
            <EntityDetailBody
              key={`${row.entityId}:${draftVer ?? 0}`}
              row={row}
              rows={rows}
              activeVer={activeVer}
              draftVer={draftVer}
              draftSurfaces={draftSurfaces}
              onOpen={onOpen}
            />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function EntityDetailBody({
  row,
  rows,
  activeVer,
  draftVer,
  draftSurfaces,
  onOpen,
}: {
  row: ManagedEntityRow;
  rows: ManagedEntityRow[];
  activeVer: number;
  draftVer: number | null;
  draftSurfaces: SurfaceView[];
  onOpen: (entityId: string) => void;
}) {
  const t = useTranslations("adminEcat.detail");
  const tr = useTranslations("adminEcat.roles");
  const te = useTranslations("adminEcat.errors");
  const tc = useTranslations("adminEcat.common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const base = row.draft ?? row.active;
  const [role, setRole] = useState<EcatRole>(draftVer ? (row.draftRole ?? "competitor") : row.activeRole);
  const [brandCode, setBrandCode] = useState(base?.brandCode ?? row.brandCode ?? "");
  const [name, setName] = useState(base?.name ?? "");
  const [note, setNote] = useState(base?.note ?? "");
  const [mergeInto, setMergeInto] = useState<string | null>(base?.mergeInto ?? null);
  const [parent, setParent] = useState<string | null>(base?.parentBrandId ?? null);
  const [surface, setSurface] = useState("");
  const [surfaceAction, setSurfaceAction] = useState<"add" | "block">("block");
  const [lang, setLang] = useState("");
  const [samples, setSamples] = useState<MentionSamplesView | null>(null);
  const [samplesErr, setSamplesErr] = useState<string | null>(null);
  const [surfaceFilter, setSurfaceFilter] = useState<string | null>(null);
  const editable = draftVer != null;

  const options: PickerOption[] = useMemo(
    () => rows.map((r) => ({ entityId: r.entityId, name: r.name, hint: r.entityType })),
    [rows],
  );
  const mySurfaces = draftSurfaces.filter((s) => s.entityId === row.entityId);
  const mergeSources = rows.filter((r) => (r.draft ?? r.active)?.mergeInto === row.entityId);

  useEffect(() => {
    let alive = true;
    entityMentionsAction(row.entityId, surfaceFilter).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setSamples(r.value);
        setSamplesErr(null);
      } else setSamplesErr(r.errorKey);
    });
    return () => {
      alive = false;
    };
  }, [row.entityId, surfaceFilter]);

  function stale(n: number[]) {
    if (n.length) toast.message(tc("staleApplies", { count: n.length }));
  }

  function save() {
    if (!draftVer) return;
    start(async () => {
      const r = await putDraftEntityAction(draftVer, row.entityId, {
        role,
        brandCode: role === "own" ? brandCode : null,
        name,
        note,
        mergeInto,
        parentBrandId: parent,
      });
      if (r.ok) {
        toast.success(t("saved", { name: row.name }));
        stale(r.value.staleApplies);
        router.refresh();
      } else toast.error(te(r.errorKey));
    });
  }

  function revert() {
    if (!draftVer) return;
    start(async () => {
      const r = await deleteDraftEntityAction(draftVer, row.entityId);
      if (r.ok) {
        toast.success(t("reverted", { name: row.name }));
        stale(r.value.staleApplies);
        router.refresh();
      } else toast.error(te(r.errorKey));
    });
  }

  function addSurface(text: string, action: "add" | "block") {
    if (!draftVer || !text.trim()) return;
    start(async () => {
      const r = await addDraftSurfaceAction(draftVer, { action, surface: text, entityId: row.entityId, lang: lang || null });
      if (r.ok) {
        toast.success(t(action === "add" ? "surfaceAdded" : "surfaceBlocked", { surface: text.trim() }));
        stale(r.value.staleApplies);
        setSurface("");
        router.refresh();
      } else toast.error(te(r.errorKey));
    });
  }

  function removeSurface(s: SurfaceView) {
    if (!draftVer) return;
    start(async () => {
      const r = await deleteDraftSurfaceAction(draftVer, s.surfaceId);
      if (r.ok) {
        stale(r.value.staleApplies);
        router.refresh();
      } else toast.error(te(r.errorKey));
    });
  }

  return (
    <div className="flex flex-col gap-5 text-sm">
      {!editable ? <Notice>{t("needDraft", { ver: activeVer })}</Notice> : null}

      {/* role and relations */}
      <section className="flex flex-col gap-3" aria-labelledby="ecat-sec-role">
        <h3 id="ecat-sec-role" className="text-xs font-semibold text-ink-700">
          {t("sectionRole")}
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ecat-role">{t("role")}</Label>
            <Select value={role} onValueChange={(v) => setRole(v as EcatRole)} disabled={!editable || pending}>
              <SelectTrigger id="ecat-role" className="h-8 text-xs" data-testid="ecat-role-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ECAT_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {tr(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{t(`roleHint.${role}`)}</p>
          </div>
          {role === "own" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ecat-brand">{t("brandCode")}</Label>
              <Select value={brandCode} onValueChange={setBrandCode} disabled={!editable || pending}>
                <SelectTrigger id="ecat-brand" className="h-8 text-xs">
                  <SelectValue placeholder={t("brandCode")} />
                </SelectTrigger>
                <SelectContent>
                  {[...new Set([...(row.brandCode ? [row.brandCode] : []), ...GEO_BRANDS])].map((b) => (
                    <SelectItem key={b} value={b}>
                      {b}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ecat-name">{t("name")}</Label>
            <Input
              id="ecat-name"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
              placeholder={row.name}
              className="h-8 text-xs"
              disabled={!editable || pending}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ecat-note">{t("note")}</Label>
            <Input
              id="ecat-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="h-8 text-xs"
              disabled={!editable || pending}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ecat-merge">{t("mergeInto")}</Label>
            <EntityPicker
              id="ecat-merge"
              options={options}
              value={mergeInto}
              onChange={setMergeInto}
              exclude={row.entityId}
              disabled={!editable || pending}
            />
            <p className="text-[11px] text-muted-foreground">{t("mergeHint")}</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ecat-parent">{t("parentBrand")}</Label>
            <EntityPicker
              id="ecat-parent"
              options={options}
              value={parent}
              onChange={setParent}
              exclude={row.entityId}
              disabled={!editable || pending}
            />
          </div>
        </div>
        {role === "removed" && row.activeRole !== "removed" ? <Notice tone="warn">{t("removeWarn")}</Notice> : null}
        {row.activeOwnBrand && role !== "own" ? (
          <Notice tone="warn" testId="ecat-own-lineage-warn">
            {t("ownLineageWarn", { brand: row.activeOwnBrand })}
          </Notice>
        ) : null}
        {role === "own" || row.activeRole === "own" ? <Notice tone="warn">{t("ownWarn")}</Notice> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={save} disabled={!editable || pending || (role === "own" && !brandCode)} data-testid="ecat-entity-save">
            {t("saveToDraft")}
          </Button>
          {editable && row.draft ? (
            <Button size="sm" variant="outline" onClick={revert} disabled={pending}>
              {t("revertDefault")}
            </Button>
          ) : null}
        </div>
        {mergeSources.length ? (
          <div className="text-xs">
            <span className="text-muted-foreground">{t("mergeSources")}</span>{" "}
            {mergeSources.map((m) => (
              <button key={m.entityId} type="button" className="mr-2 underline" onClick={() => onOpen(m.entityId)}>
                {m.name}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {/* surfaces */}
      <section className="flex flex-col gap-3" aria-labelledby="ecat-sec-surface">
        <h3 id="ecat-sec-surface" className="text-xs font-semibold text-ink-700">
          {t("sectionSurfaces")}
        </h3>
        {mySurfaces.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {mySurfaces.map((s) => (
              <li key={s.surfaceId}>
                <Badge
                  className={
                    s.action === "block" ? "gap-1 bg-danger/10 text-[11px] text-danger" : "gap-1 bg-positive/15 text-[11px] text-positive"
                  }
                >
                  {s.action === "block" ? <Ban className="h-3 w-3" aria-hidden /> : <Plus className="h-3 w-3" aria-hidden />}
                  {s.surface}
                  {s.lang ? <span className="opacity-70">({s.lang})</span> : null}
                  {editable ? (
                    <button
                      type="button"
                      aria-label={t("surfaceRemove", { surface: s.surface })}
                      onClick={() => removeSurface(s)}
                      disabled={pending}
                      className="ml-0.5"
                    >
                      <Trash2 className="h-3 w-3" aria-hidden />
                    </button>
                  ) : null}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{t("surfacesNone")}</p>
        )}
        {editable ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ecat-surface">{t("surface")}</Label>
              <Input
                id="ecat-surface"
                value={surface}
                maxLength={200}
                onChange={(e) => setSurface(e.target.value)}
                className="h-8 w-48 text-xs"
                data-testid="ecat-surface-input"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ecat-surface-action">{t("surfaceAction")}</Label>
              <Select value={surfaceAction} onValueChange={(v) => setSurfaceAction(v as "add" | "block")} disabled={pending}>
                <SelectTrigger id="ecat-surface-action" className="h-8 w-32 text-xs" data-testid="ecat-surface-action">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="block">{t("actionBlock")}</SelectItem>
                  <SelectItem value="add">{t("actionAdd")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ecat-lang">{t("lang")}</Label>
              <Input id="ecat-lang" value={lang} maxLength={16} onChange={(e) => setLang(e.target.value)} className="h-8 w-20 text-xs" />
            </div>
            <Button
              size="sm"
              onClick={() => addSurface(surface, surfaceAction)}
              disabled={pending || !surface.trim()}
              data-testid="ecat-surface-submit"
            >
              {t("surfaceSubmit")}
            </Button>
          </div>
        ) : null}
        <p className="text-[11px] text-muted-foreground">{t("surfaceHint")}</p>
      </section>

      {/* samples */}
      <section className="flex flex-col gap-3" aria-labelledby="ecat-sec-samples">
        <h3 id="ecat-sec-samples" className="text-xs font-semibold text-ink-700">
          {t("sectionSamples")}
        </h3>
        {samplesErr ? <Notice tone="danger">{te(samplesErr)}</Notice> : null}
        {!samples && !samplesErr ? <p className="text-xs text-muted-foreground">{tc("loading")}</p> : null}
        {samples ? (
          <>
            {samples.surfaces.length ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-[11px] text-muted-foreground">{t("observedSurfaces")}</p>
                <ul className="flex flex-wrap gap-1.5" data-testid="ecat-observed-surfaces">
                  {samples.surfaces.map((s) => (
                    <li key={s.surface} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px]">
                      <button
                        type="button"
                        className={surfaceFilter === s.surface ? "font-semibold underline" : "hover:underline"}
                        onClick={() => setSurfaceFilter(surfaceFilter === s.surface ? null : s.surface)}
                      >
                        {s.surface}
                      </button>
                      <span className="tabular-nums text-muted-foreground">{fmtInt(s.n)}</span>
                      {editable ? (
                        <button
                          type="button"
                          aria-label={t("blockThis", { surface: s.surface })}
                          title={t("blockThis", { surface: s.surface })}
                          className="text-danger"
                          onClick={() => addSurface(s.surface, "block")}
                          disabled={pending}
                        >
                          <Ban className="h-3 w-3" aria-hidden />
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {samples.items.length ? (
              <ul className="flex flex-col gap-2" data-testid="ecat-samples">
                {samples.items.map((m, i) => (
                  <li key={`${m.answerKey}:${i}`} className="rounded-md border border-border bg-bg-soft px-3 py-2 text-xs">
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="tabular-nums">{m.roundDate}</span>
                      {m.surfaceText ? <span className="font-medium text-ink-700">{m.surfaceText}</span> : null}
                      <span>{t(m.source === "occurrence" ? "sourceOccurrence" : "sourceBody")}</span>
                      {m.turnIndex != null ? <span>{t("turn", { n: m.turnIndex })}</span> : null}
                    </div>
                    <p className="leading-relaxed whitespace-pre-wrap text-ink-700">
                      <Highlighted text={m.context} range={m.highlight} />
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">{t("samplesNone")}</p>
            )}
          </>
        ) : null}
      </section>
    </div>
  );
}
