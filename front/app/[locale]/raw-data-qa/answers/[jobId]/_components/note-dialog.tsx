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

// 판정 저장(lib/qa/review-session.ts)과 같은 15초 상한 — 응답이 없으면 버튼을 풀고 실패를 알린다.
const NOTE_TIMEOUT_MS = 15_000;

export type NoteDraft = {
  jobId: string;
  target: NoteTarget;
  severity: QaSeverity;
  body: string;
};

/**
 * POST /api/qa/note (경로·본문 그대로) → 만든 노트. HTTP 오류·네트워크 오류·15초 타임아웃·형식 오류는
 * 던지지 않고 null 이다 — 다이얼로그가 입력을 유지한 채 실패를 알린다(자동 재시도 없음).
 */
export async function createNote(draft: NoteDraft, fetcher: typeof fetch = fetch): Promise<SerializedNote | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NOTE_TIMEOUT_MS);
  try {
    const res = await fetcher("/api/qa/note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: draft.jobId,
        targetKind: draft.target.kind,
        targetKey: draft.target.key,
        targetLabel: draft.target.label,
        severity: draft.severity,
        body: draft.body.trim(),
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { note?: SerializedNote } | null;
    return data?.note ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** 노트 저장 실패 고지 — 검수 상세 판정 저장 실패 배너(detail-shell)와 같은 문구·모양. */
export function NoteSaveFailed() {
  const t = useTranslations("qaReview");
  return (
    <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {t("detail.saveFailed")}
    </p>
  );
}

// 노트 작성. targetLabel 은 여기서 만들어 서버에 굳힌다 — 미러 재싱크로
// scope_citations.id 가 바뀌면 targetKey 만으로는 무엇을 지목했는지 알 수 없다.
export function NoteDialog({
  jobId,
  readOnly = false,
  target,
  onClose,
  onCreated,
}: {
  jobId: string;
  readOnly?: boolean;
  target: NoteTarget | null;
  onClose: () => void;
  onCreated: (note: SerializedNote) => void;
}) {
  const t = useTranslations("qaReview");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<QaSeverity>("issue");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (target) {
      setBody("");
      setSeverity("issue");
      setFailed(false);
    }
  }, [target]);

  const severityLabel: Record<QaSeverity, string> = {
    issue: t("notes.severityIssue"),
    question: t("notes.severityQuestion"),
    info: t("notes.severityInfo"),
  };

  async function submit() {
    if (readOnly || !target || !body.trim()) return;
    setBusy(true);
    setFailed(false);
    try {
      const note = await createNote({ jobId, target, severity, body });
      if (note) {
        onCreated(note);
        onClose();
      } else {
        // 입력은 그대로 두고 다이얼로그를 유지한다 — 다시 저장을 누르면 된다.
        setFailed(true);
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

        {failed ? <NoteSaveFailed /> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={readOnly || busy || !body.trim()}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
