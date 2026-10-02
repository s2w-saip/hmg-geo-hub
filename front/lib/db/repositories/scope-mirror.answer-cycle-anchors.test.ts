/**
 * 답변 단위 회차 앵커 전수 테이블(0077)의 **미러 배선**.
 *
 * 0053 배선 테스트(`scope-mirror.anchor-registry.test.ts`)와 같은 자세다 — 순수
 * 함수만 보면 "호출하는 줄을 통째로 지우는" 회귀를 하나도 못 잡는다.
 *
 * 고정하는 성질:
 *   (a) 재계산 SQL 이 **DB 함수 하나**(`refresh_answer_cycle_anchors`)를 부른다.
 *       우선순위·날짜 산술을 TS 로 재구현하지 않는다.
 *   (b) `replaceRun` 안에서, answers 삽입 직후, **같은 트랜잭션**으로 발행된다.
 *   (c) 마이그레이션 미적용(프로브 false)이면 **동기화 경로가 무변경**이다 —
 *       그 문장만 빠지고 나머지는 바이트 동일해야 한다(적용 전 배포에서 싱크가
 *       죽으면 미러 전체가 멈춘다).
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
/** 글로벌(표준) 루트 프로젝트 id — 0077 표면 판정의 'standard' 근거(B4). */
const ROOT_ID = "be28fe15-c743-4a88-abb8-182b25602812";
/** 재계산 문장을 알아보는 지문. 0053 의 `scope_answer_anchors` 와 겹치지 않는다. */
const MARK = "refresh_answer_cycle_anchors";

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
  const sym = Object.getOwnPropertySymbols(t as object).find((s) => String(s).includes("Name"));
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
  measuredAt: new Date("2026-08-31T22:35:00Z"),
  modelSlug: null,
  answerText: null,
};
const MENTION = { jobId: ANSWER.jobId, entityId: "33333333-3333-3333-3333-333333333333" };
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

describe("(a) 재계산 SQL — 산술의 정본은 DB 함수 하나", () => {
  it("refresh_answer_cycle_anchors(run, root) 만 부른다", async () => {
    const { answerCycleAnchorRefreshSql } = await import("./scope-mirror");
    const q = render(answerCycleAnchorRefreshSql(RUN_ID, ROOT_ID));
    expect(flat(q.sql)).toBe(
      "select refresh_answer_cycle_anchors(array[$1::uuid], $2::uuid)",
    );
    expect(q.params).toEqual([RUN_ID, ROOT_ID]);
  });

  it("B4 — 루트 프로젝트 id 는 바인드로만 실린다 (표면 판정의 근거를 인자로 받는다)", async () => {
    const { answerCycleAnchorRefreshSql } = await import("./scope-mirror");
    // env 미설정(mock 모드)이면 NULL 이 그대로 간다 — DB 함수가 폴백 + NOTICE 를 낸다.
    const q = render(answerCycleAnchorRefreshSql(RUN_ID, null));
    expect(q.params).toEqual([RUN_ID, null]);
    // id 를 SQL 텍스트에 인라인하지 않는다(문장 텍스트가 매번 달라지면 계획 재사용이 깨진다).
    expect(flat(q.sql)).not.toContain(ROOT_ID);
  });

  it("우선순위·날짜 산술을 TS 쪽 SQL 에 펼치지 않는다", async () => {
    const { answerCycleAnchorRefreshSql } = await import("./scope-mirror");
    const s = flat(render(answerCycleAnchorRefreshSql(RUN_ID, ROOT_ID)).sql).toLowerCase();
    for (const forbidden of [
      "at time zone",
      "date_trunc",
      "summary_cycles",
      "insert into",
      "on conflict",
      "'registry'",
    ]) {
      expect(s).not.toContain(forbidden);
    }
  });
});

