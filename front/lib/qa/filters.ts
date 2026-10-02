// 검수 목록·노트 화면의 필터 어휘와 URL 인코딩. 순수 함수 — DB·React 의존 없음.
//
// 필터가 걸린 URL 을 복사해 옆 사람에게 주는 것이 곧 일감 분배다(설계 §8.2).
// 그래서 모든 축이 URL 에 살아야 하고, 왕복이 손실 없이 돌아야 한다.

export const QA_SURFACES = ["standard", "website", "project"] as const;
export type QaSurface = (typeof QA_SURFACES)[number];

export const QA_REVIEW_STATES = ["unreviewed", "ok", "issue"] as const;
export type QaReviewState = (typeof QA_REVIEW_STATES)[number];

export const QA_TARGET_KINDS = [
  "answer",
  "prompt",
  "mention",
  "citation",
  "acr",
  "meta",
] as const;
export type QaTargetKind = (typeof QA_TARGET_KINDS)[number];

export const QA_SEVERITIES = ["issue", "question", "info"] as const;
export type QaSeverity = (typeof QA_SEVERITIES)[number];

export type QaFilter = {
  surface?: QaSurface[];
  brand?: string[];
  country?: string[];
  engine?: string[];
  lang?: string[];
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
  q?: string;
  state?: QaReviewState[];
  reviewer?: string[];
  hasNotes?: boolean;
  noMentions?: boolean;
};

// 노트 화면은 답변 필터에 노트 고유 축 셋을 더한다.
export type QaNoteFilter = QaFilter & {
  targetKind?: QaTargetKind[];
  severity?: QaSeverity[];
  includeResolved?: boolean;
};

// 필터 드롭다운을 채우는 값 목록. 리포지토리(server-only)가 만들지만 타입은 여기 둔다 —
// 클라이언트 컴포넌트가 이 타입 하나 때문에 server-only 모듈을 import 하면 안 된다.
export type QaFilterOptionsShape = {
  brand: string[];
  country: string[];
  engine: string[];
  lang: string[];
  reviewer: string[];
};

export const EMPTY_QA_FILTER: QaFilter = {};

type Raw = Record<string, string | string[] | undefined>;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_Q = 200;

function list(v: string | string[] | undefined): string[] | undefined {
  if (v == null) return undefined;
  // 반복 파라미터(?brand=A&brand=B)는 배열로 온다 — 콤마를 값에 쓸 수 있게
  // 이 경로에서는 쪼개지 않는다. 단일 문자열만 콤마 목록으로 해석한다.
  // (검수자 이름에 "김, 철수" 처럼 콤마가 들어갈 수 있다.)
  const parts = Array.isArray(v) ? v : v.split(",");
  const out = parts.map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

function within<T extends string>(
  v: string[] | undefined,
  allowed: readonly T[],
): T[] | undefined {
  if (!v) return undefined;
  const out = v.filter((x): x is T => (allowed as readonly string[]).includes(x));
  return out.length ? out : undefined;
}

function date(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && DATE_RE.test(s) ? s : undefined;
}

function flag(v: string | string[] | undefined): true | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s === "1" ? true : undefined;
}

export function parseQaFilter(sp: Raw): QaFilter {
  const f: QaFilter = {};
  const surface = within(list(sp.surface), QA_SURFACES);
  if (surface) f.surface = surface;
  const brand = list(sp.brand);
  if (brand) f.brand = brand;
  const country = list(sp.country);
  if (country) f.country = country;
  const engine = list(sp.engine);
  if (engine) f.engine = engine;
  const lang = list(sp.lang);
  if (lang) f.lang = lang;
  const from = date(sp.from);
  if (from) f.from = from;
  const to = date(sp.to);
  if (to) f.to = to;
  const rawQ = Array.isArray(sp.q) ? sp.q[0] : sp.q;
  const q = rawQ?.trim().slice(0, MAX_Q);
  if (q) f.q = q;
  const state = within(list(sp.state), QA_REVIEW_STATES);
  if (state) f.state = state;
  const reviewer = list(sp.reviewer);
  if (reviewer) f.reviewer = reviewer;
  if (flag(sp.hasNotes)) f.hasNotes = true;
  if (flag(sp.noMentions)) f.noMentions = true;
  return f;
}

export function parseQaNoteFilter(sp: Raw): QaNoteFilter {
  const f: QaNoteFilter = parseQaFilter(sp);
  const targetKind = within(list(sp.targetKind), QA_TARGET_KINDS);
  if (targetKind) f.targetKind = targetKind;
  const severity = within(list(sp.severity), QA_SEVERITIES);
  if (severity) f.severity = severity;
  if (flag(sp.includeResolved)) f.includeResolved = true;
  return f;
}

