import { describe, it, expect } from "vitest";
import {
  parseQaFilter,
  parseQaNoteFilter,
  qaFilterToQuery,
  isQaFilterActive,
  EMPTY_QA_FILTER,
  fromApiSurface,
  isInvertedRange,
  qaFilterToApiQuery,
  qaNoteFilterToApiQuery,
  toApiSurface,
  QA_SURFACES,
  type QaFilter,
  type QaNoteFilter,
} from "./filters";

// 다중 값 축이 있으므로 왕복 검증은 Record<string, string[]> 로 모은다.
// (Object.fromEntries 로 모으면 마지막 값만 남아 다중 값 축이 소리 없이 깨진다.)
function roundTrip(f: QaNoteFilter): QaNoteFilter {
  const sp = qaFilterToQuery(f);
  const raw: Record<string, string[]> = {};
  sp.forEach((v, k) => {
    (raw[k] ??= []).push(v);
  });
  return parseQaNoteFilter(raw);
}

describe("parseQaFilter", () => {
  it("콤마 목록을 배열로 푼다", () => {
    expect(parseQaFilter({ brand: "Hyundai,Kia" }).brand).toEqual(["Hyundai", "Kia"]);
  });

  it("배열 파라미터도 받는다 (반복 쿼리)", () => {
    expect(parseQaFilter({ engine: ["chatgpt", "gemini"] }).engine).toEqual([
      "chatgpt",
      "gemini",
    ]);
  });

  it("빈 문자열·공백 토큰은 버린다", () => {
    expect(parseQaFilter({ brand: " , ,Kia, " }).brand).toEqual(["Kia"]);
    expect(parseQaFilter({ brand: "" }).brand).toBeUndefined();
  });

  it("어휘 밖 surface / state 값은 버린다", () => {
    expect(parseQaFilter({ surface: "standard,bogus" }).surface).toEqual(["standard"]);
    expect(parseQaFilter({ state: "nope" }).state).toBeUndefined();
  });

  it("날짜는 YYYY-MM-DD 만 통과시킨다", () => {
    expect(parseQaFilter({ from: "2026-08-01" }).from).toBe("2026-08-01");
    expect(parseQaFilter({ from: "2026-8-1" }).from).toBeUndefined();
    expect(parseQaFilter({ to: "drop table" }).to).toBeUndefined();
  });

  it("불리언 축은 '1' 일 때만 true", () => {
    expect(parseQaFilter({ hasNotes: "1" }).hasNotes).toBe(true);
    expect(parseQaFilter({ hasNotes: "0" }).hasNotes).toBeUndefined();
    expect(parseQaFilter({ noMentions: "1" }).noMentions).toBe(true);
  });

  it("검색어는 trim 하고 200자로 자른다", () => {
    expect(parseQaFilter({ q: "  아반떼  " }).q).toBe("아반떼");
    expect(parseQaFilter({ q: "가".repeat(300) }).q?.length).toBe(200);
  });

  it("빈 입력은 EMPTY_QA_FILTER", () => {
    expect(parseQaFilter({})).toEqual(EMPTY_QA_FILTER);
  });
});

describe("parseQaNoteFilter", () => {
  it("노트 고유 축을 더한다", () => {
    const f = parseQaNoteFilter({
      targetKind: "mention,citation",
      severity: "issue",
      includeResolved: "1",
    });
    expect(f.targetKind).toEqual(["mention", "citation"]);
    expect(f.severity).toEqual(["issue"]);
    expect(f.includeResolved).toBe(true);
  });

  it("어휘 밖 targetKind / severity 는 버린다", () => {
    expect(parseQaNoteFilter({ targetKind: "bogus" }).targetKind).toBeUndefined();
    expect(parseQaNoteFilter({ severity: "critical" }).severity).toBeUndefined();
  });
});

