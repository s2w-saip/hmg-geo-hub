import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stanceRowsFor } from "./sync";
import type { QueryAnalysisSummary } from "@/lib/scope/types";

// 답변 단위 브랜드 스탠스(0072) → 미러 행 매핑 계약. 지키는 것:
//  ① 코어가 아직 `?include=stances` 를 모르면 **행 0 · 에러 아님**(WU7 AC2).
//  ② resolved_mentions 접힘을 타지 않는다 — `analysis.brand_stances` 는 형제 배열이고
//     turn 축이 살아야 한다(스펙 §5.1).
//  ③ 같은 (turn, entity) 중복은 **뒤엣것을 버린다** — PK 가 (job, turn, entity)라
//     그대로 넣으면 23505 로 run 전체 트랜잭션이 죽는다(답변·멘션·인용까지 유실).
//  ④ evidence 오프셋은 **쌍으로만** 신뢰한다 — 한쪽만 오면 "원문 대조됨"이 거짓이 된다.
//  ⑤ 어휘 밖 stance 는 버린다(조용한 오분류보다 결손이 낫다).

const SYNC_SRC = readFileSync(path.join(process.cwd(), "lib/scope/mirror/sync.ts"), "utf8");
const REPO_SRC = readFileSync(
  path.join(process.cwd(), "lib/db/repositories/scope-mirror.ts"),
  "utf8",
);

// 미러 컬럼이 uuid 라 픽스처도 실제 uuid 여야 한다 — 아니면 insert 가 22P02 로 죽고
// replaceRun 이 단일 트랜잭션이라 그 run 이 통째로 롤백된다(검증자 F4).
const HYUNDAI = "11111111-1111-4111-8111-111111111111";
const KIA = "22222222-2222-4222-8222-222222222222";

const stance = (over: Record<string, unknown> = {}) => ({
  turn_index: 0,
  entity_id: HYUNDAI,
  brand_label: "Hyundai",
  is_tracked: true,
  stance: "mixed",
  confidence: 0.8,
  evidence_text: "품질 우려가 함께 지적된다",
  evidence_start: 10,
  evidence_end: 24,
  reason: "장점과 단점이 함께",
  model_slug: "google/gemini-2.5-flash",
  ...over,
});
const analysisOf = (stances: unknown[]): QueryAnalysisSummary =>
  ({ status: "completed", brand_stances: stances } as unknown as QueryAnalysisSummary);

