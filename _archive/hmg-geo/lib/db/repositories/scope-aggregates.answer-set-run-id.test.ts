// 회귀 가드 — withAnswerSet 의 TEMP 투영과 그 안에서 `_answer_set a` 를 읽는 문장의 컬럼 참조가
// 어긋나면 런타임에만(캐시 미스 시점) 42703 으로 터진다. 2026-09-05 프로덕션 장애: #209 가
// `_answer_set a LEFT JOIN scope_runs r ON r.run_id = a.run_id` 를 넣었는데 투영은
// `a.job_id, a.region, a.measured_at` 뿐이었다. 단위 테스트는 SQL 을 실행하지 않으므로 소스를
// 직접 대조한다(이 리포의 "컴파일된 SQL·소스 가드" 관례).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(path.join(process.cwd(), "lib/db/repositories/scope-aggregates.ts"), "utf8");

// withAnswerSet( … sql`<투영>` … async (db) => { <본문> }) 블록을 대략적으로 잘라낸다:
// 투영은 첫 sql`…` 템플릿, 본문은 다음 withAnswerSet( 또는 파일 끝까지(같은 함수 안의 문장만 본다).
function blocks(): Array<{ line: number; projection: string; body: string }> {
  const out: Array<{ line: number; projection: string; body: string }> = [];
  const re = /withAnswerSet\(/g;
  let m: RegExpExecArray | null;
  const starts: number[] = [];
  while ((m = re.exec(SRC))) starts.push(m.index);
  starts.forEach((s, i) => {
    // 투영이 인라인 sql`…` 이 아니라 헬퍼 호출(예: kpiTabTrendCols(unit))인 경우가 있다 —
    // 그 헬퍼가 돌려주는 첫 sql`…` 템플릿을 투영으로 본다. 안 그러면 본문의 첫 템플릿을
    // 투영으로 오인해 가드가 엉뚱한 것을 대조한다.
    const head = SRC.slice(s + "withAnswerSet(".length, s + 200);
    const helper = /^\s*([A-Za-z_$][\w$]*)\(/.exec(head);
    let projStart = SRC.indexOf("sql`", s);
    if (helper && helper[1] !== "sql") {
      const decl = SRC.indexOf(`function ${helper[1]}(`);
      if (decl >= 0) projStart = SRC.indexOf("sql`", decl);
    }
    const projEnd = SRC.indexOf("`", projStart + 4);
    const projection = SRC.slice(projStart + 4, projEnd);
    const bodyEnd = i + 1 < starts.length ? starts[i + 1] : SRC.length;
    // 다음 최상위 함수 선언 전까지로 본문을 제한한다.
    const nextFn = SRC.indexOf("\nexport async function ", projEnd);
    const nextFn2 = SRC.indexOf("\nasync function ", projEnd);
    const limit = [bodyEnd, nextFn, nextFn2].filter((x) => x > 0).reduce((a, b) => Math.min(a, b));
    out.push({ line: SRC.slice(0, s).split("\n").length, projection, body: SRC.slice(projEnd, limit) });
  });
  return out;
}

describe("withAnswerSet 투영 ⊇ _answer_set 참조 컬럼", () => {
  const bs = blocks();
  it("블록을 찾는다", () => {
    expect(bs.length).toBeGreaterThanOrEqual(4);
  });
  it.each(bs.map((b) => [b.line, b] as const))("line %s: 본문이 a.<col> 로 읽는 컬럼은 전부 투영에 있다", (_line, b) => {
    // 본문에서 `_answer_set a` 별칭으로 읽는 a.<컬럼> — 투영 별칭도 a. 이므로 이름을 그대로 대조한다.
    // 본문 안의 다른 `a` 별칭(예: scope_answers a 를 다시 조인하는 문장)은 이 가드의 범위 밖이라,
    // `_answer_set a` 가 등장하는 SQL 템플릿 조각 안에서만 a.<col> 을 모은다.
    // 투영은 `a.<col>` 뿐 아니라 `<식> AS <alias>`(예: date_trunc(...) AS bucket) 도 컬럼이 된다.
    const projected = new Set([
      ...(b.projection.match(/a\.([a-z_]+)/g) ?? []).map((x) => x.slice(2)),
      ...(b.projection.match(/\bAS\s+([a-z_]+)/gi) ?? []).map((x) => x.replace(/^AS\s+/i, "")),
    ]);
    const templates = b.body.split("sql`").slice(1).map((t) => t.slice(0, t.indexOf("`")));
    const missing = new Set<string>();
    for (const t of templates) {
      if (!/_answer_set\s+a\b/.test(t)) continue;
      // `a.job_id IN (SELECT job_id FROM _answer_set)` 같은 서브쿼리 형태는 별칭 a 가 바깥 표를 가리키므로 제외
      if (/FROM\s+_answer_set\s*\)/.test(t) && !/FROM\s+_answer_set\s+a\b/.test(t)) continue;
      for (const c of t.match(/\ba\.([a-z_]+)/g) ?? []) {
        const col = c.slice(2);
        if (!projected.has(col)) missing.add(col);
      }
    }
    expect([...missing], `withAnswerSet(line ${b.line}) 투영 [${[...projected].join(",")}] 에 없는 참조: ${[...missing].join(",")}`).toEqual([]);
  });
});
