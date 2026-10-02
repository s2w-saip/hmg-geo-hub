"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useRouter } from "@/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GEO_BRANDS } from "@/lib/geo-catalog";
import { ECAT_ROLES, type EcatRole } from "@/lib/hgh/ecat-model";
import type { ReviewItemView, ReviewStatus } from "@/lib/hgh/adapters/admin-entities";
import { cn } from "@/lib/utils";
import { decideReviewAction } from "../_ecat-actions";
import { ECAT_BASE, fmtInt, fmtTime, Notice } from "./ecat-shared";
import { EntityPicker, type PickerOption } from "./entity-picker";

// Review inbox (decision 28): entities Scope found for the first time are already counted as
// competitors; they wait here to be registered into the draft (role, merge) or dismissed. New
// surfaces of a known entity wait the same way (register = block by default, or add).

const STATUSES: (ReviewStatus | "all")[] = ["pending", "resolved", "dismissed", "all"];

export function ReviewInbox({
  items,
  status,
  kind,
  q,
  draftVer,
  mergeOptions,
}: {
  items: ReviewItemView[];
  status: ReviewStatus | "all";
  kind: "new_entity" | "new_surface" | null;
  q: string;
  draftVer: number | null;
  mergeOptions: PickerOption[];
}) {
  const t = useTranslations("adminEcat.review");
  const tr = useTranslations("adminEcat.roles");
  const tc = useTranslations("adminEcat.common");
  const tst = useTranslations("adminEcat.status.review");
  const te = useTranslations("adminEcat.errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState<ReviewItemView | null>(null);
  const [role, setRole] = useState<EcatRole>("competitor");
  const [brand, setBrand] = useState("");
  const [merge, setMerge] = useState<string | null>(null);
  const [surfaceAction, setSurfaceAction] = useState<"block" | "add">("block");
  const [note, setNote] = useState("");
  const [query, setQuery] = useState(q);

  function nav(next: { status?: string; kind?: string | null; q?: string }) {
    const p = new URLSearchParams();
    const s = next.status ?? status;
    const k = next.kind === undefined ? kind : next.kind;
    const qq = next.q ?? q;
    if (s !== "pending") p.set("status", s);
    if (k) p.set("kind", k);
    if (qq.trim()) p.set("q", qq.trim());
    const qs = p.toString();
    router.push(`${ECAT_BASE}/review${qs ? `?${qs}` : ""}`);
  }

  function openItem(it: ReviewItemView) {
    setOpen(it);
    setRole("competitor");
    setBrand("");
    setMerge(null);
    setSurfaceAction("block");
    setNote("");
  }

  function decide(action: "register" | "dismiss") {
    if (!open) return;
    start(async () => {
      const r = await decideReviewAction(open.reviewId, {
        action,
        note: note || null,
        ...(action === "register"
          ? open.kind === "new_entity"
            ? { role, brandCode: role === "own" ? brand : null, mergeInto: merge }
            : { surfaceAction }
          : {}),
      });
      if (r.ok) {
        toast.success(t(action === "register" ? "registered" : "dismissed", { ver: r.value.ver ?? 0 }));
        setOpen(null);
        router.refresh();
      } else toast.error(te(r.errorKey));
    });
  }

  return (
    <div className="flex flex-col gap-3" data-testid="ecat-review">
      {!draftVer ? <Notice>{t("needDraft")}</Notice> : null}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label={t("statusLabel")}>
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={status === s}
              onClick={() => nav({ status: s })}
              className={cn(
                "rounded-full border px-3 py-1 text-xs",
                status === s ? "border-brand-700 bg-brand-700 text-white" : "border-border text-ink-700 hover:bg-bg-subtle",
              )}
            >
              {s === "all" ? t("statusAll") : tst(s)}
            </button>
          ))}
        </div>
        <Select value={kind ?? "any"} onValueChange={(v) => nav({ kind: v === "any" ? null : v })}>
          <SelectTrigger className="h-8 w-40 text-xs" aria-label={t("kindLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">{t("kindAny")}</SelectItem>
            <SelectItem value="new_entity">{t("kind.new_entity")}</SelectItem>
            <SelectItem value="new_surface">{t("kind.new_surface")}</SelectItem>
          </SelectContent>
        </Select>
        <form
          className="flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            nav({ q: query });
          }}
        >
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("search")} aria-label={t("search")} className="h-8 w-48 text-xs" />
          <Button type="submit" size="sm" variant="outline" className="h-8 text-xs">
            {t("searchSubmit")}
          </Button>
        </form>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("colKind")}</TableHead>
            <TableHead>{t("colName")}</TableHead>
            <TableHead>{t("colSurface")}</TableHead>
            <TableHead className="text-right">{t("colAnswers")}</TableHead>
            <TableHead className="text-right">{t("colMentions")}</TableHead>
            <TableHead>{t("colSeen")}</TableHead>
            <TableHead>{t("colStatus")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((it) => (
            <TableRow key={it.reviewId} data-testid="ecat-review-row">
              <TableCell>
                <Badge variant="outline" className="text-[10px]">
                  {t(`kind.${it.kind}`)}
                </Badge>
                {it.alertGrade ? <Badge className="ml-1 bg-sentiment-mixed/30 text-[10px] text-ink-700">{t("alert", { grade: it.alertGrade })}</Badge> : null}
              </TableCell>
              <TableCell className="text-xs font-medium">
                {it.displayName ?? it.entityId.slice(0, 8)}
                {it.entityType ? <span className="ml-1 text-muted-foreground">{it.entityType}</span> : null}
              </TableCell>
              <TableCell className="text-xs">{it.surface ?? ""}</TableCell>
              <TableCell className="text-right text-xs tabular-nums">{fmtInt(it.nAnswers)}</TableCell>
              <TableCell className="text-right text-xs tabular-nums">{fmtInt(it.nMentions)}</TableCell>
              <TableCell className="text-xs tabular-nums">
                {fmtTime(it.firstSeenAt)}
                <span className="text-muted-foreground"> {"~"} {fmtTime(it.lastSeenAt)}</span>
              </TableCell>
              <TableCell className="text-xs">
                {tst(it.status)}
                {it.resolvedVer ? <span className="ml-1 text-muted-foreground">{t("resolvedVer", { ver: it.resolvedVer })}</span> : null}
              </TableCell>
              <TableCell className="text-right">
                {it.status === "pending" ? (
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => openItem(it)} data-testid="ecat-review-open">
                    {t("decide")}
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">{t("empty")}</p>
      ) : null}

      <Dialog open={!!open} onOpenChange={(o) => (o ? null : setOpen(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{open ? (open.displayName ?? open.surface ?? "") : ""}</DialogTitle>
            <DialogDescription>{open ? t(`decideHint.${open.kind}`) : ""}</DialogDescription>
          </DialogHeader>
          {open?.kind === "new_entity" ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ecat-review-role">{t("role")}</Label>
                <Select value={role} onValueChange={(v) => setRole(v as EcatRole)}>
                  <SelectTrigger id="ecat-review-role" className="h-8 text-xs">
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
              {role === "own" ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="ecat-review-brand">{t("brand")}</Label>
                  <Select value={brand} onValueChange={setBrand}>
                    <SelectTrigger id="ecat-review-brand" className="h-8 text-xs">
                      <SelectValue placeholder={t("brand")} />
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
                <Label htmlFor="ecat-review-merge">{t("mergeInto")}</Label>
                <EntityPicker id="ecat-review-merge" options={mergeOptions} value={merge} onChange={setMerge} exclude={open.entityId} />
              </div>
            </div>
          ) : open ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ecat-review-surface">{t("surfaceAction")}</Label>
              <Select value={surfaceAction} onValueChange={(v) => setSurfaceAction(v as "block" | "add")}>
                <SelectTrigger id="ecat-review-surface" className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="block">{t("surfaceBlock")}</SelectItem>
                  <SelectItem value="add">{t("surfaceAdd")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ecat-review-note">{t("note")}</Label>
            <Input id="ecat-review-note" value={note} onChange={(e) => setNote(e.target.value)} className="h-8 text-xs" />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(null)} disabled={pending}>
              {tc("cancel")}
            </Button>
            <Button variant="outline" onClick={() => decide("dismiss")} disabled={pending} data-testid="ecat-review-dismiss">
              {t("dismiss")}
            </Button>
            <Button
              onClick={() => decide("register")}
              disabled={pending || !draftVer || (open?.kind === "new_entity" && role === "own" && !brand)}
              data-testid="ecat-review-register"
            >
              {t("register")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