describe("stanceRowsFor", () => {
  it("코어가 스탠스를 안 내려주면 빈 배열 (에러 아님)", () => {
    expect(stanceRowsFor("job-1", undefined)).toEqual([]);
    expect(stanceRowsFor("job-1", { status: "completed" } as QueryAnalysisSummary)).toEqual([]);
    // 배열이 아닌 값이 와도 죽지 않는다.
    expect(stanceRowsFor("job-1", analysisOf("nope" as unknown as never[]))).toEqual([]);
  });

  it("스탠스마다 행 하나 — turn 축이 그대로 산다", () => {
    const rows = stanceRowsFor(
      "job-1",
      analysisOf([stance(), stance({ turn_index: 1, stance: "negative" })]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      jobId: "job-1",
      turnIndex: 0,
      entityId: HYUNDAI,
      brandLabel: "Hyundai",
      isTracked: true,
      stance: "mixed",
      evidenceStart: 10,
      evidenceEnd: 24,
      modelSlug: "google/gemini-2.5-flash",
    });
    expect(rows[1]!.turnIndex).toBe(1);
    expect(rows[1]!.stance).toBe("negative");
  });

  it("turn_index 가 없으면 0 — PK 구성요소라 NULL 로 두지 않는다", () => {
    const [row] = stanceRowsFor("job-1", analysisOf([stance({ turn_index: undefined })]));
    expect(row!.turnIndex).toBe(0);
  });

  it("같은 (turn, entity) 중복은 하나만 남는다 (PK 충돌 방지)", () => {
    const rows = stanceRowsFor(
      "job-1",
      analysisOf([stance(), stance({ stance: "positive" }), stance({ entity_id: KIA })]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.stance).toBe("mixed"); // 먼저 온 것이 이긴다
    expect(rows.map((r) => r.entityId)).toEqual([HYUNDAI, KIA]);
  });

  it("오프셋은 쌍으로만 — 한쪽만 오거나 역순이면 둘 다 NULL", () => {
    const only = stanceRowsFor("job-1", analysisOf([stance({ evidence_end: null })]));
    expect(only[0]).toMatchObject({ evidenceStart: null, evidenceEnd: null });
    // 인용문 자체는 남는다 — 화면이 "원문 대조 불가"로 표기하고 인용만 보여준다.
    expect(only[0]!.evidenceText).toBe("품질 우려가 함께 지적된다");

    const reversed = stanceRowsFor("job-1", analysisOf([stance({ evidence_start: 30, evidence_end: 20 })]));
    expect(reversed[0]).toMatchObject({ evidenceStart: null, evidenceEnd: null });
  });

  it("어휘 밖 stance · entity_id 없는 행은 버린다", () => {
    const rows = stanceRowsFor(
      "job-1",
      analysisOf([
        stance({ stance: "very_positive" }),
        stance({ entity_id: "" }),
        stance({ entity_id: KIA }),
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe(KIA);
  });

  it("빈 문자열 인용·사유는 NULL 로 정규화된다", () => {
    const [row] = stanceRowsFor("job-1", analysisOf([stance({ evidence_text: "", reason: "" })]));
    expect(row).toMatchObject({ evidenceText: null, reason: null });
  });
});

// ── DB 타입 방어 (검증자 F4) ─────────────────────────────────────────────────
// 여기서 거르는 값은 전부 **run 전체 롤백**으로 이어진다: insert 가 22P02(uuid)·
// 22003(int32 범위)로 죽으면 replaceRun 이 단일 트랜잭션이라 그 run 의 답변·멘션·
// 인용까지 못 들어온다. "스탠스 한 행이 회차 하나를 날린다."
describe("stanceRowsFor — DB 타입 방어", () => {
  it("uuid 가 아닌 entity_id 는 버린다 (22P02 방지)", () => {
    const rows = stanceRowsFor(
      "job-1",
      analysisOf([
        stance({ entity_id: "e-hyundai" }),
        stance({ entity_id: "not-a-uuid-at-all" }),
        stance({ entity_id: `${HYUNDAI} ` }), // 공백 포함
        stance({ entity_id: KIA }),
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe(KIA);
  });

  it("turn_index 가 int32 범위를 넘으면 그 행을 버린다 (22003 방지 · 0 으로 접지 않는다)", () => {
    const rows = stanceRowsFor(
      "job-1",
      analysisOf([
        stance({ turn_index: 2147483648 }),
        stance({ turn_index: -2147483649, entity_id: KIA }),
        stance({ turn_index: 1.5 }),
      ]),
    );
    expect(rows).toEqual([]);
  });

  it('문자열 "1" 은 1 로 읽는다 — 0 으로 접으면 두 턴이 같은 PK 로 충돌한다', () => {
    const rows = stanceRowsFor(
      "job-1",
      analysisOf([stance(), stance({ turn_index: "1", stance: "negative" })]),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.turnIndex)).toEqual([0, 1]);
  });

  it("evidence 오프셋도 int32 범위 밖이면 쌍째로 버린다", () => {
    const [row] = stanceRowsFor("job-1", analysisOf([stance({ evidence_end: 9_999_999_999 })]));
    expect(row).toMatchObject({ evidenceStart: null, evidenceEnd: null });
  });

  it("드롭이 있으면 건수를 로그로 남긴다 (커버리지 구멍의 유일한 신호 · F3)", async () => {
    const { vi } = await import("vitest");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      stanceRowsFor("job-1", analysisOf([stance({ stance: "very_positive" }), stance()]));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("스탠스 1행 드롭");
      warn.mockClear();
      stanceRowsFor("job-1", analysisOf([stance()]));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// ── 배선 (소스 대조) ────────────────────────────────────────────────────────
// 값 계약만으로는 "job 당 1회 수집" · "테이블 없으면 통과" 가 안 잡힌다.
describe("스탠스 배선", () => {
  it("include 토큰에 stances 가 실린다 (코어가 모르면 무시된다)", () => {
    expect(SYNC_SRC).toContain('include: "result,occurrences,stances"');
  });

  it("스탠스 수집은 멘션 루프 **밖** — job 당 1회다", () => {
    // 멘션 루프 안에서 모으면 그 job 의 멘션 수만큼 같은 행이 복제된다.
    const i = SYNC_SRC.indexOf("stances.push(...stanceRowsFor(job.job_id, job.analysis))");
    const loopEnd = SYNC_SRC.indexOf("occurrences.push(...occurrenceRowsFor(job.job_id, m));");
    expect(i).toBeGreaterThan(loopEnd); // 루프 종료 뒤
    expect(SYNC_SRC).toContain("stanceRowsFor(job.job_id, job.analysis)");
  });

  it("테이블이 없으면 삭제도 삽입도 하지 않는다 (WU7 AC3)", () => {
    expect(REPO_SRC).toContain("const stanceAvailable = await answerStancesAvailable();");
    // delete·insert 가 **둘 다** 프로브 뒤에 있다.
    const deleteGuarded = /if \(stanceAvailable\) \{\s*await tx\.delete\(scopeAnswerStances\)/.test(REPO_SRC);
    const insertGuarded = /if \(stanceAvailable\) \{\s*for \(const c of chunk\(stances\)\) await tx\.insert\(scopeAnswerStances\)/.test(REPO_SRC);
    expect(deleteGuarded).toBe(true);
    expect(insertGuarded).toBe(true);
    // 프로브는 트랜잭션 **밖**에서 확정된다(citationValues 와 같은 규율).
    expect(REPO_SRC.indexOf("const stanceAvailable")).toBeLessThan(
      REPO_SRC.indexOf("await db.transaction(async (tx) =>"),
    );
  });

  it("job 단위 wipe+재삽입 — 재싱크 멱등 (A13)", () => {
    // 같은 job 을 두 번 싱크해도 행 수가 같으려면 delete 가 insert 와 같은 키(job_id)여야 한다.
    expect(REPO_SRC).toContain("tx.delete(scopeAnswerStances).where(inArray(scopeAnswerStances.jobId, ids))");
  });

  it("프롬프트 완전 삭제 캐스케이드에도 등재됐다", () => {
    const body = REPO_SRC.slice(REPO_SRC.indexOf("async deletePromptData("));
    expect(body).toContain("tx.delete(scopeAnswerStances)");
  });
});
