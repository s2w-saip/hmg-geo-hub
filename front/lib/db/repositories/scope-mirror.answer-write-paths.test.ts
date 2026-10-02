/**
 * `scope_answers` 로 들어가는 **삽입 경로가 하나뿐인지**를 소스에서 확인한다.
 *
 * 왜 이런 형태의 테스트인가 — 앵커 재적용(0053)은 `replaceRun` 트랜잭션 안에
 * 붙어 있다. 그 전제는 "**production 삽입 경로가 replaceRun 하나**"다. 두 번째
 * 경로가 생기는 순간(백필 스크립트·복구 러너·새 리포지터리 메서드) 그 경로로
 * 들어온 행은 앵커를 못 받고, 증상은 몇 주 뒤 "왜 이 주만 저표본이지"로 나타난다 —
 * 정확히 2026-08-31 사고의 발현 형태다.
 *
 * 행동이 아니라 **흔적**을 요구한다: 새 삽입 경로를 넣으면 이 테스트가 깨지고,
 * 고치려면 아래 허용 목록에 이유와 함께 등재해야 한다.
 *
 * ⚠️ 이 테스트를 통과시키려고 경로를 허용 목록에 넣기 전에, 그 경로가 앵커를
 * 재적용하는지 먼저 확인할 것.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");

/**
 * 앵커 재적용 없이 `scope_answers` 에 써도 되는 파일.
 * - scope-mirror.ts   : 유일한 production 경로. 재적용이 여기 붙어 있다.
 * - scripts/db/seed-demo.ts : 개발 시드 전용(운영 미러에 안 돈다).
 */
const ALLOWED = new Set([
  "lib/db/repositories/scope-mirror.ts",
  "scripts/db/seed-demo.ts",
]);

function grep(pattern: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["grep", "-l", "-E", pattern, "--", "*.ts", "*.tsx"],
      { cwd: ROOT, encoding: "utf8" },
    );
    return out.split("\n").filter(Boolean);
  } catch (e) {
    // git grep 은 매치 0 일 때 exit 1 — 에러가 아니다.
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
}

describe("scope_answers 삽입 경로", () => {
  it("drizzle 삽입은 허용 목록 밖에 없다", () => {
    const hits = grep(String.raw`\.insert\(scopeAnswers\)`).filter(
      (f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"),
    );
    expect(hits.sort()).toEqual([...ALLOWED].filter((f) => hits.includes(f)).sort());
    for (const f of hits) expect(ALLOWED.has(f)).toBe(true);
  });

  it("raw SQL 삽입(insert into scope_answers)도 없다", () => {
    const hits = grep(String.raw`insert\s+into\s+scope_answers`).filter(
      (f) => !f.endsWith(".test.ts"),
    );
    for (const f of hits) expect(ALLOWED.has(f)).toBe(true);
  });
});

// 배선(replaceRun 이 실제로 재적용을 발행하는가)은 여기서 소스 grep 으로 재확인하지
// 않는다 — 정의 파일에 이름이 있는지 보는 검사는 항상 통과해 안심만 준다.
// 그 성질은 scope-mirror.anchor-registry.test.ts (b) 가 **실행 결과로** 고정한다
// (돌연변이 확인: 재적용 줄을 지우면 그 테스트가 깨진다).
