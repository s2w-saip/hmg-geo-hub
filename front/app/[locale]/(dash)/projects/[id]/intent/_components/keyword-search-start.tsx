"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertCircle, Check, Loader2, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { type SearchIntent } from "../_data/sample";
import { addTrackedKeywords } from "../_actions";

const INTENT_TONE: Record<SearchIntent, string> = {
  transactional: "bg-emerald-50 text-emerald-700",
  commercial: "bg-amber-50 text-amber-700",
  informational: "bg-blue-50 text-blue-700",
  navigational: "bg-purple-50 text-purple-700",
};

type RelatedItem = { id: string; term: string; volume: number; intent: SearchIntent };
type SearchGroup = {
  term: string;
  volume: number;
  intent: SearchIntent;
  foundCount: number;
  related: RelatedItem[];
};
type Status = "idle" | "loading" | "ready" | "error";

/**
 * Runs a keyword write with its busy flag and clears the flag even when the server action throws
 * (401 / 403 / 404 -> UnauthorizedError): without it the button stayed disabled for good. The
 * error still propagates as before (no new message here).
 */
export async function withBusy<T>(setBusy: (busy: boolean) => void, write: () => Promise<T>): Promise<T> {
  setBusy(true);
  try {
    return await write();
  } finally {
    setBusy(false);
  }
}

/**
 * Saves several keywords as tabs in ONE server action (B065; the API source sends one request per
 * 100 rows) instead of one action per keyword. Each row is handled as before: a saved row becomes a
 * tab (input order), a refused row reports its own error text (same messages, same order). A throw
 * (401 / 403 / 404 -> UnauthorizedError) propagates as before.
 */
export async function saveTrackedTerms(
  projectId: string,
  terms: readonly string[],
  country: string,
  onRowError: (message: string) => void,
): Promise<{ id: string; label: string }[]> {
  const results = await addTrackedKeywords(projectId, terms.map((term) => ({ term, country })));
  const out: { id: string; label: string }[] = [];
  results.forEach((res, i) => {
    if (res.ok) out.push({ id: res.value.id, label: terms[i] });
    else onRowError(res.error);
  });
  return out;
}

// Empty-state Google Keyword search — shown instead of the full trend/SERP
// dashboard when the project has no tracked keywords yet (a fresh project has
// no keyword to build tabs/charts around). Comma-separated input searches
// several keywords at once; each result shows its own volume/intent plus its
// related keywords nested underneath, all multi-selectable for one bulk save.
// Saving at least one keyword hands the new tabs back to GoogleKeywordView,
// which then renders the normal dashboard.
export function KeywordSearchStart({
  projectId,
  canEdit,
  country,
  onSaved,
}: {
  projectId: string;
  canEdit: boolean;
  country: string;
  onSaved: (created: { id: string; label: string }[]) => void;
}) {
  const t = useTranslations("projectDetail.intent.googleKeyword");
  const [inputValue, setInputValue] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);

  async function onSearch() {
    const terms = [...new Set(inputValue.split(",").map((s) => s.trim()).filter(Boolean))];
    if (terms.length === 0) return;
    setStatus("loading");
    try {
      const res = await fetch("/api/keyword/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // projectId (C1, unit U10): the API source gates and collects per project.
        body: JSON.stringify({ keywords: terms, country, projectId: projectId || undefined }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "failed");
      setGroups(json.groups as SearchGroup[]);
      setChecked(new Set());
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }

  function toggle(term: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(term)) next.delete(term);
      else next.add(term);
      return next;
    });
  }

  async function onSaveSelected() {
    const terms = [...checked];
    if (terms.length === 0) return;
    const created = await withBusy(setSaving, () => saveTrackedTerms(projectId, terms, country, (e) => toast.error(e)));
    if (created.length > 0) {
      toast.success(t("keywordAdded"));
      onSaved(created);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">
          {t("emptyState.title")}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("emptyState.description")}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void onSearch();
              }
            }}
            placeholder={t("emptyState.placeholder")}
            disabled={status === "loading"}
            className="flex-1"
          />
          <Button
            type="button"
            onClick={() => void onSearch()}
            disabled={status === "loading" || !inputValue.trim()}
          >
            <Search className="h-4 w-4" aria-hidden />
            {t("emptyState.searchButton")}
          </Button>
        </div>
      </div>

      {status === "loading" ? (
        <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-border bg-card py-12 text-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
          <span className="text-xs text-muted-foreground">{t("loading")}</span>
        </div>
      ) : status === "error" ? (
        <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-border bg-card py-12 text-center">
          <AlertCircle className="h-5 w-5 text-destructive" aria-hidden />
          <span className="text-xs text-muted-foreground">{t("loadError")}</span>
          <Button variant="outline" size="sm" onClick={() => void onSearch()}>
            {t("retry")}
          </Button>
        </div>
      ) : status === "ready" && groups.length === 0 ? (
        <div className="flex min-h-32 items-center justify-center rounded-lg border border-border bg-card py-12 text-center text-xs text-muted-foreground">
          {t("emptyState.noResults")}
        </div>
      ) : status === "ready" ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {t("related.selected", { count: checked.size })}
            </span>
            {canEdit && checked.size > 0 && (
              <Button type="button" size="sm" disabled={saving} onClick={() => void onSaveSelected()}>
                <Plus className="h-3.5 w-3.5" aria-hidden />
                {t("related.addSelected")}
              </Button>
            )}
          </div>
          {groups.map((group) => (
            <div key={group.term} className="overflow-hidden rounded-lg border border-border bg-card">
              <KeywordRow
                term={group.term}
                volume={group.volume}
                intent={group.intent}
                canEdit={canEdit}
                checked={checked.has(group.term)}
                onToggle={() => toggle(group.term)}
                emphasized
              />
              {group.related.length > 0 && (
                <div className="border-t border-border bg-muted/20 pl-6">
                  <p className="px-3 pt-2 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                    {t("emptyState.relatedLabel")}
                  </p>
                  {group.related.map((r) => (
                    <KeywordRow
                      key={r.id}
                      term={r.term}
                      volume={r.volume}
                      intent={r.intent}
                      canEdit={canEdit}
                      checked={checked.has(r.term)}
                      onToggle={() => toggle(r.term)}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function KeywordRow({
  term,
  volume,
  intent,
  canEdit,
  checked,
  onToggle,
  emphasized,
}: {
  term: string;
  volume: number;
  intent: SearchIntent;
  canEdit: boolean;
  checked: boolean;
  onToggle: () => void;
  emphasized?: boolean;
}) {
  const t = useTranslations("projectDetail.intent.googleKeyword");
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      {canEdit ? (
        <Checkbox checked={checked} onCheckedChange={onToggle} aria-label={term} />
      ) : (
        <span className="h-4 w-4" />
      )}
      <span
        className={cn(
          "flex-1 truncate",
          emphasized ? "text-sm font-semibold text-foreground" : "text-sm text-foreground",
        )}
      >
        {term}
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {t("related.colVolume")} {volume.toLocaleString()}
      </span>
      <span
        className={cn(
          "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
          INTENT_TONE[intent],
        )}
      >
        {t(`intent.${intent}`)}
      </span>
      {checked && (
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden />
      )}
    </div>
  );
}
