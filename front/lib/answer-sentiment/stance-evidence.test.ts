import { describe, expect, it } from "vitest";
import path from "node:path";
import { verifyStanceEvidence } from "./stance-evidence";
import { readSourceText } from "@/test/source-text";

// 근거 인용 대조(검증자 F5). 고정하는 명제 하나:
// **"원문에서 확인됨"은 미러 원문과 대조한 결과여야 하고, 코어가 오프셋을 줬다는
// 사실이 아니다.** 파일럿에서 모델 인용의 8.6% 가 원문과 불일치였다 — 오프셋 존재만
// 보면 그 8.6% 를 "원문"이라고 화면에 쓰게 된다.
//
// 그리고 **미확인 ≠ 불일치**: 미러는 1턴 원문만 가지므로 turn>0 은 "틀렸다"가 아니라
// "대조할 원문이 없다"다. 두 상태를 한 문구로 뭉치면 코어 환각과 구조적 한계가 섞인다.

const ANSWER = "현대차는 품질 우려가 함께 지적된다. 기아는 가성비가 좋다.";

describe("verifyStanceEvidence", () => {
  it("① 일치 — 오프셋 슬라이스가 인용문과 같으면 verified", () => {
    const cp = Array.from(ANSWER);
    const quote = "품질 우려가 함께 지적된다";
    const start = cp.join("").indexOf(quote);
    expect(
      verifyStanceEvidence(ANSWER, {
        turnIndex: 0,
        evidenceText: quote,
        evidenceStart: start,
        evidenceEnd: start + Array.from(quote).length,
      }),
    ).toBe("verified");

    // 오프셋이 없어도 원문에 그대로 있으면 verified — 기준은 "대조"이지 "오프셋"이 아니다.
    expect(
      verifyStanceEvidence(ANSWER, {
        turnIndex: 0, evidenceText: quote, evidenceStart: null, evidenceEnd: null,
      }),
    ).toBe("verified");
  });

  it("② 불일치 — 원문에 없는 인용(환각)·오프셋이 다른 구간을 가리키면 mismatch", () => {
    expect(
      verifyStanceEvidence(ANSWER, {
        turnIndex: 0, evidenceText: "배터리 화재가 잦다", evidenceStart: null, evidenceEnd: null,
      }),
    ).toBe("mismatch");
    // 오프셋은 있는데 그 구간의 글자가 인용문과 다르다 — 코어 오프셋이 밀린 경우.
    expect(
      verifyStanceEvidence(ANSWER, {
        turnIndex: 0, evidenceText: "품질 우려가 함께 지적된다", evidenceStart: 0, evidenceEnd: 5,
      }),
    ).toBe("mismatch");
  });

  it("③ turn>0 — 미러에 그 턴 원문이 없다 → unavailable (mismatch 아님)", () => {
    const quote = "품질 우려가 함께 지적된다";
    const start = ANSWER.indexOf(quote);
    // 원문에 **실제로 있는** 인용이어도 turn>0 이면 확인해 주지 않는다: 이 원문은
    // 1턴 것이고, 2턴 답변의 인용이 우연히 여기 있어도 같은 문장이라는 보장이 없다.
    expect(
      verifyStanceEvidence(ANSWER, {
        turnIndex: 1, evidenceText: quote, evidenceStart: start, evidenceEnd: start + Array.from(quote).length,
      }),
    ).toBe("unavailable");
    // 원문이 아예 없을 때(미러 본문 미동기)도 unavailable.
    expect(
      verifyStanceEvidence(null, {
        turnIndex: 0, evidenceText: quote, evidenceStart: null, evidenceEnd: null,
      }),
    ).toBe("unavailable");
    // 인용문 자체가 없으면 대조할 것이 없다.
    expect(
      verifyStanceEvidence(ANSWER, {
        turnIndex: 0, evidenceText: null, evidenceStart: 0, evidenceEnd: 3,
      }),
    ).toBe("unavailable");
  });

  it("④ 음수·역순·범위 밖 오프셋은 확인됨이 아니다", () => {
    const quote = "품질 우려가 함께 지적된다";
    const base = { turnIndex: 0, evidenceText: quote };
    expect(verifyStanceEvidence(ANSWER, { ...base, evidenceStart: -3, evidenceEnd: 9 })).toBe("mismatch");
    expect(verifyStanceEvidence(ANSWER, { ...base, evidenceStart: 20, evidenceEnd: 10 })).toBe("mismatch");
    expect(verifyStanceEvidence(ANSWER, { ...base, evidenceStart: 5, evidenceEnd: 5 })).toBe("mismatch");
    expect(verifyStanceEvidence(ANSWER, { ...base, evidenceStart: 0, evidenceEnd: 9_999 })).toBe("mismatch");
  });

  it("오프셋은 **코드포인트** 기준 — 이모지가 앞에 있어도 슬라이스가 밀리지 않는다", () => {
    const text = "🚗🚙 현대차는 좋다";
    const quote = "현대차는 좋다";
    const start = Array.from(text).indexOf("현"); // 코드포인트 인덱스 3 (UTF-16 이면 5)
    expect(
      verifyStanceEvidence(text, {
        turnIndex: 0, evidenceText: quote, evidenceStart: start, evidenceEnd: start + Array.from(quote).length,
      }),
    ).toBe("verified");
    // UTF-16 인덱스를 그대로 넣으면 슬라이스가 밀려 불일치가 된다(그래서 코드포인트다).
    expect(
      verifyStanceEvidence(text, {
        turnIndex: 0, evidenceText: quote,
        evidenceStart: text.indexOf(quote), evidenceEnd: text.indexOf(quote) + quote.length,
      }),
    ).toBe("mismatch");
  });
});

// ── 읽기 경로 배선 ──────────────────────────────────────────────────────────
// 순수 함수가 맞아도 읽기 경로가 그것을 안 부르면 아무 소용이 없다.
describe("getMirrorAnswerBody — 대조 배선", () => {
  const SRC = readSourceText(
    path.join(process.cwd(), "lib/db/repositories/scope-aggregates.ts"),
  );
  const fn = SRC.slice(SRC.indexOf("export async function getMirrorAnswerBody("));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);

  it("evidenceMatch 는 미러 원문(text)을 넣어 계산한다 — 오프셋 존재로 판정하지 않는다", () => {
    expect(body).toMatch(/evidenceMatch: verifyStanceEvidence\(text, \{/);
    expect(body).not.toMatch(/evidenceVerified: r\.evidenceStart != null/);
  });

  it("턴도 함께 넘긴다 — turn>0 을 unavailable 로 떨어뜨리는 유일한 입력", () => {
    expect(body).toMatch(/verifyStanceEvidence\(text, \{\s*turnIndex: r\.turnIndex \?\? 0,/);
  });
});
