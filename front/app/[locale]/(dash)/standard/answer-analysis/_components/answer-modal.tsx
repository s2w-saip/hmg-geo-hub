"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import { Sparkles, Clock, Globe, Loader2, AlertCircle, Trophy, Link2, ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Sentiment, SentimentSpan } from "@/lib/answer-sentiment/spans";
import type { StanceEvidenceMatch } from "@/lib/answer-sentiment/stance-evidence";
import type { DrillAnswer } from "../_data/drilldown-screen-types";
import { MarkdownAnswer } from "./markdown-answer";

// Modal that shows the REAL AI answer behind a (brand, prompt) cell, dressed up
// as a chat transcript: the prompt as the user turn, the model's answer as the
// assistant turn. The drilled brand and the models scope rolls up to it are
// highlighted like a marker pen (see MarkdownAnswer + .geo-hl in globals.css).
//
// The answer detail is NOT in the aggregate — it's fetched lazily per click by
// job_id (/api/scope/answer, mirror-backed: body + the job's full citation list
// + per-entity mention counts). "unavailable" now only means the mirror hasn't
// synced this job's body yet → we still show what we detected (brand + models).
//
// The route (screen mention/drill-answer) answers the modal's values precomputed: each citation's
// label, the own / competitor brand split, the model chip labels, the links found in the text when
// the job has no citations (`sources`), each sentiment span's sentence (`text`) and the stance
// tags grouped by turn (`stanceGroups`). The modal only renders them.

type BrandMention = { name: string; count: number; tracked: boolean };

// Client contract of /api/scope/answer.
interface AnswerDetailPayload {
  available?: boolean;
  answerText?: string;
  measuredAt?: string | null;
  citations?: {
    url: string | null;
    domain: string | null;
    title: string | null;
    category: string | null;
    /** title, else domain, else the display URL (a row without URL: title or domain). */
    label?: string | null;
    /** domain shown next to the title (both present). */
    showDomain?: boolean;
  }[];
  brandMentions?: BrandMention[];
  ownBrandMentions?: BrandMention[];
  competitorBrandMentions?: BrandMention[];
  /** label = the chip text (the rolled-up brand prefixed unless the name holds it). */
  modelMentions?: { name: string; count: number; brand: string | null; label?: string }[];
  /** Links found in the answer text (first 12), shown only when there are no citations. */
  sources?: { url: string; host: string }[];
  sentiment?: { spans: (SentimentSpan & { text?: string })[]; skipped: number };
  // 답변 단위 브랜드 스탠스(0072). **발생 감성(sentiment.spans)과 다른 축**이라
  // 키가 따로다 — 없으면 줄 자체가 안 그려지고, 발생 감성으로 대체하지 않는다.
  stances?: AnswerStanceTag[];
  /** stances by turn, turns ascending (within a turn: own first, then brand). */
  stanceGroups?: AnswerStanceGroup[];
}

export interface AnswerStanceTag {
  /** 답변 턴. 2턴 답변(ACR 후속 선택)이 라이브의 8.2% 라 브랜드만으로는 태그가 유일하지 않다. */
  turnIndex: number;
  entityId: string;
  brand: string;
  tracked: boolean;
  stance: Sentiment;
  confidence: number | null;
  evidenceText: string | null;
  /**
   * 미러 원문과 **실제로 대조한** 결과(F5). verified 일 때만 원문 위치를 주장한다.
   * mismatch(원문에 없다)와 unavailable(그 턴 원문이 미러에 없다)은 **다른 문구**다 —
   * 하나로 뭉치면 "코어가 환각했다"와 "우리가 확인할 수 없다"가 구분되지 않는다.
   */
  evidenceMatch: StanceEvidenceMatch;
  reason: string | null;
}

/** The stance tags of one answer turn. */
export interface AnswerStanceGroup {
  turnIndex: number;
  stances: AnswerStanceTag[];
}

type BodyState =
  | { status: "loading" }
  | { status: "ready"; text: string; detail: AnswerDetailPayload }
  | { status: "unavailable" }
  | { status: "error" };

// /api/scope/answer 가 {available:false} 로 답하는 거부 상태(존재 은폐: 게이트·스코프 밖·없음). 그 밖의
// 비 2xx(401·5xx 등)는 오류 상태다.
const EXISTENCE_HIDDEN_STATUS: ReadonlySet<number> = new Set([403, 404, 422]);

