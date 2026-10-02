"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FilePenLine, Plus } from "lucide-react";
import { Link, useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createDraftAction } from "../_ecat-actions";
import { ECAT_BASE } from "./ecat-shared";

// "Draft vN: k changes" bar above the entity pages (design 7절 초안 편집). One draft at a time
// (decision 29): with no draft the bar offers to create one from the active version.

export function DraftBar({
  activeVer,
  draftVer,
  draftTitle,
  changes,
  showOpen = true,
}: {
  activeVer: number;
  draftVer: number | null;
  draftTitle?: string | null;
  changes?: number | null;
  showOpen?: boolean;
}) {
  const t = useTranslations("adminEcat.draftBar");
  const te = useTranslations("adminEcat.errors");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  function create() {
    start(async () => {
      const r = await createDraftAction(title, reason || null);
      if (r.ok) {
        setOpen(false);
        setTitle("");
        setReason("");
        toast.success(t("created", { ver: r.value.version.ver }));
        router.refresh();
      } else toast.error(te(r.errorKey));
    });
  }

  return (
    <div
      data-testid="ecat-draft-bar"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-bg-soft px-3 py-2 text-xs"
    >
      <span className="inline-flex items-center gap-2 text-ink-700">
        <FilePenLine className="h-3.5 w-3.5" aria-hidden />
        {draftVer ? (
          <>
            <span className="font-semibold">{t("draft", { ver: draftVer, count: changes ?? 0 })}</span>
            {draftTitle ? <span className="text-muted-foreground">{draftTitle}</span> : null}
          </>
        ) : (
          <span>{t("none", { ver: activeVer })}</span>
        )}
      </span>
      {draftVer ? (
        showOpen ? (
          <Button asChild size="sm" variant="outline" className="h-7 text-xs">
            <Link href={`${ECAT_BASE}/draft`}>{t("open")}</Link>
          </Button>
        ) : null
      ) : (
        <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => setOpen(true)} data-testid="ecat-draft-create">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t("create")}
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("createTitle")}</DialogTitle>
            <DialogDescription>{t("createDescription", { ver: activeVer })}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ecat-draft-title">{t("titleLabel")}</Label>
              <Input
                id="ecat-draft-title"
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("titlePlaceholder")}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ecat-draft-reason">{t("reasonLabel")}</Label>
              <Textarea id="ecat-draft-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              {t("cancel")}
            </Button>
            <Button onClick={create} disabled={pending || !title.trim()} data-testid="ecat-draft-create-confirm">
              {t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
