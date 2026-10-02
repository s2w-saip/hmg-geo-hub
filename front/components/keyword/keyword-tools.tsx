"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Download, Loader2, Search, Sparkles } from "lucide-react";
import {
  PRESETS_BY_REGION,
  getPresetById,
  DEFAULT_PRESET_ID,
  type LocationLanguagePreset,
} from "@/lib/keyword/location-presets";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

// ── Wire types (mirror the /api/keyword/* JSON, kept local so this client
// component never imports the server-only lib/keyword/* modules) ──────────────

type MonthlySearch = { year: number; month: number; search_volume: number };

type VolumeRow = {
  keyword: string;
  search_volume: number;
  // null on the api source when DataForSEO gave no level (U11-N4)
  competition: string | null;
  competition_index: number;
  cpc: number;
  monthly_searches: MonthlySearch[];
};

type VolumeSummary = {
  totalKeywords: number;
  averageSearchVolume: number;
  totalSearchVolume: number;
  highVolumeCount: number;
  mediumVolumeCount: number;
  lowVolumeCount: number;
};

type SearchIntent =
  | "informational"
  | "navigational"
  | "transactional"
  | "commercial";

type PromptRow = {
  originalInput: string;
  question: string;
  searchIntent: SearchIntent;
  volume: number | null;
};

