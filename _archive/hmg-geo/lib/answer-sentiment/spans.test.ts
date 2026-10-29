import { describe, expect, it } from "vitest";
import { buildSentimentSpans, sentenceBounds, type OccurrenceInput } from "./spans";

const EMOJI = "🚗";
const text = `${EMOJI} 추천 정리\n\n제네시스 GV70는 정숙성이 뛰어나 장거리에 적합합니다. 다만 연비는 아쉽습니다.\n- 기아 EV6는 충전이 빠릅니다.`;
const cp = Array.from(text);
const at = (s: string) => cp.join("").indexOf(s) - (cp.join("").slice(0, cp.join("").indexOf(s)).length - Array.from(cp.join("").slice(0, cp.join("").indexOf(s))).length);
// at(): 코드포인트 인덱스 — 이모지 앞 1개만큼 UTF-16 과 어긋난다.

const occ = (over: Partial<OccurrenceInput>): OccurrenceInput => ({
  entityId: "e-genesis", brandRollupEntityId: "e-genesis", brandName: "Genesis",
  // 코드포인트 길이여야 한다 — UTF-16 .length 는 astral 문자가 섞인 surface 에서 어긋난다(리뷰 Minor 6).
  sourceStart: at("제네시스"), sourceEnd: at("제네시스") + Array.from("제네시스 GV70").length,
  surfaceText: "제네시스 GV70", sentiment: "positive", assertion: "recommend",
  contextSnippet: null, descriptors: ["정숙성"], criteria: [], turnIndex: 1, ...over,
});

describe("sentenceBounds", () => {
  it("마침표+공백·줄바꿈·불릿을 경계로 본다", () => {
    const b = sentenceBounds(cp, at("제네시스"), at("제네시스") + 3);
    expect(cp.slice(b.start, b.end).join("")).toBe("제네시스 GV70는 정숙성이 뛰어나 장거리에 적합합니다.");
    const k = sentenceBounds(cp, at("기아"), at("기아") + 2);
    expect(cp.slice(k.start, k.end).join("")).toBe("기아 EV6는 충전이 빠릅니다.");
  });
});

describe("buildSentimentSpans", () => {
  const tracked = new Set(["e-genesis"]);

  it("당사 발생을 포함하는 문장이 그 감성으로 칠해진다", () => {
    const { spans, skipped } = buildSentimentSpans(text, [occ({})], tracked);
    expect(skipped).toBe(0);
    expect(spans).toHaveLength(1);
    expect(cp.slice(spans[0]!.start, spans[0]!.end).join("")).toContain("제네시스 GV70는");
    expect(spans[0]!.sentiment).toBe("positive");
    expect(spans[0]!.evidence[0]!.assertion).toBe("recommend");
  });

  it("필터 밖 브랜드(경쟁사)만 있는 문장은 칠하지 않는다", () => {
    const kia = occ({ entityId: "e-kia", brandRollupEntityId: "e-kia", brandName: "Kia",
      sourceStart: at("기아"), sourceEnd: at("기아") + "기아 EV6".length, surfaceText: "기아 EV6", sentiment: "positive" });
    expect(buildSentimentSpans(text, [kia], tracked).spans).toEqual([]);
  });

  it("같은 문장 안 당사 발생의 감성이 갈리면 혼합, 근거는 둘 다", () => {
    const a = occ({ sentiment: "positive" });
    const b = occ({ entityId: "e-hyundai", brandRollupEntityId: "e-hyundai", brandName: "Hyundai",
      sourceStart: at("GV70"), sourceEnd: at("GV70") + 4, surfaceText: "GV70", sentiment: "negative" });
    const { spans } = buildSentimentSpans(text, [a, b], new Set(["e-genesis", "e-hyundai"]));
    expect(spans).toHaveLength(1);
    expect(spans[0]!.sentiment).toBe("mixed");
    expect(spans[0]!.evidence.map((e) => e.sentiment)).toEqual(["positive", "negative"]);
  });

  it("오프셋 구간의 텍스트가 surface_text 와 다르면 버리고 skipped 를 센다", () => {
    const bad = occ({ sourceStart: 0, sourceEnd: 3 }); // 🚗 추 — surface 와 불일치
    const { spans, skipped } = buildSentimentSpans(text, [bad], tracked);
    expect(spans).toEqual([]);
    expect(skipped).toBe(1);
  });

  it("발생이 없으면 빈 결과 — 회귀 0", () => {
    expect(buildSentimentSpans(text, [], tracked)).toEqual({ spans: [], skipped: 0 });
  });
});

