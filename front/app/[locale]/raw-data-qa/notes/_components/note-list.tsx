"use client";

import { useRef, useState } from "react";
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

// 판정 저장(lib/qa/review-session.ts)과 같은 15초 상한.
const REQUEST_TIMEOUT_MS = 15_000;

export type ResolvedState = Pick<NoteListRow, "resolvedAt" | "resolvedBy">;

/**
 * PATCH /api/qa/note {id, resolved} (경로·본문 그대로) → 서버가 기록한 resolvedAt·resolvedBy.
 * HTTP 오류·네트워크 오류·15초 타임아웃·형식 오류는 던지지 않고 null 이다(자동 재시도 없음).
 */
export async function patchNoteResolved(
  id: string,
  resolved: boolean,
  fetcher: typeof fetch = fetch,
): Promise<ResolvedState | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetcher("/api/qa/note", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, resolved }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { note?: { resolvedAt?: unknown; resolvedBy?: unknown } } | null;
    const note = data?.note;
    if (!note) return null;
    return {
      resolvedAt: typeof note.resolvedAt === "string" ? note.resolvedAt : null,
      resolvedBy: typeof note.resolvedBy === "string" ? note.resolvedBy : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** 해결 토글 응답을 한 행에만 반영한다(시각·처리자는 서버 값 — 클라이언트 시각으로 덮지 않는다). */
export function applyResolved(rows: NoteListRow[], id: string, next: ResolvedState): NoteListRow[] {
  return rows.map((r) => (r.id === id ? { ...r, ...next } : r));
}

/** Content-Disposition 의 파일명(RFC 5987 filename* 우선). 없으면 null. */
function dispositionFilename(value: string | null): string | null {
  if (!value) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(value);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // 일반 filename 으로 넘어간다
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(value);
  return plain ? plain[1].trim() : null;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * CSV 내보내기. 응답이 성공일 때만 파일로 저장한다(바이트·파일명은 서버 응답 그대로) — 링크 다운로드는
 * 401·5xx 의 오류 본문(JSON)까지 CSV 파일로 받았다. 실패(HTTP 오류·네트워크)는 false.
 */
export async function downloadNotesCsv(
  href: string,
  fetcher: typeof fetch = fetch,
  save: (blob: Blob, filename: string) => void = saveBlob,
): Promise<boolean> {
  try {
    const res = await fetcher(href);
    if (!res.ok) return false;
    const blob = await res.blob();
    const filename =
      dispositionFilename(res.headers.get("content-disposition")) ??
      `qa-notes-${new Date().toISOString().slice(0, 10)}.csv`;
    save(blob, filename);
    return true;
  } catch {
    return false;
  }
}

/** 노트 화면 실패 고지 — 검수 상세 저장 실패 배너(detail-shell)와 같은 모양, 기존 문구만 쓴다. */
export function NoteListFailure({ kind }: { kind: "save" | "export" }) {
  const t = useTranslations("qaReview");
  const tExport = useTranslations("adminStandardPrompts.list");
  return (
    <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {kind === "save" ? t("detail.saveFailed") : tExport("exportFailed")}
    </p>
  );
}

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
  // 행 단위 진행 중. ref 는 다음 렌더 전의 연타까지 막는 동기 가드다(판정 저장 review-session 과 같은 이유).
  const pendingRef = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const exportingRef = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [failure, setFailure] = useState<"save" | "export" | null>(null);

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

  function markPending(id: string, on: boolean) {
    if (on) pendingRef.current.add(id);
    else pendingRef.current.delete(id);
    setPending(new Set(pendingRef.current));
  }

  async function toggleResolved(row: NoteListRow) {
    if (pendingRef.current.has(row.id)) return;
    markPending(row.id, true);
    setFailure(null);
    const next = await patchNoteResolved(row.id, !row.resolvedAt);
    markPending(row.id, false);
    if (!next) {
      setFailure("save");
      return;
    }
    setLive((prev) => applyResolved(prev, row.id, next));
  }

  const qs = qaFilterToQuery(filter).toString();
  const exportHref = `/api/qa/notes/export${qs ? `?${qs}` : ""}`;

  async function exportCsv() {
    if (exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    setFailure(null);
    const ok = await downloadNotesCsv(exportHref);
    exportingRef.current = false;
    setExporting(false);
    if (!ok) setFailure("export");
  }

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
          {/* 링크 다운로드는 401·5xx 의 오류 본문까지 파일로 받아 실패가 보이지 않았다. 응답을 확인하고
              성공일 때만 저장한다(상한 10,000행이라 blob 으로 받아도 된다, 바이트는 서버 그대로). */}
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={exporting}>
            <Download className="size-3.5" />
            {t("notes.exportCsv")}
          </Button>
        </div>
      </div>

      {failure ? <NoteListFailure kind={failure} /> : null}

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
                  disabled={pending.has(n.id)}
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
