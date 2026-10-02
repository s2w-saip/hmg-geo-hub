"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { QA_SEVERITIES, type QaSeverity } from "@/lib/qa/filters";
import { cn } from "@/lib/utils";
import type { NoteTarget, SerializedNote } from "./types";

// 노트 작성. targetLabel 은 여기서 만들어 서버에 굳힌다 — 미러 재싱크로
// scope_citations.id 가 바뀌면 targetKey 만으로는 무엇을 지목했는지 알 수 없다.
export function NoteDialog({
  jobId,
  target,
  onClose,
  onCreated,
}: {
  jobId: string;
  target: NoteTarget | null;
  onClose: () => void;
  onCreated: (note: SerializedNote) => void;
}) {
  const t = useTranslations("qaReview");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<QaSeverity>("issue");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (target) {
      setBody("");
      setSeverity("issue");
    }
  }, [target]);

  const severityLabel: Record<QaSeverity, string> = {
    issue: t("notes.severityIssue"),
    question: t("notes.severityQuestion"),
    info: t("notes.severityInfo"),
  };

  async function submit() {
    if (!target || !body.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/qa/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          targetKind: target.kind,
          targetKey: target.key,
          targetLabel: target.label,
          severity,
          body: body.trim(),
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { note: SerializedNote };
        onCreated(data.note);
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  const targetKindLabel: Record<NoteTarget["kind"], string> = {
    answer: t("notes.targetAnswer"),
    prompt: t("notes.targetPrompt"),
    mention: t("notes.targetMention"),
    citation: t("notes.targetCitation"),
    acr: t("notes.targetAcr"),
    meta: t("notes.targetMeta"),
  };

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("notes.dialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("notes.dialogTarget")}: {target ? targetKindLabel[target.kind] : ""}
            {target?.label ? ` · ${target.label}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1">
          {QA_SEVERITIES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSeverity(s)}
              aria-pressed={severity === s}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                severity === s
                  ? "border-brand-700 bg-brand-700 text-white"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {severityLabel[s]}
            </button>
          ))}
        </div>

        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t("notes.placeholder")}
          rows={5}
          maxLength={4000}
          autoFocus
        />

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={busy || !body.trim()}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
