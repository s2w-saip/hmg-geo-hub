import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseScreenAllowlist,
  resetSummaryScreensForTests,
  summaryScreenAllowed,
  SUMMARY_SCREEN_KEYS,
  SUMMARY_SCREEN_OPT_IN,
  type SummaryScreenKey,
} from "./screens";
import { readScreensRaw } from "@/lib/db/repositories/summary-settings";

vi.mock("@/lib/db/repositories/summary-settings", () => ({
  readScreensRaw: vi.fn(async () => "[]"),
}));

// `read_screens` 파서 — A5(PR① T4) + fail-closed 전환(R3, 2026-09-10).
//
// 두 방향을 동시에 못 박는다:
//   ① `'[]'`(현 프로덕션 시드) 계열은 **전 화면 허용** — 뒤집히면 배포 순간
//      라이브 화면이 전부 미러로 떨어진다(`read_enabled='1'` 로 hit 중).
//   ② 그 밖의 해석 불가 원문은 **전 화면 차단** — 의도를 알 수 없는 값이
//      전 화면 사실표 서빙을 뜻하면 스위치의 기본값 방향이 뒤집힌다.
// 아래 표는 원문 13종의 기대 결과를 통째로 고정한다(원문을 하나 늘리면 여기 추가).

/** 기대 결과 표기: "all"(전 화면 허용) · "none"(전 화면 차단) · 키 목록. */
type Expected = "all" | "none" | SummaryScreenKey[];

const outcome = (raw: string | null | undefined): "all" | "none" | string[] => {
  const { list } = parseScreenAllowlist(raw);
  if (list.allowAll) return "all";
  return list.screens.size === 0 ? "none" : [...list.screens];
};

describe("parseScreenAllowlist — 원문 13종 (R3 fail-closed)", () => {
  const CASES: Array<[label: string, raw: string | null | undefined, want: Expected, warn: string | null]> = [
    // ── 전 화면 허용: 제품 결정의 범위는 이 셋(공백·개행 변형 포함)뿐이다 ──
    ["행 없음(null)", null, "all", null],
    ["undefined(마이그레이션 전 배포)", undefined, "all", null],
    ["빈 문자열", "", "all", null],
    ["공백만", "   ", "all", null],
    ["빈 배열 = 현 프로덕션 시드", "[]", "all", null],
    ["빈 배열 + 공백", " [] ", "all", null],
    ["빈 배열 + 개행", "[]\n", "all", null],
    // ── 전 화면 차단(미러 폴백): 의도를 읽을 수 없는 값 ──
    ["JSON 이 아님", "not json", "none", "not JSON"],
    ["깨진 JSON", "{", "none", "not JSON"],
    ["객체", '{"S1.dashboard":true}', "none", "not a JSON array"],
    ["문자열", '"S1.dashboard"', "none", "not a JSON array"],
    ["숫자", "123", "none", "not a JSON array"],
    ["오타 키뿐", '["S4.dashbord"]', "none", "no known screen key (unknown: S4.dashbord)"],
    ["문자열 아닌 원소뿐", '["", null, 7]', "none", 'no known screen key (unknown: ,null,7)'],
  ];

  it.each(CASES)("%s → %s", (_label, raw, want, warn) => {
    expect(outcome(raw)).toEqual(want);
    expect(parseScreenAllowlist(raw).warn).toBe(warn);
  });

  it("차단은 곧 '아무 화면도 허용 안 함' 이다 (전 키 확인)", () => {
    const { list } = parseScreenAllowlist("not json");
    if (list.allowAll) throw new Error("expected a restricted allowlist");
    for (const k of SUMMARY_SCREEN_KEYS) expect(list.screens.has(k)).toBe(false);
  });
});

