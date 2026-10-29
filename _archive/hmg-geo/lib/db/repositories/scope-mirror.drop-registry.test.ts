/**
 * 답변 드롭 레지스트리 재적용 (migration 0054).
 *
 * ── 이 파일이 지키는 것 ──────────────────────────────────────────────────────
 * 중복 회차(같은 주·같은 사이트 두 번 측정)는 접기로 해결되지 않고 미러에서 **제외**
 * 해야 한다. 그 제외를 일회성 DELETE 로만 해 두면 `replaceRun`(run 단위 delete+insert)
 * 이 그 run 을 다시 훑는 순간 되살아난다 — 앵커가 2026-08-31 에 겪은 것과 같은 형태다.
 *
 * 그래서 고정하는 성질은 두 가지다(anchor-registry.test.ts 와 동형):
 *   (a) 재적용 SQL 이 **DB 함수 하나**(scope_answer_drop_apply)를 부른다 — TS 로 세
 *       테이블 delete 를 재구현하지 않는다(두 벌이 갈리면 mentions 만 남는 고아가 생긴다).
 *   (b) 그 문장이 **replaceRun 안에서, answers·mentions·citations 삽입이 모두 끝난 뒤,
 *       같은 트랜잭션으로** 발행된다 — 앞당기면 뒤에 삽입되는 mentions·citations 가
 *       고아로 남고, 배선이 빠지면 (a) 가 맞아도 소용없다.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQL } from "drizzle-orm";
import {
  resetColumnAvailabilityForTests,
  setColumnAvailabilityForTests,
} from "@/lib/db/column-availability";

const dialect = new PgDialect();
const render = (v: unknown) => dialect.sqlToQuery(v as SQL);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

const RUN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

type Op = { kind: string; detail?: string };

function makeFakeDb() {
  const ops: Op[] = [];
  const thenable = (kind: string, detail?: string) => {
    ops.push({ kind, detail });
    return {
      where: () => Promise.resolve(undefined),
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
    execute: (q: unknown) => {
      ops.push({ kind: "execute", detail: flat(render(q).sql) });
      return Promise.resolve(undefined);
    },
  };
  const db = {
    transaction: async (fn: (t: typeof tx) => Promise<void>) => {
      ops.push({ kind: "begin" });
      await fn(tx);
      ops.push({ kind: "commit" });
    },
  };
  return { db, ops };
}

function tableName(t: unknown): string {
  const sym = Object.getOwnPropertySymbols(t as object).find((s) =>
    String(s).includes("Name"),
  );
  return sym ? String((t as Record<symbol, unknown>)[sym]) : "?";
}

const h = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: h.getDb }));

const ANSWER = {
  jobId: "11111111-1111-1111-1111-111111111111",
  runId: RUN_ID,
  promptId: null,
  target: "chatgpt",
  region: "KR",
  status: "completed",
  measuredAt: new Date("2026-08-19T03:20:11Z"),
  modelSlug: null,
  answerText: null,
};
const MENTION = {
  jobId: ANSWER.jobId,
  entityId: "33333333-3333-3333-3333-333333333333",
};
const CITATION = {
  id: "44444444-4444-4444-4444-444444444444",
  jobId: ANSWER.jobId,
  url: "https://example.com/a",
};
const RUN = {
  runId: RUN_ID,
  projectId: "22222222-2222-2222-2222-222222222222",
  status: "completed",
  startedAt: null,
  completedAt: null,
  totalJobs: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetColumnAvailabilityForTests();
});

describe("(a) 재적용 SQL — 삭제 범위·순서의 정본은 DB 함수 하나", () => {
  it("scope_answer_drop_apply(run) 하나만 부른다 — TS delete 재구현 없음", async () => {
    const { dropReapplySql } = await import("./scope-mirror");
    const q = render(dropReapplySql(RUN_ID));
    const s = flat(q.sql);
    expect(s).toBe("select scope_answer_drop_apply($1::uuid)");
    expect(q.params).toEqual([RUN_ID]);
    expect(s).not.toContain("delete");
  });
});

describe("(b) replaceRun 배선 — 재싱크가 드롭을 되살리지 않는다", () => {
  const isDrop = (o: Op) => o.kind === "execute" && !!o.detail?.includes("scope_answer_drop_apply");

  it("레지스트리가 있으면 모든 삽입 뒤·같은 트랜잭션에서 재적용한다", async () => {
    setColumnAvailabilityForTests("scope_answer_drops", "reason", true);
    const { db, ops } = makeFakeDb();
    h.getDb.mockReturnValue(db);
    const { scopeMirrorRepository } = await import("./scope-mirror");

    await scopeMirrorRepository.replaceRun(RUN, [ANSWER], [MENTION], [CITATION], []);

    const kinds = ops.map((o) => `${o.kind}:${o.detail ?? ""}`);
    const iDrop = ops.findIndex(isDrop);
    const lastInsert = Math.max(
      kinds.lastIndexOf("insert:scope_answers"),
      kinds.lastIndexOf("insert:scope_mentions"),
      kinds.lastIndexOf("insert:scope_citations"),
    );
    const iRuns = kinds.indexOf("insert:scope_runs");

    expect(iDrop).toBeGreaterThan(-1);
    expect(iDrop).toBeGreaterThan(lastInsert); // answers·mentions·citations 전부 **뒤**
    expect(iDrop).toBeLessThan(iRuns); // 워터마크(scope_runs upsert) 전
    expect(ops[0].kind).toBe("begin");
    expect(ops[ops.length - 1].kind).toBe("commit");
  });

  it("앵커 재적용과 공존한다 — 앵커는 answers 직후, 드롭은 마지막", async () => {
    setColumnAvailabilityForTests("scope_answer_anchors", "anchor", true);
    setColumnAvailabilityForTests("scope_answer_drops", "reason", true);
    const { db, ops } = makeFakeDb();
    h.getDb.mockReturnValue(db);
    const { scopeMirrorRepository } = await import("./scope-mirror");

    await scopeMirrorRepository.replaceRun(RUN, [ANSWER], [MENTION], [CITATION], []);
    const iAnchor = ops.findIndex(
      (o) => o.kind === "execute" && o.detail?.includes("scope_answer_anchors"),
    );
    const iDrop = ops.findIndex(isDrop);
    expect(iAnchor).toBeGreaterThan(-1);
    expect(iDrop).toBeGreaterThan(iAnchor);
  });

  it("삽입할 답변이 없으면 재적용도 발행하지 않는다 (빈 run)", async () => {
    setColumnAvailabilityForTests("scope_answer_drops", "reason", true);
    const { db, ops } = makeFakeDb();
    h.getDb.mockReturnValue(db);
    const { scopeMirrorRepository } = await import("./scope-mirror");

    await scopeMirrorRepository.replaceRun(RUN, [], [], [], []);
    expect(ops.some(isDrop)).toBe(false);
  });

  it("마이그레이션 미적용(프로브 false)이면 건너뛴다 — 배포가 적용보다 앞선 창", async () => {
    setColumnAvailabilityForTests("scope_answer_drops", "reason", false);
    const { db, ops } = makeFakeDb();
    h.getDb.mockReturnValue(db);
    const { scopeMirrorRepository } = await import("./scope-mirror");

    await scopeMirrorRepository.replaceRun(RUN, [ANSWER], [], [], []);
    expect(ops.some((o) => o.kind === "insert" && o.detail === "scope_answers")).toBe(true);
    expect(ops.some(isDrop)).toBe(false);
  });
});
