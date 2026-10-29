"use client";

import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Download, HelpCircle, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { exportPromptsXlsx, importPromptsXlsx } from "../_actions";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// "엑셀 내보내기 / 가져오기" — Export is read-only (any member); Import is
// Owner-only (button hidden otherwise). Both run server-side (exceljs lives in
// the server actions), so the browser only triggers a download or uploads bytes.
export function PromptIO({
  projectId,
  canImport,
}: {
  projectId: string;
  canImport: boolean;
}) {
  const t = useTranslations("projectDetail.prompt.io");
  const tg = useTranslations("projectDetail.prompt.io.guide");
  const [exporting, startExport] = useTransition();
  const [importing, startImport] = useTransition();
  const [guideOpen, setGuideOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function onExport() {
    startExport(async () => {
      const r = await exportPromptsXlsx(projectId);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const bin = atob(r.value.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.value.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    const fd = new FormData();
    fd.set("file", file);
    startImport(async () => {
      const toastId = toast.loading(t("importStart"), {
        description: file.name,
      });
      const r = await importPromptsXlsx(projectId, fd);
      if (!r.ok) {
        toast.error(r.error, { id: toastId });
        return;
      }
      const { created, updated, skipped, createdTags, warnings } = r.value;
      toast.success(t("importSummary", { created, updated, skipped }), {
        id: toastId,
      });
      if (createdTags > 0) toast.info(t("tagsCreated", { count: createdTags }));
      for (const w of warnings.slice(0, 5)) toast.warning(w);
      if (warnings.length > 5) {
        toast.warning(t("moreWarnings", { count: warnings.length - 5 }));
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setGuideOpen(true)}
        className="text-muted-foreground"
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden />
        {tg("trigger")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onExport}
        disabled={exporting}
      >
        <Download className="h-3.5 w-3.5" aria-hidden />
        {t("export")}
      </Button>
      {canImport ? (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileRef.current?.click()}
            disabled={importing}
            aria-busy={importing}
          >
            {importing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Upload className="h-3.5 w-3.5" aria-hidden />
            )}
            {importing ? t("importing") : t("import")}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={onFile}
          />
        </>
      ) : null}

      <Dialog open={guideOpen} onOpenChange={setGuideOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{tg("title")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 text-sm">
            <GuideItem label={tg("formatLabel")} body={tg("formatBody")} />
            <GuideItem label={tg("newLabel")} body={tg("newBody")} />
            <GuideItem label={tg("editLabel")} body={tg("editBody")} />
            <GuideItem label={tg("tagLabel")} body={tg("tagBody")} />
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {tg("notesLabel")}
              </span>
              <ul className="list-disc pl-4 text-[13px] leading-relaxed text-muted-foreground">
                <li>{tg("note1")}</li>
                <li>{tg("note2")}</li>
              </ul>
            </div>
            <p className="rounded-md bg-muted/50 px-3 py-2 text-[13px] text-foreground">
              {tg("tip")}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setGuideOpen(false)}>
              {tg("close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function GuideItem({ label, body }: { label: string; body: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <p className="text-[13px] leading-relaxed text-foreground">{body}</p>
    </div>
  );
}
