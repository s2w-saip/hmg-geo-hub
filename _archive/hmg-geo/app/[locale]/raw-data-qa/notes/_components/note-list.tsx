"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Check, Download, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  QA_SEVERITIES,
  QA_TARGET_KINDS,
  qaFilterToQuery,
  type QaNoteFilter,
  type QaSeverity,
  type QaSurface,
  type QaTargetKind,
} from "@/lib/qa/filters";
import { cn } from "@/lib/utils";
import { SurfaceBadge } from "../../_components/qa-badges";

export type NoteListRow = {
  id: string;
  jobId: string;
  targetKind: QaTargetKind;
  targetLabel: string | null;
  severity: QaSeverity;
  body: string;
  reviewerName: string;
  createdAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  promptText: string | null;
  surface: QaSurface;
};

export function NoteList({
  rows,
  nextCursor,
  locale,
  filter,
}: {
  rows: NoteListRow[];
  nextCursor: string | null;
  locale: string;
  filter: QaNoteFilter;
}) {
  const t = useTranslations("qaReview");
  const router = useRouter();
  const [live, setLive] = useState(rows);

  const kindLabel: Record<QaTargetKind, string> = {
    answer: t("notes.targetAnswer"),
    prompt: t("notes.targetPrompt"),
    mention: t("notes.targetMention"),
    citation: t("notes.targetCitation"),
    acr: t("notes.targetAcr"),
    meta: t("notes.targetMeta"),
  };
  const severityLabel: Record<QaSeverity, string> = {
    issue: t("notes.severityIssue"),
    question: t("notes.severityQuestion"),
    info: t("notes.severityInfo"),
  };

  function apply(next: QaNoteFilter) {
    const qs = qaFilterToQuery(next).toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }

  function toggleIn<K extends "targetKind" | "severity">(key: K, value: string) {
    const cur = (filter[key] as string[] | undefined) ?? [];
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
    apply({ ...filter, [key]: next.length ? next : undefined } as QaNoteFilter);
  }

  async function toggleResolved(row: NoteListRow) {
    const resolved = !row.resolvedAt;
    const res = await fetch("/api/qa/note", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: row.id, resolved }),
    });
    if (!res.ok) return;
    setLive((prev) =>
      prev.map((r) =>
        r.id === row.id ? { ...r, resolvedAt: resolved ? new Date().toISOString() : null } : r,
      ),
    );
  }

  const qs = qaFilterToQuery(filter).toString();
  const exportHref = `/api/qa/notes/export${qs ? `?${qs}` : ""}`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
        <span className="text-xs text-muted-foreground">{t("notes.filterTargetKind")}</span>
        {QA_TARGET_KINDS.map((k) => (
          <Chip
            key={k}
            on={(filter.targetKind ?? []).includes(k)}
            label={kindLabel[k]}
            onClick={() => toggleIn("targetKind", k)}
          />
        ))}
        <span className="ml-3 text-xs text-muted-foreground">{t("notes.filterSeverity")}</span>
        {QA_SEVERITIES.map((s) => (
          <Chip
            key={s}
            on={(filter.severity ?? []).includes(s)}
            label={severityLabel[s]}
            onClick={() => toggleIn("severity", s)}
          />
        ))}
        <Chip
          on={filter.includeResolved === true}
          label={t("notes.filterIncludeResolved")}
          onClick={() =>
            apply({ ...filter, includeResolved: filter.includeResolved ? undefined : true })
          }
        />
        <div className="ml-auto flex items-center gap-2">
          {/* 다운로드는 링크로 — 클라이언트에서 blob 을 만들면 만 행짜리 CSV 가
              메모리에 올라간다. 서버가 스트림으로 준다. */}
          <Button variant="outline" size="sm" asChild>
            <a href={exportHref} download>
              <Download className="size-3.5" />
              {t("notes.exportCsv")}
            </a>
          </Button>
        </div>
      </div>

      {live.length === 0 ? (
        <p className="rounded-lg border border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          {t("notes.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {live.map((n) => (
            <li
              key={n.id}
              className={cn(
                "rounded-lg border border-border bg-card p-3",
                n.resolvedAt && "opacity-60",
              )}
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <SurfaceBadge surface={n.surface} />
                <Badge variant="outline" className="font-normal">
                  {kindLabel[n.targetKind]}
                </Badge>
                <Badge
                  variant={n.severity === "issue" ? "destructive" : "secondary"}
                  className="font-normal"
                >
                  {severityLabel[n.severity]}
                </Badge>
                {n.targetLabel ? (
                  <span className="text-foreground">{n.targetLabel}</span>
                ) : null}
                <span className="ml-auto tabular-nums">
                  {n.createdAt?.slice(0, 16).replace("T", " ")} · {n.reviewerName}
                </span>
              </div>

              <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{n.body}</p>

              <div className="mt-2 flex flex-wrap items-center gap-3">
                <Link
                  href={`/${locale}/raw-data-qa/answers/${n.jobId}${qs ? `?${qs}` : ""}`}
                  className="line-clamp-1 max-w-[48rem] text-xs text-brand-500 underline-offset-2 hover:underline"
                >
                  {n.promptText ?? n.jobId}
                </Link>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() => toggleResolved(n)}
                >
                  {n.resolvedAt ? (
                    <>
                      <RotateCcw className="size-3.5" />
                      {t("notes.unresolve")}
                    </>
                  ) : (
                    <>
                      <Check className="size-3.5" />
                      {t("notes.resolve")}
                    </>
                  )}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {nextCursor ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const sp = qaFilterToQuery(filter);
              sp.set("cursor", nextCursor);
              router.push(`?${sp.toString()}`, { scroll: false });
            }}
          >
            {t("common.more")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Chip({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs transition-colors",
        on
          ? "border-brand-700 bg-brand-700 text-white"
          : "border-border bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
