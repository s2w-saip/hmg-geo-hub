import "server-only";

// Answer detail adapter (unit U6): the answer modal's body (AN-2 GET /v1/answers/{job_id}) in the
// shape of the legacy fetchStandard/Project/WebsiteAnswerBody (SRV:4053/4074/4088 ->
// getMirrorAnswerBody AGG:7867 -> MirrorAnswerDetail AGG:7812), so answer-modal.tsx and
// markdown-answer.tsx stay unchanged. Design 3.3 "`/`(파싱 산물 = 답변 원문 모달)", appendix B
// "공용: 답변 드릴다운·모달" rows 1..3, error map (공통 규칙 4).
//
// Request: surface = the modal's surface (projectId in the path -> project, /website/ -> website,
// else global). brand = the admin's URL brand choice only (global and website; the backend
// ignores it on project and decides the perspective from the account or the project brand).
// Access gate = the legacy getMirrorAnswerBody IDOR gate (optional backend gates, the account
// scope is still applied by the backend; a job outside them -> 404 -> {available: false}):
//   project  project_id = the project the route gated on (legacy fetchProjectAnswerBody: only runs
//            of that project), so a job of another project is not served, and gate_country = the
//            URL countries (legacy region IN f.region: the route reads the project URL without the
//            profile scope, so they are sent as they are). No brand gate (legacy: the run gate
//            replaces prompts.brand on a project)
//   global   gate_country = the URL countries (legacy region IN f.region; urlCountries leaves out
//            the scope injection, as readStandardFilters falls back to the whole scope) and
//            gate_brand = the URL brand choice (legacy prompts.brand IN f.brand)
//   website  gate_brand only (legacy narrowScopeBrands -> website project ids). No country gate:
//            the legacy route moves region to websiteCountry, so answers are not gated by region
//            (virtual site countries such as worldwide would block every answer)
// lite = true: the backend skips the values toMirrorAnswerDetail does not read (catalog, cycle and
// representative metadata, model slug, citation owned/target_hit).
//
// Field map (AnswerDetail -> MirrorAnswerDetail):
//   available      body.available && answer_text non-empty; otherwise {available: false} only
//   answerText     body.answer_text
//   measuredAt     header.measured_at in the legacy Date#toISOString form (ms, Z)
//   citations      citations by ord: {url, domain, title, category: slug}
//   brandMentions  mentions.brands: {name, count: mention_count, tracked: own}, count desc (stable)
//   modelMentions  mentions.models: {name, count: mention_count, brand: parent_brand}, count desc
//   sentiment      only when spans or skipped exist (legacy: the key is absent without occurrence
//                  rows, so the modal draws no legend): spans with evidence camelCased
//   stances        only when non-empty: turn_index -> turnIndex, entity_id -> entityId, own ->
//                  tracked, evidence_text/_match -> evidenceText/Match; legacy order (turn, own
//                  first, brand localeCompare)
// Errors: 404 (hidden, out of scope, wrong surface, missing) -> {available: false} (the modal's
// "원문 없음"); 403 -> {available: false} (existence hidden); 422 (a malformed id or filter) ->
// {available: false}; 401 -> the route's 401 {error: "unauthorized"}; 5xx -> thrown to the route.
//
// Known differences (U6 numbering; asserted in answers.test.ts and answers.parity.test.ts):
//   U6-N7  citations[].category is the category slug (legacy: the scope classifier label). The
//          modal does not read it
// (U6-N8, a project answer served for another project's id, is closed by project_id above.)
import type { MirrorAnswerDetail } from "@/lib/db/repositories/scope-aggregates";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import type { components } from "../api-types";
import { hghGet } from "../client";
import { isHghApiError } from "../errors";
import { urlBrands, urlCountries, type Surface } from "../query";
import type { AllowedScope } from "@/lib/auth/types";

type S = components["schemas"];
export type ApiAnswerDetail = S["AnswerDetail"];

export interface AnswerRequest {
  jobId: string;
  surface: Surface;
  /** readStandardFilters result of the modal's URL (only the admin brand choice is sent). */
  filters: StandardFilters;
  /** The scope readStandardFilters used (recognises the injected brand lock). null = none. */
  scope: AllowedScope | null;
  /** surface=project: the project the route gated on (sent as project_id). */
  projectId?: string | null;
}

const UNAVAILABLE: MirrorAnswerDetail = { available: false };

