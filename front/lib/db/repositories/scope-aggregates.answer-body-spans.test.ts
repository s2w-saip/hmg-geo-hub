import { describe, expect, it } from "vitest";
import path from "node:path";
import { readSourceText } from "@/test/source-text";

// 답변 모달 감성 밑줄의 **읽기 경로 가드**. 지키는 것:
//  ① 발생 테이블 읽기는 존재 프로브 뒤에만 — 머지가 db:apply 보다 앞서는 창에서 42P01 방지.
//  ② 당사 판정은 기존 trackedIds(단위 컨텍스트 규칙)를 그대로 쓴다 — 두 번째 판정 규칙 금지.
//  ③ 결과는 순수 로직(buildSentimentSpans)이 만든다 — SQL 안에서 문장을 자르지 않는다.
const SRC = readSourceText(path.join(process.cwd(), "lib/db/repositories/scope-aggregates.ts"));
const fn = SRC.slice(SRC.indexOf("export async function getMirrorAnswerBody("));
const body = fn.slice(0, fn.indexOf("\n}\n") + 3);

describe("getMirrorAnswerBody — 감성 span 읽기 경로", () => {
  it("발생 테이블은 프로브 뒤에만 읽는다", () => {
    expect(body).toContain("mentionOccurrencesAvailable()");
    expect(body.indexOf("mentionOccurrencesAvailable()")).toBeLessThan(body.indexOf("scopeMentionOccurrences)"));
  });
  it("당사 판정은 trackedIds 를 재사용한다", () => {
    expect(body).toMatch(/buildSentimentSpans\([^)]*trackedIds/s);
  });
  it("sentiment 는 발생이 있을 때만 실린다", () => {
    expect(body).toMatch(/\.\.\.\(occRows\.length\s*\?\s*\{\s*sentiment/s);
  });
});
