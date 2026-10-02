"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  CheckCircle2,
  Loader2,
  Search,
  Send,
  Sparkles,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { getExploringSteps, reduceExploring } from "./sample-data";
import type { ActivityLogEntry, ActivityLogKind, ExploringStep, WorkerStatus } from "./types";

const TICK_MS = 850;

const LOG_TONE: Record<ActivityLogKind, string> = {
  wave: "border-l-indigo-400 text-indigo-700",
  reasoning: "border-l-purple-400 text-purple-700",
  search: "border-l-blue-400 text-blue-700",
  discover: "border-l-emerald-400 text-emerald-700",
  worker: "border-l-teal-400 text-teal-700",
  confirmation: "border-l-amber-400 text-amber-700",
  complete: "border-l-emerald-500 text-emerald-700",
};

export function ExploringView({
  keyword,
  onComplete,
}: {
  keyword: string;
  onComplete: () => void;
}) {
  const t = useTranslations("socialScraping.exploring");
  const locale = useLocale();
  const exploringSteps = useMemo(() => getExploringSteps(locale), [locale]);
  const [stepIndex, setStepIndex] = useState(0);
  const [extraSteps, setExtraSteps] = useState<ExploringStep[]>([]);
  const [userEntries, setUserEntries] = useState<ActivityLogEntry[]>([]);
  const [message, setMessage] = useState("");

  const timeline = useMemo(() => [...exploringSteps, ...extraSteps], [exploringSteps, extraSteps]);
  const done = stepIndex >= timeline.length;

  const snapshot = useMemo(
    () => reduceExploring(timeline.slice(0, stepIndex)),
    [timeline, stepIndex],
  );

  // Drive the fake stream: reveal one step per tick until exhausted.
  useEffect(() => {
    if (done) return;
    const id = setInterval(() => setStepIndex((i) => i + 1), TICK_MS);
    return () => clearInterval(id);
  }, [done]);

  // Auto-scroll the activity log to the newest entry.
  const logRef = useRef<HTMLDivElement>(null);
  const log = useMemo(() => [...snapshot.log, ...userEntries], [snapshot.log, userEntries]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log.length]);

  const completedWorkers = snapshot.workers.filter((w) => w.status === "completed").length;

  function keepResearching() {
    const n = extraSteps.length;
    const wave = (snapshot.waves.at(-1)?.wave ?? 0) + 1;
    const more: ExploringStep[] = [
      { kind: "wave", wave, strategy: t("extraStrategy") },
      { kind: "dispatch", workerId: `x${n}a`, wave, label: t("extraLabelA"), query: t("extraQueryA") },
      { kind: "dispatch", workerId: `x${n}b`, wave, label: t("extraLabelB"), query: t("extraQueryB") },
      { kind: "sources", workerId: `x${n}a`, sourceCount: 9 },
      { kind: "sources", workerId: `x${n}b`, sourceCount: 7 },
      { kind: "complete", workerId: `x${n}a` },
      { kind: "complete", workerId: `x${n}b` },
      { kind: "log", logKind: "discover", title: t("extraDiscover") },
      { kind: "cost", cost: Number((snapshot.cost + 0.3).toFixed(2)), firecrawl: snapshot.firecrawl + 4 },
    ];
    setExtraSteps((prev) => [...prev, ...more]);
  }

  function sendMessage() {
    const msg = message.trim();
    if (!msg) return;
    setUserEntries((prev) => [
      ...prev,
      { id: `u-${prev.length}`, kind: "reasoning", title: t("you"), detail: msg },
    ]);
    setMessage("");
  }

  return (
    <div className="flex flex-col gap-4">
      {/* status overlay */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border bg-card px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          {done ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
          ) : (
            <Loader2 className="h-4 w-4 animate-spin text-brand-700" aria-hidden />
          )}
          {done ? t("doneTitle", { keyword }) : t("researching", { keyword })}
        </span>
        <Counter label={t("workers")} value={completedWorkers} />
        <Counter label={t("sources")} value={snapshot.sources} />
        <Counter label={t("firecrawl")} value={snapshot.firecrawl} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        {/* waves + workers */}
        <div className="flex flex-col gap-3">
          {snapshot.waves.map((w) => {
            const workers = snapshot.workers.filter((x) => x.wave === w.wave);
            return (
              <div key={w.wave} className="rounded-lg border border-border bg-card p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
                    {t("waveLabel", { wave: w.wave })}
                  </span>
                  <span className="text-xs text-muted-foreground">{w.strategy}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {workers.map((worker) => (
                    <WorkerChip key={worker.id} status={worker.status} label={worker.label} query={worker.query} sourceCount={worker.sourceCount} />
                  ))}
                </div>
              </div>
            );
          })}
          {snapshot.waves.length === 0 && (
            <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
              {t("starting")}
            </div>
          )}
        </div>

        {/* activity log */}
        <div className="flex max-h-[480px] min-h-[320px] flex-col overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border px-3 py-2 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            {t("activityLog")}
          </div>
          <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto p-2">
            <ul className="flex flex-col gap-1.5">
              {log.map((e) => (
                <li
                  key={e.id}
                  className={cn(
                    "animate-fade-in rounded-r border-l-2 bg-muted/30 px-2.5 py-1.5",
                    LOG_TONE[e.kind],
                  )}
                >
                  <p className="text-xs font-medium">{e.title}</p>
                  {e.detail && (
                    <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{e.detail}</p>
                  )}
                </li>
              ))}
              {!done && (
                <li className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  {t("thinking")}
                </li>
              )}
            </ul>
          </div>
        </div>
      </div>

      {/* confirmation banner */}
      {done && (
        <div className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-900">
              <Sparkles className="h-4 w-4" aria-hidden />
              {t("confirmTitle")}
            </p>
            <p className="mt-0.5 text-xs text-amber-800">
              {t("confirmDesc", {
                workers: completedWorkers,
                sources: snapshot.sources,
              })}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={keepResearching}>
              <Search className="h-3.5 w-3.5" aria-hidden />
              {t("keepResearching")}
            </Button>
            <Button size="sm" onClick={onComplete}>
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              {t("generate")}
            </Button>
          </div>
        </div>
      )}

      {/* user guidance input */}
      <div className="flex items-center gap-2">
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              sendMessage();
            }
          }}
          placeholder={t("guidePlaceholder")}
        />
        <Button variant="outline" size="sm" onClick={sendMessage} disabled={!message.trim()}>
          <Send className="h-3.5 w-3.5" aria-hidden />
          {t("send")}
        </Button>
      </div>
    </div>
  );
}

function Counter({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-foreground">{value}</span>
    </span>
  );
}

function WorkerChip({
  status,
  label,
  query,
  sourceCount,
}: {
  status: WorkerStatus;
  label: string;
  query: string;
  sourceCount: number;
}) {
  const ring =
    status === "searching"
      ? "border-dashed border-brand-700/60"
      : status === "analyzing"
        ? "border-cyan-400"
        : "border-emerald-500";
  return (
    <span
      title={query}
      className={cn(
        "flex max-w-[220px] items-center gap-1.5 rounded-full border-2 bg-card px-2.5 py-1 text-xs",
        ring,
      )}
    >
      {status === "searching" && <Search className="h-3 w-3 animate-pulse text-brand-700" aria-hidden />}
      {status === "analyzing" && <Zap className="h-3 w-3 text-cyan-600" aria-hidden />}
      {status === "completed" && <CheckCircle2 className="h-3 w-3 text-emerald-600" aria-hidden />}
      <span className="truncate font-medium text-foreground">{label}</span>
      {status !== "searching" && sourceCount > 0 && (
        <span className="shrink-0 tabular-nums text-muted-foreground">·{sourceCount}</span>
      )}
    </span>
  );
}
