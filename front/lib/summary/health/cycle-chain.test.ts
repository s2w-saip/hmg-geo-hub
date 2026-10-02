import { describe, it, expect } from "vitest";
import {
  judgeViewLagSurface,
  expectedToBecomeViewable,
  buildGenerationBacklogIssueBody,
  buildViewLagAlertBody,
  VIEW_LAG_GRACE_HOURS,
  GENERATION_BACKLOG_HOURS,
  GENERATION_BACKLOG_URGENT_HOURS,
  type BacklogVerdict,
  type ViewLagVerdict,
} from "./cycle-chain";
import { DEFAULT_COMPLETE_QUIET_HOURS } from "@/lib/db/repositories/summary-cycles";
import { ANALYSIS_GAP_MAX } from "@/lib/summary/read/analysis-gap";
import type { CycleLedgerRow } from "@/lib/db/repositories/summary-cycle-health";

// 감시의 **오탐**이 이 파일의 주제다. 우는 감시는 꺼지고, 꺼진 감시는 없는 감시다.
// 그래서 "정상인데 울지 않는가" 를 "이상인데 우는가" 보다 먼저 고정한다.

const H = 3_600_000;
const D = 24 * H;

function row(over: Partial<CycleLedgerRow> & { cycleAnchorAt: string }): CycleLedgerRow {
  const anchor = over.cycleAnchorAt;
  return {
    cycleAnchorAt: anchor,
    // 글로벌 지연 2일이 기본. 테스트가 직접 넣고 싶으면 덮어쓴다.
    dueAt: new Date(Date.parse(anchor) + 2 * D).toISOString(),
    // 글로벌 묶음 키 = 앵커. 웹사이트 케이스는 명시적으로 주(週)를 넣는다.
    groupKey: anchor,
    status: "published",
    hasActiveGeneration: true,
    analysisGapRatio: 0.01,
    ...over,
  };
}

/** 웹사이트 함대 한 주 = **한 회차**. 프로젝트 수만큼 행이 나온다. */
function fleetWeek(week: string, anchors: string[]): CycleLedgerRow[] {
  return anchors.map((a) => row({ cycleAnchorAt: a, groupKey: week }));
}

function served(anchor: string | null, groupKey?: string | null) {
  return { anchor, groupKey: groupKey === undefined ? anchor : groupKey, skipped: null };
}

describe("VIEW_LAG_GRACE_HOURS — 정온 가드에서 유도된다", () => {
  it("리터럴이 아니라 DEFAULT_COMPLETE_QUIET_HOURS + 12 다", () => {
    expect(VIEW_LAG_GRACE_HOURS).toBe(DEFAULT_COMPLETE_QUIET_HOURS + 12);
    // 정온 가드가 36h 인 동안은 48h. 값이 바뀌면 이 줄이 아니라 위 줄이 정본이다.
    expect(VIEW_LAG_GRACE_HOURS).toBe(48);
  });
});

describe("expectedToBecomeViewable — 모수 술어", () => {
  it("영구 미발행(closed · 갭 초과 · generation 없음)은 모수에서 뺀다", () => {
    // 2026-07-07·07-11·07-19·07-24 글로벌 4건의 모습. 넣으면 감시가 영구히 운다.
    expect(
      expectedToBecomeViewable(
        row({ cycleAnchorAt: "2026-07-07T18:25:05Z", status: "closed",
              hasActiveGeneration: false, analysisGapRatio: 0.22379 }),
      ),
    ).toBe(false);
  });

  it("갭이 NULL 이어도 closed 면 뺀다 (생성기가 3VL 로 안 뽑는다)", () => {
    expect(
      expectedToBecomeViewable(
        row({ cycleAnchorAt: "2026-08-19T00:00:00Z", status: "closed",
              hasActiveGeneration: false, analysisGapRatio: null }),
      ),
    ).toBe(false);
  });

  it("open 은 갭이 NULL 이어도 넣는다 — '열렸는데 영영 안 닫힘'을 봐야 한다", () => {
    expect(
      expectedToBecomeViewable(
        row({ cycleAnchorAt: "2026-09-13T15:48:44Z", status: "open",
              hasActiveGeneration: false, analysisGapRatio: null }),
      ),
    ).toBe(true);
  });

  it("갭이 초과여도 활성 generation 이 있으면 넣는다 (운영자 override 경로)", () => {
    // 2026-08-31 글로벌 회차: 갭 0.21471 인데 analysis_gate='override' 로 발행됐다.
    expect(
      expectedToBecomeViewable(
        row({ cycleAnchorAt: "2026-08-31T00:00:00Z", status: "published",
              hasActiveGeneration: true, analysisGapRatio: 0.21471 }),
      ),
    ).toBe(true);
  });

  it("closed 이고 갭이 임계 이하면 넣는다 (생성기가 곧 뽑는다)", () => {
    expect(
      expectedToBecomeViewable(
        row({ cycleAnchorAt: "2026-09-13T00:00:00Z", status: "closed",
              hasActiveGeneration: false, analysisGapRatio: ANALYSIS_GAP_MAX }),
      ),
    ).toBe(true);
  });
});

