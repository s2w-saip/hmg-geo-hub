// 답변 원문 감성 밑줄 — 발생(occurrence) 을 **문장 단위 span** 으로 접는 순수 로직.
// 스펙: internal-kb/hmg-geo-answer-sentiment-underline-spec-2026-09-07.md §3.
//
// 왜 문장인가 — 판단 근거는 문장 안에 있다. context_snippet 은 원문 verbatim 비율이
// 13% 라 구간으로 못 쓴다(2026-09-07 실측). 오프셋(코드포인트)이 유일한 정본이다.
//
// 지키는 규칙:
//  · 필터 브랜드 우선 — trackedEntityIds 로 롤업되는 발생만 남긴다(경쟁사만 있는 문장은 무색).
//  · 같은 문장에 남은 발생의 감성이 갈리면 혼합, 근거는 전부 싣는다.
//  · 구간 텍스트 ≠ surface_text 인 발생은 **칠하지 않는다**(엉뚱한 자리 방지) + skipped 로 센다.

export type Sentiment = "positive" | "negative" | "mixed" | "neutral";

export interface OccurrenceInput {
  entityId: string;
  brandRollupEntityId: string | null;
  brandName: string | null;
  sourceStart: number;
  sourceEnd: number;
  surfaceText: string;
  sentiment: Sentiment;
  assertion: string | null;
  contextSnippet: string | null;
  descriptors: string[];
  criteria: string[];
  turnIndex: number | null;
}

export interface SentimentEvidence {
  brandName: string | null;
  sentiment: Sentiment;
  assertion: string | null;
  descriptors: string[];
  criteria: string[];
  contextSnippet: string | null;
}

export interface SentimentSpan {
  start: number; // 코드포인트, 문장 시작
  end: number;   // 코드포인트, 문장 끝(배타)
  sentiment: Sentiment;
  evidence: SentimentEvidence[];
}

// 문장 끝 = 종결 부호 뒤 공백/줄끝, 또는 줄바꿈. 시작 = 직전 경계 다음(불릿·번호 제외).
const TERMINAL = new Set([".", "!", "?", "。", "！", "？"]);
const BULLET_PREFIX = /^(\s*(?:[-*•]|\d+[.)])\s+)/u;

export function sentenceBounds(
  cp: string[],
  start: number,
  end: number,
): { start: number; end: number } {
  let s = start;
  while (s > 0) {
    const prev = cp[s - 1]!;
    if (prev === "\n") break;
    if (TERMINAL.has(prev) && (s >= cp.length || /\s/u.test(cp[s]!))) break;
    s--;
  }
  // 줄 머리의 불릿·번호는 문장에 넣지 않는다. 창은 그 줄 끝(또는 64cp)까지 —
  // 좁은 고정폭은 긴 들여쓰기·번호("1234567) ")를 놓친다.
  let lineEnd = s;
  while (lineEnd < cp.length && cp[lineEnd] !== "\n") lineEnd++;
  const windowEnd = Math.min(lineEnd, s + 64, cp.length);
  const lead = BULLET_PREFIX.exec(cp.slice(s, windowEnd).join(""));
  if (lead) s += Array.from(lead[1]!).length;
  // 불릿 스트립이 원래 오프셋(start)을 넘어가면 span 이 자기 발생을 못 담는다 — 되돌린다.
  s = Math.min(s, start);
  while (s < start && /\s/u.test(cp[s]!)) s++;

  // 순방향 스캔은 end 부터가 아니라 발생 자신의 마지막 문자(end-1)부터 검사해야 한다 —
  // end 부터 시작하면 surface_text 자신이 종결부호로 끝나는 경우를 놓친다(리뷰 Important 1).
  let e = Math.max(end, s);
  if (e > s && TERMINAL.has(cp[e - 1]!) && (e >= cp.length || /\s/u.test(cp[e]!))) {
    // 발생 자신의 마지막 문자가 이미 문장 종결 — 더 스캔하지 않는다.
  } else {
    while (e < cp.length) {
      const ch = cp[e]!;
      if (ch === "\n") break;
      e++;
      if (TERMINAL.has(ch) && (e >= cp.length || /\s/u.test(cp[e]!))) break;
    }
  }
  return { start: s, end: e };
}

export function buildSentimentSpans(
  answerText: string,
  occurrences: OccurrenceInput[],
  trackedEntityIds: Set<string>,
): { spans: SentimentSpan[]; skipped: number } {
  const cp = Array.from(answerText);
  let skipped = 0;
  const raw: SentimentSpan[] = [];

  for (const o of occurrences) {
    const own = trackedEntityIds.has(o.entityId) ||
      (o.brandRollupEntityId != null && trackedEntityIds.has(o.brandRollupEntityId));
    if (!own) continue;
    // 오프셋 전제 — 음수·역순·범위밖·빈 surface 는 slice 비교가 우연히 맞을 수 있어
    // (예: 빈 슬라이스 vs 빈 surface) 먼저 걸러야 한다(리뷰 Minor 5).
    if (
      o.sourceStart < 0 || o.sourceEnd <= o.sourceStart || o.sourceEnd > cp.length ||
      o.surfaceText.length === 0
    ) {
      skipped++;
      continue;
    }
    const slice = cp.slice(o.sourceStart, o.sourceEnd).join("");
    if (slice !== o.surfaceText) { skipped++; continue; }

    const b = sentenceBounds(cp, o.sourceStart, o.sourceEnd);
    const ev: SentimentEvidence = {
      brandName: o.brandName, sentiment: o.sentiment, assertion: o.assertion,
      descriptors: o.descriptors, criteria: o.criteria, contextSnippet: o.contextSnippet,
    };
    raw.push({ start: b.start, end: b.end, sentiment: o.sentiment, evidence: [ev] });
  }

  // 겹치지 않음을 불변식으로 강제한다 — 같은 문장이라도 sentenceBounds 결과가
  // 서로 다른 end 를 낼 수 있어 start:end 키만으로는 부분 겹침을 못 잡는다(리뷰 Important 2).
  // 정렬 후 인접 겹침을 유니온: 범위 합집합, 근거 이어붙이기, 감성 불일치는 mixed.
  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  const spans: SentimentSpan[] = [];
  for (const span of raw) {
    const last = spans[spans.length - 1];
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      last.evidence.push(...span.evidence);
      if (last.sentiment !== span.sentiment) last.sentiment = "mixed";
    } else {
      spans.push(span);
    }
  }
  return { spans, skipped };
}
