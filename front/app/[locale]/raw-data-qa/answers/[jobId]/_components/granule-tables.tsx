"use client";

import { useTranslations } from "next-intl";
import { MessageSquarePlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { displayCitationUrl } from "@/lib/url-display";
import { cn } from "@/lib/utils";
import type { SerializedDetail, NoteTarget } from "./types";

// 우측 낱알 패널의 테이블들. 여기가 이 도구의 본체다 — KPI 롤업이 아니라
// scope_mentions / scope_citations / scope_acr_rollups 의 **행 그 자체**를 편다.
// 컬럼을 줄이지 않는 것이 의도다: 검수자가 "이 값이 왜 이렇지"를 물을 수 있는
// 모든 필드가 화면에 있어야 사람 눈 대조가 성립한다(설계 §7).

type NoteProps = {
  onNote: (target: NoteTarget) => void;
  noteCountFor: (kind: NoteTarget["kind"], key: string | null) => number;
  readOnly: boolean;
};

function NoteButton({
  target,
  onNote,
  count,
  readOnly,
}: {
  target: NoteTarget;
  onNote: (t: NoteTarget) => void;
  count: number;
  readOnly: boolean;
}) {
  const t = useTranslations("qaReview.detail");
  return (
    <button
      type="button"
      onClick={() => onNote(target)}
      disabled={readOnly}
      title={t("addNote")}
      aria-label={t("addNote")}
      className={cn(
        "inline-flex items-center gap-0.5 rounded p-1 transition-colors disabled:opacity-40",
        count > 0 ? "text-accent-gold" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <MessageSquarePlus className="size-3.5" />
      {count > 0 ? <span className="text-[10px] tabular-nums">{count}</span> : null}
    </button>
  );
}

// 0 / 3 / 0 / 0 처럼 자리로만 구분하는 표기는 "3이 어느 축인지"를 매번 세게 만든다.
// 값이 있는 항목만 라벨과 함께 낸다 — 검수자가 한 줄에 수십 행을 훑는 화면이라
// 읽는 데 드는 시간이 곧 검수 속도다.
function LabeledCounts({
  items,
}: {
  items: Array<{ label: string; value: number; tone?: "danger"; hint?: string }>;
}) {
  const shown = items.filter((i) => i.value > 0);
  if (shown.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      {shown.map((i) => (
        <span key={i.label} className="whitespace-nowrap" title={i.hint}>
          <span
            className={cn(
              "text-muted-foreground",
              i.tone === "danger" && "text-destructive",
            )}
          >
            {i.label}
          </span>{" "}
          <span
            className={cn(
              "font-medium tabular-nums",
              i.tone === "danger" ? "text-destructive" : "text-foreground",
            )}
          >
            {i.value}
          </span>
        </span>
      ))}
    </span>
  );
}

const TH = "px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground whitespace-nowrap";
const TD = "px-2 py-1.5 text-xs align-top";

function Scroll({ children }: { children: React.ReactNode }) {
  // 낱알 테이블은 컬럼이 많다. 페이지 본체가 가로로 흐르지 않도록 각자 스크롤한다.
  return <div className="overflow-x-auto">{children}</div>;
}

export function MentionTable({
  mentions,
  onNote,
  noteCountFor,
  readOnly,
}: { mentions: SerializedDetail["mentions"] } & NoteProps) {
  const t = useTranslations("qaReview.detail");
  if (mentions.length === 0) {
    return <p className="px-4 py-6 text-xs text-muted-foreground">{t("noMentions")}</p>;
  }
  return (
    <Scroll>
      <table className="w-full border-collapse">
        <thead className="border-b border-border">
          <tr>
            <th className={TH}>{t("mentionEntity")}</th>
            <th className={TH}>{t("mentionType")}</th>
            <th className={cn(TH, "text-right")}>{t("mentionCount")}</th>
            <th className={TH}>{t("mentionSentiment")}</th>
            <th className={cn(TH, "text-right")}>{t("mentionPosition")}</th>
            <th className={TH}>{t("mentionTypes")}</th>
            <th className={TH}>{t("mentionSurfaces")}</th>
            <th className={TH}>{t("mentionRollup")}</th>
            <th className={TH} />
          </tr>
        </thead>
        <tbody>
          {mentions.map((m) => (
            <tr key={m.entityId} className="border-b border-border/60 last:border-0">
              <td className={cn(TD, "min-w-[10rem]")}>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="font-medium text-foreground">
                    {m.brand ?? m.entityId.slice(0, 8)}
                  </span>
                  {m.isOwn ? (
                    <Badge className="bg-brand-50 px-1 py-0 text-[10px] font-normal text-brand-700 hover:bg-brand-50">
                      {t("mentionOwn")}
                    </Badge>
                  ) : null}
                  {m.isExcluded ? (
                    <Badge variant="outline" className="px-1 py-0 text-[10px] font-normal">
                      {t("mentionExcluded")}
                    </Badge>
                  ) : null}
                </div>
              </td>
              <td className={cn(TD, "text-muted-foreground")}>{m.entityType ?? "—"}</td>
              <td className={cn(TD, "text-right tabular-nums")}>{m.mentionCount}</td>
              <td className={cn(TD, "min-w-[8rem]")}>
                <LabeledCounts
                  items={[
                    { label: t("sentPositive"), value: m.sentimentPositive },
                    {
                      label: t("sentNeutral"),
                      value: m.sentimentNeutral,
                      hint: t("sentNeutralHint"),
                    },
                    {
                      label: t("sentNegative"),
                      value: m.sentimentNegative,
                      tone: "danger",
                    },
                    { label: t("sentMixed"), value: m.sentimentMixed },
                  ]}
                />
              </td>
              <td className={cn(TD, "text-right tabular-nums")}>
                {m.avgPosition == null ? "—" : m.avgPosition.toFixed(2)}
              </td>
              <td className={cn(TD, "min-w-[9rem]")}>
                <LabeledCounts
                  items={[
                    { label: t("typeMention"), value: m.typeMention },
                    { label: t("typeRecommendation"), value: m.typeRecommendation },
                    { label: t("typeComparison"), value: m.typeComparison },
                    { label: t("typeDefinition"), value: m.typeDefinition },
                    { label: t("typeFinalChoice"), value: m.typeFinalChoice },
                  ]}
                />
              </td>
              <td className={cn(TD, "max-w-[14rem] text-muted-foreground")}>
                {m.surfaces?.length ? m.surfaces.join(", ") : "—"}
              </td>
              <td className={cn(TD, "text-muted-foreground")}>
                {m.rollupParentName ?? "—"}
              </td>
              <td className={cn(TD, "text-right")}>
                <NoteButton
                  target={{
                    kind: "mention",
                    key: m.entityId,
                    label: m.brand ?? m.entityId,
                  }}
                  onNote={onNote}
                  count={noteCountFor("mention", m.entityId)}
                  readOnly={readOnly}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

export function CitationTable({
  citations,
  onNote,
  noteCountFor,
  readOnly,
}: { citations: SerializedDetail["citations"] } & NoteProps) {
  const t = useTranslations("qaReview.detail");
  if (citations.length === 0) {
    return <p className="px-4 py-6 text-xs text-muted-foreground">{t("noCitations")}</p>;
  }
  return (
    <Scroll>
      <table className="w-full border-collapse">
        <thead className="border-b border-border">
          <tr>
            <th className={cn(TH, "w-8")}>{t("citationRef")}</th>
            <th className={TH}>{t("citationUrl")}</th>
            <th className={TH}>{t("citationDomain")}</th>
            <th className={TH}>{t("citationTitle")}</th>
            <th className={TH}>{t("citationCategory")}</th>
            <th className={TH}>{t("citationNorm")}</th>
            <th className={TH} />
          </tr>
        </thead>
        <tbody>
          {citations.map((c) => (
            <tr key={c.id} className="border-b border-border/60 last:border-0">
              <td className={cn(TD, "tabular-nums text-muted-foreground")}>
                {c.refIndex ?? "—"}
              </td>
              <td className={cn(TD, "max-w-[20rem]")}>
                {c.url ? (
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="break-all text-brand-500 underline-offset-2 hover:underline"
                  >
                    {displayCitationUrl(c.url)}
                  </a>
                ) : (
                  "—"
                )}
              </td>
              <td className={cn(TD, "whitespace-nowrap")}>{c.domain ?? "—"}</td>
              <td className={cn(TD, "max-w-[14rem] text-muted-foreground")}>
                <span className="line-clamp-2">{c.title ?? "—"}</span>
              </td>
              <td className={TD}>
                <span>{c.effectiveCategory ?? "—"}</span>
                {/* 오버라이드가 걸린 행은 저장값을 함께 보여준다 — "분류가 왜 이렇지"의
                    원인이 scope 분류인지 우리 오버라이드인지 구분되어야 한다. */}
                {c.overrideCategory && c.overrideCategory !== c.storedCategory ? (
                  <span className="mt-0.5 block text-[10px] text-accent-gold">
                    {t("citationCategoryOverridden", { stored: c.storedCategory ?? "—" })}
                  </span>
                ) : null}
              </td>
              <td className={cn(TD, "max-w-[16rem] font-mono text-[10px] text-muted-foreground")}>
                <div className="break-all">{c.urlNorm ?? "—"}</div>
                <div className="break-all opacity-70">{c.urlBaseNorm ?? "—"}</div>
              </td>
              <td className={cn(TD, "text-right")}>
                <NoteButton
                  target={{
                    kind: "citation",
                    // 노트 키: API 원천은 백엔드 규약 'job_id:ord'(targetKey), 현행 원천은 scope_citations.id.
                    key: c.targetKey ?? String(c.id),
                    label: `#${c.refIndex ?? "?"} ${c.domain ?? c.url ?? ""}`.trim(),
                  }}
                  onNote={onNote}
                  count={noteCountFor("citation", c.targetKey ?? String(c.id))}
                  readOnly={readOnly}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

export function AcrTable({
  acr,
  onNote,
  noteCountFor,
  readOnly,
}: { acr: SerializedDetail["acr"] } & NoteProps) {
  const t = useTranslations("qaReview.detail");
  if (acr.length === 0) {
    return <p className="px-4 py-6 text-xs text-muted-foreground">{t("noAcr")}</p>;
  }
  return (
    <div>
      {/* ACR 은 job 이 아니라 prompt-run 키라 이 답변 하나의 값이 아니다.
          이 경고가 없으면 검수자가 답변 단위로 대조하려다 헛수고한다. */}
      <p className="border-b border-border bg-secondary/60 px-3 py-1.5 text-[11px] text-secondary-foreground">
        {t("acrScopeNotice")}
      </p>
      <Scroll>
        <table className="w-full border-collapse">
          <thead className="border-b border-border">
            <tr>
              <th className={TH}>{t("acrEntity")}</th>
              <th className={TH}>{t("acrLevel")}</th>
              <th className={TH}>{t("acrIterations")}</th>
              <th className={TH}>{t("acrCounts")}</th>
              <th className={TH}>{t("acrRates")}</th>
              <th className={TH}>{t("acrCoOccurrence")}</th>
              <th className={TH} />
            </tr>
          </thead>
          <tbody>
            {acr.map((r) => (
              <tr
                key={`${r.promptRunId}:${r.entityId}`}
                className="border-b border-border/60 last:border-0"
              >
                <td className={TD}>
                  <span className="font-medium text-foreground">
                    {r.brand ?? r.entityId.slice(0, 8)}
                  </span>
                  {r.parentBrand ? (
                    <span className="ml-1 text-muted-foreground">({r.parentBrand})</span>
                  ) : null}
                </td>
                <td className={cn(TD, "text-muted-foreground")}>{r.rollupLevel ?? "—"}</td>
                <td className={cn(TD, "min-w-[9rem]")}>
                  <LabeledCounts
                    items={[
                      { label: t("acrPlanned"), value: r.plannedIterations },
                      { label: t("acrValidTurn1"), value: r.validTurn1Iterations },
                      { label: t("acrValidAcr"), value: r.validAcrIterations },
                    ]}
                  />
                </td>
                <td className={cn(TD, "min-w-[11rem]")}>
                  <LabeledCounts
                    items={[
                      { label: t("acrAppearance"), value: r.appearanceCount },
                      { label: t("acrChoice"), value: r.choiceCount },
                      { label: t("acrConditional"), value: r.conditionalChoiceCount },
                      { label: t("acrOffShortlist"), value: r.offShortlistChoiceCount },
                      { label: t("acrUnresolved"), value: r.unresolvedChoiceCount },
                      { label: t("acrGeneric"), value: r.genericChoiceCount },
                    ]}
                  />
                </td>
                <td className={cn(TD, "min-w-[11rem]")}>
                  <LabeledRates
                    items={[
                      { label: t("acrRateAppearance"), value: r.appearanceRate },
                      { label: t("acrRateAcr"), value: r.acr },
                      { label: t("acrRateShare"), value: r.overallChoiceShare },
                    ]}
                  />
                </td>
                <td className={cn(TD, "min-w-[11rem]")}>
                  <LabeledCounts
                    items={[
                      { label: t("coSingle"), value: r.coSingleEntity },
                      { label: t("coConditional"), value: r.coConditionalMultiple },
                      { label: t("coGeneric"), value: r.coGenericCategory },
                      { label: t("coOffShortlist"), value: r.coResolvedOffShortlist },
                      { label: t("coUnresolved"), value: r.coUnresolvedChoice },
                      { label: t("coNone"), value: r.coNone },
                    ]}
                  />
                </td>
                <td className={cn(TD, "text-right")}>
                  <NoteButton
                    target={{
                      kind: "acr",
                      key: `${r.promptRunId}:${r.entityId}`,
                      label: r.brand ?? r.entityId,
                    }}
                    onNote={onNote}
                    count={noteCountFor("acr", `${r.promptRunId}:${r.entityId}`)}
                    readOnly={readOnly}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
    </div>
  );
}

// 비율은 0%%도 정보다("한 번도 선택되지 않았다") — LabeledCounts 처럼 숨기지 않는다.
function LabeledRates({
  items,
}: {
  items: Array<{ label: string; value: number | null }>;
}) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      {items.map((i) => (
        <span key={i.label} className="whitespace-nowrap">
          <span className="text-muted-foreground">{i.label}</span>{" "}
          <span className="font-medium tabular-nums text-foreground">{fmtRate(i.value)}</span>
        </span>
      ))}
    </span>
  );
}

function fmtRate(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}

export function PromptTable({ detail }: { detail: SerializedDetail }) {
  const t = useTranslations("qaReview.detail");
  const { prompt } = detail;
  const cat = prompt.catalog;
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 px-3 py-3 text-xs">
      <Field label={t("promptFunnel")} value={prompt.funnelStage} />
      <Field label={t("promptLang")} value={prompt.lang} />
      <Field label={t("promptRegions")} value={prompt.regions?.join(", ") ?? null} />
      {cat ? (
        <>
          <Field label={t("promptListType")} value={cat.listType} />
          <Field
            label={t("promptDepth")}
            value={[cat.depth1, cat.depth2, cat.depth3, cat.depth4]
              .filter(Boolean)
              .join(" › ")}
          />
          <Field label={t("promptKind")} value={cat.kind} />
          <Field label={t("promptBrandPresence")} value={cat.brandPresence} />
          <Field label={t("promptCatalog")} value={cat.brand} />
        </>
      ) : (
        <>
          <dt className="text-muted-foreground">{t("promptCatalog")}</dt>
          <dd className="text-muted-foreground">{t("promptNoCatalog")}</dd>
        </>
      )}
    </dl>
  );
}

export function MetaTable({ detail }: { detail: SerializedDetail }) {
  const t = useTranslations("qaReview.detail");
  const a = detail.answer;
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 px-3 py-3 text-xs">
      <Field label={t("metaJobId")} value={a.jobId} mono />
      <Field label={t("metaRunId")} value={a.runId} mono />
      <Field label={t("metaPromptId")} value={a.promptId} mono />
      <Field label={t("metaEngine")} value={a.target} />
      <Field label={t("metaRegion")} value={a.region} />
      <Field label={t("metaSurface")} value={a.surface} />
      <Field label={t("metaStatus")} value={a.status} />
      <Field label={t("metaModel")} value={a.modelSlug} />
      <Field label={t("metaMeasuredAt")} value={a.measuredAt} mono />
    </dl>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("break-all text-foreground", mono && "font-mono text-[10px]")}>
        {value || "—"}
      </dd>
    </>
  );
}
