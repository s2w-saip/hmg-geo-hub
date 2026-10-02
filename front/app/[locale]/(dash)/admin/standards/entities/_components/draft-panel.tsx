"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useRouter } from "@/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SectionCard } from "@/components/section-card";
import { GEO_BRANDS } from "@/lib/geo-catalog";
import { ECAT_ROLES } from "@/lib/hgh/ecat-model";
import type {
  EcatRole,
  LintView,
  SurfaceView,
  VersionDiffView,
  VersionSummaryView,
} from "@/lib/hgh/adapters/admin-entities";
import { addDraftSurfaceAction, addHubEntityAction, discardDraftAction, patchDraftAction } from "../_ecat-actions";
import { ApplyRequestForm } from "./apply-request-form";
import { fmtTime, Notice } from "./ecat-shared";
import { DiffTable } from "./diff-table";
import { LintPanel } from "./lint-panel";

// Draft editing panel (design 7절 초안 편집): title and reason, the change list against the
// version it was based on, hub entity and global block surface forms, lint, and the apply
// request. The apply request stays disabled until the current lint has no L1 / L3 and every
// L2 is confirmed (the backend refuses the same with ECAT_LINT_BLOCKED / ECAT_LINT_UNACKED).

export function applyBlockedKey(lint: LintView | null): string | null {
  if (!lint || !lint.lintedAt) return "notLinted";
  if (lint.stale) return "stale";
  if (lint.blocked) return "lintBlocked";
  if (lint.unacked.length) return "unacked";
  return null;
}