describe("judgeViewLagSurface — 오탐 점검", () => {
  const latest = "2026-09-13T15:48:44Z";
  const prev = "2026-09-08T01:10:26Z";
  const rows = [row({ cycleAnchorAt: latest }), row({ cycleAnchorAt: prev })];

  it("최신을 내고 있으면 PASS (2026-09-16 현재 글로벌의 모습)", () => {
    const v = judgeViewLagSurface(
      "global", rows, served(latest),
      new Date("2026-09-30T00:00:00Z"), // 기한을 한참 넘겨도 PASS 여야 한다
    );
    expect(v.severity).toBe(0);
    expect(v.cyclesBehind).toBe(0);
    expect(v.overdueHours).toBeNull();
  });

  it("앵커+지연+여유가 아직 안 왔으면 PASS — 정온 창 안의 대기는 정상이다", () => {
    // 09-13 회차가 아직 안 나왔지만 기준선(09-15 15:48 + 48h = 09-17 15:48)이 안 됐다.
    const v = judgeViewLagSurface(
      "global", rows, served(prev),
      new Date("2026-09-17T15:00:00Z"),
    );
    expect(v.severity).toBe(0);
    expect(v.cyclesBehind).toBe(1);
    expect(v.deadlineAt).toBe("2026-09-17T15:48:44.000Z");
  });

  it("기준선을 넘고 한 회차 밀리면 1(주의) — 화면은 설계된 폴백 중이다", () => {
    const v = judgeViewLagSurface(
      "global", rows, served(prev),
      new Date("2026-09-17T21:48:44Z"), // +6h
    );
    expect(v.severity).toBe(1);
    expect(v.overdueHours).toBe(6);
  });

  it("두 회차 이상 밀리면 2(긴급) — 고객이 2주 이상 낡은 값을 본다", () => {
    const three = [...rows, row({ cycleAnchorAt: "2026-08-31T00:00:00Z" })];
    const v = judgeViewLagSurface(
      "global", three, served("2026-08-31T00:00:00Z"),
      new Date("2026-09-18T00:00:00Z"),
    );
    expect(v.cyclesBehind).toBe(2);
    expect(v.severity).toBe(2);
  });

  it("아무것도 못 고르면 2(긴급) — 회차 폴백조차 못 해 전 화면이 미러로 떨어진다", () => {
    const v = judgeViewLagSurface(
      "website", rows, served(null),
      new Date("2026-09-18T00:00:00Z"),
    );
    expect(v.severity).toBe(2);
    expect(v.servedAnchorAt).toBeNull();
  });

  it("영구 미발행 회차만 더 최신이면 PASS — 그것 때문에 영구히 울지 않는다", () => {
    const withSkipped = [
      row({ cycleAnchorAt: "2026-09-20T00:00:00Z", status: "closed",
            hasActiveGeneration: false, analysisGapRatio: 0.3 }),
      ...rows,
    ];
    const v = judgeViewLagSurface(
      "global", withSkipped, served(latest),
      new Date("2026-10-30T00:00:00Z"),
    );
    expect(v.severity).toBe(0);
    expect(v.latestAnchorAt).toBe(latest);
  });

  it("판정 불가(루트 미설정)는 PASS 가 아니라 skipped 로 남는다", () => {
    const v = judgeViewLagSurface(
      "global", rows, { anchor: null, groupKey: null, skipped: "no-root-project" },
      new Date("2026-10-30T00:00:00Z"),
    );
    expect(v.skipped).toBe("no-root-project");
    expect(v.severity).toBe(0);
    expect(v.latestAnchorAt).toBeNull();
  });

  it("원장이 비면 판정하지 않는다", () => {
    const v = judgeViewLagSurface(
      "website", [], served(null), new Date("2026-10-30T00:00:00Z"),
    );
    expect(v.severity).toBe(0);
    expect(v.latestAnchorAt).toBeNull();
  });
});

