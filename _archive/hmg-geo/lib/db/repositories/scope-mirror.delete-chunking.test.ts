/**
 * `replaceRun` 의 **delete 도 청크된다** (2026-09-13 리뷰 R3).
 *
 * ── 무엇이 문제였나 ──────────────────────────────────────────────────────
 * `inArray(scope_citations.job_id, jobIds)` 는 id 하나당 바인드 파라미터 하나다.
 * insert 쪽은 처음부터 `chunk()`(500)를 거쳤는데 **delete 세 줄만 빠져 있었다.**
 * jobIds 가 길어지면 postgres.js 의 파라미터 상한(65,534)을 넘겨
 * `MAX_PARAMETERS_EXCEEDED` 가 나고, `replaceRun` 이 단일 트랜잭션이라 그 run 의
 * 쓰기가 통째로 롤백된다 — 즉 **대형 run 회복이 시작하자마자 깨진다.**
 *
 * 지금까지 안 터진 것은 run 당 job 이 작아서였을 뿐이다. 회복 경로
 * (`MIRROR_JOB_MAX_PAGES` 상향, 3.4~5.2만 답변 예상)는 상한의 ~80% 까지 올라가
 * 마진이 없다. 상한에 **닿기 전에** 깨지는지를 여기서 고정한다.
 *
 * 행동이 아니라 흔적을 요구한다: 청크 루프를 지우면 delete 발행 횟수가 1로
 * 떨어져 이 테스트가 깨진다.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { resetColumnAvailabilityForTests } from "@/lib/db/column-availability";

const dialect = new PgDialect();

const RUN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
/** scope-mirror.ts 의 chunk() 기본 크기. */
const CHUNK = 500;
/** postgres.js 가 한 문장에 실을 수 있는 바인드 파라미터 상한. */
const PG_MAX_PARAMS = 65_534;

type Op = { kind: string; table?: string; params?: number };

function makeFakeDb() {
  const ops: Op[] = [];
  const thenable = (kind: string, table?: string) => {
    ops.push({ kind, table });
    return {
      // where 절에 실제로 들어간 id 개수를 센다 — "청크했다"의 유일한 증거다.
      where: (cond: unknown) => {
        const n = countParams(cond);
        ops[ops.length - 1].params = n;
        return Promise.resolve(undefined);
      },
      values: () => ({
        onConflictDoUpdate: () => Promise.resolve(undefined),
        then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r),
      }),
      then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r),
    };
  };
  const tx = {
    delete: (t: unknown) => thenable("delete", tableName(t)),
    insert: (t: unknown) => thenable("insert", tableName(t)),
    execute: () => Promise.resolve(undefined),
  };
  const db = {
    transaction: async (fn: (t: typeof tx) => Promise<void>) => {
      await fn(tx);
    },
  };
  return { db, ops };
}

/**
 * where 절에 실제로 바인드된 파라미터 개수 — 휴리스틱 AST 순회가 아니라
 * **드라이버가 보게 될 값**을 센다(상한 판정의 기준이 그것이기 때문이다).
 */
function countParams(cond: unknown): number {
  return dialect.sqlToQuery(cond as SQL).params.length;
}

function tableName(t: unknown): string {
  const sym = Object.getOwnPropertySymbols(t as object).find((s) =>
    String(s).includes("Name"),
  );
  return sym ? String((t as Record<symbol, unknown>)[sym]) : "?";
}

const h = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: h.getDb }));

const RUN = {
  runId: RUN_ID,
  projectId: "22222222-2222-2222-2222-222222222222",
  status: "completed",
  startedAt: null,
  completedAt: null,
  totalJobs: 0,
};

const answersOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    jobId: `11111111-1111-1111-1111-${String(i).padStart(12, "0")}`,
    runId: RUN_ID,
    promptId: null,
    target: "chatgpt",
    region: "KR",
    status: "completed",
    measuredAt: null,
    modelSlug: null,
    answerText: null,
  }));

beforeEach(() => {
  vi.clearAllMocks();
  resetColumnAvailabilityForTests();
});

describe("replaceRun delete 청킹 (R3)", () => {
  it("★ jobIds 1,200개면 삭제도 3회로 쪼개 발행한다 — 한 방에 안 넣는다", async () => {
    const { db, ops } = makeFakeDb();
    h.getDb.mockReturnValue(db);
    const { scopeMirrorRepository } = await import("./scope-mirror");

    await scopeMirrorRepository.replaceRun(RUN, answersOf(1_200), [], [], []);

    const citationDeletes = ops.filter(
      (o) => o.kind === "delete" && o.table === "scope_citations",
    );
    const mentionDeletes = ops.filter(
      (o) => o.kind === "delete" && o.table === "scope_mentions",
    );
    // ceil(1200 / 500) = 3
    expect(citationDeletes).toHaveLength(3);
    expect(mentionDeletes).toHaveLength(3);
    // 각 문장이 실제로 청크 크기 이하의 id 만 싣는다.
    for (const d of [...citationDeletes, ...mentionDeletes]) {
      expect(d.params ?? 0).toBeLessThanOrEqual(CHUNK);
    }
    // 전부 합치면 원래 집합을 빠짐없이 덮는다 — 청킹이 삭제를 흘리면 안 된다.
    expect(citationDeletes.reduce((s, d) => s + (d.params ?? 0), 0)).toBe(1_200);
  });

  it("★ 회복 규모(5.2만 답변)에서 어떤 delete 도 PG 파라미터 상한에 닿지 않는다", async () => {
    const { db, ops } = makeFakeDb();
    h.getDb.mockReturnValue(db);
    const { scopeMirrorRepository } = await import("./scope-mirror");

    await scopeMirrorRepository.replaceRun(RUN, answersOf(52_000), [], [], []);

    const deletes = ops.filter((o) => o.kind === "delete" && o.params != null);
    expect(deletes.length).toBeGreaterThan(0);
    for (const d of deletes) {
      expect(d.params!).toBeLessThan(PG_MAX_PARAMS);
      expect(d.params!).toBeLessThanOrEqual(CHUNK);
    }
    // 청크 전이었다면 단일 문장에 52,000 파라미터가 실렸을 것이다.
    expect(Math.max(...deletes.map((d) => d.params!))).toBeLessThanOrEqual(CHUNK);
  });

  it("답변이 없으면 job 단위 delete 를 아예 발행하지 않는다 (기존 동작 보존)", async () => {
    const { db, ops } = makeFakeDb();
    h.getDb.mockReturnValue(db);
    const { scopeMirrorRepository } = await import("./scope-mirror");

    await scopeMirrorRepository.replaceRun(RUN, [], [], [], []);

    expect(ops.some((o) => o.kind === "delete" && o.table === "scope_citations")).toBe(false);
    expect(ops.some((o) => o.kind === "delete" && o.table === "scope_mentions")).toBe(false);
    // run 단위 delete(scope_answers·scope_acr_rollups)는 그대로 돈다.
    expect(ops.some((o) => o.kind === "delete" && o.table === "scope_answers")).toBe(true);
  });
});
