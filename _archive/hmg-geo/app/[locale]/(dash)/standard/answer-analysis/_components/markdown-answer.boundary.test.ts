import { describe, it, expect } from "vitest";

// 하이라이터 토큰 경계 규칙의 회귀 테스트.
//
// 이 규칙은 두 사고 사이에서 균형을 잡는다:
//   ① "es 폭주" — 짧은 라틴 표기가 "best/uses/series" 안에서 전부 칠해진 사고.
//      → 라틴 문자 경계는 반드시 유지돼야 한다.
//   ② 한국어 무칠 — `\p{L}` 전체를 경계로 삼아 "기아가/기아의/기아차"가 하나도
//      안 칠해진 문제. scope 집계 3건 중 1건만 하이라이트되어 검수가 불가능했다
//      (2026-09-04 GGMD 검수 콘솔에서 발견). 조사가 붙는 언어는 경계에서 빼야 한다.
//
// markdown-answer.tsx 의 정규식과 **같은 식**을 여기서 재현한다. 원본은 rehype
// 플러그인 클로저 안에 있어 직접 import 할 수 없다 — 식이 갈리면 이 테스트가
// 의미를 잃으므로, 바꿀 때는 양쪽을 함께 고친다.
const WORDY_CHAR =
  "[\\p{sc=Latin}\\p{sc=Cyrillic}\\p{sc=Greek}\\p{sc=Arabic}\\p{sc=Hebrew}\\p{N}_]";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function build(terms: string[]): RegExp {
  return new RegExp(
    `(?<!${WORDY_CHAR})(${terms.map(escapeRegExp).join("|")})(?!${WORDY_CHAR})`,
    "giu",
  );
}

function hits(text: string, terms: string[]): string[] {
  const re = build(terms);
  return [...text.matchAll(re)].map((m) => m[0]);
}

describe("한국어 — 조사·접미가 붙어도 칠해진다", () => {
  it.each([
    ["기아 EV6는 좋다.", "공백"],
    ["기아가 발표했다.", "주격조사"],
    ["기아의 전략은", "관형격조사"],
    ["기아를 추천합니다", "목적격조사"],
    ["기아차 라인업", "접미 -차"],
    ["기아자동차는 현대와", "복합어"],
    ["(기아)", "괄호"],
  ])("%s (%s)", (text) => {
    expect(hits(text, ["기아"])).toContain("기아");
  });

  it("라틴 표기 뒤에 한글 조사가 붙어도 칠해진다", () => {
    expect(hits("Kia의 신차", ["Kia"])).toEqual(["Kia"]);
    expect(hits("EV6는 IS와 비교", ["IS"])).toEqual(["IS"]);
  });

  it("한 답변 안의 여러 출현을 모두 잡는다 — scope 집계와 수가 맞아야 한다", () => {
    const body = "기아는 앞서 있다. 기아의 EV6는 인기가 많고, 기아차 전반이 호평이다.";
    expect(hits(body, ["기아"])).toHaveLength(3);
  });
});

describe("라틴 — 단어 내부 부분일치는 계속 막힌다 (es 폭주 회귀 방지)", () => {
  it.each([
    ["the best uses", ["es"]],
    ["vehicles series", ["es"]],
    ["ISO 표준", ["IS"]],
    ["Kian 이라는 이름", ["Kia"]],
  ])("%s 는 칠하지 않는다", (text, terms) => {
    expect(hits(text, terms as string[])).toEqual([]);
  });

  it("독립 토큰일 때는 칠한다", () => {
    expect(hits("Kia EV6", ["Kia"])).toEqual(["Kia"]);
    expect(hits("the ES is fast", ["ES"])).toEqual(["ES"]);
  });

  it("숫자도 경계다 — 모델 코드가 숫자에 먹히지 않게", () => {
    expect(hits("EV60", ["EV6"])).toEqual([]);
    expect(hits("EV6 GT", ["EV6"])).toEqual(["EV6"]);
  });
});

// ── GFM 단일 물결표 취소선 ──────────────────────────────────────────────────
// remark-gfm 기본값(singleTilde: true)은 `~text~` 를 취소선으로 본다. 한국어 답변의
// 범위 표기("3~5월", "9~10월")가 한 문단에 여러 개 있으면 물결표끼리 짝지어져
// <del> 이 되고, 물결표는 delimiter 로 소비돼 사라진다 → 화면에 "35월", "910월".
// 2026-09-04 검수 콘솔에서 실제 답변으로 발견. MarkdownAnswer 는 singleTilde:false 로
// 이를 끈다 — 이 테스트는 그 설정이 유지되는지 본다.
describe("범위 표기 물결표는 취소선으로 먹히지 않는다", () => {
  it("MarkdownAnswer 가 singleTilde 를 끈 채로 remark-gfm 을 넘긴다", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      "app/[locale]/(dash)/standard/answer-analysis/_components/markdown-answer.tsx",
      "utf8",
    );
    expect(src).toContain("singleTilde: false");
    // 옵션이 실제로 remark-gfm 에 전달되는 형태여야 한다(배열 튜플).
    expect(src).toMatch(/remarkPlugins=\{\[\[remarkGfm, GFM_OPTIONS\]/);
  });

  it("mdast 수준 재현 — singleTilde 를 끄면 물결표가 보존된다", async () => {
    const [{ unified }, remarkParse, remarkGfm, remarkBreaks] = await Promise.all([
      import("unified"),
      import("remark-parse").then((m) => m.default),
      import("remark-gfm").then((m) => m.default),
      import("remark-breaks").then((m) => m.default),
    ]);
    const src = "1순위: 3~5월 — 봄철 성수기\n2순위: 9~10월 — 추석 이후";
    const text = (tree: { children?: unknown[] }): string => {
      const walk = (n: Record<string, unknown>): string => {
        if (n.type === "text") return String(n.value);
        if (n.type === "break") return "\n";
        return ((n.children as Record<string, unknown>[]) ?? []).map(walk).join("");
      };
      return ((tree.children as Record<string, unknown>[]) ?? []).map(walk).join("\n");
    };

    const on = unified().use(remarkParse).use(remarkGfm).use(remarkBreaks);
    const off = unified()
      .use(remarkParse)
      .use(remarkGfm, { singleTilde: false })
      .use(remarkBreaks);

    // 기본값은 물결표를 먹는다 (버그 재현)
    expect(text(on.runSync(on.parse(src)))).not.toContain("3~5월");
    // 끄면 원문 그대로 (수정 확인)
    const fixed = text(off.runSync(off.parse(src)));
    expect(fixed).toContain("3~5월");
    expect(fixed).toContain("9~10월");
  });
});