describe("본문", () => {
  it("노출 지체 본문은 UTC 를 명시하고 PASS 표면을 싣지 않는다", () => {
    const v: ViewLagVerdict = {
      checked: true, mode: "live", severity: 1,
      surfaces: [
        { surface: "global", latestAnchorAt: "2026-09-13T15:48:44Z",
          deadlineAnchorAt: "2026-09-13T15:48:44Z",
          dueAt: "2026-09-15T15:48:44Z", deadlineAt: "2026-09-17T15:48:44Z",
          servedAnchorAt: "2026-09-08T01:10:26Z", cyclesBehind: 1,
          overdueHours: 6, severity: 1, skipped: null },
        { surface: "website", latestAnchorAt: "2026-09-14T00:00:00Z",
          deadlineAnchorAt: null,
          dueAt: "2026-09-15T00:00:00Z", deadlineAt: "2026-09-17T00:00:00Z",
          servedAnchorAt: "2026-09-14T00:00:00Z", cyclesBehind: 0,
          overdueHours: null, severity: 0, skipped: null },
      ],
    };
    const body = buildViewLagAlertBody(v);
    expect(body).toContain("global");
    expect(body).not.toContain("website");
    expect(body).toContain("UTC");
    expect(body).toContain("2 days"); // VIEW_ANCHOR_DELAY.global 을 그대로 싣는다
  });

  it("생성 적체 본문은 갭 제외 건수를 **반드시** 표기한다", () => {
    const v: BacklogVerdict = {
      checked: true, mode: "live", pendingTotal: 3,
      aged: [{ cycleId: "c1", surface: "global", anchorAt: "2026-09-13T15:48:44Z",
               since: "2026-09-13T20:00:00Z", ageHours: 30 }],
      oldestAgeHours: 30, stale: [],
      gapExcluded: [{ surface: "global", count: 4,
                      oldestAnchorAt: "2026-07-07T18:25:05Z",
                      newestAnchorAt: "2026-07-24T17:15:03Z" }],
      saturated: false, severity: 2,
    };
    const body = buildGenerationBacklogIssueBody(v);
    expect(body).toContain("2(긴급)");
    expect(body).toContain("제외된");
    expect(body).toContain("| global | 4 |");
    expect(body).toContain("2026-07-07T18:25:05Z");
    expect(body).toContain(String(ANALYSIS_GAP_MAX));
  });

  it("갭 제외가 0건이어도 그 섹션을 지우지 않는다", () => {
    const v: BacklogVerdict = {
      checked: true, mode: "live", pendingTotal: 1,
      aged: [{ cycleId: "c1", surface: "website", anchorAt: "2026-09-13T00:00:00Z",
               since: "2026-09-13T00:00:00Z", ageHours: 7 }],
      oldestAgeHours: 7, stale: [], gapExcluded: [], saturated: false, severity: 1,
    };
    const body = buildGenerationBacklogIssueBody(v);
    expect(body).toContain("제외된");
    expect(body).toContain("없음.");
    expect(body).toContain("1(주의)");
  });
});

describe("임계값", () => {
  it("30분 폴링 기준 6h = 틱 12회 · 24h = 틱 48회", () => {
    expect(GENERATION_BACKLOG_HOURS * 2).toBe(12);
    expect(GENERATION_BACKLOG_URGENT_HOURS * 2).toBe(48);
    expect(GENERATION_BACKLOG_URGENT_HOURS).toBeGreaterThan(GENERATION_BACKLOG_HOURS);
  });
});

