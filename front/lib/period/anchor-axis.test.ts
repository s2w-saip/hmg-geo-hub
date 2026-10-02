import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  ANCHOR_ALIAS,
  ANCHOR_TABLE,
  anchorDefaultEngineScope,
  anchorDefaultEngineSql,
  anchorJobIdIn,
  anchorJoinSql,
  anchorMeasuredOrigSql,
  anchorMonthSql,
  anchorRoundDateSql,
  anchorWeekSql,
} from "./anchor-axis";
import { anchorCellSnapshotKeys, cellSnapshotKeys } from "./cell-snapshot";
import { anchorRoundAxis, periodBounds, periodBoundsPredicate } from "./period-bounds";
import { resolvePeriodMode, isCumulativePeriod } from "./period-mode";

// 앵커 축 조각의 **텍스트 계약**. 기대 문자열은 계약(CONTRACT.md §2·§3)의 컬럼
// 이름에서 손으로 적은 것이다 — 구현 함수로 기대값을 만들지 않는다(계약 §5).

const dialect = new PgDialect();
const text = (q: SQL) => dialect.sqlToQuery(q).sql;
const params = (q: SQL) => dialect.sqlToQuery(q).params;

describe("컬럼 조각 — 기간 키는 round_date 다", () => {
  it("기본 별칭은 ca", () => {
    expect(ANCHOR_ALIAS).toBe("ca");
    expect(ANCHOR_TABLE).toBe("scope_answer_cycle_anchors");
  });

  it("round_date · anchor_week · anchor_month · measured_at_orig · is_default_engine", () => {
    expect(text(anchorRoundDateSql())).toBe("ca.round_date");
    expect(text(anchorWeekSql())).toBe("ca.anchor_week");
    expect(text(anchorMonthSql())).toBe("ca.anchor_month");
    expect(text(anchorMeasuredOrigSql())).toBe("ca.measured_at_orig");
    expect(text(anchorDefaultEngineSql())).toBe("ca.is_default_engine");
  });

  // 기록용 `anchor_date` 를 기간 키로 쓰면 달력과 기간 술어가 갈린다(스펙 §9.2).
  it("기간 키 조각 어디에도 anchor_date 가 없다", () => {
    for (const q of [anchorRoundDateSql(), anchorWeekSql(), anchorMonthSql()]) {
      expect(text(q)).not.toContain("anchor_date");
    }
  });

  it("별칭을 바꿀 수 있다", () => {
    expect(text(anchorRoundDateSql("ca2"))).toBe("ca2.round_date");
  });
});

describe("조인·semi-join 형태 — 상관 서브쿼리를 만들지 않는다", () => {
  it("anchorJoinSql 은 선행 공백 + INNER JOIN", () => {
    expect(text(anchorJoinSql(sql.raw("a.job_id")))).toBe(
      " JOIN scope_answer_cycle_anchors ca ON ca.job_id = a.job_id",
    );
  });

  it("anchorJobIdIn — 비상관 IN 서브쿼리", () => {
    const q = anchorJobIdIn(sql.raw("a.job_id"), [
      sql`ca.round_date >= ${"2026-08-20"}::date`,
      sql`ca.surface = ${"standard"}`,
    ]);
    expect(text(q!)).toBe(
      "a.job_id IN (SELECT ca.job_id FROM scope_answer_cycle_anchors ca WHERE ca.round_date >= $1::date AND ca.surface = $2)",
    );
    expect(params(q!)).toEqual(["2026-08-20", "standard"]);
  });

  it("술어가 비면 null — 절을 통째로 생략한다(전수 semi-join 금지)", () => {
    expect(anchorJobIdIn(sql.raw("a.job_id"), [])).toBeNull();
  });
});

describe("기본 엔진 범위 — 사용자가 고르면 그 선택이 이긴다", () => {
  it("엔진 필터가 비면 is_default_engine 로 좁힌다", () => {
    expect(text(anchorDefaultEngineScope(undefined)!)).toBe("ca.is_default_engine");
    expect(text(anchorDefaultEngineScope([])!)).toBe("ca.is_default_engine");
  });

  it("엔진을 고르면 이 축의 술어는 없다", () => {
    expect(anchorDefaultEngineScope(["deepseek"])).toBeNull();
    expect(anchorDefaultEngineScope(["chatgpt", "gemini"])).toBeNull();
  });
});

