import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { answerWhere, SNAPSHOT_CELL_STALE_DAYS } from "./scope-aggregates";

// 2026-09-06: 프로젝트(웹사이트) 스냅샷에서 **측정이 끊긴 셀**을 제외한다.
//
// 종전 "셀(프롬프트×엔진×지역)별 최신 1건"은 그 셀이 언제 마지막으로 측정됐는지
// 보지 않았다. Kia·worldwide·en 실측: US 셀은 7/17 이 마지막인데 KR(9/4)과 합산돼
// 카드 34.6%(1,133/3,278), 같은 화면 주간 추이의 마지막 버킷(KR 만)은 36.3%
// (464/1,277). 분모의 61% 가 7주 묵은 답변이었다.
//
// 계약: 셀은 **그 프로젝트의 최신 측정 시각 − 7일** 안에 측정된 것만 남는다.
// 기준점이 now() 가 아닌 이유 — 프로젝트가 통째로 쉬면(123개 중 29개가 최근 7일
// 측정 없음) now() 기준은 빈 화면을 만든다. 프로젝트별 기준점이어야 다중 프로젝트
// 컨텍스트(브랜드 전체 사이트)에서 각 사이트가 자기 회차로 판정된다.
const compile = (q: SQL) => new PgDialect().sqlToQuery(q);
const PID = "7af85fbf-4ab4-420d-8223-a69cf253fd04";

describe("프로젝트 스냅샷 — 측정이 끊긴 셀 제외", () => {
  it("셀 선택이 프로젝트별 최신 측정 − 7일 창을 건다", () => {
    const { sql } = compile(answerWhere({}, PID));
    expect(sql).toContain("DISTINCT ON (a.prompt_id, a.target, a.region)");
    expect(sql).toContain(
      `max(a.measured_at) - interval '${SNAPSHOT_CELL_STALE_DAYS} days' AS floor_at`,
    );
    expect(sql).toContain("GROUP BY r.project_id");
    expect(sql).toContain("pm ON pm.project_id = r.project_id");
    expect(sql).toContain("a.measured_at >= pm.floor_at");
  });

  it("기준점은 now() 가 아니다 — 프로젝트가 통째로 쉬어도 마지막 회차가 남는다", () => {
    const { sql } = compile(answerWhere({}, PID));
    expect(sql).not.toContain("now() - interval '7 days'");
  });

  it("명시 기간이 있으면 기준점도 그 범위 안의 최신 측정이다 (기간말 스냅샷)", () => {
    const { sql, params } = compile(
      answerWhere({ dateFrom: "2026-07-01", dateTo: "2026-07-31" }, PID),
    );
    // 바깥 선택과 기준점 서브쿼리 양쪽에 같은 기간 상·하한이 걸린다.
    expect(sql.match(/r\.started_at >= /g)?.length).toBe(2);
    expect(sql.match(/r\.started_at < \(/g)?.length).toBe(2);
    expect(params.filter((p) => p === "2026-07-01").length).toBe(2);
    expect(sql).toContain("a.measured_at >= pm.floor_at");
  });

  it("추이(allRuns) 읽기는 창을 걸지 않는다 — 버킷별 스냅샷은 추이 리더가 담당", () => {
    const { sql } = compile(answerWhere({}, PID, { allRuns: true }));
    expect(sql).not.toContain("floor_at");
    expect(sql).toContain("a.run_id IN (SELECT run_id FROM scope_runs");
  });

  it("다중 프로젝트 컨텍스트도 프로젝트별로 기준점을 잡는다", () => {
    const ids = [PID, "11111111-1111-1111-1111-111111111111"];
    const { sql, params } = compile(answerWhere({}, ids));
    expect(sql).toContain("GROUP BY r.project_id");
    // 프로젝트 id 는 배열 바인드 1개다(PR① B4-b) — 그 배열이 바깥 선택과 기준점
    // 서브쿼리 양쪽에 한 번씩, 즉 두 번 등장한다(종전 개별 인라인과 같은 자리).
    expect(
      params.filter((p) => Array.isArray(p) && p[0] === PID && p.length === ids.length).length,
    ).toBe(2);
  });
});
