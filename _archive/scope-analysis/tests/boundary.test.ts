// 경계 감시 — **G3: lane 은 코어 DB 에 접속하지 않는다.**
//
// 수용 기준 A8 의 리포 쪽 절반이다("lane 리포 전수: 코어 DB 접속 문자열·드라이버 의존성 0건").
// 나머지 절반(보안그룹 아웃바운드 규칙 0)은 CDK·배포 시점이 판정한다.
//
// ⚠️ 이 테스트가 잡으려는 것은 실수가 아니라 **편의다**. 누군가 "잠깐 코어에서 카탈로그만
//    읽어오자" 고 하는 순간 구 P2 의 선행 조건(pgbouncer 풀 예산·RLS·alias·vCPU 쿼터)이 전부
//    되살아난다(스펙 §12 기각표). 그래서 경계는 리뷰가 아니라 테스트가 지킨다.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".git", "cdk.out", "dist", ".github"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const SOURCE_EXT = [".ts", ".sql", ".yml", ".yaml", ".json"];
const sourceFiles = walk(ROOT).filter(
  (p) => SOURCE_EXT.some((e) => p.endsWith(e)) && !p.includes("/tests/boundary.test.ts") && !p.endsWith("pnpm-lock.yaml"),
);

test("no core Scope database identifiers appear anywhere in the lane repo (A8)", () => {
  // 코어 DB 의 지문들. 하나라도 나오면 경계가 샌 것이다.
  const banned: Array<[string, RegExp]> = [
    ["core drizzle schema import", /@\/db\/schema/],
    ["core db client import", /@\/lib\/db/],
    ["pgbouncer alias", /analysis_tx/],
    ["core measurement tables", /\bmeasurement_(turn_analysis|entity_mentions|analysis_tickets)\b/],
    ["core query_runs table", /\bquery_runs\b/],
    ["core prompt_runs table", /\bprompt_runs\b/],
  ];
  const hits: string[] = [];
  for (const file of sourceFiles) {
    const text = readFileSync(file, "utf8");
    for (const [label, re] of banned) {
      // 주석 안의 언급은 허용한다 — 스펙을 인용하지 못하면 왜 그런지가 코드에서 사라진다.
      // 코드 라인(주석/문자열 설명이 아닌 줄)만 본다.
      for (const [i, line] of text.split("\n").entries()) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("--") || trimmed.startsWith("*") || trimmed.startsWith("#")) continue;
        if (re.test(line)) hits.push(`${file.slice(ROOT.length)}:${i + 1} [${label}] ${trimmed.slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(hits, [], `core DB boundary leak:\n${hits.join("\n")}`);
});

test("no core database driver or ORM is a dependency", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  // drizzle 은 코어 스키마와 짝이다 — 있으면 코어 테이블을 보겠다는 뜻이다.
  for (const banned of ["drizzle-orm", "drizzle-kit", "@supabase/supabase-js", "mysql2"]) {
    assert.ok(!(banned in all), `${banned} must not be a dependency of the analysis lane`);
  }
  assert.ok("postgres" in pkg.dependencies, "lane owns its OWN postgres (its own RDS) — that is allowed");
});

test("lane migrations only create analysis_* objects", () => {
  const dir = join(ROOT, "migrations");
  for (const name of readdirSync(dir)) {
    // `--` 주석 줄은 뺀다 — 주석이 왜 그런지를 설명하려면 금지 구문(CONCURRENTLY 등)을
    // 인용해야 하고, 인용을 못 하게 하면 근거가 코드에서 사라진다.
    const text = readFileSync(join(dir, name), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    const created = [...text.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|INDEX|VIEW)\s+(?:IF NOT EXISTS\s+)?([a-z_0-9]+)/gi)].map(
      (m) => m[1]!,
    );
    for (const obj of created) {
      assert.ok(
        obj.startsWith("analysis_") || obj.startsWith("v_analysis_") || obj === "schema_migrations",
        `${name}: created object ${obj} must be namespaced analysis_* (found in a lane migration)`,
      );
    }
  }
});

test("no secret-shaped literal is committed", () => {
  // 워크스페이스 룰 secrets-handling 1·2 — 리포는 조직으로 단방향 미러된다.
  const secretish = [
    // ⚠️ 문자 클래스에서 `$` 를 뺀 것은 의도다 — 템플릿 리터럴(`${...}`)은 자격증명이 아니라
    //    **조립 코드**다. 빼지 않으면 DSN 을 코드로 만드는 것 자체가 위반으로 잡혀, 통짜 DSN 을
    //    시크릿에 손으로 넣는 더 나쁜 쪽으로 사람을 민다.
    /postgres(?:ql)?:\/\/[^\s"'$]*:[^\s"':@$]{16,}@/,
    /sk-[A-Za-z0-9]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ];
  // dev 전용 파일은 자리표시자 자격증명이 정상이다(compose 의 analysis/analysis 등).
  // 그 값들이 라이브 어디에도 없다는 것이 규칙이지, 존재 자체가 위반은 아니다.
  const devPlaceholders = ["/.env.example", "/deploy/compose.yml"];
  const hits: string[] = [];
  for (const file of sourceFiles) {
    if (devPlaceholders.some((d) => file.endsWith(d))) continue;
    const text = readFileSync(file, "utf8");
    for (const re of secretish) {
      const m = re.exec(text);
      if (m) hits.push(`${file.slice(ROOT.length)}: ${m[0].slice(0, 24)}…`);
    }
  }
  assert.deepEqual(hits, [], `possible secret literal:\n${hits.join("\n")}`);
});
