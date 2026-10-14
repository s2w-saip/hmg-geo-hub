"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import { MessageSquareText, Loader2, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSortableTable } from "@/hooks/use-sortable-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import { ColInfo } from "@/components/dash/col-info";
import { cn } from "@/lib/utils";
import type { MentionsPromptLive, CitationDomainLive } from "@/lib/scope/result-adapter";
import { AnswerModal } from "./answer-modal";
import { CitationDomainTable, TRUNCATED_ROW_CLASS, TruncatedNote } from "./citation-domain-table";
import { isTopRank, promptBestRank } from "../_data/prompt-rank";

// Per-brand drilldown rendered inline when a Brand row is clicked — LIVE only.
//   - "Prompts" tab: the prompts where this brand appeared (real: text,
//     mentions, share, funnel stage, AI providers). A prompt that carries a real
//     answer body opens the AnswerModal (chat-style transcript w/ highlights).
//   - "Citation Sources" tab: per-brand cited domains, lazy-loaded on open via
//     /api/scope/brand-citations — embeds the citation tab's domain table scoped
//     to this brand (row → URL list, 프롬프트 count → prompts → answer modal).
//
// Unit U6 (API source): on a project page both tabs carry ?projectId= (taken from the path, as
// the answer modal and the signal dialog do), so the project surface reads the project (the
// legacy citation tab read the standard root). An own row asks by "own" (+ its brand code on a
// split perspective, D13) instead of by name (BG-17). The legacy routes ignore both.
//
// B005: a route reply that is not 2xx (5xx, 403, 400) is the tab's existing error state, not "no
// prompts / no sources" (the signal dialog and the row detail already did this). B008: when the
// route cut a list it sends `total` (before the cap) and the table adds the existing
// "{total}개 중 {shown}개 표시" line; a list that fits renders exactly as before.

/** Project id of a /projects/<id>/... page, else null (same rule as answer-modal.tsx). */
export function projectIdFromPath(pathname: string | null | undefined): string | null {
  return /\/projects\/([^/]+)\//.exec(pathname ?? "")?.[1] ?? null;
}

/** The drilldown routes' surface and target parameters (appended to the screen's URL filters). */
export function drilldownParams(
  base: string,
  opts: { brand: string; own?: { code: string | null } | null; isWebsite: boolean; projectId: string | null },
): URLSearchParams {
  const params = new URLSearchParams(base);
  params.set("mentionBrand", opts.brand);
  if (opts.own) {
    params.set("own", "1");
    if (opts.own.code) params.set("ownCode", opts.own.code);
  }
  if (opts.projectId) params.set("projectId", opts.projectId);
  else if (opts.isWebsite) params.set("surface", "website");
  return params;
}

