import { describe, expect, it } from "vitest";
import {
  annotateSimilar,
  textSimilarity,
  SIMILARITY_THRESHOLD,
} from "./similarity";
import type { GeneratedPrompt } from "@/components/social-scraping/types";

function gp(id: string, question: string): GeneratedPrompt {
  return {
    id,
    question,
    layer: "L1-context",
    funnelStage: "consideration",
    sourceLabel: "src",
    priority: 50,
  };
}

describe("textSimilarity", () => {
  it("identical texts → 1", () => {
    expect(textSimilarity("7인승 SUV 추천해줘", "7인승 SUV 추천해줘")).toBe(1);
  });

  it("paraphrase sharing core vocabulary clears the threshold", () => {
    const s = textSimilarity(
      "다자녀 가족에게 맞는 7인승 SUV 추천해줘",
      "다자녀 가족용 7인승 SUV 뭐가 좋아?",
    );
    expect(s).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
  });

  it("boilerplate ending alone stays below the threshold", () => {
    const s = textSimilarity(
      "연비 좋은 하이브리드 세단 추천해줘",
      "겨울철 눈길에 강한 4륜구동 추천해줘",
    );
    expect(s).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it("unrelated texts → near 0", () => {
    expect(textSimilarity("전기차 보조금 얼마야?", "회사 근처 맛집 알려줘")).toBeLessThan(
      0.2,
    );
  });
});

describe("annotateSimilar", () => {
  it("attaches the best match above threshold with its kind", () => {
    const [p] = annotateSimilar(
      [gp("a", "다자녀 가족에게 맞는 7인승 SUV 추천해줘")],
      [
        { text: "다자녀 가족용 7인승 SUV 뭐가 좋아?", kind: "prompt" },
        { text: "회사 근처 맛집 알려줘", kind: "candidate" },
      ],
    );
    expect(p.similarTo?.kind).toBe("prompt");
    expect(p.similarTo?.score).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
  });

  it("skips exact matches (handled by the 추가됨 state)", () => {
    const [p] = annotateSimilar(
      [gp("a", "7인승 SUV 추천해줘")],
      [{ text: "7인승 SUV 추천해줘", kind: "candidate" }],
    );
    expect(p.similarTo).toBeUndefined();
  });

  it("leaves prompts untouched when nothing clears the threshold", () => {
    const [p] = annotateSimilar(
      [gp("a", "전기차 보조금 얼마야?")],
      [{ text: "회사 근처 맛집 알려줘", kind: "prompt" }],
    );
    expect(p.similarTo).toBeUndefined();
  });
});
