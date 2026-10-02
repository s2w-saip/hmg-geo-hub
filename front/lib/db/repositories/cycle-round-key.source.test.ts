// 회차 → **귀속 날짜**를 구하는 방법이 **한 곳**(DATA 헬퍼)에서만 나오는가 (2026-09-20).
//
// 고치는 결함: 집계층 두 자리가 매핑 표 `scope_cycle_rounds` 를 **원장 앵커**로 찾고
// 있었다(`m.anchor_date = (c.cycle_anchor_at AT TIME ZONE 'Asia/Seoul')::date`).
// 매핑 표의 `anchor_date` 는 **앵커 표가 실제로 쓴 앵커**(0053 registry 보정 반영)라
// 원장 값과 다를 수 있고, 다르면 조인이 빗나가 폴백이 앵커 KST 일자를 낸다.
// website 함대 실측: 원장 앵커 08-01/08-02 인 24개 회차가 registry 로 07-27 에 접혀
// 귀속이 07-24 인데, 조인이 빗나가 추이 x축에 **토·일 라벨**이 서고 값이 두 점으로
// 쪼개졌다.
//
// 값이 틀리는 방향이라 화면만 봐서는 안 보인다. 그래서 **조각의 출처**를 기계로 고정한다:
//   ① 귀속 날짜 조각은 `lib/period/anchor-axis.ts::cycleRoundJoinSql` 하나에서만 나온다.
//   ② 그 조각은 `cycle_id` 를 키로 쓴다(원장 앵커 날짜가 아니다).
//   ③ 리더 어느 파일도 `scope_cycle_rounds` 를 직접 조인하지 않는다.
//   ④ 상관 서브쿼리가 아니다(파생 표 + GROUP BY) · `min(uuid)` 가 없다.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

/** 조각의 **유일한 정의**가 사는 곳. */
const HELPER = "lib/period/anchor-axis.ts";
/** 그 조각을 쓰는 리더들. 새 소비자가 생기면 여기 추가하고, 직접 짜지 않는다. */
const READERS = [
  "lib/db/repositories/summary-cycles.ts",
  "lib/db/repositories/summary-period-compare.ts",
];

describe("귀속 날짜 조각의 출처는 한 곳이다", () => {
  const helper = read(HELPER);

  it("① DATA 헬퍼가 조각을 정의한다", () => {
    expect(helper).toContain("export function cycleRoundJoinSql(");
    expect(helper).toContain("export const cycleRoundDateSql");
  });

  it("② 조인 키는 `cycle_id` 다 (원장 앵커 날짜가 아니다)", () => {
    const body = helper.slice(helper.indexOf("export function cycleRoundJoinSql("));
    const flat = body.slice(0, body.indexOf("\n}")).replace(/\s+/g, " ");
    expect(flat).toContain(".cycle_id = ${cycleIdCol}");
    expect(flat).toContain("GROUP BY");
    // 매핑 표를 앵커 날짜로 찾는 형태가 되살아나면 여기서 잡힌다.
    expect(flat).not.toContain("scope_cycle_rounds");
    expect(flat).not.toContain("anchor_date");
  });

  it("④ 파생 표이지 상관 서브쿼리가 아니고, `min` 은 날짜에 걸린다", () => {
    const body = helper.slice(helper.indexOf("export function cycleRoundJoinSql("));
    const frag = body.slice(0, body.indexOf("\n}"));
    expect(frag).toContain("LEFT JOIN (");
    expect(frag).toContain("min(");
    expect(frag).toContain("round_date");
    // `min(uuid)` 금지 — 정렬 의미가 없는 값으로 대표를 고르지 않는다.
    expect(frag).not.toMatch(/min\([^)]*(cycle_id|job_id|run_id|project_id)/);
  });

  it.each(READERS)("③ %s 는 매핑 표를 직접 조인하지 않는다", (file) => {
    const src = read(file);
    // 주석에서는 이름을 언급해도 된다(왜 안 쓰는지 적혀 있다) — **SQL 템플릿** 안만 본다.
    const templates = src.split("sql`").slice(1).map((t) => t.slice(0, t.indexOf("`")));
    for (const t of templates) {
      expect(t, `${file} 의 SQL 에 매핑 표 조인이 남아 있다`).not.toContain(
        "scope_cycle_rounds",
      );
    }
  });

  it.each(READERS)("③ %s 는 헬퍼를 import 해서 쓴다", (file) => {
    const src = read(file);
    expect(src).toMatch(/import \{[^}]*cycleRoundJoinSql[^}]*\} from "@\/lib\/period\/anchor-axis"/s);
    expect(src).toContain("cycleRoundDateSql(");
  });
});