describe("모수 — 감시 표면은 생성기 표면과 같아야 한다", () => {
  it("소스에 `project` 표면이 모수로 들어가 있지 않다", async () => {
    // 2026-09-16 실측: 원장의 surface='project' 회차 121건은 활성 generation 이
    // **0건**이다(생성기가 안 만드는 표면). 모수에 넣으면 "생성 대기 105건" 이
    // 첫날부터 영구 오탐으로 뜬다. 타입이 막고 있지만, 누가 문자열로 넓히는
    // 순간 조용히 뚫리므로 소스로 못 박는다.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("./cycle-chain.ts", import.meta.url),
      "utf8",
    );
    const decl = src.match(/const SURFACES: SummarySurface\[\] = \[[^\]]*\]/)?.[0];
    expect(decl).toBe('const SURFACES: SummarySurface[] = ["global", "website"]');
  });
});

describe("cyclesBehind — 웹사이트는 함대 '주' 하나가 한 회차다", () => {
  // 행으로 세면 한 주 밀림이 95(프로젝트 수)로 잡혀 등급이 언제나 2가 된다.
  // 2026-09-16 실측: website 표면 회차 769건 / 프로젝트 95개 규모.
  const wk0911 = fleetWeek("2026-09-08", [
    "2026-09-11T00:00:00Z", "2026-09-11T01:00:00Z", "2026-09-11T02:00:00Z",
  ]);
  const wk0914 = fleetWeek("2026-09-15", [
    "2026-09-14T06:10:44Z", "2026-09-14T07:00:00Z", "2026-09-14T08:00:00Z",
  ]);

  it("한 주 밀리면 cyclesBehind=1 → 1(주의), 행 수(3)가 아니다", () => {
    const v = judgeViewLagSurface(
      "website", [...wk0914, ...wk0911],
      served("2026-09-11T02:00:00Z", "2026-09-08"),
      new Date("2026-09-30T00:00:00Z"),
    );
    expect(v.cyclesBehind).toBe(1);
    expect(v.severity).toBe(1);
  });

  it("두 주 밀리면 2(긴급)", () => {
    const wk0904 = fleetWeek("2026-09-01", ["2026-09-04T00:00:00Z", "2026-09-04T01:00:00Z"]);
    const v = judgeViewLagSurface(
      "website", [...wk0914, ...wk0911, ...wk0904],
      served("2026-09-04T01:00:00Z", "2026-09-01"),
      new Date("2026-09-30T00:00:00Z"),
    );
    expect(v.cyclesBehind).toBe(2);
    expect(v.severity).toBe(2);
  });
});