describe("리뷰 회귀 (2026-09-07, 3/6 fix)", () => {
  const tracked = new Set(["e-genesis"]);

  it("Important 1 — 발생 자신의 끝이 종결부호면 다음 문장을 삼키지 않는다", () => {
    const t = "제네시스는 좋은가? 그렇다. 끝.";
    const c = Array.from(t);
    const s = t.indexOf("좋은가");
    const e = s + Array.from("좋은가?").length;
    const b = sentenceBounds(c, s, e);
    expect(c.slice(b.start, b.end).join("")).toBe("제네시스는 좋은가?");
  });

  it("Important 2 — 문장 경계를 가로지르는 오프셋이 있어도 반환된 span 은 서로 겹치지 않는다(유니온 병합)", () => {
    // 정상 발생(mentionA, sentence1 안)과, 데이터 결함으로 sentence1→sentence2 경계를
    // 가로지르는 발생(mentionB) — 둘 다 e-genesis. 겹치면 병합돼야 한다.
    const a = occ({ sentiment: "positive" });
    const straddle = occ({
      sourceStart: at("적합합니다"),
      sourceEnd: at("적합합니다") + Array.from("적합합니다. 다만").length,
      surfaceText: "적합합니다. 다만",
      sentiment: "negative",
    });
    const { spans } = buildSentimentSpans(text, [a, straddle], tracked);
    // 겹치지 않음 불변식 — 정렬된 인접 span 은 항상 end <= 다음 start.
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
    }
    expect(spans).toHaveLength(1);
    expect(spans[0]!.sentiment).toBe("mixed");
    expect(spans[0]!.evidence).toHaveLength(2);
    expect(cp.slice(spans[0]!.start, spans[0]!.end).join("")).toContain("아쉽습니다.");
  });

  it("Minor 3 — 번호 불릿(7자리 숫자)도 창을 넓혀 문장에서 제외한다", () => {
    const t = "1234567) 제네시스는 좋습니다.";
    const c = Array.from(t);
    const gs = t.indexOf("제네시스");
    const b = sentenceBounds(c, gs, gs + Array.from("제네시스").length);
    expect(c.slice(b.start, b.end).join("")).toBe("제네시스는 좋습니다.");
  });

  it("Minor 4 — start === 0(문서 맨 앞)에서도 안전하게 동작한다", () => {
    const b = sentenceBounds(cp, 0, 1); // 🚗 자체를 발생 오프셋으로 준 경우
    expect(b.start).toBe(0);
    expect(cp.slice(b.start, b.end).join("")).toBe(`${EMOJI} 추천 정리`);
  });

  it("같은 문장 안 동일 감성 발생 2건은 혼합이 아니라 근거만 누적된다", () => {
    const a = occ({ assertion: "recommend" });
    const b = occ({
      sourceStart: at("GV70"), sourceEnd: at("GV70") + 4, surfaceText: "GV70",
      assertion: "praise", sentiment: "positive",
    });
    const { spans } = buildSentimentSpans(text, [a, b], tracked);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.sentiment).toBe("positive");
    expect(spans[0]!.evidence).toHaveLength(2);
  });

  it("neutral 발생도 그대로 span 감성에 반영된다", () => {
    const { spans } = buildSentimentSpans(text, [occ({ sentiment: "neutral" })], tracked);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.sentiment).toBe("neutral");
  });

  it("Minor 5 — 음수·역순·범위밖·빈 surface 오프셋은 slice 비교 전에 걸러 skipped 로 센다", () => {
    const negative = occ({ sourceStart: -1, sourceEnd: 3 });
    const reversed = occ({ sourceStart: 5, sourceEnd: 5 }); // end <= start
    const outOfRange = occ({ sourceStart: 0, sourceEnd: cp.length + 10 });
    const emptySurface = occ({ sourceStart: 2, sourceEnd: 2, surfaceText: "" }); // 빈 슬라이스 == 빈 surface(우연 일치)
    const { spans, skipped } = buildSentimentSpans(text, [negative, reversed, outOfRange, emptySurface], tracked);
    expect(spans).toEqual([]);
    expect(skipped).toBe(4);
  });
});