describe("anchorRoundAxis — 기간은 양 끝 포함", () => {
  const F = "2026-08-20";
  const T = "2026-09-04";

  it("상한이 <= (BETWEEN 과 같은 집합)", () => {
    expect(periodBounds({ dateFrom: F, dateTo: T }, anchorRoundAxis()).map(text)).toEqual([
      "ca.round_date >= $1::date",
      "ca.round_date <= $1::date",
    ]);
  });

  it("한쪽만 / 없음", () => {
    expect(periodBounds({ dateFrom: F }, anchorRoundAxis()).map(text)).toEqual([
      "ca.round_date >= $1::date",
    ]);
    expect(periodBounds({ dateTo: T }, anchorRoundAxis()).map(text)).toEqual([
      "ca.round_date <= $1::date",
    ]);
    expect(periodBounds({}, anchorRoundAxis())).toEqual([]);
  });

  it("바인드는 날짜 둘, 캐스트는 명시(42883 방지)", () => {
    const q = periodBoundsPredicate({ dateFrom: F, dateTo: T }, anchorRoundAxis());
    expect(text(q)).toBe("ca.round_date >= $1::date AND ca.round_date <= $2::date");
    expect(params(q)).toEqual([F, T]);
  });
});

describe("anchorCellSnapshotKeys — 회차마다 셀당 대표 1건", () => {
  it("회차 키가 맨 앞, 동점은 measured_at_orig → job_id", () => {
    const k = anchorCellSnapshotKeys({ alias: "a." });
    expect(text(k.all)).toBe("ca.round_date, a.prompt_id, a.target, a.region");
    // `job_id DESC` 는 **결정성**이다(검증 C): `measured_at_orig` 는 0077 의
    // COALESCE 폴백(회차 앵커 시각) 때문에 한 회차 전체가 동률이 될 수 있고,
    // 거기서 끝나면 PostgreSQL 이 임의 행을 골라 JS 짝과 다른 대표가 나온다.
    expect(text(k.tieBreak)).toBe("ca.measured_at_orig DESC, a.job_id DESC");
    expect(text(k.cells)).toBe("a.prompt_id, a.target, a.region");
  });

  it("bare 경로에서도 동점 처리에 job_id 가 있다", () => {
    expect(text(anchorCellSnapshotKeys().tieBreak)).toBe(
      "ca.measured_at_orig DESC, job_id DESC",
    );
  });

  // 접힌 measured_at 으로 정렬하면 날짜부가 앵커로 덮여 시:분만 비교한다(스펙 §2-16).
  it("종전 tieBreak(measured_at)를 쓰지 않는다", () => {
    expect(text(anchorCellSnapshotKeys({ alias: "a." }).tieBreak)).not.toBe(
      "a.measured_at DESC",
    );
  });

  it("DISTINCT ON ↔ ORDER BY 제약 — 키 목록에 바인드가 없다", () => {
    expect(params(anchorCellSnapshotKeys({ alias: "a." }).all)).toEqual([]);
  });

  // 종전 호출부(인자 셋)는 그대로여야 한다 — off 경로의 바이트 동일성.
  it("tieBreak 를 안 넘기면 종전 기본값", () => {
    expect(text(cellSnapshotKeys({ alias: "a." }).tieBreak)).toBe("a.measured_at DESC");
  });
});

describe("resolvePeriodMode — 앵커 축 분기", () => {
  const RANGE = { dateFrom: "2026-08-20", dateTo: "2026-09-04" };

  it("앵커 축 + 기간 → anchor_period (cumulative 선언과 무관)", () => {
    expect(resolvePeriodMode(RANGE, { anchorAxis: true })).toBe("anchor_period");
    expect(resolvePeriodMode({ ...RANGE, cumulative: true }, { anchorAxis: true })).toBe(
      "anchor_period",
    );
    expect(resolvePeriodMode({ dateFrom: RANGE.dateFrom }, { anchorAxis: true })).toBe(
      "anchor_period",
    );
  });

  it("앵커 축 + 기간 없음 → snapshot", () => {
    expect(resolvePeriodMode({}, { anchorAxis: true })).toBe("snapshot");
    expect(resolvePeriodMode({ cumulative: true }, { anchorAxis: true })).toBe("snapshot");
  });

  it("추이(allRuns)가 앵커 축보다 먼저 이긴다", () => {
    expect(resolvePeriodMode(RANGE, { anchorAxis: true, allRuns: true })).toBe("trend");
  });

  // off 경로의 진리표는 한 칸도 움직이지 않아야 한다.
  it("anchorAxis 를 안 넘기면 종전 진리표 그대로", () => {
    expect(resolvePeriodMode({})).toBe("snapshot");
    expect(resolvePeriodMode(RANGE)).toBe("snapshot");
    expect(resolvePeriodMode({ cumulative: true })).toBe("snapshot");
    expect(resolvePeriodMode({ ...RANGE, cumulative: true })).toBe("cumulative");
    expect(resolvePeriodMode(RANGE, { allRuns: true })).toBe("trend");
  });

  it("isCumulativePeriod 는 두 모드를 함께 참으로 본다", () => {
    expect(isCumulativePeriod(RANGE, { anchorAxis: true })).toBe(true);
    expect(isCumulativePeriod({}, { anchorAxis: true })).toBe(false);
    expect(isCumulativePeriod({ ...RANGE, cumulative: true })).toBe(true);
    expect(isCumulativePeriod(RANGE)).toBe(false);
  });
});
