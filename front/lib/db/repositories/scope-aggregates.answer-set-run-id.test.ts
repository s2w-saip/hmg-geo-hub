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
    // 투영이 **축 헬퍼의 결과 필드**(`axis.cols` · `trendAxis.cols`)인 경우도 있다
    // (2026-09-20 수리로 KPI 탭 추이 세 호출이 전부 이 형태가 됐다). 그때는
    // `kpiTabTrendCols` 가 돌려주는 첫 템플릿 = **축 on 투영**을 대조 기준으로 삼는다.
    // 안 그러면 본문의 첫 템플릿을 투영으로 오인해 가드가 엉뚱한 것을 본다.
    const axisCols = /^\s*\w*[Aa]xis\.cols\b/.test(head);
    let projStart = SRC.indexOf("sql`", s);
    if (axisCols) {
      const decl = SRC.indexOf("function kpiTabTrendCols(");
      if (decl >= 0) projStart = SRC.indexOf("sql`", decl);
    } else if (helper && helper[1] !== "sql") {
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

// ════════════════════════════════════════════════════════════════════════════
// 축 on 조합 — 투영과 소비 문장이 **같은 조건**으로 축을 판단하는가 (2026-09-20)
// ════════════════════════════════════════════════════════════════════════════
//
// 위 가드는 본문의 `a.<col>` 만 본다. 그런데 KPI 탭 추이의 소비 문장은
// `kpiTabCellSnapshot()` **헬퍼**가 만들고, 그 헬퍼는 컬럼을 **bare** 로 읽는다
// (`round_date`·`measured_at_orig` — `a.` 접두가 없다). 그래서 이 형태는 위 가드의
// 정규식에 잡히지 않는다.
//
// 프리뷰 차단 결함(2026-09-20)이 정확히 그 틈이었다:
//   · 투영 `kpiTabTrendCols(unit, wk)` 는 **`wk.applied === "anchor"`** 로 판단
//   · 소비 `kpiTabCellSnapshot()` 은 **`anchorAxisKnownEnabled()`** 로 판단
// 한 호출부가 `wk` 를 안 넘겨(`kpiTabTrendCols(unit)`) 두 조건이 갈렸고,
// 축을 켠 글로벌 대시보드의 주 단위 창이 `column "round_date" does not exist`(42703)로
// 통째로 죽었다. 문장 텍스트 스냅샷은 **컬럼의 존재**를 검증하지 않으므로 못 잡았다.
//
// 그래서 여기서는 **배선**을 본다: 그 소비 헬퍼를 쓰는 `withAnswerSet` 호출은
//   ① 투영을 `kpiTabTrendAxis(...)` 결과에서 받고
//   ② 예산에 `join:` 을 넘긴다(축 on 투영이 `ca.*` 를 읽는다)
describe("축 on — KPI 탭 추이의 투영·소비 조건이 갈리지 않는다", () => {
  /** `withAnswerSet(` 하나의 인자 블록(괄호 짝)을 텍스트로 잘라 낸다. */
  function callBlocks(): Array<{ line: number; text: string }> {
    const out: Array<{ line: number; text: string }> = [];
    const re = /withAnswerSet\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(SRC))) {
      const start = m.index + m[0].length - 1;
      let depth = 0;
      let end = start;
      let inTick = false;
      for (let i = start; i < SRC.length; i += 1) {
        const ch = SRC[i];
        if (ch === "`") inTick = !inTick;
        if (inTick) continue;
        if (ch === "(") depth += 1;
        else if (ch === ")") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      out.push({ line: SRC.slice(0, m.index).split("\n").length, text: SRC.slice(start, end) });
    }
    return out;
  }

  const consumers = callBlocks().filter((b) => b.text.includes("kpiTabCellSnapshot()"));

  it("소비 헬퍼를 쓰는 호출을 찾는다", () => {
    expect(consumers.length).toBeGreaterThanOrEqual(3);
  });

  it.each(consumers.map((b) => [b.line, b] as const))(
    "line %s: 투영이 kpiTabTrendAxis 결과다",
    (_line, b) => {
      // `axis.cols` · `trendAxis.cols` 처럼 축 헬퍼가 만든 값이어야 한다.
      // `kpiTabTrendCols(...)` 를 직접 부르면 축 판단이 호출부마다 갈린다.
      expect(b.text, `withAnswerSet(line ${b.line})`).toMatch(/\b\w*[Aa]xis\.cols\b/);
      expect(b.text).not.toMatch(/kpiTabTrendCols\(/);
    },
  );

  it.each(consumers.map((b) => [b.line, b] as const))(
    "line %s: 예산에 join 을 넘긴다 (축 on 투영이 ca.* 를 읽는다)",
    (_line, b) => {
      expect(b.text, `withAnswerSet(line ${b.line})`).toMatch(/join:\s*\w*[Aa]xis\.join/);
    },
  );

  it("투영 헬퍼의 `wk` 는 필수다 — 선택이면 호출부가 빠뜨릴 수 있다", () => {
    expect(SRC).toContain("function kpiTabTrendCols(unit: BucketUnit, wk: TrendWeekKey)");
    expect(SRC).not.toContain("wk?: TrendWeekKey");
  });

  it("소비 헬퍼가 축을 켤 때 읽는 컬럼이 축 on 투영에 있다", () => {
    const consumer = SRC.slice(
      SRC.indexOf("function kpiTabCellSnapshot()"),
      SRC.indexOf("\n}", SRC.indexOf("function kpiTabCellSnapshot()")),
    );
    const producer = SRC.slice(
      SRC.indexOf("function kpiTabTrendCols("),
      SRC.indexOf("\n}", SRC.indexOf("function kpiTabTrendCols(")),
    );
    // 소비가 bare 로 더하는 컬럼 두 개.
    for (const col of ["round_date", "measured_at_orig"]) {
      expect(consumer, `소비가 ${col} 을 읽는다`).toContain(col);
      expect(producer, `투영이 ${col} 을 싣는다`).toContain(col);
    }
    // 둘 다 축을 보지만 **조건이 달라도** 되는 구조가 아니어야 한다:
    // 투영은 `wk.applied === "anchor"`, 그 `wk` 는 `trendWeekKey` 가 만들고
    // `trendWeekKey` 는 `anchorAxisKnownEnabled()` 로 판단한다 — 한 줄기다.
    expect(consumer).toContain("anchorAxisKnownEnabled()");
    expect(producer).toContain('wk.applied === "anchor"');
    const weekKey = SRC.slice(
      SRC.indexOf("export async function trendWeekKey("),
      SRC.indexOf("\n}", SRC.indexOf("export async function trendWeekKey(")),
    );
    expect(weekKey).toContain("anchorAxisKnownEnabled()");
    expect(weekKey).toContain('applied: "anchor"');
  });
});