export function AnswerModal({
  brand,
  promptText,
  answers,
  open,
  onOpenChange,
  variant = "mention",
}: {
  brand: string;
  promptText: string;
  answers: DrillAnswer[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // "citation": 인용 화면의 프롬프트 열람 — brand 자리에 카드 제목이 들어가
  // 헤더가 문장으로 깨지고, 인용 수가 "언급"으로 표기되던 오배선 수정
  // (2026-08-06 고객 피드백: AI 답변 화면 깨짐). 제목은 브랜드 무관 문안,
  // 수치 칩은 "인용 N건", brand 는 비어 있으면 배지 생략.
  variant?: "mention" | "citation";
}) {
  const t = useTranslations("answerAnalysis.mentions.answerModal");
  const [active, setActive] = useState(0);
  const [bodies, setBodies] = useState<Record<string, BodyState>>({});
  const fetched = useRef<Set<string>>(new Set());
  const [enabledSentiments, setEnabledSentiments] = useState<Set<Sentiment>>(new Set(["positive", "negative", "mixed"]));
  const [unpaintedByJob, setUnpaintedByJob] = useState<Record<string, number>>({});
  const toggleSentiment = (s: Sentiment) =>
    setEnabledSentiments((prev) => { const n = new Set(prev); if (n.has(s)) n.delete(s); else n.add(s); return n; });

  const current = answers[active] ?? answers[0] ?? null;
  const currentJobId = current?.jobId ?? null;
  // jobId 로 카운트를 키잉해 부모 리셋과 자식(MarkdownAnswer) 마운트 효과 간
  // 실행 순서 의존을 없앤다 — 같은 커밋에서 자식 effect(실제값 전달)가 부모
  // effect(리셋)보다 먼저 실행되므로, 부모가 무조건 0으로 덮어쓰면 캐시 재방문
  // 시 캡션이 사라지거나 과소표기된다(2026-09-07 리뷰 지적).
  const onSentimentUnpainted = useCallback(
    (n: number) => {
      if (!currentJobId) return;
      setUnpaintedByJob((prev) => (prev[currentJobId] === n ? prev : { ...prev, [currentJobId]: n }));
    },
    [currentJobId],
  );

  // Reset selection + cached bodies when a different prompt opens / on close.
  useEffect(() => {
    if (open) setActive(0);
    else {
      fetched.current = new Set();
      setBodies({});
    }
  }, [open, promptText]);

  // 당사 배지 단위 컨텍스트 — 현재 화면의 URL 필터를 그대로 전달하고, 프로젝트
  // 화면(/projects/[id]/…)이면 projectId도 붙인다 (서버가 project.brand 조회 →
  // KPI와 동일한 단위 규칙으로 배지 판정).
  const sp = useSearchParams();
  const pathname = usePathname();
  const projectId = useMemo(
    () => /\/projects\/([^/]+)\//.exec(pathname)?.[1] ?? null,
    [pathname],
  );

  // Lazy-load the selected job's body (once per job_id while the modal is open).
  useEffect(() => {
    if (!open || !current) return;
    const jobId = current.jobId;
    if (fetched.current.has(jobId)) return;
    fetched.current.add(jobId);
    setBodies((b) => ({ ...b, [jobId]: { status: "loading" } }));
    const ctrl = new AbortController();
    const params = new URLSearchParams(sp.toString());
    params.set("jobId", jobId);
    if (projectId) params.set("projectId", projectId);
    // 웹사이트 표면은 표준 카탈로그 밖 프롬프트라 서버가 website project 집합으로
    // 접근을 게이트한다 (route 의 surface=website 분기 — 드릴다운 API 와 동일 규약).
    else if (pathname.includes("/website/")) params.set("surface", "website");
    fetch(`/api/scope/answer?${params.toString()}`, { signal: ctrl.signal })
      .then((r) => {
        // 5xx·401 은 오류 상태(loadError)로 — 라우트의 {error:{code}} 본문을 available 없음('원문 미수집')으로
        // 읽지 않는다(현행은 라우트 throw → 비 JSON → 같은 오류 상태). 403·404·422 {available:false} 는
        // 존재 은폐 설계라 그대로 '원문 없음'.
        if (!r.ok && !EXISTENCE_HIDDEN_STATUS.has(r.status)) throw new Error(`answer ${r.status}`);
        return r.json();
      })
      .then((d: AnswerDetailPayload) =>
        setBodies((b) => ({
          ...b,
          [jobId]:
            d?.available && d.answerText
              ? { status: "ready", text: d.answerText, detail: d }
              : { status: "unavailable" },
        })),
      )
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        fetched.current.delete(jobId);
        setBodies((b) => ({ ...b, [jobId]: { status: "error" } }));
      });
    return () => ctrl.abort();
  }, [open, current?.jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = current ? bodies[current.jobId] : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex max-h-[86vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      >
        {/* Header — brand context + engine switcher */}
        <DialogHeader className="gap-3 border-b border-border px-6 pt-6 pb-4 text-left">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-700 px-2.5 py-1 text-[11px] font-semibold text-primary-foreground">
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              {t("eyebrow")}
            </span>
            {brand ? <Badge variant="secondary" className="text-[11px]">{brand}</Badge> : null}
          </div>
          <DialogTitle className="text-base leading-snug font-semibold">
            {variant === "citation" ? t("titleCitation") : t("title", { brand })}
          </DialogTitle>
          <DialogDescription className="sr-only">{promptText}</DialogDescription>

          {answers.length > 1 ? (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {answers.map((a, i) => (
                <button
                  key={a.jobId}
                  type="button"
                  onClick={() => setActive(i)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium transition-colors",
                    i === active
                      ? "border-brand-700 bg-brand-700 text-primary-foreground"
                      : "border-border bg-card text-muted-foreground hover:border-brand-300 hover:text-foreground",
                  )}
                >
                  {a.provider}
                  {a.region ? (
                    <span className={cn("text-[10px]", i === active ? "opacity-80" : "opacity-70")}>· {a.region}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </DialogHeader>

        {/* Body — chat transcript */}
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto bg-bg-soft px-6 py-5">
          {/* user turn */}
          <div className="flex justify-end">
            <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-brand-700 px-3.5 py-2.5 text-sm leading-relaxed text-primary-foreground shadow-soft">
              {promptText}
            </div>
          </div>

          {/* assistant turn */}
          {current ? (
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-700 text-primary-foreground">
                <Sparkles className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="font-semibold text-foreground">{current.provider}</span>
                  {current.region ? (
                    <span className="inline-flex items-center gap-1">
                      <Globe className="h-3 w-3" aria-hidden />
                      {current.region}
                    </span>
                  ) : null}
                  <span className="rounded-full bg-muted px-2 py-0.5 tabular-nums">
                    {variant === "citation"
                      ? t("citationsInAnswer", { count: current.mentionCount })
                      : t("mentionsInAnswer", { count: current.mentionCount })}
                  </span>
                  {current.position != null ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 font-medium text-brand-700 tabular-nums">
                      <Trophy className="h-3 w-3" aria-hidden />
                      {t("position", {
                        n: Number.isInteger(current.position)
                          ? current.position
                          : current.position.toFixed(1),
                      })}
                    </span>
                  ) : null}
                  {current.measuredAt ? (
                    <span className="inline-flex items-center gap-1 tabular-nums">
                      <Clock className="h-3 w-3" aria-hidden />
                      {t("measuredOn", { date: current.measuredAt.slice(0, 10) })}
                    </span>
                  ) : null}
                  {current.runs > 1 ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 tabular-nums">
                      {t("runsBadge", { count: current.runs })}
                    </span>
                  ) : null}
                </div>
                {body?.status === "ready" && body.detail.stances?.length ? (
                  <StanceTags groups={body.detail.stanceGroups ?? []} />
                ) : null}
                <div className="rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-3 shadow-soft">
                  {body?.status === "ready" ? (
                    <MarkdownAnswer
                      key={current.jobId}
                      text={body.text}
                      brandTerms={current.highlights.brand}
                      modelTerms={current.highlights.model}
                      highlightTerms={current.highlightTerms}
                      sentimentSpans={body.detail.sentiment?.spans}
                      enabledSentiments={enabledSentiments}
                      onSentimentUnpainted={onSentimentUnpainted}
                    />
                  ) : body?.status === "loading" || body === undefined ? (
                    <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      {t("loading")}
                    </div>
                  ) : body?.status === "error" ? (
                    <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
                      <AlertCircle className="h-4 w-4" aria-hidden />
                      {t("loadError")}
                    </div>
                  ) : (
                    <Unavailable
                      label={t("noAnswer")}
                      detectedLabel={t("detected")}
                      brandTerms={current.highlights.brand}
                      modelTerms={current.highlights.model}
                    />
                  )}
                </div>
                {body?.status === "ready" ? (
                  <>
                    <AnswerCitations
                      citations={body.detail.citations ?? []}
                      sources={body.detail.sources ?? []}
                    />
                    <MentionStats
                      brandMentions={body.detail.brandMentions ?? []}
                      ownBrandMentions={body.detail.ownBrandMentions ?? []}
                      competitorBrandMentions={body.detail.competitorBrandMentions ?? []}
                      modelMentions={body.detail.modelMentions ?? []}
                    />
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        {/* Footer — highlight legend (only meaningful once a body is shown) */}
        {body?.status === "ready" ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border px-6 py-3 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">{t("legendTitle")}</span>
            <span className="geo-hl geo-hl--brand geo-hl--static px-1.5">{t("legendBrand")}</span>
            <span className="geo-hl geo-hl--model geo-hl--static px-1.5">{t("legendModel")}</span>
            {body.detail.sentiment ? (
              <>
                <span className="ml-3 font-medium text-foreground">{t("sentiment.legendTitle")}</span>
                <button
                  type="button"
                  onClick={() => toggleSentiment("positive")}
                  aria-pressed={enabledSentiments.has("positive")}
                  className={cn("geo-ul cursor-pointer px-1.5", "geo-ul--positive", !enabledSentiments.has("positive") && "opacity-40")}
                >
                  {t("sentiment.label.positive")}
                </button>
                <button
                  type="button"
                  onClick={() => toggleSentiment("negative")}
                  aria-pressed={enabledSentiments.has("negative")}
                  className={cn("geo-ul cursor-pointer px-1.5", "geo-ul--negative", !enabledSentiments.has("negative") && "opacity-40")}
                >
                  {t("sentiment.label.negative")}
                </button>
                <button
                  type="button"
                  onClick={() => toggleSentiment("mixed")}
                  aria-pressed={enabledSentiments.has("mixed")}
                  className={cn("geo-ul cursor-pointer px-1.5", "geo-ul--mixed", !enabledSentiments.has("mixed") && "opacity-40")}
                >
                  {t("sentiment.label.mixed")}
                </button>
                <button
                  type="button"
                  onClick={() => toggleSentiment("neutral")}
                  aria-pressed={enabledSentiments.has("neutral")}
                  className={cn("geo-ul cursor-pointer px-1.5", "geo-ul--neutral", !enabledSentiments.has("neutral") && "opacity-40")}
                >
                  {t("sentiment.label.neutral")}
                </button>
                {(() => {
                  const unpainted = current ? (unpaintedByJob[current.jobId] ?? 0) : 0;
                  return body.detail.sentiment!.skipped + unpainted > 0 ? (
                    <span className="text-muted-foreground">
                      {t("sentiment.unpainted", { count: body.detail.sentiment!.skipped + unpainted })}
                    </span>
                  ) : null;
                })()}
              </>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// The job's cited sources. Primary source is the mirror's scope_citations feed
// (전수 — "인용된 출처 모두 표기"); when a job has no synced citations the route
// sends the links found in the answer text instead (`sources`, the old heuristic path).
function AnswerCitations({
  citations,
  sources,
}: {
  citations: NonNullable<AnswerDetailPayload["citations"]>;
  sources: NonNullable<AnswerDetailPayload["sources"]>;
}) {
  const t = useTranslations("answerAnalysis.mentions.answerModal");
  if (citations.length === 0) return <AnswerSources sources={sources} />;
  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2.5">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
        <Link2 className="h-3.5 w-3.5 text-brand-500" aria-hidden />
        {t("sourcesTitle")}{" "}
        <span className="font-normal text-muted-foreground">({citations.length})</span>
      </span>
      <ul className="flex flex-col gap-1">
        {citations.map((c, i) => (
          <li key={`${c.url ?? c.domain ?? "x"}-${i}`} className="flex items-start gap-1.5">
            {c.url ? (
              <a
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-w-0 items-start gap-1 text-[11px] text-brand-700 hover:underline"
              >
                <span className="min-w-0 break-all">{c.label}</span>
                <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              </a>
            ) : (
              <span className="min-w-0 break-all text-[11px] text-foreground">
                {c.label}
              </span>
            )}
            {c.showDomain ? (
              <span className="shrink-0 text-[10px] text-muted-foreground">{c.domain}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// 답변 단위 브랜드 스탠스 태그 (0072) — 답변 카드 메타 줄.
//
// ⚠️ **밑줄(발생 감성)과 라벨을 분리한다.** 밑줄은 "이 문장이 이 브랜드를 어떻게
// 말하는가", 이 태그는 "이 답변 전체가 이 브랜드에 대해 어떤 태도인가"다. 같은 4어휘를
// 쓰지만 세는 단위가 달라, 두 축을 한 숫자로 합치지 않는다(스펙 R6 · WU8 AC4).
// 그래서 축을 말하는 문구(axisNote)가 태그 줄에 항상 붙는다.
//
// 근거 인용은 **원문 대조가 된 것만 원문으로 연결**한다(evidenceVerified). 파일럿
// 실측에서 모델이 낸 인용의 79.2% 만 원문과 완전일치했고 8.6% 는 불일치였다 —
// 대조 안 된 인용을 원문인 양 보여주면 사용자가 답변에서 찾을 수 없는 문장을 읽는다.
// 태그의 유일 키 — **브랜드(entityId)만으로는 유일하지 않다.** 미러 PK 가
// (job, turn, entity)이고 2턴 답변이 라이브의 8.2% 라, entityId 를 React key 로 쓰면
// 그 답변들에서 key 가 충돌하고 근거 패널이 두 개 동시에 열린다(검증자 F1).
const tagKey = (s: AnswerStanceTag) => `${s.turnIndex}:${s.entityId}`;

const STANCE_DOT: Record<Sentiment, string> = {
  positive: "bg-sentiment-positive",
  negative: "bg-sentiment-negative",
  mixed: "bg-sentiment-mixed",
  neutral: "bg-sentiment-neutral",
};

export function StanceTags({
  groups,
  initialOpenId = null,
}: {
  /** The answer's stance tags by turn (the route's stanceGroups). */
  groups: AnswerStanceGroup[];
  /**
   * 렌더 테스트 seam — 근거 패널 분기. 화면 기본은 닫힘(favorability 탭의 initialCounts 와
   * 같은 자세). 값은 `${turnIndex}:${entityId}` (= tagKey).
   */
  initialOpenId?: string | null;
}) {
  const t = useTranslations("answerAnalysis.mentions.answerModal.stance");
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const open = groups.flatMap((g) => g.stances).find((s) => tagKey(s) === openId) ?? null;
  // 턴별 그룹(라우트가 턴 오름차순으로 묶어 보낸다) — 2턴 답변에서 같은 브랜드가 두 번 나오므로
  // "브랜드가 중복된 배지"로 보이지 않으려면 턴이 화면에 드러나야 한다. 턴이 하나뿐이면(대다수)
  // 헤더를 안 단다.
  const multiTurn = groups.length > 1;
  return (
    <div className="mb-1.5 flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="font-semibold text-foreground">{t("tagTitle")}</span>
      </div>
      {groups.map(({ turnIndex: turn, stances }) => (
        <div key={turn} className="flex flex-wrap items-center gap-1.5 text-[11px]">
          {multiTurn ? (
            <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              {t("turn", { n: turn + 1 })}
            </span>
          ) : null}
          {stances
            .map((s) => {
              const key = tagKey(s);
              const detail = s.evidenceText || s.reason;
              const label = `${s.brand} · ${t(`label.${s.stance}`)}`;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={!detail}
                  aria-pressed={openId === key}
                  onClick={() => setOpenId((prev) => (prev === key ? null : key))}
                  title={s.reason ?? undefined}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
                    s.tracked
                      ? "border-brand-300 bg-brand-50 text-brand-700"
                      : "border-border bg-card text-foreground",
                    openId === key && "ring-1 ring-brand-300",
                    detail ? "cursor-pointer" : "cursor-default",
                  )}
                >
                  <span className={cn("h-2 w-2 rounded-full", STANCE_DOT[s.stance])} aria-hidden />
                  {label}
                  {s.tracked ? (
                    <span className="text-[10px] font-semibold opacity-70">{t("own")}</span>
                  ) : null}
                </button>
              );
            })}
        </div>
      ))}
      <p className="text-[10px] text-muted-foreground">{t("axisNote")}</p>
      {open ? (
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2 text-[11px]">
          {open.evidenceText ? (
            <>
              <span className="font-semibold text-foreground">{t("evidenceTitle")}</span>
              <blockquote
                className={cn(
                  "border-l-2 pl-2 text-muted-foreground",
                  open.evidenceMatch === "verified"
                    ? "border-brand-300 text-foreground"
                    : "border-border",
                )}
              >
                {open.evidenceText}
              </blockquote>
              <span className="text-[10px] text-muted-foreground">
                {open.evidenceMatch === "verified"
                  ? t("evidenceVerified")
                  : open.evidenceMatch === "mismatch"
                    ? t("evidenceMismatch")
                    : t("evidenceUnavailable")}
              </span>
            </>
          ) : null}
          {open.reason ? (
            <span className="text-muted-foreground">
              <span className="font-semibold text-foreground">{t("reasonTitle")}</span> · {open.reason}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// 이 답변에서 감지된 브랜드(자사/경쟁 분리) + 연관 차량모델의 언급 횟수. 자사 =
// TRACKED(Hyundai/Kia/Genesis) — 미러 detail의 tracked 플래그가 판정 소스(라우트가 나눠 보낸다).
function MentionStats({
  brandMentions,
  ownBrandMentions: own,
  competitorBrandMentions: competitors,
  modelMentions,
}: {
  brandMentions: BrandMention[];
  ownBrandMentions: BrandMention[];
  competitorBrandMentions: BrandMention[];
  modelMentions: NonNullable<AnswerDetailPayload["modelMentions"]>;
}) {
  const t = useTranslations("answerAnalysis.mentions.answerModal");
  if (brandMentions.length === 0 && modelMentions.length === 0) return null;
  const chip = (name: string, count: number, key: string, highlight: boolean) => (
    <span
      key={key}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] tabular-nums",
        highlight
          ? "border-brand-300 bg-brand-50 text-brand-700"
          : "border-border bg-card text-foreground",
      )}
    >
      {name}
      <span className="font-semibold">×{count}</span>
    </span>
  );
  const group = (label: string, items: { name: string; count: number }[], highlight: boolean) =>
    items.length ? (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        {items.map((b) => chip(b.name, b.count, b.name, highlight))}
      </div>
    ) : null;
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5">
      {brandMentions.length ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold text-foreground">
            {t("brandMentionsTitle")}
          </span>
          {group(t("ownGroup"), own, true)}
          {group(t("competitorGroup"), competitors, false)}
        </div>
      ) : null}
      {modelMentions.length ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold text-foreground">
            {t("modelMentionsTitle")}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {modelMentions.map((m) =>
              // label: 모델 display name이 이미 브랜드를 포함하면(예: "Kia Sportage")
              // 롤업 브랜드를 덧붙이지 않은 칩 문구(라우트가 만든다).
              chip(m.label ?? m.name, m.count, `${m.brand}-${m.name}`, false),
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Citation sources parsed from the answer text (markdown links + bare URLs, deduped by URL, first
// 12, host without "www.") — the route's fallback when the mirror has no citations for the job.
function AnswerSources({ sources }: { sources: NonNullable<AnswerDetailPayload["sources"]> }) {
  const t = useTranslations("answerAnalysis.mentions.answerModal");
  if (sources.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2.5">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
        <Link2 className="h-3.5 w-3.5 text-brand-500" aria-hidden />
        {t("sourcesTitle")}{" "}
        <span className="font-normal text-muted-foreground">({sources.length})</span>
      </span>
      <ul className="flex flex-col gap-1">
        {sources.map((s) => (
          <li key={s.url}>
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-start gap-1 text-[11px] text-brand-700 hover:underline"
            >
              <span className="min-w-0 break-all">{s.host}</span>
              <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Body couldn't be fetched yet — show what scope's analysis DID detect (brand +
// rolled-up models) so the click is never empty, plus the honest "준비 중" note.
function Unavailable({
  label,
  detectedLabel,
  brandTerms,
  modelTerms,
}: {
  label: string;
  detectedLabel: string;
  brandTerms: string[];
  modelTerms: string[];
}) {
  const hasTerms = brandTerms.length > 0 || modelTerms.length > 0;
  return (
    <div className="flex flex-col gap-3 py-2">
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p className="leading-relaxed">{label}</p>
      </div>
      {hasTerms ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            {detectedLabel}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {brandTerms.map((term) => (
              <span key={`b-${term}`} className="geo-hl geo-hl--brand geo-hl--static rounded px-1.5 text-xs text-foreground">
                {term}
              </span>
            ))}
            {modelTerms.map((term) => (
              <span key={`m-${term}`} className="geo-hl geo-hl--model geo-hl--static rounded px-1.5 text-xs text-foreground">
                {term}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