describe("qaFilterToQuery ↔ parse 왕복", () => {
  it("모든 축을 보존한다", () => {
    const f: QaNoteFilter = {
      surface: ["standard", "website"],
      brand: ["Hyundai"],
      country: ["KR", "US"],
      engine: ["chatgpt"],
      lang: ["KO"],
      from: "2026-08-01",
      to: "2026-08-31",
      q: "전기차",
      state: ["unreviewed"],
      reviewer: ["홍길동"],
      hasNotes: true,
      noMentions: true,
      targetKind: ["mention"],
      severity: ["issue", "question"],
      includeResolved: true,
    };
    expect(roundTrip(f)).toEqual(f);
  });

  it("빈 필터는 빈 쿼리", () => {
    expect(qaFilterToQuery(EMPTY_QA_FILTER).toString()).toBe("");
    expect(isQaFilterActive(EMPTY_QA_FILTER)).toBe(false);
  });

  it("이름에 콤마가 있어도 왕복한다 — 반복 파라미터를 쓰는 이유", () => {
    expect(roundTrip({ reviewer: ["김, 철수"] }).reviewer).toEqual(["김, 철수"]);
  });

  it("값이 하나라도 있으면 활성으로 본다", () => {
    expect(isQaFilterActive({ engine: ["chatgpt"] })).toBe(true);
    expect(isQaFilterActive({ hasNotes: true })).toBe(true);
  });
});

describe("QaFilter 타입 호환", () => {
  it("답변 필터는 노트 필터로 그대로 쓸 수 있다", () => {
    const f: QaFilter = { brand: ["Kia"] };
    const n: QaNoteFilter = f;
    expect(n.brand).toEqual(["Kia"]);
  });
});

// U12: 화면·URL 어휘 → 백엔드(/v1/qa/*) 쿼리 어휘. URL 은 그대로 두고 보낼 때만 바꾼다.
describe("API 쿼리 어휘 변환", () => {
  it("표면 standard ↔ global 왕복, website·project 는 그대로", () => {
    for (const s of QA_SURFACES) expect(fromApiSurface(toApiSurface(s))).toBe(s);
    expect(QA_SURFACES.map(toApiSurface)).toEqual(["global", "website", "project"]);
  });

  it("답변 필터: 이름 변환·플래그 불리언·중복 제거, 빈 축은 보내지 않는다", () => {
    const f = parseQaFilter({
      surface: ["standard", "project", "standard"],
      brand: ["Kia", "Kia"],
      country: "US",
      engine: "chatgpt",
      lang: "ko",
      from: "2026-09-01",
      to: "2026-09-30",
      q: "suv",
      state: ["unreviewed", "issue"],
      reviewer: ["김, 철수"],
      hasNotes: "1",
      noMentions: "1",
    });
    expect(qaFilterToApiQuery(f)).toEqual({
      surface: ["global", "project"],
      brand: ["Kia"],
      country: ["US"],
      engine: ["chatgpt"],
      lang: ["ko"],
      from: "2026-09-01",
      to: "2026-09-30",
      q: "suv",
      state: ["unreviewed", "issue"],
      reviewer: ["김, 철수"],
      has_notes: true,
      no_mentions: true,
    });
    expect(qaFilterToApiQuery(EMPTY_QA_FILTER)).toEqual({});
  });

  it("노트 필터: target_kind·severity·include_resolved 추가, 기본(미해결만)은 보내지 않는다", () => {
    expect(qaNoteFilterToApiQuery(parseQaNoteFilter({ targetKind: "citation,acr", severity: "info", includeResolved: "1", surface: "website" }))).toEqual({
      surface: ["website"],
      target_kind: ["citation", "acr"],
      severity: ["info"],
      include_resolved: true,
    });
    expect(qaNoteFilterToApiQuery(parseQaNoteFilter({}))).toEqual({});
  });

  it("역순 기간 판정: from > to 만 참", () => {
    expect(isInvertedRange({ from: "2026-09-02", to: "2026-09-01" })).toBe(true);
    expect(isInvertedRange({ from: "2026-09-01", to: "2026-09-01" })).toBe(false);
    expect(isInvertedRange({ from: "2026-09-02" })).toBe(false);
    expect(isInvertedRange({})).toBe(false);
  });
});