function parseKeywords(input: string): string[] {
  return input
    .split("\n")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

function csvCell(value: string | number): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const lines = [headers, ...rows].map((r) => r.map(csvCell).join(","));
  // BOM so Excel reads UTF-8 (Korean) correctly.
  const blob = new Blob(["﻿" + lines.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Shared location picker ────────────────────────────────────────────────────

function LocationPicker({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string;
  onChange: (id: string) => void;
  label: string;
  placeholder: string;
}) {
  const locale = useLocale();
  const presetLabel = (p: LocationLanguagePreset) =>
    locale === "ko" ? p.name : p.nameEn;
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent className="max-h-[360px]">
          {Object.entries(PRESETS_BY_REGION).map(([region, presets]) => (
            <SelectGroup key={region}>
              <SelectLabel>{region}</SelectLabel>
              {presets.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <span className="mr-1.5">{p.flag}</span>
                  {presetLabel(p)}
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {p.language_code}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ── Tab 1: keyword → search volume ───────────────────────────────────────────

function VolumeTab() {
  const t = useTranslations("keywordTools");
  const [presetId, setPresetId] = useState(DEFAULT_PRESET_ID);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState<VolumeRow[]>([]);
  const [summary, setSummary] = useState<VolumeSummary | null>(null);
  // api source (U11-N4): terms the backend is still collecting after the route's bounded wait.
  const [pendingTerms, setPendingTerms] = useState<string[]>([]);

  const count = useMemo(() => parseKeywords(input).length, [input]);

  const run = async () => {
    setError("");
    const keywords = parseKeywords(input);
    if (keywords.length === 0) {
      setError(t("errorNoKeywords"));
      return;
    }
    const preset = getPresetById(presetId);
    setLoading(true);
    setRows([]);
    setSummary(null);
    setPendingTerms([]);
    try {
      const res = await fetch("/api/keyword/volume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keywords,
          locationCode: preset?.location_code,
          languageCode: preset?.language_code,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || data.details || "request failed");
      }
      setRows(data.keywords ?? []);
      setSummary(data.summary ?? null);
      setPendingTerms(Array.isArray(data.pending) ? data.pending : []);
    } catch {
      setError(t("errorGeneric"));
    } finally {
      setLoading(false);
    }
  };

  const exportCsv = () => {
    downloadCsv(
      `keyword-volume-${presetId}.csv`,
      [
        t("volumeCols.keyword"),
        t("volumeCols.volume"),
        t("volumeCols.competition"),
        t("volumeCols.cpc"),
      ],
      rows.map((r) => [
        r.keyword,
        r.search_volume ?? 0,
        r.competition ?? "",
        r.cpc ?? 0,
      ]),
    );
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-[1fr_240px]">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="vol-kw">{t("keywords")}</Label>
            <span className="text-xs text-muted-foreground">
              {t("keywordCount", { count })}
            </span>
          </div>
          <Textarea
            id="vol-kw"
            rows={8}
            className="font-mono text-sm"
            placeholder={t("keywordsPlaceholder")}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <LocationPicker
          value={presetId}
          onChange={setPresetId}
          label={t("location")}
          placeholder={t("locationPlaceholder")}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={run} disabled={loading || count === 0}>
          {loading ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Search />
          )}
          {loading ? t("running") : t("run")}
        </Button>
        {rows.length > 0 ? (
          <Button variant="outline" onClick={exportCsv}>
            <Download />
            {t("exportCsv")}
          </Button>
        ) : null}
        {error ? (
          <span className="text-sm text-destructive">{error}</span>
        ) : null}
      </div>

      {pendingTerms.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("pendingCollection", { count: pendingTerms.length, terms: pendingTerms.slice(0, 5).join(", ") })}
        </p>
      ) : null}

      {summary ? (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          <SummaryCard label={t("summary.total")} value={summary.totalKeywords} />
          <SummaryCard
            label={t("summary.avg")}
            value={summary.averageSearchVolume}
          />
          <SummaryCard
            label={t("summary.totalVolume")}
            value={summary.totalSearchVolume}
          />
          <SummaryCard label={t("summary.high")} value={summary.highVolumeCount} />
          <SummaryCard label={t("summary.mid")} value={summary.mediumVolumeCount} />
          <SummaryCard label={t("summary.low")} value={summary.lowVolumeCount} />
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("volumeCols.keyword")}</TableHead>
                <TableHead className="text-right">{t("volumeCols.volume")}</TableHead>
                <TableHead>{t("volumeCols.competition")}</TableHead>
                <TableHead className="text-right">{t("volumeCols.cpc")}</TableHead>
                <TableHead>{t("volumeCols.trend")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.keyword}>
                  <TableCell className="font-medium">{r.keyword}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {(r.search_volume ?? 0).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.competition ?? "-"}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {(r.cpc ?? 0).toFixed(2)}
                  </TableCell>
                  <TableCell>
                    <TrendBars monthly={r.monthly_searches ?? []} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}

// ── Tab 2: keyword → prompt ──────────────────────────────────────────────────

function ToPromptTab() {
  const t = useTranslations("keywordTools");
  const [presetId, setPresetId] = useState(DEFAULT_PRESET_ID);
  const [input, setInput] = useState("");
  const [includeVolume, setIncludeVolume] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState<PromptRow[]>([]);

  const count = useMemo(() => parseKeywords(input).length, [input]);

  const run = async () => {
    setError("");
    const keywords = parseKeywords(input);
    if (keywords.length === 0) {
      setError(t("errorNoKeywords"));
      return;
    }
    const preset = getPresetById(presetId);
    setLoading(true);
    setRows([]);
    try {
      // Optional: fetch volumes first so prompts carry search volume.
      let keywordVolumeMap: Record<string, number> | undefined;
      if (includeVolume) {
        const volRes = await fetch("/api/keyword/volume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            keywords,
            locationCode: preset?.location_code,
            languageCode: preset?.language_code,
          }),
        });
        const volData = await volRes.json();
        if (volRes.ok && volData.success) {
          keywordVolumeMap = {};
          for (const v of volData.keywords as VolumeRow[]) {
            keywordVolumeMap[v.keyword] = v.search_volume ?? 0;
          }
        }
      }

      const res = await fetch("/api/keyword/to-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords, keywordVolumeMap, maxQuestions: 200 }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || data.details || "request failed");
      }
      const result: PromptRow[] = data.data?.questions ?? [];
      result.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
      setRows(result);
    } catch {
      setError(t("errorGeneric"));
    } finally {
      setLoading(false);
    }
  };

  const exportCsv = () => {
    downloadCsv(
      "keyword-to-prompt.csv",
      [
        t("promptCols.prompt"),
        t("promptCols.intent"),
        t("promptCols.keyword"),
        t("promptCols.volume"),
      ],
      rows.map((r) => [
        r.question,
        t(`intent.${r.searchIntent}`),
        r.originalInput,
        r.volume ?? 0,
      ]),
    );
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-[1fr_240px]">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="k2p-kw">{t("keywords")}</Label>
            <span className="text-xs text-muted-foreground">
              {t("keywordCount", { count })}
            </span>
          </div>
          <Textarea
            id="k2p-kw"
            rows={8}
            className="font-mono text-sm"
            placeholder={t("keywordsPlaceholder")}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <div className="space-y-4">
          <LocationPicker
            value={presetId}
            onChange={setPresetId}
            label={t("location")}
            placeholder={t("locationPlaceholder")}
          />
          <label className="flex items-center gap-2 text-sm text-foreground/80">
            <Checkbox
              checked={includeVolume}
              onCheckedChange={(c) => setIncludeVolume(c === true)}
            />
            {t("includeVolume")}
          </label>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={run} disabled={loading || count === 0}>
          {loading ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {loading ? t("running") : t("generate")}
        </Button>
        {rows.length > 0 ? (
          <>
            <Button variant="outline" onClick={exportCsv}>
              <Download />
              {t("exportCsv")}
            </Button>
            <span className="text-sm text-muted-foreground">
              {t("resultsCount", { count: rows.length })}
            </span>
          </>
        ) : null}
        {error ? (
          <span className="text-sm text-destructive">{error}</span>
        ) : null}
      </div>

      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-1/2">{t("promptCols.prompt")}</TableHead>
                <TableHead>{t("promptCols.intent")}</TableHead>
                <TableHead>{t("promptCols.keyword")}</TableHead>
                <TableHead className="text-right">{t("promptCols.volume")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={`${r.originalInput}-${i}`}>
                  <TableCell className="font-medium">{r.question}</TableCell>
                  <TableCell>
                    <IntentBadge intent={r.searchIntent} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.originalInput}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.volume != null ? r.volume.toLocaleString() : "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}

// ── Small presentational helpers ─────────────────────────────────────────────

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="font-head text-lg font-semibold tabular-nums">
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function TrendBars({ monthly }: { monthly: MonthlySearch[] }) {
  const recent = [...monthly]
    .sort((a, b) => a.year * 100 + a.month - (b.year * 100 + b.month))
    .slice(-6);
  if (recent.length === 0) return <span className="text-muted-foreground">-</span>;
  const max = Math.max(...recent.map((m) => m.search_volume), 1);
  return (
    <div className="flex h-7 items-end gap-0.5">
      {recent.map((m) => (
        <div
          key={`${m.year}-${m.month}`}
          className="w-1.5 rounded-sm bg-brand-700/70"
          style={{ height: `${Math.max(8, (m.search_volume / max) * 100)}%` }}
          title={`${m.year}-${String(m.month).padStart(2, "0")}: ${m.search_volume.toLocaleString()}`}
        />
      ))}
    </div>
  );
}

function IntentBadge({ intent }: { intent: SearchIntent }) {
  const t = useTranslations("keywordTools");
  const tone: Record<SearchIntent, string> = {
    informational: "border-sky-300 text-sky-700 dark:text-sky-300",
    navigational: "border-violet-300 text-violet-700 dark:text-violet-300",
    transactional: "border-emerald-300 text-emerald-700 dark:text-emerald-300",
    commercial: "border-amber-300 text-amber-700 dark:text-amber-300",
  };
  return (
    <Badge variant="outline" className={cn(tone[intent])}>
      {t(`intent.${intent}`)}
    </Badge>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────

export function KeywordTools() {
  const t = useTranslations("keywordTools");
  return (
    <Tabs defaultValue="volume" className="w-full">
      <TabsList>
        <TabsTrigger value="volume">{t("tabs.volume")}</TabsTrigger>
        <TabsTrigger value="toPrompt">{t("tabs.toPrompt")}</TabsTrigger>
      </TabsList>
      <TabsContent value="volume" className="pt-4">
        <VolumeTab />
      </TabsContent>
      <TabsContent value="toPrompt" className="pt-4">
        <ToPromptTab />
      </TabsContent>
    </Tabs>
  );
}
