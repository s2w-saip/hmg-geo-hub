"use client";

import { useState, useTransition } from "react";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { deleteProject } from "../_actions";

export type DangerZoneProps = {
  projectId: string;
  projectName: string;
  disabled?: boolean;
};

export function DangerZone({ projectId, projectName, disabled }: DangerZoneProps) {
  const t = useTranslations("projectDetail.setting.danger");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [pending, startTransition] = useTransition();

  function onDelete() {
    startTransition(async () => {
      const result = await deleteProject(projectId, confirm, locale);
      // deleteProject redirects on success — control returns here only on
      // failure. (Next throws a special redirect error that the transition
      // catches and propagates; we don't need to handle the success path.)
      if (result && !result.ok) {
        toast.error(result.error);
      }
    });
  }

  const canConfirm = confirm.trim() === projectName;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="destructive" disabled={disabled}>
            <Trash2 className="h-4 w-4" aria-hidden />
            {t("deleteButton")}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("deleteDialog.description", { name: projectName })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="danger-confirm">{t("deleteDialog.confirmLabel")}</Label>
            <Input
              id="danger-confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={projectName}
              disabled={pending}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              {t("deleteDialog.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={onDelete}
              disabled={pending || !canConfirm}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              {t("deleteDialog.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
