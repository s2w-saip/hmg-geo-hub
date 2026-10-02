/**
 * 회차 앵커 레지스트리 재적용 (migration 0053).
 *
 * ── 이 파일이 지키는 것 ──────────────────────────────────────────────────────
 * 미러의 `measured_at` 은 소속 회차의 **앵커 날짜**를 가리켜야 한다. 그 접기를
 * 미러 행 위의 일회성 UPDATE 로만 해 두면 `replaceRun`(run 단위 delete+insert)이
 * 그 run 을 다시 훑는 순간 scope 원본값으로 덮여 소멸한다 — 2026-08-31 회수
 * 재싱크가 18,890행을 되돌린 것이 그 실증이다(RCA §9).
 *
 * 그래서 고정하는 성질은 두 가지다:
 *   (a) 재적용 SQL 이 **DB 함수 하나**(scope_anchor_fold)로 날짜를 옮기고,
 *       이미 앵커인 행은 건드리지 않는다 — TS 로 날짜 산술을 재구현하지 않는다.
 *   (b) 그 문장이 **replaceRun 안에서, answers 삽입 직후, 같은 트랜잭션으로**
 *       실제로 발행된다 — 배선이 빠지면 (a) 가 아무리 맞아도 소용없다.
 *
 * (b) 가 별도로 필요한 이유는 watermark.call-sites.test.ts 와 같다: 순수 함수만
 * 테스트하면 "호출하는 줄을 통째로 지우는" 회귀를 하나도 못 잡는다.
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
/** 공백을 접어 문장 비교를 들여쓰기에 의존하지 않게 한다. */
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

const RUN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

// ── replaceRun 배선 관찰용 가짜 DB ────────────────────────────────────────────
// drizzle 빌더를 흉내내되, **무엇이 어떤 순서로 발행됐는지**만 기록한다.
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
  measuredAt: new Date("2026-07-05T03:20:11Z"),
  modelSlug: null,
  answerText: null,
};
const MENTION = {
  jobId: ANSWER.jobId,
  entityId: "33333333-3333-3333-3333-333333333333",
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

describe("(a) 재적용 SQL — 접기 산술의 정본은 DB 함수 하나", () => {
  it("scope_anchor_fold() 로 날짜만 옮긴다 — TS 날짜 산술 없음", async () => {
    const { anchorReapplySql } = await import("./scope-mirror");
    const q = render(anchorReapplySql(RUN_ID));
    const s = flat(q.sql);

    expect(s).toContain("update scope_answers a");
    expect(s).toContain("set measured_at = scope_anchor_fold(a.measured_at, r.anchor)");
    expect(s).toContain("from scope_answer_anchors r");
    expect(s).toContain("where a.job_id = r.job_id");
    // 산술을 SQL 문장 안에 손으로 펼치지 않는다(정의가 두 벌이 되는 순간
    // 같은 답변이 경로마다 다른 날짜를 받는다 — 0052 의 교훈과 동형).
    expect(s).not.toContain("interval '1 day'");
  });

  it("run 으로 좁힌다 — 방금 삽입한 행 집합과 정확히 같은 범위", async () => {
    const { anchorReapplySql } = await import("./scope-mirror");
    const q = render(anchorReapplySql(RUN_ID));
    expect(flat(q.sql)).toContain("a.run_id = $1::uuid");
    expect(q.params).toEqual([RUN_ID]);
  });

  it("이미 앵커인 행은 건드리지 않는다 (멱등) · measured_at NULL 은 제외", async () => {
    const { anchorReapplySql } = await import("./scope-mirror");
    const s = flat(render(anchorReapplySql(RUN_ID)).sql);
    expect(s).toContain(
      "(a.measured_at at time zone 'UTC')::date is distinct from r.anchor",
    );
    expect(s).toContain("a.measured_at is not null");
  });

  it("날짜 비교는 UTC 로 한다 — 표시 경로(as-of 배지)가 UTC 날짜이기 때문", async () => {
    const { anchorReapplySql } = await import("./scope-mirror");
    const s = flat(render(anchorReapplySql(RUN_ID)).sql);
    expect(s).toContain("at time zone 'UTC'");
    expect(s).not.toMatch(/at time zone '(?!UTC)/);
  });
});

describe("(b) replaceRun 배선 — 재싱크가 앵커를 되돌리지 않는다", () => {
  it("레지스트리가 있으면 answers 삽입 직후·같은 트랜잭션에서 재적용한다", async () => {
    setColumnAvailabilityForTests("scope_answer_anchors", "anchor", true);
    const { db, ops } = makeFakeDb();
    h.getDb.mockReturnValue(db);
    const { scopeMirrorRepository } = await import("./scope-mirror");

    await scopeMirrorRepository.replaceRun(RUN, [ANSWER], [MENTION], [], []);

    const kinds = ops.map((o) => `${o.kind}:${o.detail ?? ""}`);
    const iAnswers = kinds.indexOf("insert:scope_answers");
    const iReapply = ops.findIndex(
      (o) => o.kind === "execute" && o.detail?.includes("scope_answer_anchors"),
    );
    const iMentions = kinds.indexOf("insert:scope_mentions");

    expect(iAnswers).toBeGreaterThan(-1);
    expect(iReapply).toBeGreaterThan(iAnswers); // 삽입 **후**
    expect(iReapply).toBeLessThan(iMentions); // 그리고 곧바로
    // 트랜잭션 경계 안 — 부분 적용(앵커 없는 행이 잠깐 보이는 창)이 없어야 한다.
    expect(ops[0].kind).toBe("begin");
    expect(ops[ops.length - 1].kind).toBe("commit");
    expect(iReapply).toBeLessThan(ops.length - 1);
  });

  it("삽입할 답변이 없으면 재적용도 발행하지 않는다 (빈 run)", async () => {
    setColumnAvailabilityForTests("scope_answer_anchors", "anchor", true);
    const { db, ops } = makeFakeDb();
    h.getDb.mockReturnValue(db);
    const { scopeMirrorRepository } = await import("./scope-mirror");

    await scopeMirrorRepository.replaceRun(RUN, [], [], [], []);
    expect(ops.some((o) => o.kind === "execute" && o.detail?.includes("scope_answer_anchors"))).toBe(false);
  });

  it("마이그레이션 미적용(프로브 false)이면 재적용을 건너뛴다 — 배포가 적용보다 앞선 창", async () => {
    setColumnAvailabilityForTests("scope_answer_anchors", "anchor", false);
    const { db, ops } = makeFakeDb();
    h.getDb.mockReturnValue(db);
    const { scopeMirrorRepository } = await import("./scope-mirror");

    await scopeMirrorRepository.replaceRun(RUN, [ANSWER], [], [], []);
    // 그래도 삽입 자체는 정상적으로 끝나야 한다(싱크 전체가 죽으면 안 된다).
    expect(ops.some((o) => o.kind === "insert" && o.detail === "scope_answers")).toBe(true);
    expect(ops.some((o) => o.kind === "execute" && o.detail?.includes("scope_answer_anchors"))).toBe(false);
  });
});
