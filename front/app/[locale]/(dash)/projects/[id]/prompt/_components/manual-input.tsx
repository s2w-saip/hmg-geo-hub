"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { addManualPrompt } from "../_actions";

// 수동 추가 입력 — 후보 풀 옆/아래에 위치. 다중 라인 textarea로 입력 후
// 추가하면 prompts 테이블에 candidateId=null로 행 생성.
export function ManualPromptInput({ projectId }: { projectId: string }) {
  const t = useTranslations("projectDetail.prompt.manual");
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const r = await addManualPrompt(projectId, trimmed);
      if (r.ok) {
        toast.success(
          r.value.count === 1
            ? t("success")
            : t("successCount", { count: r.value.count }),
        );
        setText("");
      } else {
        toast.error(r.error);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="manual-prompt">{t("label")}</Label>
        <Button type="submit" size="sm" disabled={pending || !text.trim()}>
          <Plus className="h-4 w-4" aria-hidden />
          {t("add")}
        </Button>
      </div>
      <textarea
        id="manual-prompt"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("placeholder")}
        className="rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        disabled={pending}
      />
    </form>
  );
}
