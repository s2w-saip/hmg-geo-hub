// mirroredRunStates() 의 SQL 을 실 DB(read-only)로 검증한다. DATABASE_URL 이
// 있을 때만 실행 — CI(무DB)에서는 skip.
//
//   node --env-file=.env.local node_modules/.bin/vitest run \
//     lib/db/repositories/scope-mirror.watermark.int.test.ts
//
// 존재 이유: 이 쿼리는 **상관 서브쿼리**라 타입 검사를 통과해도 런타임에 죽는다.
// 2026-08-29 프로덕션 회귀 실증 — drizzle 이 `${scopeAnswers.runId}` 를 테이블
// 한정 없이 렌더해 `where "run_id" = "run_id"` 가 됐고, 워터마크 조회가 통째로
// 실패해 **모든 프로젝트의 미러 sync 가 멈췄다**. 유닛 테스트로는 잡을 수 없다.
import { describe, expect, it } from "vitest";
import { scopeMirrorRepository } from "./scope-mirror";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("scopeMirrorRepository.mirroredRunStates (실 DB)", { timeout: 60_000 }, () => {
  it("쿼리가 실행되고 run 별 (status·미완 여부·재확인 창) 삼중항을 돌려준다", async () => {
    const states = await scopeMirrorRepository.mirroredRunStates();
    expect(states.size).toBeGreaterThan(0);
    for (const [runId, s] of states) {
      expect(typeof runId).toBe("string");
      expect(["completed", "failed", "partial_failed", null]).toContain(s.status);
      expect(typeof s.hasUnresolved).toBe("boolean");
      expect(typeof s.recheckable).toBe("boolean");
    }
  });

  it("미완 답변이 있는 run 과 없는 run 이 둘 다 존재한다 — 술어가 상수로 접히지 않았다", async () => {
    const states = await scopeMirrorRepository.mirroredRunStates();
    const values = [...states.values()];
    expect(values.some((s) => s.hasUnresolved)).toBe(true);
    expect(values.some((s) => !s.hasUnresolved)).toBe(true);
  });
});
