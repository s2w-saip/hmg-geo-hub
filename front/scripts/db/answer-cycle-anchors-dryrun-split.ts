/**
 * dry-run SQL 의 **문장 분리기**. 백필 스크립트와 pglite 실행 테스트가 같은 것을 쓴다.
 *
 * 왜 모듈로 뺐는가: 백필 스크립트는 import 즉시 `postgres()` 를 열고 env 가 없으면
 * `process.exit` 하므로 테스트에서 import 할 수 없다. 분리기를 테스트에 복사하면
 * "테스트가 자기 사본을 검사" 하게 되므로, 정의를 한 곳으로 옮기고 둘 다 여기서 읽는다.
 */
import path from "node:path";

export const DRYRUN_SQL_PATH = path.join("scripts", "db", "answer-cycle-anchors-dryrun.sql");

/**
 * dry-run SQL 파일을 `-- @@statement <이름>` 줄로 자르고, **맨 앞 `-- @@prelude`
 * 블록을 각 문장 앞에 붙인다**.
 *
 * prelude 가 따로 있는 이유는 하나뿐이다 — 타임존 상수(`tz` CTE)를 파일에 **한 번만**
 * 적기 위해서다(B12). 종전에는 문장마다 `WITH tz AS (SELECT 'UTC'…)` 를 다시 적어
 * "뒤집기는 함수 한 줄" 선언과 어긋났다. 그래서 각 문장은 `, <cte> AS (…)` 로 시작하고,
 * 여기서 `WITH tz AS (…)` 를 앞에 이어 붙여야 완성된 문장이 된다.
 */
export function splitDryRunStatements(body: string): Array<{ name: string; sql: string }> {
  const preludeMatch = body.match(/^-- @@prelude\s*$/m);
  if (!preludeMatch) throw new Error(`${DRYRUN_SQL_PATH} 에 '-- @@prelude' 가 없다`);
  const afterPrelude = body.slice((preludeMatch.index ?? 0) + preludeMatch[0].length);
  const parts = afterPrelude.split(/^-- @@statement (\S+)\s*$/m);
  const prelude = parts[0]
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n")
    .trim();
  if (!prelude) throw new Error(`${DRYRUN_SQL_PATH} 의 prelude 가 비어 있다`);
  const out: Array<{ name: string; sql: string }> = [];
  for (let i = 1; i < parts.length; i += 2) {
    out.push({ name: parts[i], sql: `${prelude}\n${parts[i + 1].trim()}` });
  }
  if (out.length === 0) throw new Error(`${DRYRUN_SQL_PATH} 에 '-- @@statement' 경계가 없다`);
  return out;
}
