import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = readFileSync(
  path.join(process.cwd(), "app/[locale]/(dash)/standard/answer-analysis/_components/answer-modal.tsx"),
  "utf8",
);

describe("답변 모달 — 감성 범례/토글 배선", () => {
  it("범례 칩 4개가 토글이고 중립은 기본 꺼짐", () => {
    expect(SRC).toContain('useState<Set<Sentiment>>(new Set(["positive", "negative", "mixed"]))');
    for (const s of ["positive", "negative", "mixed", "neutral"]) expect(SRC).toContain(`toggleSentiment("${s}")`);
  });
  it("MarkdownAnswer 에 span·토글·미확인 콜백이 배선된다", () => {
    expect(SRC).toMatch(/sentimentSpans=\{body\.detail\.sentiment\?\.spans/);
    expect(SRC).toContain("enabledSentiments={enabledSentiments}");
    expect(SRC).toContain("onSentimentUnpainted=");
  });
  it("미확인 캡션은 count > 0 일 때만", () => {
    expect(SRC).toMatch(/unpainted\s*>\s*0/);
  });
  it("미확인 수는 jobId 별 상태로 관리 — 부모 리셋이 자식 전달값을 덮지 않는다", () => {
    expect(SRC).toContain("unpaintedByJob[");
    expect(SRC).not.toContain("setUnpainted(0)");
  });
});