export function qaFilterToQuery(f: QaNoteFilter): URLSearchParams {
  const sp = new URLSearchParams();
  // 값마다 append — 콤마가 들어간 검수자 이름이 두 개로 쪼개지지 않는다.
  const push = (k: string, v: readonly string[] | undefined) =>
    v?.forEach((x) => sp.append(k, x));
  push("surface", f.surface);
  push("brand", f.brand);
  push("country", f.country);
  push("engine", f.engine);
  push("lang", f.lang);
  if (f.from) sp.set("from", f.from);
  if (f.to) sp.set("to", f.to);
  if (f.q) sp.set("q", f.q);
  push("state", f.state);
  push("reviewer", f.reviewer);
  if (f.hasNotes) sp.set("hasNotes", "1");
  if (f.noMentions) sp.set("noMentions", "1");
  push("targetKind", f.targetKind);
  push("severity", f.severity);
  if (f.includeResolved) sp.set("includeResolved", "1");
  return sp;
}

// URL 쿼리 문자열(앞의 "?" 없이). 빈 필터면 빈 문자열.
export function qaFilterQueryString(f: QaNoteFilter): string {
  return qaFilterToQuery(f).toString();
}

// 필터에 값이 하나라도 있는가 — "초기화" 버튼 노출 판정.
export function isQaFilterActive(f: QaNoteFilter): boolean {
  return qaFilterToQuery(f).toString().length > 0;
}

// ─── 백엔드 API(/v1/qa/*) 어휘 변환 (U12, 설계 부록 F) ─────────────────────────
//
// 화면·URL 어휘는 그대로 두고(공유된 필터 링크가 계속 열려야 한다) 백엔드로 보낼 때만 바꾼다.
//   surface   standard → global (website·project 는 같음). 목록 쿼리 surface 는 배열.
//   hasNotes·noMentions·includeResolved   "1" 플래그 → has_notes·no_mentions·include_resolved=true
//   targetKind → target_kind, 나머지 축은 같은 이름(값마다 반복)
// 값은 중복 제거만 한다(순서 유지). 개수 상한(brand 20 등)을 넘기면 백엔드가 422 로 거절한다.

export type QaApiSurface = "global" | "website" | "project";

export function toApiSurface(s: QaSurface): QaApiSurface {
  return s === "standard" ? "global" : s;
}

export function fromApiSurface(s: QaApiSurface): QaSurface {
  return s === "global" ? "standard" : s;
}

/** 답변 필터 → /v1/qa/answers·progress·neighbors 쿼리. */
export type QaApiAnswerQuery = {
  surface?: QaApiSurface[];
  brand?: string[];
  country?: string[];
  engine?: string[];
  lang?: string[];
  from?: string;
  to?: string;
  q?: string;
  state?: QaReviewState[];
  reviewer?: string[];
  has_notes?: boolean;
  no_mentions?: boolean;
};

/** 노트 필터 → /v1/qa/notes·counts·export 쿼리. */
export type QaApiNoteQuery = QaApiAnswerQuery & {
  target_kind?: QaTargetKind[];
  severity?: QaSeverity[];
  include_resolved?: boolean;
};

function uniq<T>(v: readonly T[] | undefined): T[] | undefined {
  if (!v?.length) return undefined;
  return [...new Set(v)];
}

export function qaFilterToApiQuery(f: QaFilter): QaApiAnswerQuery {
  const out: QaApiAnswerQuery = {};
  const surface = uniq(f.surface?.map(toApiSurface));
  if (surface) out.surface = surface;
  const brand = uniq(f.brand);
  if (brand) out.brand = brand;
  const country = uniq(f.country);
  if (country) out.country = country;
  const engine = uniq(f.engine);
  if (engine) out.engine = engine;
  const lang = uniq(f.lang);
  if (lang) out.lang = lang;
  if (f.from) out.from = f.from;
  if (f.to) out.to = f.to;
  if (f.q) out.q = f.q;
  const state = uniq(f.state);
  if (state) out.state = state;
  const reviewer = uniq(f.reviewer);
  if (reviewer) out.reviewer = reviewer;
  if (f.hasNotes) out.has_notes = true;
  if (f.noMentions) out.no_mentions = true;
  return out;
}

export function qaNoteFilterToApiQuery(f: QaNoteFilter): QaApiNoteQuery {
  const out: QaApiNoteQuery = qaFilterToApiQuery(f);
  const targetKind = uniq(f.targetKind);
  if (targetKind) out.target_kind = targetKind;
  const severity = uniq(f.severity);
  if (severity) out.severity = severity;
  if (f.includeResolved) out.include_resolved = true;
  return out;
}

/**
 * from > to: 현행 SQL 은 조건이 겹치지 않아 0건을 냈고, 백엔드는 422("from ≤ to")로 거절한다.
 * API 경로는 이 경우 요청하지 않고 현행과 같은 빈 결과를 만든다(lib/hgh/adapters/qa.ts).
 */
export function isInvertedRange(f: QaFilter): boolean {
  return Boolean(f.from && f.to && f.from > f.to);
}
