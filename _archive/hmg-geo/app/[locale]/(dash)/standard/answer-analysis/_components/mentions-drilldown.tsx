"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { MessageSquareText, Loader2, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSortableTable } from "@/hooks/use-sortable-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import { ColInfo } from "@/components/dash/col-info";
import { cn } from "@/lib/utils";
import type { MentionsPromptLive, CitationDomainLive } from "@/lib/scope/result-adapter";
import { AnswerModal } from "./answer-modal";
import { CitationDomainTable } from "./citation-domain-table";
import { isTopRank, promptBestRank } from "../_data/prompt-rank";

// Per-brand drilldown rendered inline when a Brand row is clicked — LIVE only.
//   - "Prompts" tab: the prompts where this brand appeared (real: text,
//     mentions, share, funnel stage, AI providers). A prompt that carries a real
//     answer body opens the AnswerModal (chat-style transcript w/ highlights).
//   - "Citation Sources" tab: per-brand cited domains, lazy-loaded on open via
//     /api/scope/brand-citations — embeds the citation tab's domain table scoped
//     to this brand (row → URL list, 프롬프트 count → prompts → answer modal).

export function MentionsDrilldown({
  prompts: eagerPrompts,
  brand,
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
  isWebsite?: boolean;
  lazyPrompts?: boolean;
  /**
   * 순위 열 + "언급 TOP 3 이내" 배지(디자인 327:116 하단, 2026-09-02). 표준 공통
   * 하단만 켠다 — website/project mention 화면은 종전 마크업 그대로(스펙 회귀 기준).
   */
  showRank?: boolean;
}) {
  const t = useTranslations("answerAnalysis.mentions.drilldown");
  const prompts = useBrandPrompts(brand, isWebsite, lazyPrompts, eagerPrompts);

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
          {prompts.status === "loading" ? (
            <LoadingBox label={t("promptsLoading")} />
          ) : prompts.status === "error" ? (
            <ErrorBox label={t("promptsError")} />
          ) : prompts.list.length === 0 ? (
            <Empty label={t("noPrompts")} />
          ) : (
            <PromptsTable rows={prompts.list} brand={brand} showRank={showRank} />
          )}
        </TabsContent>

        <TabsContent value="citations">
          <BrandCitationsTab brand={brand} isWebsite={isWebsite} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

type PromptsState =
  | { status: "loading" }
  | { status: "ready"; list: MentionsPromptLive[] }
  | { status: "error" };

// 프롬프트 목록 소스 — lazy면 /api/scope/brand-mention-prompts로 그 브랜드만 가져오고
// (BrandCitationsTab와 동일 lazy 패턴), 아니면 eager prop을 그대로 쓴다.
function useBrandPrompts(
  brand: string,
  isWebsite: boolean,
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
    const params = new URLSearchParams(spStr);
    params.set("mentionBrand", brand);
    if (isWebsite) params.set("surface", "website");
    const ctrl = new AbortController();
    setState({ status: "loading" });
    fetch(`/api/scope/brand-mention-prompts?${params.toString()}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d: { prompts?: MentionsPromptLive[] }) =>
        setState({ status: "ready", list: d.prompts ?? [] }),
      )
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setState({ status: "error" });
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- eager only read on !lazy
  }, [brand, spStr, isWebsite, lazy]);
  return state;
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
  brand,
  showRank = false,
}: {
  rows: MentionsPromptLive[];
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
function BrandCitationsTab({ brand, isWebsite }: { brand: string; isWebsite: boolean }) {
  const t = useTranslations("answerAnalysis.mentions.drilldown");
  const sp = useSearchParams();
  const spStr = sp.toString();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; domains: CitationDomainLive[] }
    | { status: "error" }
  >({ status: "loading" });

  useEffect(() => {
    const params = new URLSearchParams(spStr);
    params.set("mentionBrand", brand);
    if (isWebsite) params.set("surface", "website");
    const ctrl = new AbortController();
    setState({ status: "loading" });
    fetch(`/api/scope/brand-citations?${params.toString()}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d: { domains?: CitationDomainLive[] }) =>
        setState({ status: "ready", domains: d.domains ?? [] }),
      )
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setState({ status: "error" });
      });
    return () => ctrl.abort();
  }, [brand, spStr, isWebsite]);

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
  if (state.domains.length === 0) {
    return <Empty label={t("noCitations")} />;
  }
  return <CitationDomainTable domains={state.domains} />;
}

function Empty({ label }: { label: string }) {
  return (
    <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
      {label}
    </p>
  );
}
