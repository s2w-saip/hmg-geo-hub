import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  LEDGER_SURFACE_ORDER,
  QA_CONSOLE_SURFACE_ORDER,
  SURFACE_LABEL,
  addressableRootProjectId,
  rootRunScopeSql,
  rootSurfaceArmSql,
  toAnchorSurface,
  toLedgerSurface,
  websiteSurfaceArmSql,
} from "./run-surface";

const dialect = new PgDialect();
const text = (q: SQL) => dialect.sqlToQuery(q).sql;

describe("표면 어휘 매핑 — 한 곳", () => {
  it("두 어휘가 갈리는 지점은 글로벌 이름뿐", () => {
    expect(toLedgerSurface("standard")).toBe("global");
    expect(toLedgerSurface("website")).toBe("website");
    expect(toLedgerSurface("project")).toBe("project");
    expect(toAnchorSurface("global")).toBe("standard");
  });

  it("왕복이 항등", () => {
    for (const s of ["standard", "website", "project"] as const) {
      expect(toAnchorSurface(toLedgerSurface(s))).toBe(s);
    }
  });

  it("라벨 표", () => {
    expect(SURFACE_LABEL.ledger.root).toBe("global");
    expect(SURFACE_LABEL.anchor.root).toBe("standard");
  });
});

describe("판정 팔 조각 — 종전 인라인과 글자가 같아야 한다", () => {
  it("rootSurfaceArmSql", () =>
    expect(text(rootSurfaceArmSql(sql`c.project_id`, "id", "global"))).toBe(
      "WHEN c.project_id = $1::uuid THEN 'global'",
    ));

  it("rootSurfaceArmSql — 루트를 모르면 빈 조각", () =>
    expect(text(rootSurfaceArmSql(sql`c.project_id`, null, "global"))).toBe(""));

  it("websiteSurfaceArmSql", () =>
    expect(text(websiteSurfaceArmSql(sql`c.project_id`, "website"))).toBe(
      "WHEN EXISTS (SELECT 1 FROM website_sites ws WHERE ws.scope_project_id = c.project_id::text) THEN 'website'",
    ));
});

describe("루트 run 스코프 술어", () => {
  it("루트를 알면 project_id 바인드", () => {
    expect(text(rootRunScopeSql("", "root-id"))).toBe("project_id = $1");
    expect(text(rootRunScopeSql("r.", "root-id"))).toBe("r.project_id = $1");
  });
  it("모르면 true (종전 삼항과 같은 SQL)", () => {
    expect(text(rootRunScopeSql("", null))).toBe("true");
    expect(text(rootRunScopeSql("r.", null))).toBe("true");
  });
  it("mock 기본값에서는 주소 지정 불가", () => {
    expect(addressableRootProjectId()).toBeNull();
  });
});

// 생산자마다 판정 **순서**가 다르다는 사실을 값으로 붙잡아 둔다. 순서가 결과를 가르는데
// SQL 안에 묻혀 있어 아무도 비교하지 않았던 것이 오분류의 근인이다.
describe("생산자별 판정 순서 — 지금 서로 다르다(의도적 기록)", () => {
  it("원장은 루트가 맨 앞, QA 콘솔은 맨 뒤", () => {
    expect(LEDGER_SURFACE_ORDER).toEqual(["root", "website", "project"]);
    expect(QA_CONSOLE_SURFACE_ORDER).toEqual(["website", "project", "root"]);
    expect(LEDGER_SURFACE_ORDER).not.toEqual(QA_CONSOLE_SURFACE_ORDER);
  });

  it("QA 콘솔 CTE 의 실제 순서가 상수와 일치한다 (상수만 고치고 SQL 을 안 고치는 것을 막는다)", () => {
    const src = readFileSync("lib/db/repositories/qa-review.ts", "utf-8");
    const cte = src.slice(src.indexOf("const RUN_SURFACE_CTE"));
    const arms = [...cte.matchAll(/THEN '(website|project)'|ELSE '(standard)'/g)]
      .map((m) => m[1] ?? m[2])
      .slice(0, 3);
    expect(arms).toEqual(["website", "project", "standard"]);
  });
});
