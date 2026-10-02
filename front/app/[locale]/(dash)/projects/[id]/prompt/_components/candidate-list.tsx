"use client";

import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deleteCandidate,
  deleteCandidates,
  selectFromCandidates,
} from "../_actions";

export type CandidateRow = {
  id: string;
  source: "google_keyword" | "social_scraping" | "manual";
  sourceKeyword: string | null;
  text: string;
  createdAt: string;
};

// 정렬 옵션 — 최신순(기본) / 오래된순 / 가나다 / 출처.
const SORT_KEYS = ["newest", "oldest", "text", "source"] as const;
type SortKey = (typeof SORT_KEYS)[number];

// 후보 풀 — Intent (Google Keyword + Social Scraping) 결과가 누적된 곳.
// 체크박스 다중 선택 후 "선정"을 누르면 prompts 테이블로 사본이 만들어진다
// (v22 §3-2 A-④ "원본은 후보 풀에 유지").
export function CandidateList({
  projectId,
  candidates,
  canEdit,
}: {
  projectId: string;
  candidates: CandidateRow[];
  canEdit: boolean;
}) {
  const t = useTranslations("projectDetail.prompt.candidates");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortKey>("newest");
  const [pending, startTransition] = useTransition();

  const sorted = useMemo(() => {
    const rows = [...candidates];
    rows.sort((a, b) => {
      switch (sort) {
        case "oldest":
          return a.createdAt.localeCompare(b.createdAt);
        case "text":
          return a.text.localeCompare(b.text);
        case "source":
          return a.source.localeCompare(b.source);
        case "newest":
        default:
          return b.createdAt.localeCompare(a.createdAt);
      }
    });
    return rows;
  }, [candidates, sort]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function onApply() {
    if (selected.size === 0) return;
    startTransition(async () => {
      const r = await selectFromCandidates(projectId, Array.from(selected));
      if (r.ok) {
        toast.success(t("applySuccess", { count: r.value.created }));
        setSelected(new Set());
      } else {
        toast.error(r.error);
      }
    });
  }

  function onDelete(id: string) {
    startTransition(async () => {
      const r = await deleteCandidate(projectId, id);
      if (r.ok) {
        toast.success(t("deleteSuccess"));
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      } else {
        toast.error(r.error);
      }
    });
  }

  function onDeleteSelected() {
    if (selected.size === 0) return;
    startTransition(async () => {
      const r = await deleteCandidates(projectId, Array.from(selected));
      if (r.ok) {
        toast.success(t("deleteSelectedSuccess", { count: r.value.count }));
        setSelected(new Set());
      } else {
        toast.error(r.error);
      }
    });
  }

  if (candidates.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        {t("empty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="font-normal">
            {t("selectedCount", { count: selected.size })}
          </Badge>
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger size="sm" className="min-w-[8rem]">
              <SelectValue placeholder={t("sort.label")} />
            </SelectTrigger>
            <SelectContent>
              {SORT_KEYS.map((k) => (
                <SelectItem key={k} value={k}>
                  {t(`sort.${k}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {canEdit ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="text-muted-foreground hover:text-destructive"
              disabled={pending || selected.size === 0}
              onClick={onDeleteSelected}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              {t("deleteSelected")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={pending || selected.size === 0}
              onClick={onApply}
            >
              <Plus className="h-4 w-4" aria-hidden />
              {t("apply")}
            </Button>
          </div>
        ) : null}
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-card">
        {sorted.map((c) => (
          <li key={c.id} className="flex items-start gap-3 px-4 py-3">
            {canEdit ? (
              <Checkbox
                checked={selected.has(c.id)}
                onCheckedChange={() => toggle(c.id)}
                aria-label={t("apply")}
                className="mt-1"
              />
            ) : null}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm text-foreground">{c.text}</span>
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                <span className="rounded bg-muted px-1.5 py-0.5">
                  {t(`source.${c.source}`)}
                </span>
                {c.sourceKeyword ? <span>· {c.sourceKeyword}</span> : null}
              </div>
            </div>
            {canEdit ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                disabled={pending}
                onClick={() => onDelete(c.id)}
                aria-label={t("delete")}
                title={t("delete")}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