describe("F1 — 더 나쁜 상태가 경보를 끄면 안 된다 (단조성 가드)", () => {
  // 2026-09-16 독립 검증이 잡은 치명 결함. 초판은 기준선을 **가장 최신 회차**의
  // `dueAt` 에서 쟀다. 그래서 새 회차가 열리면 기준선이 미래로 밀려, 이미 기한을
  // 한참 넘긴 이전 회차의 경보가 조용히 꺼졌다:
  //     2주 밀림 → severity 0 (무음)  ·  1주 밀림 → severity 1 (경보)
  // 주간 케이던스에서 다음 회차가 열리는 순간 며칠간 침묵한다는 뜻이다.
  //
  // 여기서는 개별 케이스가 아니라 **성질 자체**를 가드한다: 더 밀릴수록 등급은
  // 절대 내려가지 않는다.
  const NOW = new Date("2026-09-20T00:00:00Z");
  // 주간 케이던스 4회차 — 가장 오래된 것이 가장 먼저 기한을 넘긴다.
  const c1 = row({ cycleAnchorAt: "2026-08-30T00:00:00Z" });
  const c2 = row({ cycleAnchorAt: "2026-09-06T00:00:00Z" });
  const c3 = row({ cycleAnchorAt: "2026-09-13T00:00:00Z" });
  const c4 = row({ cycleAnchorAt: "2026-09-19T00:00:00Z" });
  const ledger = [c4, c3, c2, c1]; // 앵커 내림차순

  it("2주 밀림이 1주 밀림보다 약하지 않다", () => {
    const oneWeek = judgeViewLagSurface("global", ledger, served(c3.cycleAnchorAt), NOW);
    const twoWeeks = judgeViewLagSurface("global", ledger, served(c2.cycleAnchorAt), NOW);
    expect(twoWeeks.cyclesBehind).toBeGreaterThan(oneWeek.cyclesBehind);
    expect(twoWeeks.severity).toBeGreaterThanOrEqual(oneWeek.severity);
    // 초판의 지문: 더 밀린 쪽이 overdue null 이 되는 것.
    expect(twoWeeks.overdueHours).not.toBeNull();
  });

  it("밀림이 깊어질수록 등급이 단조 증가한다 (전 구간)", () => {
    const grades = [c4, c3, c2, c1].map(
      (c) => judgeViewLagSurface("global", ledger, served(c.cycleAnchorAt), NOW).severity,
    );
    for (let i = 1; i < grades.length; i += 1) {
      expect(grades[i]).toBeGreaterThanOrEqual(grades[i - 1] as number);
    }
    // 플래핑(1 → 0 → 2)이 없다는 것까지 본다.
    expect(grades).toEqual([...grades].sort((a, b) => a - b));
  });

  it("기준선은 **가장 오래된 미서빙 회차**에서 잰다 — 최신이 아니다", () => {
    const v = judgeViewLagSurface("global", ledger, served(c1.cycleAnchorAt), NOW);
    // 밀린 것은 c2·c3·c4. 그중 가장 오래된 c2 가 기준선을 만든다.
    expect(v.deadlineAnchorAt).toBe(c2.cycleAnchorAt);
    expect(v.dueAt).toBe(c2.dueAt);
    // 최신 앵커는 따로 보고된다(둘을 섞지 않는다).
    expect(v.latestAnchorAt).toBe(c4.cycleAnchorAt);
  });

  it("새 회차가 열려도 기존 경보가 꺼지지 않는다", () => {
    const before = judgeViewLagSurface("global", [c3, c2, c1], served(c1.cycleAnchorAt), NOW);
    const afterNewCycleOpens = judgeViewLagSurface("global", ledger, served(c1.cycleAnchorAt), NOW);
    expect(afterNewCycleOpens.severity).toBeGreaterThanOrEqual(before.severity);
    expect(afterNewCycleOpens.overdueHours).toBe(before.overdueHours);
  });
});

describe("F2 — 묶음 키 축이 갈리면 밀림을 놓친다", () => {
  // 리포지토리는 `to_char(… 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` 로 내고 픽은
  // `toISOString()` 으로 낸다 — **둘이 같은 형식이어야** 문자열 비교가 성립한다.
  // 픽스처가 이 형식을 한 번도 안 지나면 이 결함이 살아남는다(초판이 그랬다).
  const REPO_FMT = "2026-09-13T15:48:44.276Z"; // 리포지토리 실제 출력 형식
  const LEGACY_TEXT = "2026-09-13 15:48:44.276+00"; // `::text` 가 내던 것

  it("같은 날짜의 더 최신 회차가 '밀림' 으로 잡힌다", () => {
    const older = row({ cycleAnchorAt: "2026-09-13T09:00:00.000Z" });
    const newer = row({ cycleAnchorAt: REPO_FMT });
    const v = judgeViewLagSurface(
      "global", [newer, older], served(older.cycleAnchorAt),
      new Date("2026-09-30T00:00:00Z"),
    );
    expect(v.cyclesBehind).toBe(1);
    expect(v.severity).toBe(1);
  });

  it("`::text` 축은 ISO 축보다 작다 — 이것이 결함의 기계적 원인이었다", () => {
    // ' '(0x20) < 'T'(0x54). 원장이 LEGACY_TEXT 를 내고 픽이 ISO 를 내면,
    // `r.groupKey > servedKey` 가 거짓이 되어 밀림이 0 으로 잡힌다.
    expect(LEGACY_TEXT < REPO_FMT).toBe(true);
    const mixed = row({ cycleAnchorAt: REPO_FMT, groupKey: LEGACY_TEXT });
    const v = judgeViewLagSurface(
      "global", [mixed], served("2026-09-13T09:00:00.000Z"),
      new Date("2026-09-30T00:00:00Z"),
    );
    // 축이 갈리면 이렇게 조용히 0 이 된다 — 리포지토리 테스트가 형식을 못 박는 이유.
    expect(v.cyclesBehind).toBe(0);
  });
});