describe("parseScreenAllowlist — 명시 배열", () => {
  it("알려진 키만 허용한다", () => {
    const { list, warn } = parseScreenAllowlist('["S4.dashboard"]');
    expect(warn).toBeNull();
    if (list.allowAll) throw new Error("expected a restricted allowlist");
    expect([...list.screens]).toEqual(["S4.dashboard"]);
    expect(list.screens.has("S1.dashboard")).toBe(false);
  });

  it("알려진 키가 하나라도 있으면 미지 키는 무시하고 경고만 남긴다", () => {
    const { list, warn } = parseScreenAllowlist('["S1.dashboard","nope",7]');
    expect(warn).toContain("nope");
    if (list.allowAll) throw new Error("expected a restricted allowlist");
    expect([...list.screens]).toEqual(["S1.dashboard"]);
  });

  it("어휘 전체를 적으면 전부 허용된다(값으로도, 의미로도)", () => {
    const { list } = parseScreenAllowlist(JSON.stringify(SUMMARY_SCREEN_KEYS));
    if (list.allowAll) throw new Error("expected a restricted allowlist");
    expect(list.screens.size).toBe(SUMMARY_SCREEN_KEYS.length);
  });

  it("공백·중복은 정규화된다", () => {
    const { list } = parseScreenAllowlist('[" S2.mention ","S2.mention"]');
    if (list.allowAll) throw new Error("expected a restricted allowlist");
    expect([...list.screens]).toEqual(["S2.mention"]);
  });
});

