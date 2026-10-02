"use client";

import { useRef, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Download, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  exportTrackedUrlsXlsx,
  importTrackedUrlsXlsx,
} from "../_actions";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// "엑셀 내보내기 / 가져오기" for the tracked-URL list. Export is read-only (any
// member); Import is Owner-only (button hidden when canImport is false). Both
// run server-side (exceljs lives in the server actions), so the browser only
// triggers a download or uploads bytes.
export function TrackedUrlIO({
  projectId,
  canImport,
}: {
  projectId: string;
  canImport: boolean;
}) {
  const t = useTranslations("projectDetail.setting.trackedUrls.io");
  const [exporting, startExport] = useTransition();
  const [importing, startImport] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  function onExport() {
    startExport(async () => {
      const r = await exportTrackedUrlsXlsx(projectId);
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
      const r = await importTrackedUrlsXlsx(projectId, fd);
      if (!r.ok) {
        toast.error(r.error, { id: toastId });
        return;
      }
      const { created, updated, skipped, warnings } = r.value;
      toast.success(t("importSummary", { created, updated, skipped }), {
        id: toastId,
      });
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
    </div>
  );
}
