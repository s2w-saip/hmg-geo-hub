import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { MarkdownAnswer, unpaintedToDeliver } from "./markdown-answer";
import type { SentimentSpan } from "@/lib/answer-sentiment/spans";

// 감성 밑줄의 **렌더 실측**. 기존 brand/model 배경 하이라이트와 같은 문장에 겹쳐도
// 둘 다 살아 있어야 한다(밑줄 vs 배경 — 스펙 §1).
const text = "🚗 추천\n\n제네시스 GV70는 정숙성이 뛰어납니다. 다만 연비는 아쉽습니다.";
const cp = Array.from(text);
const sent = "제네시스 GV70는 정숙성이 뛰어납니다.";
const nextSent = "다만 연비는 아쉽습니다.";
const s0 = cp.join("").indexOf(sent) - 1; // 이모지 1개만큼
const spans: SentimentSpan[] = [{
  start: s0, end: s0 + Array.from(sent).length, sentiment: "positive",
  evidence: [{ brandName: "Genesis", sentiment: "positive", assertion: "recommend", descriptors: ["정숙성"], criteria: [], contextSnippet: null }],
}];

const render = (el: React.ReactElement) =>
  renderToStaticMarkup(<NextIntlClientProvider locale="ko" messages={ko}>{el}</NextIntlClientProvider>);

// mark 요소 안에 brand/model mark 가 중첩될 수 있어 `(.*?)<\/mark>` 같은
// non-greedy 정규식은 **첫 내부 mark 의 닫는 태그**에서 멈춰 버린다(내용 잘림).
// 태그 깊이를 세어 짝이 맞는 닫는 태그까지 스캔한다.
function extractBalancedMark(html: string, openTagRegex: RegExp): string {
  const openMatch = openTagRegex.exec(html);
  if (!openMatch) throw new Error("mark not found: " + openTagRegex);
  let i = openMatch.index + openMatch[0].length;
  let depth = 1;
  while (depth > 0) {
    const nextOpen = html.indexOf("<mark", i);
    const nextClose = html.indexOf("</mark>", i);
    if (nextClose === -1) throw new Error("unbalanced <mark> in output");
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 5;
    } else {
      depth--;
      i = depth === 0 ? nextClose : nextClose + 7;
    }
  }
  return html.slice(openMatch.index + openMatch[0].length, i);
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");