describe("SUMMARY_SCREEN_KEYS", () => {
  it("어휘는 표면.화면 6종 + S4 배지 전용 1종 + 프로젝트 예약 1종 + PR③ 추이 2종 + PR④ 경쟁사 1종 + 언급 추이 1종 + 기간 비교 1종 + 기간 경로 2종 + 앵커 축 1종 + 추이 격자 1종 + website 자사 단위 1종 + 발행값 1종", () => {
    expect([...SUMMARY_SCREEN_KEYS]).toEqual([
      "S1.dashboard",
      "S2.mention",
      "S3.citation",
      "S4.dashboard",
      // B6 — S4 카드 배지의 Sub-KPI. S5 와 의미론이 달라 따로 켠다(screens.ts 예외 블록).
      "S4.subkpi",
      "S5.mention",
      "S6.citation",
      "P.dashboard",
      "S1.brandTrend",
      "S1.firstPosition",
      // PR④ B1·B2 — 대시보드 카드 하단 경쟁사 행(값 + Δ). 회차 스냅샷으로 통일한다.
      "S1.competitors",
      // 2026-09-17 — 언급 탭 추이 차트만 회차 앵커 축으로(제품 결정). `S2.mention` 과 별개 키다.
      "S2.mentionTrend",
      // GGMD-107 — 기간 비교 Δ 의 단일 스위치(프리셋 끝점 + 창 대 창 산식을 함께 켠다).
      "S1.periodCompare",
      // 2026-09-18: 기간 누적을 집계층이 서빙한다. 리더를 고르는 키가 아니라
      // "기간이 걸린 요청을 회차 집합 모드로 읽을 것인가" 하나다. 표면마다 따로 켠다.
      "S1.periodRoute",
      "S4.periodRoute",
      // 2026-09-19 — 기간 축 전환(0077). 화면 하나가 아니라 리포 전체의 축이라 `X.`.
      "X.answerAnchor",
      // 2026-09-20 — 공용 추이 격자(§4 D2 = A + §7 D5). 축과 같은 `X.` 층이지만
      // 바꾸는 것이 다르다(게이트·자리 목록·창·갭 정책). 값의 원천은 안 바꾼다.
      "X.trendGrid",
      // 2026-09-20 — website 자사 판정 단위(flat 평면 합집합 → 그 프롬프트 유닛의 base).
      // 화면 하나가 아니라 website 표면의 자사 계열 전부가 함께 움직이므로 `X.` 다.
      "X.websiteOwnedUnit",
      // 2026-09-20 — 발행 리포트를 정본으로. 발행 회차의 website 인용 카드가 라이브
      // 집계 대신 발행물의 정수 쌍을 읽는다. 값과 모수가 둘 다 바뀌므로 옵트인이다.
      "X.reportTruth",
    ]);
  });

  // B6 회귀 가드 — 이 키는 **off 로 머지**한다. 켜면 배지 숫자가 바뀐다(미러 ≠ 집계층).
  // 프로덕션 현행값에 이 키가 없어야 배포가 값 무변경이다.
  it("프로덕션 현행 allowlist 에는 S4.subkpi 가 없다 — 배포 시 값 무변경", () => {
    const { list } = parseScreenAllowlist(
      '["S4.dashboard","S1.dashboard","S3.citation","S6.citation"]',
    );
    expect(list.allowAll).toBe(false);
    if (!list.allowAll) {
      expect(list.screens.has("S4.dashboard")).toBe(true);
      expect(list.screens.has("S4.subkpi")).toBe(false);
      expect(list.screens.has("S5.mention")).toBe(false);
      // PR④ 도 같은 계약이다 — 값이 바뀌는 키는 off 로 머지한다.
      expect(list.screens.has("S1.competitors")).toBe(false);
    }
  });

  // 2026-09-17 — 언급 추이 주 격자 키. ⚠️ 프로덕션 현행값에는 이 키가 **이미 들어 있다**
  // (2026-09-17 읽기 전용 실측: `…,"S1.competitors","S2.mentionTrend"]`). 즉 머지 후 배포는
  // 값 무변경이 아니라 **주 배정이 회차 주로 바뀐 상태로 뜬다** — 그 사실을 여기 고정한다.
  // 함께 단언하는 것: 이 키가 켜져도 `S2.mention`(T8, GGMD 대기)은 여전히 꺼져 있다.
  it("프로덕션 현행 allowlist 는 S2.mentionTrend 를 켜고 S2.mention 은 끈다", () => {
    const { list, warn } = parseScreenAllowlist(
      '["S4.dashboard","S1.dashboard","S3.citation","S6.citation","S4.subkpi","S1.competitors","S2.mentionTrend"]',
    );
    expect(warn ?? "").not.toContain("S2.mentionTrend");
    expect(list.allowAll).toBe(false);
    if (!list.allowAll) {
      expect(list.screens.has("S2.mentionTrend")).toBe(true);
      // T8 은 별개 키다 — 추이 키를 켜는 것이 화면 전체 전환을 켜지 않는다.
      expect(list.screens.has("S2.mention")).toBe(false);
      expect(list.screens.has("S5.mention")).toBe(false);
      // 2026-09-18: 기간 경로 두 키 다 현행값에 없다. 머지 시점의 값 무변경 근거다.
      expect(list.screens.has("S1.periodRoute")).toBe(false);
      expect(list.screens.has("S4.periodRoute")).toBe(false);
    }
  });

  it("S4.subkpi 만 추가로 켤 수 있다 — S5 는 그대로 미러", () => {
    const { list, warn } = parseScreenAllowlist(
      '["S4.dashboard","S1.dashboard","S3.citation","S6.citation","S4.subkpi"]',
    );
    expect(warn ?? "").not.toContain("S4.subkpi");
    if (!list.allowAll) {
      expect(list.screens.has("S4.subkpi")).toBe(true);
      expect(list.screens.has("S5.mention")).toBe(false);
    }
  });
});

