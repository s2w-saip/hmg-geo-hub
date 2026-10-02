import { describe, expect, it } from "vitest";
import {
  hasTruncation,
  buildTruncationIssueBody,
  TRUNCATION_ISSUE_TITLE,
} from "./truncation-health";

describe("hasTruncation — 알릴 것이 있는가", () => {
  it("둘 다 비면 알리지 않는다 — 정상 패스가 매번 이슈를 열면 안 된다", () => {
    expect(hasTruncation({ pageCapHits: [], recheckCapHits: [] })).toBe(false);
  });

  it("페이지 상한만 걸려도 알린다", () => {
    expect(
      hasTruncation({
        pageCapHits: [{ projectId: "be28fe15", kind: "runs" }],
        recheckCapHits: [],
      }),
    ).toBe(true);
  });

  it("재확인 상한만 걸려도 알린다 — 예전엔 skipped 에 조용히 섞였다", () => {
    expect(hasTruncation({ pageCapHits: [], recheckCapHits: ["be28fe15"] })).toBe(true);
  });
});

describe("buildTruncationIssueBody", () => {
  it("페이지 상한 절단을 project × source 로 적는다", () => {
    const body = buildTruncationIssueBody({
      pageCapHits: [
        { projectId: "be28fe15", kind: "runs" },
        { projectId: "be28fe15", kind: "prompts" },
      ],
      recheckCapHits: [],
    });
    expect(body).toContain("페이지 상한 소진");
    expect(body).toContain("be28fe15");
    expect(body).toContain("runs");
    expect(body).toContain("prompts");
    // 걸리지 않은 섹션은 넣지 않는다 — 빈 표가 신호를 흐린다.
    expect(body).not.toContain("재확인 상한 소진");
  });

  it("재확인 상한 절단에는 상한값을 함께 적는다", () => {
    const body = buildTruncationIssueBody({
      pageCapHits: [],
      recheckCapHits: ["be28fe15"],
    });
    expect(body).toContain("재확인 상한 소진");
    expect(body).toContain("25건");
    expect(body).not.toContain("페이지 상한 소진");
  });

  it("둘 다 걸리면 두 섹션이 모두 나온다", () => {
    const body = buildTruncationIssueBody({
      pageCapHits: [{ projectId: "p1", kind: "runs" }],
      recheckCapHits: ["p2"],
    });
    expect(body).toContain("페이지 상한 소진");
    expect(body).toContain("재확인 상한 소진");
  });

  // ── 2026-09-13 미러 정지 사고 ─────────────────────────────────────────
  // 회차 8 의 66,144 잡짜리 run 은 페이지 상한과 성격이 다르다: 저쪽은 "잘린 채
  // 들어왔다", 이쪽은 **"아예 없다"**. 같은 감시가 둘 다 잡아야 한다.
  it("★ 잡 상한 초과 run 도 절단 신호다 — 미러에 아예 없는 회차를 침묵시키지 않는다", () => {
    const f = {
      pageCapHits: [],
      recheckCapHits: [],
      oversizedRuns: [
        {
          projectId: "be28fe15-c743-4a88-abb8-182b25602812",
          runId: "3353963e-3b35-40a1-b99c-a236ca35df3c",
          totalJobs: 66_144,
        },
      ],
    };
    expect(hasTruncation(f)).toBe(true);
    const body = buildTruncationIssueBody(f);
    expect(body).toContain("잡 상한 초과 run");
    expect(body).toContain("66144");
    expect(body).toContain("3353963e-3b35-40a1-b99c-a236ca35df3c");
  });

  it("★ 절단으로 건너뛴 run 도 신호다", () => {
    const f = {
      pageCapHits: [],
      recheckCapHits: [],
      truncatedRuns: [{ projectId: "p1", runId: "r1" }],
    };
    expect(hasTruncation(f)).toBe(true);
    expect(buildTruncationIssueBody(f)).toContain("jobs 피드 절단으로 건너뛴 run");
  });

  it("새 필드가 없거나 비어 있으면 종전대로 조용하다 — 기존 호출부 회귀 방지", () => {
    expect(hasTruncation({ pageCapHits: [], recheckCapHits: [] })).toBe(false);
    expect(
      hasTruncation({
        pageCapHits: [],
        recheckCapHits: [],
        oversizedRuns: [],
        truncatedRuns: [],
      }),
    ).toBe(false);
  });

  it("제목은 안정적인 식별자다 — 중복 억제가 제목 완전일치로 돈다", () => {
    expect(TRUNCATION_ISSUE_TITLE).toBe(
      "[mirror] 조용한 절단 감지 — 미러가 데이터를 덜 가져오고 있다",
    );
  });
});

// ── 재확인 잡 상한 이월 (2026-09-14 사고 #262) ─────────────────────────────
// 이 신호를 라우팅에서 빼면 **더 심각한 것이 덜 심각한 것보다 약해진다**:
// 페이지 상한은 다음 패스가 다시 시도하지만, 이쪽은 정규 크론이 더는 시도하지
// 않는다(판정이 같다). 재확인 창 3일이 지나면 신호 자체가 사라진다.
describe("재확인 잡 상한 이월 — recheckDeferredHeavy", () => {
  const HEAVY = [{ projectId: "be28fe15", runId: "run-heavy", jobs: 2_170 }];

  it("이월만 있어도 알린다", () => {
    expect(
      hasTruncation({ pageCapHits: [], recheckCapHits: [], recheckDeferredHeavy: HEAVY }),
    ).toBe(true);
  });

  it("빈 배열은 알리지 않는다 — 정상 패스가 매번 이슈를 열면 안 된다", () => {
    expect(
      hasTruncation({ pageCapHits: [], recheckCapHits: [], recheckDeferredHeavy: [] }),
    ).toBe(false);
  });

  it("본문에 run·잡 수와 **명시적 resync 안내**가 들어간다", () => {
    const body = buildTruncationIssueBody({
      pageCapHits: [],
      recheckCapHits: [],
      recheckDeferredHeavy: HEAVY,
    });
    expect(body).toContain("재확인 잡 상한 초과");
    expect(body).toContain("run-heavy");
    expect(body).toContain("2170");
    expect(body).toContain("force=1");
    expect(body).toContain("mirror:local-resync");
    // 회수하지 않으면 신호가 사라진다는 시한을 본문이 말해야 한다.
    expect(body).toContain("3일");
  });

  it("이월이 없으면 그 섹션을 넣지 않는다 — 빈 표가 신호를 흐린다", () => {
    const body = buildTruncationIssueBody({
      pageCapHits: [{ projectId: "be28fe15", kind: "runs" }],
      recheckCapHits: [],
    });
    expect(body).not.toContain("재확인 잡 상한 초과");
  });
});

describe("이슈 제목은 하나다 — 신호를 쪼개지 않는다", () => {
  it("TRUNCATION_ISSUE_TITLE 로 모든 절단 신호가 모인다", () => {
    expect(TRUNCATION_ISSUE_TITLE).toContain("조용한 절단");
  });
});