describe("MarkdownAnswer — 감성 밑줄", () => {
  it("문장이 감성 mark 로 감싸이고, 브랜드 배경 하이라이트도 그대로 남는다", () => {
    const html = render(<MarkdownAnswer text={text} brandTerms={["제네시스"]} modelTerms={["GV70"]} sentimentSpans={spans} />);
    expect(html).toMatch(/<mark class="geo-ul geo-ul--positive"[^>]*data-sentiment-i="0"/);
    expect(html).toContain("geo-hl--brand");
    expect(html).toContain("geo-hl--model");
  });
  it("꺼진 감성은 칠하지 않는다", () => {
    const html = render(<MarkdownAnswer text={text} brandTerms={[]} modelTerms={[]} sentimentSpans={spans} enabledSentiments={new Set(["negative"])} />);
    expect(html).not.toContain("geo-ul--positive");
  });
  it("span 이 없으면 종전과 동일 — 회귀 0", () => {
    const a = render(<MarkdownAnswer text={text} brandTerms={["제네시스"]} modelTerms={[]} />);
    const b = render(<MarkdownAnswer text={text} brandTerms={["제네시스"]} modelTerms={[]} sentimentSpans={[]} />);
    expect(b).toBe(a);
  });
  it("mark 의 텍스트는 정확히 그 문장이고, 다음 문장은 mark 밖에 있다 (C1 회귀)", () => {
    const html = render(<MarkdownAnswer text={text} brandTerms={["제네시스"]} modelTerms={["GV70"]} sentimentSpans={spans} />);
    const inner = extractBalancedMark(html, /<mark class="geo-ul geo-ul--positive"[^>]*data-sentiment-i="0"[^>]*>/);
    const innerText = stripTags(inner);
    expect(innerText).toBe(sent);
    expect(innerText).not.toContain(nextSent);
    // 문단 전체(<p>…</p>)가 mark 안에 통째로 들어가지 않는다 — 블록이 phrasing 안에
    // 들어가는 비적합 HTML을 만들지 않는다는 뜻.
    expect(inner).not.toContain("<p");
    // 다음 문장은 mark 를 벗어난 자리에서 그대로 나온다.
    const afterMarkIdx = html.indexOf(inner) + inner.length;
    expect(html.slice(afterMarkIdx)).toContain(nextSent);
  });
  it("리스트 항목마다 독립적으로 칠한다 — 블록 하나에 1건만 칠해지던 회귀(C2) 방지", () => {
    const listText = `- ${sent}\n- ${nextSent}`;
    const listCp = Array.from(listText);
    const posStart = listCp.join("").indexOf(sent);
    const negStart = listCp.join("").indexOf(nextSent);
    const listSpans: SentimentSpan[] = [
      {
        start: posStart, end: posStart + Array.from(sent).length, sentiment: "positive",
        evidence: [{ brandName: "Genesis", sentiment: "positive", assertion: null, descriptors: [], criteria: [], contextSnippet: null }],
      },
      {
        start: negStart, end: negStart + Array.from(nextSent).length, sentiment: "negative",
        evidence: [{ brandName: null, sentiment: "negative", assertion: null, descriptors: [], criteria: [], contextSnippet: null }],
      },
    ];
    const html = render(<MarkdownAnswer text={listText} brandTerms={[]} modelTerms={[]} sentimentSpans={listSpans} />);
    // 정확히 2건 — <ul> 통째로 감싸는 회귀라면 1건(양성)만 나오고 음성 span 은
    // 사라진다(joined 텍스트에서 통째로 소비됨).
    const markCount = (html.match(/data-sentiment-i="\d"/g) ?? []).length;
    expect(markCount).toBe(2); // ⇔ unpainted = targets.length(2) - painted.size(2) = 0
    const liMatches = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)];
    expect(liMatches).toHaveLength(2);
    expect(liMatches[0]![1]).toContain('geo-ul--positive');
    expect(liMatches[0]![1]).not.toContain('geo-ul--negative');
    expect(liMatches[1]![1]).toContain('geo-ul--negative');
    expect(liMatches[1]![1]).not.toContain('geo-ul--positive');
  });
  it("같은 문장이 반복돼도 mark 가 중첩되지 않는다 — 발생마다 하나씩 (I2 회귀)", () => {
    const one = "제네시스는 좋습니다.";
    const repeated = `${one} ${one}`;
    const rc = Array.from(repeated).join("");
    const first = rc.indexOf(one);
    const second = rc.indexOf(one, first + one.length);
    const repSpans: SentimentSpan[] = [
      {
        start: first, end: first + Array.from(one).length, sentiment: "positive",
        evidence: [{ brandName: "Genesis", sentiment: "positive", assertion: null, descriptors: [], criteria: [], contextSnippet: null }],
      },
      {
        start: second, end: second + Array.from(one).length, sentiment: "negative",
        evidence: [{ brandName: "Genesis", sentiment: "negative", assertion: null, descriptors: [], criteria: [], contextSnippet: null }],
      },
    ];
    const html = render(<MarkdownAnswer text={repeated} brandTerms={[]} modelTerms={[]} sentimentSpans={repSpans} />);
    // 정확히 2건, 그리고 **중첩 없음** — 중첩 회귀라면 negative mark 안에 positive
    // mark 가 들어가 두 클래스가 한 겹 안에 겹쳐 나온다.
    expect((html.match(/data-sentiment-i="\d"/g) ?? []).length).toBe(2);
    const pos = extractBalancedMark(html, /<mark class="geo-ul geo-ul--positive"[^>]*>/);
    const neg = extractBalancedMark(html, /<mark class="geo-ul geo-ul--negative"[^>]*>/);
    expect(pos).not.toContain("<mark");
    expect(neg).not.toContain("<mark");
    expect(stripTags(pos)).toBe(one);
    expect(stripTags(neg)).toBe(one);
    // 순서: 첫 발생 = positive, 둘째 발생 = negative.
    expect(html.indexOf("geo-ul--positive")).toBeLessThan(html.indexOf("geo-ul--negative"));
  });
  it("짧은 문장도 칠한다 — 길이 하한이 조용히 떨어뜨리지 않는다 (M4 회귀)", () => {
    const shortText = "좋다. 나머지 문장은 충분히 깁니다.";
    const shortSpans: SentimentSpan[] = [{
      start: 0, end: 3, sentiment: "positive",
      evidence: [{ brandName: null, sentiment: "positive", assertion: null, descriptors: [], criteria: [], contextSnippet: null }],
    }];
    const html = render(<MarkdownAnswer text={shortText} brandTerms={[]} modelTerms={[]} sentimentSpans={shortSpans} />);
    expect(html).toContain("geo-ul--positive");
    expect(stripTags(extractBalancedMark(html, /<mark class="geo-ul geo-ul--positive"[^>]*>/))).toBe("좋다.");
  });
  it("칩이 전부 꺼지면 배달값은 0 — 직전 미확인 수가 눌러앉지 않는다 (I3 계약)", () => {
    // 컴포넌트의 useEffect 는 플러그인 토큰을 deps 로 잡고 이 함수로 배달값을 정한다.
    // (jsdom 이 없어 effect 자체는 실측 불가 — 계약을 순수 함수로 고정한다.)
    expect(unpaintedToDeliver(false, 3)).toBe(0);
    expect(unpaintedToDeliver(true, 2)).toBe(2);
    // 칩이 전부 꺼지면 감성 플러그인이 만들어지지 않는다(= hasSentimentPlugin false).
    const html = render(<MarkdownAnswer text={text} brandTerms={[]} modelTerms={[]} sentimentSpans={spans} enabledSentiments={new Set()} />);
    expect(html).not.toContain("geo-ul");
  });
  it(".geo-ul 이 UA 기본 mark 배경/색을 리셋한다 (C1 소스 가드)", () => {
    // CSS 는 렌더 출력에 안 나오므로 소스를 직접 읽어 지킨다. Tailwind preflight 에
    // mark 리셋이 없어 이 두 줄이 빠지면 밑줄 문장이 노란 블록으로 칠해진다.
    const css = readFileSync(fileURLToPath(new URL("../../../../../globals.css", import.meta.url)), "utf-8");
    const at = css.indexOf(".geo-ul {");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("}", at));
    expect(block).toContain("background-color: transparent");
    expect(block).toContain("color: inherit");
  });
  it("node prop 이 DOM 속성으로 새지 않는다 (I2 회귀)", () => {
    const html = render(<MarkdownAnswer text={text} brandTerms={["제네시스"]} modelTerms={["GV70"]} sentimentSpans={spans} />);
    expect(html).not.toContain("node=");
  });
});
