// listUnmirrored() 의 SQL 을 실 DB(read-only)로 검증한다. DATABASE_URL 이
// 있을 때만 실행 — CI(무DB)에서는 skip.
//
//   npx vitest run lib/db/repositories/projects.unmirrored.int.test.ts
//   (로컬은 .env.local 의 DATABASE_URL 이 필요하다:
//    `node --env-file=.env.local node_modules/.bin/vitest run <file>`)
//
// 존재 이유: 이 쿼리는 상관 서브쿼리 + `is null` 조합이라 타입만으로는 맞았는지
// 알 수 없다. 고아 감시 전체가 이 한 줄의 술어 위에 서 있다.
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { prompts } from "@/lib/db/schema";
import { projectRepository } from "./projects";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("projectRepository.listUnmirrored (실 DB)", { timeout: 60_000 }, () => {
  it("scope_project_id IS NULL 인 행만, 오래된 순으로, 프롬프트 수와 함께 돌려준다", async () => {
    const rows = await projectRepository.listUnmirrored();

    // 형태 — promptCount 가 문자열로 새어 나오면(count(*) 캐스팅 누락) 본문 표가
    // 조용히 깨진다.
    for (const r of rows) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.name).toBe("string");
      expect(typeof r.country).toBe("string");
      expect(r.createdAt).toBeInstanceOf(Date);
      expect(typeof r.promptCount).toBe("number");
      expect(r.promptCount).toBeGreaterThanOrEqual(0);
    }

    // 정렬 — oldest first (유예 판정과 본문 표가 이 순서를 전제한다).
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].createdAt.getTime()).toBeGreaterThanOrEqual(
        rows[i - 1].createdAt.getTime(),
      );
    }

    // 교차 검증 — 전체 목록에서 직접 센 고아 수와 일치해야 한다. 술어가
    // 반대로 뒤집히면(NOT NULL 을 세면) 여기서 걸린다.
    const all = await projectRepository.listAll();
    const expected = all.filter((p) => p.scopeProjectId === null).length;
    expect(rows).toHaveLength(expected);
    expect(rows.every((r) => all.some((p) => p.id === r.id))).toBe(true);
  });

  it("promptCount 가 독립 쿼리와 일치한다 — 상관 서브쿼리가 조용히 0을 내지 않는지", async () => {
    // 이 단언이 잡는 것: 손으로 쓴 `where ${prompts.projectId} = ${projects.id}`
    // 는 한정 없이 렌더돼(`where "project_id" = "id"`) 서브쿼리 안에서
    // prompts.id 로 묶이고, 개수가 **전부 0** 이 된다. 2026-08-20 실측에서
    // 프롬프트 20개짜리 프로젝트가 0 으로 나왔다. 값이 "그럴듯한 0"이라
    // 화면·본문만 봐서는 절대 드러나지 않는다.
    const rows = await projectRepository.listUnmirrored();
    for (const r of rows) {
      const [direct] = await getDb()
        .select({ n: sql<number>`count(*)::int` })
        .from(prompts)
        .where(eq(prompts.projectId, r.id));
      expect(r.promptCount, `promptCount for ${r.id} (${r.name})`).toBe(
        Number(direct.n),
      );
    }
  });
});