export function MentionsDrilldown({
  prompts: eagerPrompts,
  brand,
  own = null,
  isWebsite = false,
  lazyPrompts = false,
  showRank = false,
}: {
  // 프로젝트 경로에선 집계에 이미 실려온 prompts를 그대로 쓰고(eager), 표준/웹사이트
  // 경로에선 lazyPrompts=true로 클릭 시 fetch한다. 2026-07-08: 표준/웹사이트 mentions
  // 집계에서 perBrandPrompts(전 브랜드 드릴다운)가 12.4MB로 2MB 캐시 한도를 넘겨
  // 슬림화했기 때문 — 그 결과 eagerPrompts는 이 두 경로에서 항상 빈 배열이다.
  prompts: MentionsPromptLive[];
  brand: string;
  /** Own row target (unit U6): own rows drill by "own" (+ split brand code), not by name. */
  own?: { code: string | null } | null;
  isWebsite?: boolean;
  lazyPrompts?: boolean;
  /**
   * 순위 열 + "언급 TOP 3 이내" 배지(디자인 327:116 하단, 2026-09-02). 표준 공통
   * 하단만 켠다 — website/project mention 화면은 종전 마크업 그대로(스펙 회귀 기준).
   */
  showRank?: boolean;
}) {
  const t = useTranslations("answerAnalysis.mentions.drilldown");
  const projectId = projectIdFromPath(usePathname());
  const prompts = useBrandPrompts(brand, own, isWebsite, projectId, lazyPrompts, eagerPrompts);

  return (
    <div className="flex flex-col gap-3">
      <Tabs defaultValue="prompts">
        <TabsList>
          <TabsTrigger value="prompts">
            {t("tabs.prompts")}{" "}
            {prompts.status === "ready" ? (
              <span className="ml-1.5 text-[10px] text-muted-foreground">
                ({prompts.list.length})
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="citations">{t("tabs.citations")}</TabsTrigger>
        </TabsList>

        <TabsContent value="prompts">
          <BrandPromptsPanel state={prompts} brand={brand} showRank={showRank} />
        </TabsContent>

        <TabsContent value="citations">
          <BrandCitationsTab brand={brand} isWebsite={isWebsite} projectId={projectId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** A lazily loaded drilldown list; total = rows before the route's cap, only when it cut the list (B008). */
export type ListState<T> =
  | { status: "loading" }
  | { status: "ready"; list: T[]; total?: number }
  | { status: "error" };

type PromptsState = ListState<MentionsPromptLive>;

/**
 * One lazy drilldown list load (the effect body of useBrandPrompts and BrandCitationsTab): `key` is
 * the route's list field (prompts / domains). A reply that is not 2xx is the error state, never an
 * empty list (B005: the routes answer a backend failure with its status). Returns the cleanup (abort).
 */
export function startListLoad<T>(
  url: string,
  key: "prompts" | "domains",
  setState: (s: ListState<T>) => void,
  fetchImpl: typeof fetch = fetch,
): () => void {
  const ctrl = new AbortController();
  setState({ status: "loading" });
  fetchImpl(url, { signal: ctrl.signal })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
    .then((d: { prompts?: T[]; domains?: T[]; total?: number }) => {
      const list = d[key] ?? [];
      setState(typeof d.total === "number" ? { status: "ready", list, total: d.total } : { status: "ready", list });
    })
    .catch((e: unknown) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setState({ status: "error" });
    });
  return () => ctrl.abort();
}

// 프롬프트 목록 소스 — lazy면 /api/scope/brand-mention-prompts로 그 브랜드만 가져오고
// (BrandCitationsTab와 동일 lazy 패턴), 아니면 eager prop을 그대로 쓴다.
function useBrandPrompts(
  brand: string,
  own: { code: string | null } | null,
  isWebsite: boolean,
  projectId: string | null,
  lazy: boolean,
  eager: MentionsPromptLive[],
): PromptsState {
  const sp = useSearchParams();
  const spStr = sp.toString();
  const [state, setState] = useState<PromptsState>(
    lazy ? { status: "loading" } : { status: "ready", list: eager },
  );
  useEffect(() => {
    if (!lazy) {
      setState({ status: "ready", list: eager });
      return;
    }
    const params = drilldownParams(spStr, { brand, own, isWebsite, projectId });
    return startListLoad<MentionsPromptLive>(`/api/scope/brand-mention-prompts?${params.toString()}`, "prompts", setState);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- eager only read on !lazy
  }, [brand, own?.code, own === null, spStr, isWebsite, projectId, lazy]);
  return state;
}

/** The prompts tab body for a list state: loading / error / no prompts / the table. */
export function BrandPromptsPanel({
  state,
  brand,
  showRank = false,
}: {
  state: PromptsState;
  brand: string;
  showRank?: boolean;
}) {
  const t = useTranslations("answerAnalysis.mentions.drilldown");
  return state.status === "loading" ? (
    <LoadingBox label={t("promptsLoading")} />
  ) : state.status === "error" ? (
    <ErrorBox label={t("promptsError")} />
  ) : state.list.length === 0 ? (
    <Empty label={t("noPrompts")} />
  ) : (
    <PromptsTable rows={state.list} total={state.total} brand={brand} showRank={showRank} />
  );
}

function LoadingBox({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/20 px-4 py-8 text-xs text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

function ErrorBox({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/20 px-4 py-8 text-xs text-muted-foreground">
      <AlertCircle className="h-4 w-4" aria-hidden />
      {label}
    </div>
  );
}

type PromptsSortKey = "prompt" | "rank" | "mentions" | "share" | "funnel" | "providers";

function PromptsTable({
  rows,
  total,
  brand,
  showRank = false,
}: {
  rows: MentionsPromptLive[];
  /** Prompts before the route's cap, only when it cut the list (B008). */
  total?: number;
  brand: string;
  showRank?: boolean;
}) {
  const t = useTranslations("answerAnalysis.mentions.drilldown");
  const tModal = useTranslations("answerAnalysis.mentions.answerModal");
  const [selected, setSelected] = useState<MentionsPromptLive | null>(null);

  const { sorted, headerProps } = useSortableTable<MentionsPromptLive, PromptsSortKey>(
    rows,
    {
      prompt: (r) => r.promptText,
      // 순위 없음은 맨 뒤로(Infinity) — 0 으로 두면 "1위보다 앞"으로 정렬된다.
      rank: (r) => promptBestRank(r) ?? Number.POSITIVE_INFINITY,
      mentions: (r) => r.mentions,
      share: (r) => r.share,
      funnel: (r) => r.funnelStage ?? "",
      providers: (r) => r.providers.length,
    },
    { defaultKey: "mentions", defaultAsc: false, ascByDefault: ["prompt", "funnel", "rank"] },
  );

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-muted-foreground">{tModal("tableHint")}</p>
      <div className="overflow-hidden rounded-md border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              <th className="px-3 py-2"><SortableHeader {...headerProps("prompt")}>{t("col.prompt")}</SortableHeader></th>
              {showRank ? (
                <th className="px-3 py-2 w-16">
                  <div className="flex w-full items-center justify-end gap-1">
                    <SortableHeader {...headerProps("rank")} align="right">{t("col.rank")}</SortableHeader>
                    <ColInfo title={t("col.rank")} definition={t("colDefinition.rank")} />
                  </div>
                </th>
              ) : null}
              <th className="px-3 py-2 w-16">
                <div className="flex w-full items-center justify-end gap-1">
                  <SortableHeader {...headerProps("mentions")} align="right">{t("col.mentions")}</SortableHeader>
                  <ColInfo title={t("col.mentions")} definition={t("colDefinition.mentions")} />
                </div>
              </th>
              <th className="px-3 py-2 w-16">
                <div className="flex w-full items-center justify-end gap-1">
                  <SortableHeader {...headerProps("share")} align="right">{t("col.share")}</SortableHeader>
                  <ColInfo
                    title={t("col.share")}
                    definition={t("colDefinition.share")}
                    formula={t("colFormula.share")}
                  />
                </div>
              </th>
              <th className="px-3 py-2 w-24"><SortableHeader {...headerProps("funnel")}>{t("col.funnel")}</SortableHeader></th>
              <th className="px-3 py-2 w-28"><SortableHeader {...headerProps("providers")} align="right">{t("col.providers")}</SortableHeader></th>
              {showRank ? <th className="px-3 py-2 w-24" aria-label={t("top3")} /> : null}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              // Every drilldown prompt has ≥1 measured answer (the brand was
              // mentioned in ≥1 job for it), so every row opens the real answer.
              const hasAnswers = (r.answers?.length ?? 0) > 0;
              const rank = showRank ? promptBestRank(r) : null;
              return (
                <tr
                  key={r.id}
                  className={cn(
                    "border-t border-border first:border-t-0",
                    hasAnswers && "cursor-pointer hover:bg-muted/40",
                  )}
                  onClick={hasAnswers ? () => setSelected(r) : undefined}
                >
                  <td className="px-3 py-2 text-foreground">
                    {hasAnswers ? (
                      <span className="group inline-flex items-start gap-1.5 text-left">
                        <MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" aria-hidden />
                        <span className="underline-offset-2 group-hover:underline">{r.promptText}</span>
                      </span>
                    ) : (
                      r.promptText
                    )}
                  </td>
                  {showRank ? (
                    <td className="px-3 py-2 text-right tabular-nums text-foreground">
                      {rank == null ? <span className="text-muted-foreground">—</span> : rank.toFixed(1)}
                    </td>
                  ) : null}
                  <td className="px-3 py-2 text-right tabular-nums text-foreground">{r.mentions.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-foreground">{r.share.toFixed(1)}%</td>
                  <td className="px-3 py-2">
                    {r.funnelStage ? (
                      <Badge variant="outline" className="text-[10px] capitalize">{r.funnelStage}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-[10px] text-muted-foreground">
                    {r.providers.join(", ") || "—"}
                  </td>
                  {showRank ? (
                    <td className="px-3 py-2 text-right">
                      {isTopRank(rank) ? (
                        <span
                          className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-700"
                          data-top3
                        >
                          {t("top3Badge")}
                        </span>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
        <TruncatedNote shown={rows.length} total={total} className={TRUNCATED_ROW_CLASS} />
      </div>

      <AnswerModal
        brand={brand}
        promptText={selected?.promptText ?? ""}
        answers={selected?.answers ?? []}
        open={selected !== null}
        onOpenChange={(o) => {
          if (!o) setSelected(null);
        }}
      />
    </div>
  );
}

// 인용출처 탭 — citation domains for answers where THIS brand was mentioned,
// fetched lazily when the tab opens (Radix mounts only the active tab). Reuses
// the citation tab's domain table; the current dimension filters ride along as
// query params so the per-brand domains match the filtered mention view.
function BrandCitationsTab({
  brand,
  isWebsite,
  projectId,
}: {
  brand: string;
  isWebsite: boolean;
  projectId: string | null;
}) {
  const sp = useSearchParams();
  const spStr = sp.toString();
  const [state, setState] = useState<ListState<CitationDomainLive>>({ status: "loading" });

  useEffect(() => {
    const params = drilldownParams(spStr, { brand, isWebsite, projectId });
    return startListLoad<CitationDomainLive>(`/api/scope/brand-citations?${params.toString()}`, "domains", setState);
  }, [brand, spStr, isWebsite, projectId]);

  return (
    <BrandCitationsPanel state={state} detailQuery={drilldownParams(spStr, { brand, isWebsite, projectId }).toString()} />
  );
}

/** The citation sources tab body for a list state: loading / error / no sources / the domain table. */
export function BrandCitationsPanel({ state, detailQuery }: { state: ListState<CitationDomainLive>; detailQuery: string }) {
  const t = useTranslations("answerAnalysis.mentions.drilldown");
  if (state.status === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/20 px-4 py-8 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        {t("citationsLoading")}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/20 px-4 py-8 text-xs text-muted-foreground">
        <AlertCircle className="h-4 w-4" aria-hidden />
        {t("citationsError")}
      </div>
    );
  }
  if (state.list.length === 0) {
    return <Empty label={t("noCitations")} />;
  }
  // API rows carry skey and no urls/promptList: the table loads a row's detail when it opens.
  return <CitationDomainTable domains={state.list} detailQuery={detailQuery} total={state.total} />;
}

function Empty({ label }: { label: string }) {
  return (
    <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
      {label}
    </p>
  );
}
