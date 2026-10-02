import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import { __testables } from "./scope-aggregates";
import {
  resetAnchorAxisForTests,
  setAnchorAxisForTests,
} from "@/lib/period/anchor-axis-state";
import { anchorJoinSql } from "@/lib/period/anchor-axis";
import type { ResolvedMention } from "@/lib/scope/types";

const {
  readMirrorAnswerMeta,
  buildMirrorJobs,
  cycleAsOfRowSql,
  cycleAsOfSql,
  cycleAsOfDisplaySql,
  anchorAsOfJoinSql,
  normalizeAsOf,
} = __testables;

// ─────────────────────────────────────────────────────────────────────────────
// 미러 answer 메타 투영 — 앵커 축의 **JS 롤업 입력**이 어디서 오는지 고정한다.
//
// 두 가지를 잠근다:
//   ① 축이 **꺼지면** 문장이 종전 그대로다(앵커 표 이름이 텍스트에 한 번도 없다).
//   ② 축이 **켜지면** 다섯 컬럼이 조인으로 실린다(상관 서브쿼리가 아니다).
//
// DB 에 접속하지 않는다(계약 §5: 표가 아직 어떤 DB 에도 없다) — `MirrorReader` 를
// 가짜로 넣어 두 분기가 각각 무엇을 발행하는지만 본다. 꺼진 분기는 drizzle 의
// 실제 빌더(`QueryBuilder`)로 컴파일해 **텍스트까지** 확인한다.
// ─────────────────────────────────────────────────────────────────────────────

const dialect = new PgDialect();
const ANCHOR_TABLE = "scope_answer_cycle_anchors";

type Capture = { select?: { text: string }; execute?: { text: string } };

function fakeReader(cap: Capture) {
  const qb = new QueryBuilder();
  return {
    // drizzle 빌더를 그대로 태워 종전 문장의 **실제 텍스트**를 얻는다.
    select: (fields: Record<string, unknown>) => {
      const b = qb.select(fields as never);
      return {
        from: (table: never) => {
          const f = b.from(table);
          return {
            where: (w: SQL) => {
              cap.select = { text: f.where(w).toSQL().sql };
              return Promise.resolve([]);
            },
          };
        },
      };
    },
    execute: (q: SQL) => {
      cap.execute = { text: dialect.sqlToQuery(q).sql };
      return Promise.resolve([]);
    },
  } as never;
}

/** 술어 텍스트가 분기 판정에 섞이지 않게 최소 술어만 쓴다. */
const RUN_FILTER = sql`job_id = 'j1'`;

afterEach(() => resetAnchorAxisForTests());

describe("readMirrorAnswerMeta — 축 off 는 종전 문장 그대로", () => {
  beforeEach(() => setAnchorAxisForTests(false));

  it("앵커 표 이름이 문장 어디에도 없다", async () => {
    const cap: Capture = {};
    await readMirrorAnswerMeta(RUN_FILTER, fakeReader(cap));
    expect(cap.execute).toBeUndefined(); // raw 경로를 타지 않는다
    expect(cap.select?.text).toBeDefined();
    expect(cap.select!.text).not.toContain(ANCHOR_TABLE);
    expect(cap.select!.text).not.toContain("round_date");
    expect(cap.select!.text).not.toContain("anchor_week");
    expect(cap.select!.text).not.toContain("measured_at_orig");
    expect(cap.select!.text).not.toContain("is_default_engine");
    expect(cap.select!.text).not.toContain("view_anchor_date");
  });

  it("컬럼 6개·표 1개 그대로", async () => {
    const cap: Capture = {};
    await readMirrorAnswerMeta(RUN_FILTER, fakeReader(cap));
    expect(cap.select!.text).toBe(
      'select "job_id", "prompt_id", "target", "region", "status", "measured_at" ' +
        'from "scope_answers" where job_id = \'j1\'',
    );
  });
});

