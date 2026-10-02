// 감시 ④ 회차 표시(앵커) 공백: 등급 판정과 알림 본문 (2026-09-29).
//
// 1차 방어(sync 크론 자동 채움)가 못 채운 공백이 사람에게 보이는 유일한 경로다.
// "울려야 할 때 울리고, 긴급과 주의가 기준대로 갈리는가" 를 고정한다.
import { describe, expect, it } from "vitest";
import {
  judgeAnchorGap,
  buildAnchorGapAlertBody,
  buildAnchorGapAlertTitle,
  ANCHOR_GAP_URGENT_ANSWERS,
} from "./cycle-chain";
import type { AnchorGapGroup } from "@/lib/db/repositories/scope-answer-anchors-catchup";

const NOW = new Date("2026-09-29T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const G = (over: Partial<AnchorGapGroup> = {}): AnchorGapGroup => ({
  surface: "project",
  projectId: "p1",
  projectName: "GV80 HEV 1.2v",
  answers: 50,
  cycles: 1,
  oldestAnchorAt: "2026-09-23T00:00:00Z",
  oldestSyncedAt: hoursAgo(2),
  ...over,
});

describe("judgeAnchorGap", () => {
  it("공백이 없으면 0", () => {
    const v = judgeAnchorGap([], NOW);
    expect(v.severity).toBe(0);
    expect(v.answers).toBe(0);
    expect(v.oldest).toBeNull();
  });

  it("project 표면 소규모·24h 미만이면 주의(1)", () => {
    expect(judgeAnchorGap([G()], NOW).severity).toBe(1);
  });

  it("global·website 표면이 하나라도 있으면 긴급(2)", () => {
    expect(judgeAnchorGap([G(), G({ surface: "global", projectId: "root", answers: 3 })], NOW).severity).toBe(2);
    expect(judgeAnchorGap([G({ surface: "website", answers: 1 })], NOW).severity).toBe(2);
  });

  it("답변 합이 1,000 이상이면 긴급(2): 경계 포함", () => {
    expect(judgeAnchorGap([G({ answers: ANCHOR_GAP_URGENT_ANSWERS - 1 })], NOW).severity).toBe(1);
    expect(
      judgeAnchorGap([G({ answers: 600 }), G({ projectId: "p2", answers: 400 })], NOW).severity,
    ).toBe(2);
  });

  it("싱크 후 24시간 이상 남았으면 긴급(2)", () => {
    expect(judgeAnchorGap([G({ oldestSyncedAt: hoursAgo(23) })], NOW).severity).toBe(1);
    const v = judgeAnchorGap([G({ oldestSyncedAt: hoursAgo(24) })], NOW);
    expect(v.severity).toBe(2);
    expect(v.oldestSyncAgeHours).toBe(24);
  });

  it("unattributed 표면은 주의 기준을 따른다(원장 귀속 전)", () => {
    expect(judgeAnchorGap([G({ surface: "unattributed" })], NOW).severity).toBe(1);
  });

  it("표면별 합·상위 5·최고령 회차를 모은다", () => {
    const groups = [
      G({ projectId: "a", answers: 10, oldestAnchorAt: "2026-09-21T00:00:00Z" }),
      G({ projectId: "b", answers: 70 }),
      G({ projectId: "c", answers: 30, surface: "website" }),
      G({ projectId: "d", answers: 20 }),
      G({ projectId: "e", answers: 5 }),
      G({ projectId: "f", answers: 1, oldestAnchorAt: null }),
    ];
    const v = judgeAnchorGap(groups, NOW);
    expect(v.answers).toBe(136);
    expect(v.cycles).toBe(6);
    expect(v.bySurface).toEqual({ project: 106, website: 30 });
    expect(v.top.map((g) => g.projectId)).toEqual(["b", "c", "d", "a", "e"]);
    expect(v.oldest).toMatchObject({ anchorAt: "2026-09-21T00:00:00Z", projectId: "a" });
  });
});

describe("알림 본문·제목", () => {
  const v = judgeAnchorGap(
    [G({ answers: 474, cycles: 1 }), G({ projectId: "root", projectName: "Global", surface: "global", answers: 12 })],
    NOW,
  );

  it("제목에 총계와 표면별 건수가 있다", () => {
    const t = buildAnchorGapAlertTitle(v);
    expect(t).toContain("완료 답변 486건");
    expect(t).toContain("회차 2개");
    expect(t).toContain("project 474");
    expect(t).toContain("global 12");
  });

  it("본문에 상위 프로젝트·최고령 회차·복구 명령이 있다", () => {
    const b = buildAnchorGapAlertBody(v);
    expect(b).toContain("GV80 HEV 1.2v [project] 474건");
    expect(b).toContain("최고령 회차: 2026-09-23T00:00:00Z");
    expect(b).toContain("npm run db:backfill:answer-anchors -- --apply --no-reassign");
    expect(b).toContain("표면별: project 474 · global 12");
  });
});
