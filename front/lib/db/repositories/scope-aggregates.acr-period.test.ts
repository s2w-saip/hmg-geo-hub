import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { latestAcrPromptRunIds } from "./scope-aggregates";

// ACR 기간 의미론 (2026-09-16 제품 확정) — 답변 경로와 **같은 규칙**이어야 한다:
//   · 필터 없음(기본) = 최신 1회차 (셀당 최신 prompt-run 1건)
//   · 기간 설정        = 그 기간의 prompt-run 전부 (누적)
//
// 종전 ACR 은 기간을 걸어도 "그 기간 안의 최신 1건"(기간말 스냅샷)이라 달력을
// 넓혀도 모집단이 안 늘었다 — 라이브 실측(루트, 미러): 기본 4,054 셀 vs
// 2026-08-19~09-15 스냅샷 3,129 셀(창을 넓혔는데 **더 적다**). 누적은 11,676.
//
// ⚠️ ACR 은 고객 계약 지표라, 이 파일이 지키는 것은 "언제 누적이 되는가" 하나다.
// 판정은 `cumulativeMode` 한 곳에서 오므로 answerWhere/detailAnswerWhere 와
// 자동으로 같이 움직인다 — 여기서는 ACR 술어가 그 판정을 **실제로 반영하는지**를
// 고정한다(종전에는 `cumulative` 를 아예 읽지 않았다).

const dialect = new PgDialect();
const text = (w: SQL) => dialect.sqlToQuery(w).sql;
const RANGE = { dateFrom: "2026-08-19", dateTo: "2026-09-15" } as const;

describe("latestAcrPromptRunIds — 기간 의미론", () => {
  it("필터 없음: 셀당 최신 1건 (DISTINCT ON 유지)", () => {
    const s = text(latestAcrPromptRunIds({ cumulative: true }));
    expect(s).toContain("DISTINCT ON (x.prompt_id, x.target, x.region)");
    // 페이지가 넘기는 값과 무관하게 SQL 이 같아야 한다 — 기본 화면 불변의 계약.
    expect(s).toBe(text(latestAcrPromptRunIds({})));
  });

  it("기간 + 누적 표면: 셀 접기를 버리고 기간 안 prompt-run 을 전부 센다", () => {
    const s = text(latestAcrPromptRunIds({ ...RANGE, cumulative: true }));
    expect(s).not.toContain("DISTINCT ON");
    expect(s).toContain("SELECT DISTINCT x.prompt_run_id");
    expect(s).toMatch(/x\.measured_at >= \$\d+::date/);
    expect(s).toMatch(/x\.measured_at < \(\$\d+::date \+ 1\)/);
  });

  it("누적 표면이 아니면 기간이 있어도 종전대로 (기간말 스냅샷)", () => {
    const s = text(latestAcrPromptRunIds({ ...RANGE }));
    expect(s).toContain("DISTINCT ON (x.prompt_id, x.target, x.region)");
  });

  it("기간이 한쪽만 있어도 누적이다 (open-ended)", () => {
    expect(text(latestAcrPromptRunIds({ dateFrom: RANGE.dateFrom, cumulative: true })))
      .not.toContain("DISTINCT ON");
    expect(text(latestAcrPromptRunIds({ dateTo: RANGE.dateTo, cumulative: true })))
      .not.toContain("DISTINCT ON");
  });
});