describe("readMirrorAnswerMeta — 축 on 은 다섯 컬럼을 조인으로 싣는다", () => {
  beforeEach(() => setAnchorAxisForTests(true));

  it("drizzle select 경로를 타지 않고 raw 문장을 낸다", async () => {
    const cap: Capture = {};
    await readMirrorAnswerMeta(RUN_FILTER, fakeReader(cap));
    expect(cap.select).toBeUndefined();
    expect(cap.execute?.text).toBeDefined();
  });

  it("다섯 컬럼이 계약상의 별칭으로 투영된다", async () => {
    const cap: Capture = {};
    await readMirrorAnswerMeta(RUN_FILTER, fakeReader(cap));
    const text = cap.execute!.text;
    expect(text).toContain("to_char(ca.round_date, 'YYYY-MM-DD') AS round_date");
    expect(text).toContain("to_char(ca.anchor_week, 'YYYY-MM-DD') AS anchor_week");
    expect(text).toContain(
      "to_char(ca.measured_at_orig AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS measured_at_orig",
    );
    expect(text).toContain("ca.is_default_engine AS is_default_engine");
    expect(text).toContain("to_char(ca.view_anchor_date, 'YYYY-MM-DD') AS view_anchor_date");
  });

  it("조인이고(상관 서브쿼리 아님) 술어는 한 글자도 안 바뀐다", async () => {
    const cap: Capture = {};
    await readMirrorAnswerMeta(RUN_FILTER, fakeReader(cap));
    const text = cap.execute!.text;
    expect(text).toContain(`JOIN ${ANCHOR_TABLE} ca ON ca.job_id = sa.job_id`);
    // 술어는 파생 테이블 안에 그대로 들어간다 — 한정 없는 `job_id` 가 모호해지지 않는다.
    expect(text).toContain("FROM scope_answers WHERE job_id = 'j1'");
    // 앵커 표를 서브쿼리로 다시 읽는 형태가 없다(계약 §5).
    expect(text).not.toContain(`IN (SELECT ca.job_id FROM ${ANCHOR_TABLE}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 측정 기준일(asOf) 축 라우터 — 대시보드 pill 과 언급·인용 화면이 **같은 값**을 보게
// 하는 자리. 종전에는 지역 롤업만 `COALESCE(r.cycle_anchor_at, a.measured_at)` 에
// 남아 있어 회차 209개에서 하루 갈렸다.
// ─────────────────────────────────────────────────────────────────────────────

const t = (q: SQL) => dialect.sqlToQuery(q).sql;
/** 종전 축의 행 단위 기준일 — 이 문자열이 바뀌면 대시보드 SQL 이 바뀐 것이다. */
const LEGACY_ROW = "COALESCE(r.cycle_anchor_at, a.measured_at)";

describe("측정 기준일 라우터 — 축 off 는 종전 식 그대로", () => {
  beforeEach(() => setAnchorAxisForTests(false));

  it("행 단위 · 집계 · 표시용 셋 다 종전 텍스트", () => {
    expect(t(cycleAsOfRowSql())).toBe(LEGACY_ROW);
    expect(t(cycleAsOfSql())).toBe(`max(${LEGACY_ROW})`);
    // 표시용도 **감싸지 않는다** — 헤드라인 문장이 바이트로 같아야 한다.
    expect(t(cycleAsOfDisplaySql())).toBe(`max(${LEGACY_ROW})`);
    expect(t(cycleAsOfDisplaySql())).not.toContain("to_char");
  });

  it("asOf 조인 조각이 비어 있다", () => {
    expect(t(anchorAsOfJoinSql(sql.raw("a.job_id")))).toBe("");
  });
});

describe("측정 기준일 라우터 — 축 on 은 귀속 날짜(round_date)", () => {
  beforeEach(() => setAnchorAxisForTests(true));

  it("행 단위 = ca.round_date · 집계 = max(ca.round_date)", () => {
    expect(t(cycleAsOfRowSql())).toBe("ca.round_date");
    expect(t(cycleAsOfSql())).toBe("max(ca.round_date)");
    expect(t(cycleAsOfRowSql())).not.toContain("cycle_anchor_at");
  });

  it("표시용은 YYYY-MM-DD 텍스트로 자른다", () => {
    expect(t(cycleAsOfDisplaySql())).toBe("to_char(max(ca.round_date), 'YYYY-MM-DD')");
  });

  it("asOf 조인은 **LEFT** 다 — 모집단(count) 을 건드리면 안 된다", () => {
    const text = t(anchorAsOfJoinSql(sql.raw("a.job_id")));
    expect(text).toBe(` LEFT JOIN ${ANCHOR_TABLE} ca ON ca.job_id = a.job_id`);
    // INNER 로 바뀌면 앵커 행 없는 답변이 count(*)·tracked 에서 조용히 빠진다.
    expect(text.trim().startsWith("LEFT JOIN")).toBe(true);
    // 값 투영 전용 조각과 술어용 INNER 조각(anchorJoinSql)은 서로 다른 텍스트여야 한다.
    expect(t(anchorJoinSql(sql.raw("a.job_id")))).not.toBe(text);
  });
});

describe("normalizeAsOf — 축 안에서 형식이 균일하다", () => {
  it("YYYY-MM-DD 는 그대로(앵커 축)", () => {
    expect(normalizeAsOf("2026-09-04")).toBe("2026-09-04");
    expect(normalizeAsOf("2026-08-31")).toBe("2026-08-31");
  });

  it("Date 는 ISO(종전 축 — 출력 무변경)", () => {
    // 손계산: 2026-09-04 15:30Z 는 그대로 ISO 로 나간다.
    expect(normalizeAsOf(new Date("2026-09-04T15:30:00.000Z"))).toBe(
      "2026-09-04T15:30:00.000Z",
    );
  });

  it("timestamptz 텍스트는 ISO 로 정규화", () => {
    expect(normalizeAsOf("2026-09-04T15:30:00.000Z")).toBe("2026-09-04T15:30:00.000Z");
  });

  it("null/undefined 는 null", () => {
    expect(normalizeAsOf(null)).toBeNull();
    expect(normalizeAsOf(undefined)).toBeNull();
  });
});

describe("buildMirrorJobs — 필드 실림 조건", () => {
  const noMentions = new Map<string, ResolvedMention[]>();
  const BASE = {
    jobId: "j1",
    promptId: "p1",
    target: "chatgpt",
    region: "KR",
    status: "completed",
    // 손계산: 2026-09-04T01:23:45.678Z (UTC) — KST 로는 09-04 10:23 이다.
    measuredAt: new Date("2026-09-04T01:23:45.678Z"),
  };

  it("roundDate 가 없으면 다섯 키가 **아예 없다**(종전 job 모양)", () => {
    const [job] = buildMirrorJobs([BASE], noMentions);
    expect(job.measured_at).toBe("2026-09-04T01:23:45.678Z");
    expect("round_date" in job).toBe(false);
    expect("anchor_week" in job).toBe(false);
    expect("measured_at_orig" in job).toBe(false);
    expect("is_default_engine" in job).toBe(false);
    // 노출 게이트는 키의 유무가 곧 on/off 다 — 없어야 종전처럼 통과한다.
    expect("view_anchor_date" in job).toBe(false);
  });

  it("roundDate 가 있으면 다섯 키가 함께 실린다", () => {
    const [job] = buildMirrorJobs(
      [
        {
          ...BASE,
          roundDate: "2026-09-04",
          anchorWeek: "2026-08-31", // 손계산: 2026-09-04(금)이 속한 주의 월요일
          measuredAtOrig: "2026-09-04T01:23:45.678Z",
          isDefaultEngine: true,
          viewAnchorDate: "2026-09-06",
        },
      ],
      noMentions,
    );
    expect(job.round_date).toBe("2026-09-04");
    expect(job.anchor_week).toBe("2026-08-31");
    expect(job.measured_at_orig).toBe("2026-09-04T01:23:45.678Z");
    expect(job.is_default_engine).toBe(true);
    expect(job.view_anchor_date).toBe("2026-09-06");
  });

  it("view_anchor_date 가 NULL 이면 키는 있고 값이 null 이다(= 비노출)", () => {
    const [job] = buildMirrorJobs(
      [
        {
          ...BASE,
          roundDate: "2026-09-04",
          anchorWeek: "2026-08-31",
          measuredAtOrig: "2026-09-04T01:23:45.678Z",
          isDefaultEngine: false,
          viewAnchorDate: null,
        },
      ],
      noMentions,
    );
    expect("view_anchor_date" in job).toBe(true);
    expect(job.view_anchor_date).toBeNull();
    expect(job.is_default_engine).toBe(false);
  });

  it("한 배치에 축 유무가 섞여도 행마다 갈린다", () => {
    const jobs = buildMirrorJobs(
      [
        { ...BASE, jobId: "j1" },
        {
          ...BASE,
          jobId: "j2",
          roundDate: "2026-08-28",
          anchorWeek: "2026-08-24", // 손계산: 2026-08-28(금)이 속한 주의 월요일
          measuredAtOrig: "2026-08-28T09:00:00.000Z",
          isDefaultEngine: true,
          viewAnchorDate: "2026-08-30",
        },
      ],
      noMentions,
    );
    expect("round_date" in jobs[0]).toBe(false);
    expect(jobs[1].round_date).toBe("2026-08-28");
    expect(jobs[1].anchor_week).toBe("2026-08-24");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 축 on 의 raw 경로는 drizzle postgres-js 드라이버를 거치면 timestamptz 가 **문자열**로
// 온다(`drizzle-orm/postgres-js/driver.js` 의 투명 파서). 2026-09-28 프리뷰 드릴다운 500
// (`a.measuredAt?.toISOString is not a function`)의 재현: 가짜 리더가 그 모양(문자열)을
// 돌려주면 매핑이 Date 계약을 지켜야 하고 buildMirrorJobs 가 던지면 안 된다.
// ─────────────────────────────────────────────────────────────────────────────
describe("readMirrorAnswerMeta: 축 on, postgres-js 모양(문자열 measured_at)", () => {
  beforeEach(() => setAnchorAxisForTests(true));

  function stringRowReader(cap: Capture, rows: unknown[]) {
    return {
      select: () => {
        throw new Error("축 on 은 select 경로를 타지 않는다");
      },
      execute: (q: SQL) => {
        cap.execute = { text: dialect.sqlToQuery(q).sql };
        return Promise.resolve(rows);
      },
    } as never;
  }

  const ROW = {
    job_id: "j1",
    prompt_id: "p1",
    target: "chatgpt",
    region: "KR",
    status: "completed",
    round_date: "2026-09-11",
    anchor_week: "2026-09-07",
    measured_at_orig: "2026-09-11T02:00:00.123Z",
    is_default_engine: true,
    view_anchor_date: "2026-09-13",
  };

  it("measured_at 도 UTC ISO(ms) 텍스트로 투영한다: 드라이버 파서와 무관", async () => {
    const cap: Capture = {};
    await readMirrorAnswerMeta(RUN_FILTER, stringRowReader(cap, []));
    expect(cap.execute!.text).toContain(
      "to_char(sa.measured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS measured_at",
    );
  });

  it("문자열 measured_at 을 Date 로 매핑하고 buildMirrorJobs 가 ISO 를 싣는다", async () => {
    const cap: Capture = {};
    const meta = await readMirrorAnswerMeta(
      RUN_FILTER,
      stringRowReader(cap, [
        { ...ROW, measured_at: "2026-09-11T02:00:00.123Z" },
        { ...ROW, job_id: "j2", measured_at: null },
      ]),
    );
    // 프리뷰에서 터진 그 호출을 먼저: 수정 전에는 여기서 TypeError 가 난다.
    const jobs = buildMirrorJobs(meta, new Map<string, ResolvedMention[]>());
    expect(meta[0].measuredAt).toBeInstanceOf(Date);
    expect(meta[1].measuredAt).toBeNull();
    expect(jobs[0].measured_at).toBe("2026-09-11T02:00:00.123Z");
    expect(jobs[1].measured_at).toBe("");
    expect(jobs[0].round_date).toBe("2026-09-11");
  });
});
