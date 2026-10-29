"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ListChecks, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  loadConversionEvents,
  saveConversionEvents,
} from "@/lib/ga4/tracked-events-actions";
import type { Ga4EventRow } from "@/lib/ga4/tracked-events-service";

// property별 GA4 이벤트 목록을 불러와 "전환으로 셀 이벤트"를 체크로 고르는 다이얼로그.
// 세 화면(admin 레지스트리 / project 전환 / website 전환)이 공유한다. 대상은 항상
// propertyId(=국가별 속성); project 맥락이면 projectId를 함께 넘겨 권한/IDOR을 서버가
// 프로젝트 기준으로 검증한다. canEdit=false면 조회 전용(저장 버튼 숨김).
export function Ga4EventsDialog({
  propertyId,
  projectId,
  title,
  canEdit = true,
}: {
  propertyId: string;
  projectId?: string;
  title: string;
  canEdit?: boolean;
}) {
  const t = useTranslations("adminGa4.events");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Ga4EventRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, startSaving] = useTransition();

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) void load();
  }

  async function load() {
    setLoading(true);
    setError(null);
    const r = await loadConversionEvents(propertyId, projectId);
    setLoading(false);
    if (!r.ok) {
      setError(r.error);
      setRows([]);
      setSelected(new Set());
      return;
    }
    setRows(r.value);
    setSelected(new Set(r.value.filter((e) => e.tracked).map((e) => e.eventName)));
  }

  function toggle(name: string) {
    if (!canEdit) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function onSave() {
    startSaving(async () => {
      const r = await saveConversionEvents(propertyId, [...selected], projectId);
      if (r.ok) {
        toast.success(t("saved"));
        setOpen(false);
      } else {
        toast.error(r.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 text-xs"
        onClick={() => onOpenChange(true)}
      >
        <ListChecks className="h-3.5 w-3.5" aria-hidden />
        {t("button")}
      </Button>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title", { target: title })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t("loading")}
          </div>
        ) : error ? (
          <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-destructive">
            {error}
          </p>
        ) : rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            {t("empty")}
          </p>
        ) : (
          <div className="flex max-h-80 flex-col overflow-y-auto rounded-md border border-border">
            <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
              <span>{t("colEvent")}</span>
              <span>{t("colVolume")}</span>
            </div>
            {rows.map((e) => (
              <label
                key={e.eventName}
                className={`flex items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-0 ${
                  canEdit ? "cursor-pointer hover:bg-muted/30" : "cursor-default"
                }`}
              >
                <Checkbox
                  checked={selected.has(e.eventName)}
                  disabled={!canEdit}
                  onCheckedChange={() => toggle(e.eventName)}
                />
                <span className="flex-1 font-mono text-xs text-foreground">
                  {e.eventName}
                </span>
                <span className="tabular-nums text-xs text-muted-foreground">
                  {e.count.toLocaleString()}
                </span>
              </label>
            ))}
          </div>
        )}

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-[11px] text-muted-foreground">
            {selected.size > 0
              ? t("selectedCount", { count: selected.size })
              : t("fallbackHint")}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => setOpen(false)}
            >
              {canEdit ? t("cancel") : t("close")}
            </Button>
            {canEdit ? (
              <Button
                type="button"
                size="sm"
                disabled={saving || loading || error !== null}
                onClick={onSave}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                {t("save")}
              </Button>
            ) : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