/** An instant in the legacy Date#toISOString form ("2026-09-14T03:00:00.000Z"); unparseable -> as is. */
export function isoInstant(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

/** AnswerDetail -> MirrorAnswerDetail (field map in the header). */
export function toMirrorAnswerDetail(d: ApiAnswerDetail): MirrorAnswerDetail {
  const text = d.body.answer_text;
  if (!d.body.available || !text) return { ...UNAVAILABLE };
  const byCount = <T extends { count: number }>(xs: T[]) => xs.map((x, i) => ({ x, i })).sort((a, b) => b.x.count - a.x.count || a.i - b.i).map((e) => e.x);
  const out: MirrorAnswerDetail = {
    available: true,
    answerText: text,
    measuredAt: isoInstant(d.header.measured_at),
    citations: [...(d.citations ?? [])]
      .sort((a, b) => a.ord - b.ord)
      .map((c) => ({ url: c.url ?? null, domain: c.domain ?? null, title: c.title ?? null, category: c.category ?? null })),
    brandMentions: byCount((d.mentions.brands ?? []).map((b) => ({ name: b.name, count: b.mention_count, tracked: b.own }))),
    modelMentions: byCount(
      (d.mentions.models ?? []).map((m) => ({ name: m.name, count: m.mention_count, brand: m.parent_brand ?? null })),
    ),
  };
  const spans = d.sentiment.spans ?? [];
  const skipped = d.sentiment.skipped ?? 0;
  if (spans.length > 0 || skipped > 0) {
    out.sentiment = {
      spans: spans.map((s) => ({
        start: s.start,
        end: s.end,
        sentiment: s.sentiment,
        evidence: s.evidence.map((e) => ({
          brandName: e.brand_name ?? null,
          sentiment: e.sentiment,
          assertion: e.assertion ?? null,
          descriptors: [...(e.descriptors ?? [])],
          criteria: [...(e.criteria ?? [])],
          contextSnippet: e.context_snippet ?? null,
        })),
      })),
      skipped,
    };
  }
  const stances = (d.stances ?? [])
    .map((s) => ({
      turnIndex: s.turn_index,
      entityId: s.entity_id,
      brand: s.brand,
      tracked: s.own,
      stance: s.stance,
      confidence: s.confidence ?? null,
      evidenceText: s.evidence_text ?? null,
      evidenceMatch: s.evidence_match,
      reason: s.reason ?? null,
    }))
    .sort((a, b) =>
      a.turnIndex !== b.turnIndex
        ? a.turnIndex - b.turnIndex
        : a.tracked === b.tracked
          ? a.brand.localeCompare(b.brand)
          : a.tracked
            ? -1
            : 1,
    );
  if (stances.length) out.stances = stances;
  return out;
}

/** Backend refusals the modal shows as "원문 없음" (existence hidden). */
function isUnavailableError(e: unknown): boolean {
  return isHghApiError(e) && (e.status === 404 || e.status === 403 || e.status === 422);
}

/**
 * GET /v1/answers/{job_id} for the modal. 404/403/422 -> {available: false}; 401 and 5xx are
 * thrown (the route answers 401 {error: "unauthorized"} or the error response).
 */
export async function loadAnswerDetail(req: AnswerRequest): Promise<MirrorAnswerDetail> {
  const query: {
    surface: Surface;
    lite: boolean;
    brand?: string[];
    project_id?: string;
    gate_brand?: string[];
    gate_country?: string[];
  } = { surface: req.surface, lite: true };
  if (req.surface === "project") {
    if (req.projectId) query.project_id = req.projectId;
    const countries = urlCountries(req.filters.region, req.scope);
    if (countries.length) query.gate_country = countries;
  } else {
    const brand = urlBrands(req.filters.brand, req.scope);
    if (brand.length) {
      query.brand = brand;
      query.gate_brand = brand;
    }
    if (req.surface === "global") {
      const countries = urlCountries(req.filters.region, req.scope);
      if (countries.length) query.gate_country = countries;
    }
  }
  try {
    const res = await hghGet("/v1/answers/{job_id}", { pathParams: { job_id: req.jobId }, query, retryOn401: true });
    return toMirrorAnswerDetail(res.data);
  } catch (e) {
    if (isUnavailableError(e)) return { ...UNAVAILABLE };
    throw e;
  }
}