// ── 옵트인 화면 — 빈 배열(= 전 화면 허용)이 이들에게는 적용되지 않는다 ──────────
// 값의 **산식이 바뀌는** 둘이라 스위치 없이 켜지면 안 된다(`screens.ts` 주석의 근거).
describe("SUMMARY_SCREEN_OPT_IN — 명시해야만 켜진다", () => {
  beforeEach(() => resetSummaryScreensForTests());

  // PR③-a 의 `S4.subkpi` 가 여기 합류했다(#235 D6) — 그 키의 머리 주석이 "옵트인은
  // PR③ 에서 합류한다, 그때까지 `all` 을 쓰지 마라" 라고 적어 둔 그 자리다. 이제
  // `screens all`(= `'[]'`)이 이 키를 켜지 않으므로 그 임시 제약이 풀린다.
  it("옵트인 목록은 열넷: 산식이 바뀌는 셋 + T8 누적 전환 둘 + PR④ 경쟁사 하나 + 언급 추이 하나 + 기간 비교 하나 + 기간 경로 둘 + 앵커 축 하나 + 추이 격자 하나 + website 자사 단위 하나 + 발행값 하나", () => {
    expect([...SUMMARY_SCREEN_OPT_IN].sort()).toEqual([
      "S1.brandTrend", "S1.competitors", "S1.firstPosition", "S1.periodCompare", "S1.periodRoute",
      "S2.mention", "S2.mentionTrend", "S4.periodRoute", "S4.subkpi", "S5.mention",
      "X.answerAnchor", "X.reportTruth", "X.trendGrid", "X.websiteOwnedUnit",
    ]);
  });

  // F2 — T8(누적 → 회차 집합 SUM)은 켜는 조건이 코드가 아니라 **GGMD 확인(P-5)** 이다.
  // 플랜 §6-2 의 계약("코드만 머지, 켜지 않는다")을 `read_screens='[]'` 가 조용히 깨고
  // 있었다: 전 화면 허용이 S2/S5 까지 켜서 화면의 "고유 프롬프트" 계열이 바뀔 수 있었다.
  it("`screens all`(= `[]`)로도 열세 키가 전부 꺼져 있다", async () => {
    vi.mocked(readScreensRaw).mockResolvedValue("[]");
    for (const k of [
      "S1.brandTrend", "S1.competitors", "S1.firstPosition", "S1.periodCompare", "S1.periodRoute",
      "S2.mention", "S2.mentionTrend", "S4.periodRoute", "S4.subkpi", "S5.mention",
      "X.answerAnchor", "X.trendGrid", "X.websiteOwnedUnit",
    ] as const) {
      expect(await summaryScreenAllowed(k), k).toBe(false);
    }
    // 성능만 바뀌는 키는 그대로 켜진다 — 옵트인이 전 화면을 잠그면 안 된다.
    expect(await summaryScreenAllowed("S1.dashboard")).toBe(true);
    expect(await summaryScreenAllowed("S4.dashboard")).toBe(true);
  });

  it("빈 배열(전 화면 허용)에서도 옵트인 화면은 꺼져 있다", async () => {
    vi.mocked(readScreensRaw).mockResolvedValue("[]");
    expect(await summaryScreenAllowed("S1.dashboard")).toBe(true);
    expect(await summaryScreenAllowed("S1.brandTrend")).toBe(false);
    expect(await summaryScreenAllowed("S1.firstPosition")).toBe(false);
    // #235 D6 — `screens all` 이 배지 숫자를 바꾸지 않는다.
    expect(await summaryScreenAllowed("S4.subkpi")).toBe(false);
    expect(await summaryScreenAllowed("S4.dashboard")).toBe(true);
  });

  it("행 자체가 없어도(기본값) 꺼져 있다", async () => {
    vi.mocked(readScreensRaw).mockResolvedValue(null);
    expect(await summaryScreenAllowed("S1.brandTrend")).toBe(false);
  });

  it("명시하면 켜진다 — 그리고 다른 화면은 그 목록으로 제한된다", async () => {
    vi.mocked(readScreensRaw).mockResolvedValue('["S1.dashboard","S1.brandTrend"]');
    expect(await summaryScreenAllowed("S1.brandTrend")).toBe(true);
    expect(await summaryScreenAllowed("S1.firstPosition")).toBe(false);
    expect(await summaryScreenAllowed("S1.dashboard")).toBe(true);
    expect(await summaryScreenAllowed("S4.dashboard")).toBe(false);
  });
});