describe("F3 — 조회 실패를 긴급으로 올리지 않는다", () => {
  it("pick-unavailable 은 경보가 아니다 (DB 순간 오류)", () => {
    const rows = [row({ cycleAnchorAt: "2026-09-13T00:00:00Z" })];
    const v = judgeViewLagSurface(
      "global", rows,
      { anchor: null, groupKey: null, skipped: "pick-unavailable" },
      new Date("2026-10-30T00:00:00Z"),
    );
    expect(v.severity).toBe(0);
    expect(v.skipped).toBe("pick-unavailable");
  });

  it("조회는 멀쩡한데 고를 게 없으면 그대로 긴급 2 다", () => {
    const rows = [row({ cycleAnchorAt: "2026-09-13T00:00:00Z" })];
    const v = judgeViewLagSurface(
      "global", rows, served(null), new Date("2026-10-30T00:00:00Z"),
    );
    expect(v.severity).toBe(2);
  });
});

describe("F7 — stale 회차가 적체 감시의 둘째 술어로 보인다", () => {
  const staleRow = {
    cycleId: "8907690a-d569-4ac7-8f3e-0cfb297cebc6",
    surface: "global" as const,
    anchorAt: "2026-09-13T15:48:44.276Z",
    staleSince: "2026-09-15T18:40:00.330Z",
    ageHours: 6,
  };

  it("적체가 0건이어도 stale 이 있으면 등급 1", () => {
    const v: BacklogVerdict = {
      checked: true, mode: "live", pendingTotal: 0, aged: [], stale: [staleRow],
      oldestAgeHours: null, gapExcluded: [], saturated: false, severity: 1,
    };
    const body = buildGenerationBacklogIssueBody(v);
    expect(body).toContain("stale");
    expect(body).toContain(staleRow.cycleId);
    expect(body).toContain("2026-09-15T18:40:00.330Z");
    // 적체 표가 비어도 섹션이 사라지지 않는다.
    expect(body).toContain("없음");
  });

  it("stale 건수를 머리말에 싣는다 (본문을 끝까지 안 읽어도 보이게)", () => {
    const v: BacklogVerdict = {
      checked: true, mode: "live", pendingTotal: 0, aged: [],
      stale: [staleRow, { ...staleRow, cycleId: "9db294d8-7cd7-4f45-b0ef-bd22783de92e" }],
      oldestAgeHours: null, gapExcluded: [], saturated: false, severity: 1,
    };
    expect(buildGenerationBacklogIssueBody(v)).toContain("stale): **2건**");
  });
});

