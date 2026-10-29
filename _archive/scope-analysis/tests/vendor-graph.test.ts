// 벤더 그래프 가드(`verifyGraph`) 자신을 검사한다 — **가드가 정말 무는가.**
//
// ── 왜 이 파일이 생겼나 (2026-09-15 WU6)
//
//   `verifyGraph` 는 "벤더된 코어 코드가 목록 밖 파일을 참조하면 동기화를 실패시킨다" 가 일이다.
//   그런데 WU6 재동기에서 코어가 새 파일(`pure/stance-targets.ts`)을 만들었는데 가드가
//   **"벤더 그래프 OK" 를 찍고 지나갔다.** 정규식이 `import ... from "x"` 를 **한 줄로만**
//   봤기 때문이다(`[^\n]*?`) — 코어 스타일은 여러 줄로 쪼갠다. 결손은 그 다음 `tsc` 의
//   `Cannot find module` 로만 드러났다: 가드가 할 일을 타입체커가 대신 했다.
//
//   가드에 구멍이 있으면 그 구멍은 **조용하다** — 초록 불이 켜지고 아무도 안 본다.
//   그래서 가드의 판정을 픽스처로 고정한다. "고쳤다" 를 주장하려면 **고치기 전 형태가 실제로
//   잡히는지**를 보여야 한다.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { verifyGraph } from "../scripts/sync-analysis-core.ts";

/**
 * 실제 벤더 트리는 건드리지 않는다 — 임시 디렉토리에 **가짜 벤더 파일 하나**를 만들고
 * 목록도 그 하나로 좁혀 `verifyGraph` 를 돌린다. 진짜 트리로 실험하면 sha256 핀이 깨진다.
 */
function probe(source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "vendor-graph-"));
  try {
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "lib/probe.ts"), source);
    return verifyGraph({ vendorDir: dir, files: ["lib/probe.ts"], shimmed: ["@/lib/log"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("가드가 무는 형태 — 한 줄 import (원래 잡던 것, 회귀 방지)", () => {
  assert.deepEqual(probe(`import { x } from "./missing";\n`).length, 1);
  assert.match(probe(`import { x } from "./missing";\n`)[0]!, /".\/missing"/);
});

test("가드가 무는 형태 — **다중행 import** (WU6 에서 실제로 새던 구멍)", () => {
  const src = `import {\n  buildStanceTargets,\n  matchAndVerifyStances,\n} from "./stance-targets";\n`;
  const problems = probe(src);
  assert.equal(problems.length, 1, "다중행 import 가 안 잡힌다 — 이것이 stance-targets 를 놓친 그 형태다");
  assert.match(problems[0]!, /stance-targets/);
});

test("가드가 무는 형태 — **부수효과 import** `import \"x\";` (F6)", () => {
  const problems = probe(`import "./side-effect";\n`);
  assert.equal(problems.length, 1, "바인딩 없는 import 도 모듈을 평가한다 — 간선이다");
  assert.match(problems[0]!, /side-effect/);
});

test("가드가 무는 형태 — **동적 import** `await import(\"x\")` (F6)", () => {
  const problems = probe(`export async function load() {\n  const m = await import("./lazy");\n  return m;\n}\n`);
  assert.equal(problems.length, 1, "동적 import 도 목록 밖 코드를 실행시킨다");
  assert.match(problems[0]!, /lazy/);
});

test("가드가 무는 형태 — 재수출 `export ... from` 과 `@/` alias", () => {
  assert.equal(probe(`export { a } from "./missing";\n`).length, 1);
  assert.equal(probe(`import { a } from "@/lib/not-vendored";\n`).length, 1);
});

test("거짓 양성이 없다 — shim·node:·bare 패키지·목록 안 파일은 문제가 아니다", () => {
  assert.deepEqual(probe(`import { log } from "@/lib/log";\n`), [], "shim 은 허용 목록이다");
  assert.deepEqual(probe(`import { readFileSync } from "node:fs";\n`), [], "node: 내장은 대상이 아니다");
  assert.deepEqual(probe(`import { z } from "zod";\n`), [], "bare 패키지는 package.json 이 정본이다");
  assert.deepEqual(probe(`import { self } from "./probe";\n`), [], "목록 안 파일 참조는 정상이다");
});

test("실제 벤더 트리는 지금 깨끗하다 (목록 밖 참조 0건)", () => {
  // 기본 인자 = 진짜 벤더 트리 + 진짜 목록. 여기서 문제가 나오면 재동기가 필요하다는 뜻이다.
  assert.deepEqual(verifyGraph(), []);
});
