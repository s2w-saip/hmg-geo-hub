"use client";

import { useEffect, useMemo, useRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
// 단일 개행 → <br> (2026-08-06 고객 피드백: 답변 화면 깨짐). scope 답변에는
// plain-text 에 가까운 단일 개행 본문이 섞여 있는데, 표준 마크다운 규칙은 이를
// 공백으로 접어 문단이 한 덩어리로 뭉친다.
import remarkBreaks from "remark-breaks";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { Sentiment, SentimentSpan } from "@/lib/answer-sentiment/spans";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// Renders a real AI answer body as markdown and paints the drilled brand + the
// models that scope's ontology rolls up to it like a highlighter pen.
//
// The highlighting is a tiny rehype plugin (no extra dep): it walks the hast
// tree and splits every text node on the matched surface forms, wrapping each
// hit in a <mark> tagged brand vs model so two-tone CSS + a staggered sweep
// animation (.geo-hl in globals.css) can light them up. Code / pre / existing
// marks are skipped so we never rewrite literal code or double-wrap.

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const SKIP_TAGS = new Set(["code", "pre", "script", "style", "mark"]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Builds a unified rehype plugin bound to the given terms, or null when there is
// nothing to highlight (caller then renders plain markdown).
function makeHighlightPlugin(brandTerms: string[], modelTerms: string[]) {
  const kind = new Map<string, "brand" | "model">();
  // Short surfaces (≤3 chars — e.g. the Lexus model codes "IS"/"ES") collide with
  // ordinary words ("is", or "es" inside "best/uses/series/…"). For those we keep
  // the ORIGINAL-CASE forms and only accept an exact-case hit, so the English word
  // never lights up — only the real uppercase model token does. This is the fix
  // for the "es 폭주" (every "es" painted) report.
  const shortForms = new Map<string, Set<string>>();
  const add = (raw: string, k: "brand" | "model") => {
    const t = raw.trim();
    const lc = t.toLowerCase();
    if (lc.length < 2) return; // 1-char surfaces are pure noise
    kind.set(lc, k);
    if (lc.length <= 3) {
      const set = shortForms.get(lc) ?? new Set<string>();
      set.add(t);
      shortForms.set(lc, set);
    }
  };
  // model first, then brand so an exact brand surface always wins its color
  for (const t of modelTerms) add(t, "model");
  for (const t of brandTerms) add(t, "brand");
  const terms = [...kind.keys()].sort((a, b) => b.length - a.length); // longest first
  if (terms.length === 0) return null;
  // Token boundaries, script-aware. A surface must not match inside a longer word
  // — that is what stops "es" painting every "best/uses/vehicles".
  //
  // ⚠️ The guard blocks only scripts that SEPARATE WORDS WITH SPACES. It used to be
  // `\p{L}` (any letter), which silently broke every agglutinative language: Korean
  // attaches 조사/접미 directly to the noun, so "기아가"·"기아의"·"기아차"·"Kia의" all
  // failed the trailing check and stayed unpainted. Only a surface followed by a
  // space or punctuation lit up — in Korean prose that is the exception, not the
  // rule (2026-09-04: an answer with mention_count 3 showed exactly 1 highlight,
  // and scope's own record confirmed all three occurrences were the surface "기아").
  // Hangul/Han/Kana are therefore NOT boundaries; Latin/Cyrillic/Greek/Arabic/Hebrew
  // and digits still are, so the "es 폭주" regression stays fixed.
  //
  // Must be a single-character class: putting a lookahead inside `(?<!…)` makes it
  // zero-width, so it would inspect the character AFTER the position, not before.
  const WORDY_CHAR =
    "[\\p{sc=Latin}\\p{sc=Cyrillic}\\p{sc=Greek}\\p{sc=Arabic}\\p{sc=Hebrew}\\p{N}_]";
  const re = new RegExp(
    `(?<!${WORDY_CHAR})(${terms.map(escapeRegExp).join("|")})(?!${WORDY_CHAR})`,
    "giu",
  );

  function splitText(value: string, counter: { i: number }): HastNode[] {
    re.lastIndex = 0;
    const out: HastNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) {
      const matched = m[0];
      if (matched.length === 0) {
        re.lastIndex++;
        continue;
      }
      const lc = matched.toLowerCase();
      // Reject a short surface unless its case matches a stored form exactly:
      // "is"/"es" as plain words stay text; only "IS"/"ES" the model code lights.
      const forms = shortForms.get(lc);
      if (forms && !forms.has(matched)) continue; // leave as plain text
      if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
      const k = kind.get(lc) ?? "brand";
      const idx = counter.i++;
      out.push({
        type: "element",
        tagName: "mark",
        properties: {
          className: ["geo-hl", k === "model" ? "geo-hl--model" : "geo-hl--brand"],
          style: `--hl-i:${idx % 12}`,
        },
        children: [{ type: "text", value: matched }],
      });
      last = m.index + matched.length;
    }
    if (out.length === 0) return [{ type: "text", value }];
    if (last < value.length) out.push({ type: "text", value: value.slice(last) });
    return out;
  }

  function walk(node: HastNode, counter: { i: number }): void {
    if (!Array.isArray(node.children)) return;
    if (node.tagName && SKIP_TAGS.has(node.tagName)) return;
    const next: HastNode[] = [];
    for (const child of node.children) {
      if (child.type === "text" && typeof child.value === "string") {
        next.push(...splitText(child.value, counter));
      } else {
        walk(child, counter);
        next.push(child);
      }
    }
    node.children = next;
  }

  return function rehypeHighlightTerms() {
    return function transform(tree: HastNode) {
      walk(tree, { i: 0 });
    };
  };
}

const DEFAULT_ENABLED: ReadonlySet<Sentiment> = new Set(["positive", "negative", "mixed"]);

// 미확인(못 칠한) 문장 수의 **배달값**. 감성 플러그인이 없으면(스팬 0 또는 칩 전부 off)
// rehype transform 이 아예 안 돌아 ref 가 갱신되지 않는다 — 그대로 배달하면 직전 렌더의
// 수가 캡션에 눌러앉는다. 그 경우 0 을 배달한다(리뷰 I3).
//
// 컴포넌트의 useEffect 배선(토큰 deps)은 jsdom 없이는 실측할 수 없어(이 리포의 vitest
// environment 는 node) 순수 함수로 떼어 계약만 테스트한다.
export function unpaintedToDeliver(hasSentimentPlugin: boolean, lastTransformCount: number): number {
  return hasSentimentPlugin ? lastTransformCount : 0;
}

// 감성 밑줄 플러그인이 건너뛰지 않을 태그 집합. brand/model 하이라이트 플러그인의
// SKIP_TAGS 와 달리 `mark` 를 뺀다 — 문장 안에 브랜드 mark 가 있어도 그 텍스트를
// 이어 붙여 문장을 찾아야 한다(§ 아래 paintIn 주석).
const SENTIMENT_SKIP_TAGS = new Set(["code", "pre", "script", "style"]);

// 인라인(phrasing) 요소만 이 집합에 있다 — 이 태그로만 이루어진 자식 목록이면
// "매칭을 시도해도 되는" 최내부 컨테이너로 본다. p/li/ul/블록 요소는 여기 없다 —
// 그런 요소를 통째로 <mark> 로 감싸면 블록이 phrasing 안에 들어가는 비적합
// HTML(`<mark><p>…</p></mark>`)이 나온다(리뷰 C1).
const PHRASING_TAGS = new Set(["mark", "a", "strong", "em", "code", "br", "span"]);

function isAllPhrasing(children: HastNode[]): boolean {
  return children.every(
    (c) => c.type === "text" || (c.type === "element" && !!c.tagName && PHRASING_TAGS.has(c.tagName)),
  );
}

// 문장 단위 감성 밑줄 플러그인. 원문 오프셋을 HAST 위치로 직접 옮길 수 없다 —
// react-markdown 이 마크다운 문법(**, #, "- ")을 벗기면서 텍스트가 줄어든다. 그래서
// span 의 **문장 텍스트**를 문장이 실제로 담기는 최내부 phrasing 컨테이너(p/li 등의
// 자식 목록 — 텍스트와 인라인 요소만으로 구성된 목록)의 자식 텍스트를 이어 붙인
// 문자열 안에서 찾는다 — brand/model mark 가 문장 안에 있어도(흔하다 — 문장에
// 브랜드명이 있으니까) 그 children 텍스트까지 이어 붙여 찾고, 찾은 범위에 걸친
// 자식 노드들을 통째로 하나의 감성 mark 요소로 감싼다. 경계가 **텍스트 노드**
// 중간에서 시작/끝나면 그 텍스트 노드를 쪼개 정확한 경계에서 감싼다(리뷰 C1 —
// 한 텍스트 노드에 두 문장이 이어 붙어 있을 때 뒤 문장까지 삼키는 사고 방지).
// 경계가 인라인 요소(브랜드/모델 mark 등) **내부**에서 시작/끝나면 그 요소는
// 쪼개지 않고 통째로 포함한다 — 흔치 않은 경우이고, mark 를 쪼개면 브랜드 강조가
// 깨진다.
//
// 트리는 **먼저 재귀해 들어가고**(code/pre/script/style 만 건너뜀), 자식이 전부
// phrasing 일 때만 그 레벨에서 매칭을 시도한다 — p 나 li 자체는 phrasing 태그가
// 아니라서 재귀 대상이고, 그 "자식 목록"이 phrasing 이면 그 자식 목록 안에서 문장을
// 찾는다(블록 하나를 통째로 감싸는 C1, 블록 하나당 1건만 칠해지는 C2 둘 다 이
// 구조에서 나오지 않는다 — ul 요소는 phrasing 이 아니므로 각 li 요소로 내려가
// li 요소마다 독립적으로 매칭한다). 방금 만든 감성 mark 안으로는 다시 내려가지
// 않지만(재매칭·중복 방지), 같은 phrasing 컨테이너 안의 나머지 형제 문장은 계속
// 찾는다(matched 갱신 후 while 루프 재시도).
//
// 문장이 마크다운 문법 안에서 갈려(`**정숙성**` 처럼) 어느 phrasing 컨테이너 안에서도
// 안 찾아지면 그 span 은 칠하지 않는다 — 조용히 엉뚱한 문장을 칠하는 것보다 낫다.
// 못 칠한 수는 onUnpainted 로 올린다(모달 캡션).
function makeSentimentPlugin(
  answerText: string,
  spans: SentimentSpan[],
  enabled: ReadonlySet<Sentiment>,
  onUnpainted: (n: number) => void,
) {
  const cp = Array.from(answerText);
  const targets = spans
    .map((s, i) => ({ i, text: cp.slice(s.start, s.end).join("").trim(), sentiment: s.sentiment }))
    // 길이 하한 없음(리뷰 M4). `>= 4` 를 두면 짧은 문장이 **칠해지지도 않고 미확인
    // 수에도 안 잡혀** 조용히 사라졌다. 빈 문자열만 뺀다 — indexOf("") 는 항상 0 이라
    // 아무 자리나 칠해 버린다.
    .filter((t) => t.text.length > 0 && enabled.has(t.sentiment));
  if (targets.length === 0) return null;

  function textOf(n: HastNode): string {
    if (n.type === "text") return n.value ?? "";
    return Array.isArray(n.children) ? n.children.map(textOf).join("") : "";
  }

  // phrasing 컨테이너(kids 전부가 텍스트/인라인 요소) 안에서 문장을 반복 탐색한다.
  // 한 문장을 감싸면 flat/joined 를 갱신해 같은 컨테이너의 다음 문장도 계속 찾는다.
  function paintPhrasing(kids: HastNode[], painted: Set<number>): void {
    const flat = kids.map((k) => textOf(k));
    let progressed = true;
    while (progressed) {
      progressed = false;
      const joined = flat.join("");
      for (const t of targets) {
        if (painted.has(t.i)) continue;
        const at = joined.indexOf(t.text);
        if (at < 0) continue;
        const end = at + t.text.length;
        if (end <= at || end > joined.length) continue;

        // 자식 경계 [a, b] 를 자식별 시작 오프셋(starts)으로 정확히 찾는다.
        const starts: number[] = [];
        let pos = 0;
        for (let k = 0; k < kids.length; k++) { starts.push(pos); pos += flat[k]!.length; }
        let a = -1, b = -1;
        for (let k = 0; k < kids.length; k++) {
          const s = starts[k]!;
          const e = s + flat[k]!.length;
          if (a < 0 && at < e) a = k;
          if (end > s) b = k;
        }
        if (a < 0 || b < a) continue;
        const aOffset = at - starts[a]!;
        const bOffset = end - starts[b]!;

        // 경계가 텍스트 노드 **중간**이면 쪼갠다 — 그러지 않으면 다음 문장(자식
        // 경계 안쪽 나머지 텍스트)까지 mark 안으로 통째로 딸려 들어간다(리뷰 C1
        // 정확 재현: 문단 끝 텍스트 노드 하나에 두 문장이 이어 붙어 있을 때, 첫
        // 문장만 칠하려던 것이 두 번째 문장까지 삼켰다). b 를 먼저 쪼갠다 —
        // 인덱스가 a 보다 크거나 같아 앞쪽(a) 인덱스에 영향을 주지 않는다.
        if (kids[b]!.type === "text" && bOffset < flat[b]!.length) {
          const val = flat[b]!;
          kids.splice(b, 1, { type: "text", value: val.slice(0, bOffset) }, { type: "text", value: val.slice(bOffset) });
          flat.splice(b, 1, val.slice(0, bOffset), val.slice(bOffset));
        }
        if (kids[a]!.type === "text" && aOffset > 0) {
          const val = flat[a]!;
          kids.splice(a, 1, { type: "text", value: val.slice(0, aOffset) }, { type: "text", value: val.slice(aOffset) });
          flat.splice(a, 1, val.slice(0, aOffset), val.slice(aOffset));
          a += 1; // 앞쪽 조각이 새로 끼어들었으니 매칭 시작 인덱스가 하나 밀린다
          b += 1; // b 도 a 이후(또는 a 와 같음)라 함께 밀린다
        }

        const wrapped: HastNode = {
          type: "element",
          tagName: "mark",
          properties: { className: ["geo-ul", `geo-ul--${t.sentiment}`], "data-sentiment-i": String(t.i) },
          children: kids.slice(a, b + 1),
        };
        kids.splice(a, b - a + 1, wrapped);
        // 칠한 자리는 flat 에서 **매칭 불가능한 동일 길이 placeholder** 로 바꾼다
        // (리뷰 I2). t.text 를 그대로 넣으면 같은 문장이 반복되는 답변에서
        // joined.indexOf 가 **이미 감싼 mark** 를 다시 집어 <mark><mark>…</mark></mark>
        // 로 중첩된다(span0=첫 발생, span1=둘째 발생인데 둘 다 첫 발생 위로). NUL 은
        // 문장 텍스트에 나올 수 없고 길이가 같아 뒤쪽 오프셋이 흐트러지지 않는다.
        flat.splice(a, b - a + 1, "\u0000".repeat(t.text.length));
        painted.add(t.i);
        progressed = true;
        break; // kids/flat 이 바뀌었으니 joined 를 다시 만들어 재시도
      }
    }
  }

  function paintIn(parent: HastNode, painted: Set<number>): void {
    if (!Array.isArray(parent.children)) return;
    if (parent.tagName && SENTIMENT_SKIP_TAGS.has(parent.tagName)) return;
    const kids = parent.children;
    if (isAllPhrasing(kids)) {
      paintPhrasing(kids, painted);
      return;
    }
    // phrasing 이 아니면(블록 자식을 품고 있으면) 먼저 각 자식으로 내려간다 —
    // 방금 만든 감성 mark 는 이미 phrasing 매칭이 끝난 결과이므로 다시 내려가지 않는다.
    for (const k of kids) {
      if (k.type === "element") paintIn(k, painted);
    }
  }

  return function rehypeSentimentUnderline() {
    return function transform(tree: HastNode) {
      const painted = new Set<number>();
      paintIn(tree, painted);
      onUnpainted(targets.length - painted.size);
    };
  };
}

// On-brand prose styling via the component map (the repo has no typography
// plugin and forbids hex literals — every class resolves to a design token).
const markdownComponents: Components = {
  h1: ({ children }) => (
    <h1 className="font-head text-base font-semibold tracking-tight text-foreground">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="font-head text-[0.95rem] font-semibold tracking-tight text-foreground">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-sm font-semibold tracking-tight text-foreground">{children}</h3>
  ),
  // break-words / break-all: 답변 속 긴 원시 URL·비분절 토큰이 모달(DialogContent
  // overflow-hidden)을 밀어 본문이 잘려 보이던 것 방지 (2026-08-06 고객 피드백:
  // AI 답변 화면 깨짐의 렌더 축).
  p: ({ children }) => <p className="text-sm leading-relaxed break-words text-foreground">{children}</p>,
  ul: ({ children }) => <ul className="ml-1 flex list-disc flex-col gap-1 pl-4 text-sm break-words text-foreground marker:text-muted-foreground">{children}</ul>,
  ol: ({ children }) => <ol className="ml-1 flex list-decimal flex-col gap-1 pl-4 text-sm break-words text-foreground marker:text-muted-foreground">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed break-words">{children}</li>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="break-all text-brand-700 underline underline-offset-2 hover:text-brand-500">
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  hr: () => <hr className="my-1 border-border" />,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border pl-3 text-sm text-muted-foreground">{children}</blockquote>
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = typeof className === "string" && className.includes("language-");
    if (isBlock) {
      return (
        <code className={cn("font-mono text-[0.8rem]", className)} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-md bg-muted p-3 text-[0.8rem] leading-relaxed text-foreground">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/40 text-left">{children}</thead>,
  th: ({ children }) => <th className="border-b border-border px-2.5 py-1.5 font-semibold text-foreground">{children}</th>,
  td: ({ children }) => <td className="border-b border-border px-2.5 py-1.5 align-top text-foreground">{children}</td>,
};

// GFM 의 **단일 물결표 취소선**(`~text~`)을 끈다. 기본값(true)이면 한국어 답변의
// 범위 표기가 조용히 파괴된다 — 한 문단 안의 `~` 들이 짝지어져 <del> 이 되고,
// 물결표는 delimiter 로 소비돼 사라진다:
//
//   "1순위: 3~5월 … 2순위: 9~10월"  →  "1순위: 3<del>5월 … 2순위: 9</del>10월" /* i18n-ignore: 주석 예시 */
//                                  →  화면에는 "35월", "910월"
//
// 짝이 맞아야 발동하므로 어떤 물결표는 살아남고 어떤 건 사라진다 — 2026-09-04
// 검수 콘솔에서 발견됐을 때 "35월"과 "1~2월"이 한 답변에 공존한 이유다.
// `~~취소선~~`(이중)은 그대로 동작한다. AI 답변에서 단일 물결표로 취소선을 의도하는
// 경우는 사실상 없고, 범위 표기는 한국어·일본어 답변에 흔하다.
const GFM_OPTIONS = { singleTilde: false } as const;

export function MarkdownAnswer({
  text,
  brandTerms,
  modelTerms,
  className,
  sentimentSpans,
  enabledSentiments,
  onSentimentUnpainted,
}: {
  text: string;
  brandTerms: string[];
  modelTerms: string[];
  className?: string;
  sentimentSpans?: SentimentSpan[];
  enabledSentiments?: ReadonlySet<Sentiment>;
  onSentimentUnpainted?: (n: number) => void;
}) {
  const plugin = useMemo(
    () => makeHighlightPlugin(brandTerms, modelTerms),
    [brandTerms, modelTerms],
  );
  // 못 칠한 수는 렌더 중(rehype transform 안)에 확정되지만, 그 자리에서 바로
  // onSentimentUnpainted 를 부르면 부모 setState 가 렌더 도중 실행될 수 있다 —
  // ref 에 적어 두고 커밋 후 useEffect 에서 알린다(리뷰 I3).
  const unpaintedRef = useRef(0);
  // 순서 고정: brand/model 먼저, 감성 나중. brand/model 플러그인의 SKIP_TAGS 에
  // `mark` 가 있어 감성 mark 가 먼저 생기면 그 안의 브랜드명이 배경색을 못 받는다.
  // deps 에 onSentimentUnpainted 를 넣지 않는다 — ref 로 넘기므로 콜백 아이덴티티가
  // 플러그인 재생성을 유발할 이유가 없다(리뷰 M1).
  // 플러그인을 **토큰과 함께** 새 객체로 만든다(리뷰 I3). deps 를 `unpaintedRef.current`
  // 로 잡으면 effect 가 한 렌더 뒤처진다 — 이번 렌더의 transform 이 쓴 값이 아니라
  // 지난 렌더 시점에 평가된 값으로 비교되기 때문이다. 토큰은 플러그인이 다시 만들어질
  // 때(=transform 이 다시 돌 때)마다 아이덴티티가 바뀌므로, effect 는 정확히 "새로
  // 칠한 렌더" 뒤에 한 번 돈다.
  const sentimentPlugin = useMemo(
    () => ({
      fn: sentimentSpans?.length
        ? makeSentimentPlugin(text, sentimentSpans, enabledSentiments ?? DEFAULT_ENABLED, (n) => {
            unpaintedRef.current = n;
          })
        : null,
      token: {},
    }),
    [text, sentimentSpans, enabledSentiments],
  );
  // 커밋 후에 알린다 — transform 안에서 바로 부르면 부모 setState 가 렌더 도중 실행된다.
  // fn 이 null 이면(스팬 0 또는 칩 전부 off) transform 자체가 안 돌아 ref 가 갱신되지
  // 않으므로 **직전 값이 눌러앉는다** → 명시적으로 0 을 배달한다(unpaintedToDeliver).
  useEffect(() => {
    onSentimentUnpainted?.(unpaintedToDeliver(sentimentPlugin.fn !== null, unpaintedRef.current));
  }, [sentimentPlugin, onSentimentUnpainted]);
  const rehype = [plugin, sentimentPlugin.fn].filter(Boolean) as NonNullable<typeof plugin>[];
  const components = useMemo(
    () => (sentimentSpans?.length ? { ...markdownComponents, mark: sentimentMark(sentimentSpans) } : markdownComponents),
    [sentimentSpans],
  );
  return (
    <TooltipProvider delayDuration={150}>
      <div className={cn("flex flex-col gap-2.5", className)}>
        <ReactMarkdown
          remarkPlugins={[[remarkGfm, GFM_OPTIONS], remarkBreaks]}
          rehypePlugins={rehype}
          components={components}
        >
          {text}
        </ReactMarkdown>
      </div>
    </TooltipProvider>
  );
}

// <mark> 컴포넌트 매핑 — 감성 mark 만 툴팁을 단다(brand/model mark 는 data 속성이
// 없어 그대로 <mark> 로 렌더).
function sentimentMark(spans: SentimentSpan[]): Components["mark"] {
  // `node` 를 구조분해로 빼내 버린다 — react-markdown v9 는 모든 컴포넌트에 hast
  // `node` prop 을 얹어 주는데, 그대로 `{...props}` 를 DOM 엘리먼트에 뿌리면
  // React 가 `node="[object Object]"` 를 실제 속성으로 찍는다(brand/model mark 도
  // 이 컴포넌트 맵 없이 그대로 <mark> 로 렌더되므로 이 함수를 거치는 모든 mark —
  // 감성이든 아니든 — 가 영향을 받는다. 리뷰 I2).
  return function SentimentMark({ children, node: _node, ...props }) {
    const idx = (props as Record<string, unknown>)["data-sentiment-i"];
    const span = typeof idx === "string" ? spans[Number(idx)] : undefined;
    if (!span) return <mark {...props}>{children}</mark>;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <mark {...props} tabIndex={0}>{children}</mark>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-sm text-left">
          <SentimentEvidenceList span={span} />
        </TooltipContent>
      </Tooltip>
    );
  };
}

function SentimentEvidenceList({ span }: { span: SentimentSpan }) {
  const t = useTranslations("answerAnalysis.mentions.answerModal.sentiment");
  return (
    <div className="flex flex-col gap-1.5">
      {span.evidence.map((e, i) => (
        <div key={i} className="flex flex-col gap-0.5">
          <div className="font-semibold">
            {t(`label.${e.sentiment}`)}
            {e.brandName ? ` · ${e.brandName}` : ""}
          </div>
          {e.assertion ? <div>{t("assertion")}: {e.assertion}</div> : null}
          {e.descriptors.length ? <div>{t("descriptors")}: {e.descriptors.join(", ")}</div> : null}
          {e.criteria.length ? <div>{t("criteria")}: {e.criteria.join(", ")}</div> : null}
          {e.contextSnippet ? <div className="opacity-80">{t("context")}: &ldquo;{e.contextSnippet}&rdquo;</div> : null}
        </div>
      ))}
    </div>
  );
}