// ── 중복 주(같은 cycle_week 에 회차 둘) — 2026-09-18 ────────────────────────
//
// `pickGlobalCycle` 이 그 주의 **대표**를 내게 바뀌었다(검증자 R1). 원장은 패자도
// 그대로 싣고(병리를 봐야 하므로), 글로벌 묶음 키는 **앵커**라 패자가 자기 그룹을
// 만든다 — 접지 않으면 중복 주마다 "한 회차 밀림" 오탐이 상시로 뜬다.
describe("judgeViewLagSurface — 중복 주 패자는 기대 집합이 아니다", () => {
  const WEEK = "2026-08-17";
  const REP = "2026-08-18T12:46:00Z";   // 대표 9,068유닛
  const LOSER = "2026-08-19T00:06:00Z"; // 패자 906유닛(결손)
  const P1 = "11111111-1111-1111-1111-111111111111";
  const P2 = "22222222-2222-2222-2222-222222222222";
  const dup = (repVisible: boolean, loserVisible: boolean): CycleLedgerRow[] => [
    row({ cycleAnchorAt: LOSER, cycleWeek: WEEK, projectId: P1, fleetVisible: loserVisible }),
    row({ cycleAnchorAt: REP, cycleWeek: WEEK, projectId: P1, fleetVisible: repVisible }),
  ];
  // 기한을 한참 넘긴 시점 — 접기가 안 되면 반드시 운다.
  const LATE = new Date("2026-09-30T00:00:00Z");

  it("대표를 서빙 중이면 PASS — 패자 때문에 울지 않는다", () => {
    const v = judgeViewLagSurface("global", dup(true, false), served(REP), LATE);
    expect(v.cyclesBehind).toBe(0);
    expect(v.severity).toBe(0);
    // 표시되는 '최신' 도 대표다 — 사람이 보는 값과 화면이 같아야 한다.
    expect(v.latestAnchorAt).toBe(REP);
  });

  it("⚠️ 한 주가 통째로 패자면 접지 않는다 — 관제 결함을 감시가 봐야 한다", () => {
    // 대표가 하나도 없는 주는 `dropFleetLosers` 가 통째로 남긴다.
    const v = judgeViewLagSurface("global", dup(false, false), served(REP), LATE);
    expect(v.cyclesBehind).toBe(1);
    expect(v.severity).toBe(1);
  });

  it("패자가 아니라 **진짜 새 회차**가 밀리면 그대로 운다(면제가 안 넓어졌다)", () => {
    const rows = [
      row({ cycleAnchorAt: "2026-08-25T00:00:00Z", cycleWeek: "2026-08-24" }),
      ...dup(true, false),
    ];
    const v = judgeViewLagSurface("global", rows, served(REP), LATE);
    expect(v.cyclesBehind).toBe(1);
    expect(v.severity).toBe(1);
  });

  it("같은 주 **다른 프로젝트**의 대표는 이 프로젝트의 패자를 지우지 않는다", () => {
    // 접기 그룹은 관제 파티션과 같은 `(프로젝트, 주)` 다. 주만 보면 P2 의 대표가
    // P1 의 패자를 지워, P1 이 실제로 밀렸는데 감시가 조용해진다.
    const rows = [
      row({ cycleAnchorAt: LOSER, cycleWeek: WEEK, projectId: P1, fleetVisible: false }),
      row({ cycleAnchorAt: REP, cycleWeek: WEEK, projectId: P2, fleetVisible: true }),
    ];
    const v = judgeViewLagSurface("global", rows, served(REP), LATE);
    // P1 패자가 남아 있으므로 밀림으로 잡힌다(그룹에 대표가 없다).
    expect(v.cyclesBehind).toBe(1);
  });

  it("값이 안 실린 원장(fleetVisible 미상)은 종전 판정 그대로", () => {
    const rows = [row({ cycleAnchorAt: LOSER }), row({ cycleAnchorAt: REP })];
    expect(judgeViewLagSurface("global", rows, served(LOSER), LATE).cyclesBehind).toBe(0);
    expect(judgeViewLagSurface("global", rows, served(REP), LATE).cyclesBehind).toBe(1);
  });

  it("웹사이트는 **접지 않는다** — 묶음 키가 이미 주라 패자가 흡수된다", () => {
    // 패자를 **맨 앞**(= 원장 앵커 내림차순의 최신)에 둔다. 접었다면 `latestAnchorAt` 이
    // 대표로 바뀌므로, 이 단언이 "글로벌 전용 접기" 를 실제로 가른다.
    const week = fleetWeek("2026-08-17", [LOSER, REP]).map((r, i) => ({
      ...r, cycleWeek: "2026-08-17", fleetVisible: i !== 0,
    }));
    const v = judgeViewLagSurface("website", week, served(REP, "2026-08-17"), LATE);
    expect(v.cyclesBehind).toBe(0);
    expect(v.latestAnchorAt).toBe(LOSER);
    // 같은 행을 글로벌로 판정하면 접힌다(= 표면 분기가 실재한다).
    expect(judgeViewLagSurface("global", week, served(REP), LATE).latestAnchorAt).toBe(REP);
  });
});