export function DraftPanel({
  version,
  diff,
  names,
  lint,
  globalBlocks,
}: {
  version: VersionSummaryView;
  diff: VersionDiffView | null;
  names: Record<string, string>;
  lint: LintView | null;
  globalBlocks: SurfaceView[];
}) {
  const t = useTranslations("adminEcat.draft");
  const tc = useTranslations("adminEcat.common");
  const tr = useTranslations("adminEcat.roles");
  const te = useTranslations("adminEcat.errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const ver = version.ver;
  // A rollback draft is the previous version's content as it is (backend 409 ECAT_ROLLBACK_IMMUTABLE on edits).
  const readOnly = version.origin === "rollback";
  const [title, setTitle] = useState(version.title);
  const [reason, setReason] = useState(version.reason ?? "");
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardReason, setDiscardReason] = useState("");
  const [hub, setHub] = useState<{ name: string; type: string; role: EcatRole; brand: string; note: string }>({
    name: "",
    type: "Brand",
    role: "competitor",
    brand: "",
    note: "",
  });
  const [block, setBlock] = useState({ surface: "", lang: "" });

  function stale(n: number[]) {
    if (n.length) toast.message(tc("staleApplies", { count: n.length }));
  }

  function saveMeta() {
    start(async () => {
      const r = await patchDraftAction(ver, title, reason || null);
      if (r.ok) {
        toast.success(t("metaSaved"));
        router.refresh();
      } else toast.error(te(r.errorKey));
    });
  }

  function discard() {
    start(async () => {
      const r = await discardDraftAction(ver, discardReason || null);
      if (r.ok) {
        setDiscardOpen(false);
        toast.success(t("discarded", { ver, count: r.value.rejectedApplies.length }));
        router.refresh();
      } else toast.error(te(r.errorKey));
    });
  }

  function addHub() {
    start(async () => {
      const r = await addHubEntityAction(ver, {
        name: hub.name,
        entityType: hub.type,
        role: hub.role,
        brandCode: hub.role === "own" ? hub.brand : null,
        note: hub.note || null,
      });
      if (r.ok) {
        toast.success(t("hubAdded", { name: hub.name.trim() }));
        stale(r.value.staleApplies);
        setHub({ name: "", type: "Brand", role: "competitor", brand: "", note: "" });
        router.refresh();
      } else toast.error(te(r.errorKey));
    });
  }

  function addGlobalBlock() {
    start(async () => {
      const r = await addDraftSurfaceAction(ver, { action: "block", surface: block.surface, entityId: null, lang: block.lang || null });
      if (r.ok) {
        toast.success(t("globalBlocked", { surface: block.surface.trim() }));
        stale(r.value.staleApplies);
        setBlock({ surface: "", lang: "" });
        router.refresh();
      } else toast.error(te(r.errorKey));
    });
  }

  return (
    <div className="flex flex-col gap-6" data-testid="ecat-draft-panel">
      <SectionCard title={t("metaTitle", { ver })} description={t("metaDescription", { based: version.basedOn ?? 0, at: fmtTime(version.createdAt) })}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ecat-meta-title">{t("title")}</Label>
            <Input id="ecat-meta-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} className="h-8 text-xs" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ecat-meta-reason">{t("reason")}</Label>
            <Textarea id="ecat-meta-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="text-xs" />
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={saveMeta} disabled={pending || !title.trim()}>
            {t("saveMeta")}
          </Button>
          <Button size="sm" variant="outline" className="text-danger" onClick={() => setDiscardOpen(true)} disabled={pending}>
            {t("discard")}
          </Button>
        </div>
      </SectionCard>

      <SectionCard title={t("changesTitle")} description={t("changesDescription", { based: diff?.against ?? version.basedOn ?? 0 })}>
        {diff ? <DiffTable diff={diff} names={names} /> : <Notice tone="danger">{te("generic")}</Notice>}
      </SectionCard>

      <SectionCard title={t("addTitle")} description={t("addDescription")}>
        {readOnly ? (
          <Notice tone="warn" testId="ecat-rollback-readonly">
            {t("rollbackReadOnly")}
          </Notice>
        ) : null}
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold text-ink-700">{t("hubTitle")}</p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ecat-hub-name">{t("hubName")}</Label>
                <Input id="ecat-hub-name" value={hub.name} maxLength={200} onChange={(e) => setHub({ ...hub, name: e.target.value })} className="h-8 w-48 text-xs" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ecat-hub-type">{t("hubType")}</Label>
                <Input id="ecat-hub-type" value={hub.type} maxLength={60} onChange={(e) => setHub({ ...hub, type: e.target.value })} className="h-8 w-32 text-xs" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ecat-hub-role">{t("hubRole")}</Label>
                <Select value={hub.role} onValueChange={(v) => setHub({ ...hub, role: v as EcatRole })}>
                  <SelectTrigger id="ecat-hub-role" className="h-8 w-32 text-xs">
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
              </div>
              {hub.role === "own" ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="ecat-hub-brand">{t("hubBrand")}</Label>
                  <Select value={hub.brand} onValueChange={(v) => setHub({ ...hub, brand: v })}>
                    <SelectTrigger id="ecat-hub-brand" className="h-8 w-32 text-xs">
                      <SelectValue placeholder={t("hubBrand")} />
                    </SelectTrigger>
                    <SelectContent>
                      {GEO_BRANDS.map((b) => (
                        <SelectItem key={b} value={b}>
                          {b}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ecat-hub-note">{t("hubNote")}</Label>
                <Input id="ecat-hub-note" value={hub.note} onChange={(e) => setHub({ ...hub, note: e.target.value })} className="h-8 w-48 text-xs" />
              </div>
              <Button size="sm" onClick={addHub} disabled={readOnly || pending || !hub.name.trim() || (hub.role === "own" && !hub.brand)}>
                {t("hubSubmit")}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">{t("hubHint")}</p>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold text-ink-700">{t("globalTitle")}</p>
            {globalBlocks.length ? (
              <ul className="flex flex-wrap gap-1.5">
                {globalBlocks.map((s) => (
                  <li key={s.surfaceId}>
                    <Badge className="bg-danger/10 text-[11px] text-danger">
                      {s.surface}
                      {s.lang ? ` (${s.lang})` : ""}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ecat-global-surface">{t("globalSurface")}</Label>
                <Input
                  id="ecat-global-surface"
                  value={block.surface}
                  maxLength={200}
                  onChange={(e) => setBlock({ ...block, surface: e.target.value })}
                  className="h-8 w-48 text-xs"
                  data-testid="ecat-global-surface"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ecat-global-lang">{t("globalLang")}</Label>
                <Input id="ecat-global-lang" value={block.lang} maxLength={16} onChange={(e) => setBlock({ ...block, lang: e.target.value })} className="h-8 w-20 text-xs" />
              </div>
              <Button size="sm" onClick={addGlobalBlock} disabled={readOnly || pending || !block.surface.trim()} data-testid="ecat-global-submit">
                {t("globalSubmit")}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">{t("globalHint")}</p>
          </div>
        </div>
      </SectionCard>

      <SectionCard title={t("lintTitle")} description={t("lintDescription")}>
        <LintPanel key={`${lint?.lintedAt ?? ""}:${lint?.acked.join("|") ?? ""}`} ver={ver} lint={lint} />
      </SectionCard>

      <SectionCard title={t("applyTitle")} description={t("applyDescription")}>
        <ApplyRequestForm blockedKey={applyBlockedKey(lint)} />
      </SectionCard>

      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("discardTitle", { ver })}</DialogTitle>
            <DialogDescription>{t("discardDescription")}</DialogDescription>
          </DialogHeader>
          <Textarea value={discardReason} onChange={(e) => setDiscardReason(e.target.value)} rows={2} aria-label={t("reason")} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDiscardOpen(false)} disabled={pending}>
              {tc("cancel")}
            </Button>
            <Button variant="destructive" onClick={discard} disabled={pending}>
              {t("discard")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

