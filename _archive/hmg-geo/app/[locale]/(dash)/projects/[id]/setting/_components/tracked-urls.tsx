"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  addProjectTrackedUrlAction,
  removeProjectTrackedUrlAction,
} from "../_actions";
import { TrackedUrlIO } from "./tracked-url-io";

// 프로젝트별 추적 URL — KPI ⑥ AI 타겟 URL 인용률의 분자. URL은 정확한 경로
// 그대로 저장. label은 사용자 메모 (선택). 측정 wiring(KPI 활성)은 별도 작업.

export type TrackedUrlRow = {
  id: string;
  url: string;
  label: string | null;
};

export function TrackedUrlsPanel({
  projectId,
  rows,
  ownedBaseCount,
  disabled,
}: {
  projectId: string;
  rows: TrackedUrlRow[];
  ownedBaseCount: number;
  disabled?: boolean;
}) {
  const t = useTranslations("projectDetail.setting.trackedUrls");
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    startTransition(async () => {
      const r = await addProjectTrackedUrlAction(projectId, {
        url,
        label: label || null,
      });
      if (r.ok) {
        toast.success(t("added"));
        setUrl("");
        setLabel("");
      } else {
        toast.error(r.error);
      }
    });
  }

  function remove(id: string) {
    startTransition(async () => {
      const r = await removeProjectTrackedUrlAction(projectId, id);
      if (r.ok) toast.success(t("removed"));
      else toast.error(r.error);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-[12.5px] text-muted-foreground">{t("hint")}</p>
          {ownedBaseCount >= 2 ? (
            <p className="text-[12.5px] text-amber-700">{t("multiBaseHint")}</p>
          ) : ownedBaseCount === 0 ? (
            <p className="text-[12.5px] text-muted-foreground">{t("noOwnedBaseHint")}</p>
          ) : null}
        </div>
        <TrackedUrlIO projectId={projectId} canImport={!disabled} />
      </div>

      {disabled ? null : (
        <form
          onSubmit={submit}
          className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3 sm:flex-row sm:items-end"
        >
          <div className="flex grow flex-col gap-1.5">
            <Label htmlFor="tracked-url" className="text-[11px]">
              {t("urlLabel")}
            </Label>
            <Input
              id="tracked-url"
              type="url"
              placeholder={t("urlPlaceholder")}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </div>
          <div className="flex w-full flex-col gap-1.5 sm:w-48">
            <Label htmlFor="tracked-url-label" className="text-[11px]">
              {t("memoLabel")}
            </Label>
            <Input
              id="tracked-url-label"
              type="text"
              placeholder={t("memoPlaceholder")}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={pending}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t("add")}
          </Button>
        </form>
      )}

      {rows.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2"
            >
              <div className="flex min-w-0 flex-col">
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-xs font-medium text-foreground hover:underline"
                >
                  {r.url}
                </a>
                {r.label ? (
                  <span className="text-[11px] text-muted-foreground">
                    {r.label}
                  </span>
                ) : null}
              </div>
              {disabled ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => remove(r.id)}
                  disabled={pending}
                  aria-label={t("remove")}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