describe("(b) replaceRun 배선", () => {
  /**
   * ⚠️ 재계산은 **`scope_runs` upsert 뒤**여야 한다. 이 함수는 `JOIN scope_runs r` 로
   * 표면(project_id)과 우선순위 3(cycle_anchor_at)을 읽는데, 처음 미러되는 run 은
   * upsert 전에 `scope_runs` 에 행이 없다(FK 가 없어 answers 삽입은 성공한다) →
   * INNER JOIN 이 전부 떨어져 **앵커 행이 한 줄도 안 생긴다.**
   */
  it("scope_runs upsert 뒤·같은 트랜잭션의 마지막에서 재계산한다", async () => {
    setColumnAvailabilityForTests("scope_answer_cycle_anchors", "round_date", true);
    const { db, ops } = makeFakeDb();
    h.getDb.mockReturnValue(db);
    const { scopeMirrorRepository } = await import("./scope-mirror");

    await scopeMirrorRepository.replaceRun(RUN, [ANSWER], [MENTION], [], []);

    const kinds = ops.map((o) => `${o.kind}:${o.detail ?? ""}`);
    const iAnswers = kinds.indexOf("insert:scope_answers");
    const iRuns = kinds.lastIndexOf("insert:scope_runs");
    const iRefresh = ops.findIndex((o) => o.kind === "execute" && o.detail?.includes(MARK));

    expect(iAnswers).toBeGreaterThan(-1);
    expect(iRuns).toBeGreaterThan(-1);
    expect(iRefresh).toBeGreaterThan(iAnswers);
    expect(iRefresh).toBeGreaterThan(iRuns);
    expect(ops[0].kind).toBe("begin");
    expect(ops[ops.length - 1].kind).toBe("commit");
    // 커밋 전 — 같은 트랜잭션 안이다.
    expect(iRefresh).toBeLessThan(ops.length - 1);
  });

  it("run 당 한 번만 발행한다 (B11)", async () => {
    setColumnAvailabilityForTests("scope_answer_cycle_anchors", "round_date", true);
    const { db, ops } = makeFakeDb();
    h.getDb.mockReturnValue(db);
    const { scopeMirrorRepository } = await import("./scope-mirror");

    await scopeMirrorRepository.replaceRun(RUN, [ANSWER], [MENTION], [], []);
    expect(ops.filter((o) => o.detail?.includes(MARK))).toHaveLength(1);
  });

  it("대량 미러 청크(append·finalize:false)는 재계산하지 않고, finalize 한 번만 돈다", async () => {
    setColumnAvailabilityForTests("scope_answer_cycle_anchors", "round_date", true);
    const { writeMirrorChunk, prepareMirrorWrite } = await import("./scope-mirror");
    const caps = { ...(await prepareMirrorWrite()), cycleAnchors: true, rootProjectId: ROOT_ID };

    const seen: string[] = [];
    const tx = {
      delete: () => ({ where: async () => undefined }),
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: async () => undefined,
          then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r),
        }),
      }),
      execute: async (q: unknown) => {
        seen.push(flat(render(q as never).sql));
        return [];
      },
    } as never;

    // 적재 청크 3개 — 전부 finalize:false.
    for (let i = 0; i < 3; i += 1) {
      await writeMirrorChunk(tx, RUN, [ANSWER], [], [], [], [], [], caps, {
        append: i > 0, reset: i === 0, finalize: false,
      });
    }
    expect(seen.filter((s) => s.includes(MARK))).toHaveLength(0);

    // verify 단계 — finalize:true, 배열은 전부 비어 있다.
    await writeMirrorChunk(tx, RUN, [], [], [], [], [], [], caps, { append: true, finalize: true });
    expect(seen.filter((s) => s.includes(MARK))).toHaveLength(1);
  });

  /**
   * N-3 — 종전에는 `answers.length === 0` 이면 재계산·B8 삭제가 통째로 스킵됐다.
   * 그런데 `!options.append` 경로가 바로 앞에서 그 run 의 `scope_answers` 를 전부
   * 지우므로, 0건 재동기화는 **답변이 사라진 run** 이다. 낡은 앵커 행이 남았다.
   */
  it("삽입할 답변이 0건이어도 재계산을 발행한다 — 낡은 앵커 행을 지워야 한다 (N-3)", async () => {
    setColumnAvailabilityForTests("scope_answer_cycle_anchors", "round_date", true);
    const { db, ops } = makeFakeDb();
    h.getDb.mockReturnValue(db);
    const { scopeMirrorRepository } = await import("./scope-mirror");

    await scopeMirrorRepository.replaceRun(RUN, [], [], [], []);
    expect(ops.filter((o) => o.kind === "execute" && o.detail?.includes(MARK))).toHaveLength(1);
  });
});

describe("(c) 프로브 off — 동기화 경로 무변경", () => {
  it("재계산만 빠지고 나머지 발행은 바이트 동일하다", async () => {
    // 0053 레지스트리는 두 경우 모두 없는 상태로 고정한다(비교 대상을 하나만 바꾸려고).
    setColumnAvailabilityForTests("scope_answer_anchors", "anchor", false);
    setColumnAvailabilityForTests("scope_answer_drops", "reason", false);
    setColumnAvailabilityForTests("scope_mention_occurrences", "sentiment", false);
    setColumnAvailabilityForTests("scope_answer_stances", "stance", false);

    const { scopeMirrorRepository } = await import("./scope-mirror");

    setColumnAvailabilityForTests("scope_answer_cycle_anchors", "round_date", false);
    const off = makeFakeDb();
    h.getDb.mockReturnValue(off.db);
    await scopeMirrorRepository.replaceRun(RUN, [ANSWER], [MENTION], [], []);

    setColumnAvailabilityForTests("scope_answer_cycle_anchors", "round_date", true);
    const on = makeFakeDb();
    h.getDb.mockReturnValue(on.db);
    await scopeMirrorRepository.replaceRun(RUN, [ANSWER], [MENTION], [], []);

    expect(off.ops.some((o) => o.detail?.includes(MARK))).toBe(false);
    expect(on.ops.some((o) => o.detail?.includes(MARK))).toBe(true);
    // 그 한 줄을 빼면 두 실행의 발행 시퀀스가 같아야 한다.
    const strip = (ops: Op[]) =>
      ops.filter((o) => !o.detail?.includes(MARK)).map((o) => `${o.kind}:${o.detail ?? ""}`);
    expect(strip(on.ops)).toEqual(strip(off.ops));
    // 그리고 삽입 자체는 정상적으로 끝난다(싱크 전체가 죽으면 안 된다).
    expect(off.ops.some((o) => o.kind === "insert" && o.detail === "scope_answers")).toBe(true);
  });
});
