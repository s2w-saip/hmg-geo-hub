// 순수 분석 코드 벤더링 — 코어 워크트리에서 **바이트 그대로** 복사하고 핀을 다시 쓴다.
//
//   pnpm sync:analysis-core /path/to/scope-repo [--ref <sha|branch>] [--verify-graph]
//
// ── 왜 복사인가 (스펙 §6.1 은 공유 패키지를 채택했다)
//
//   스펙의 최종형은 코어 리포의 `packages/analysis-core` 를 lane 이 **버전 핀**하는 것이고,
//   그것은 pnpm 워크스페이스 도입 + 빌드·배포 경로 설계를 동반하는 별도 PR 이다(스펙 §9 단계 2).
//   그 단계가 오기 전의 lane 은 소비할 패키지가 아직 없다. 그래서 G3-2 는 **같은 보장을 다른
//   수단으로** 만든다:
//
//     - 재구현 드리프트 = **0** — 손으로 옮겨 적은 줄이 한 줄도 없다. 전부 `git show` 바이트다.
//     - 버전 스큐      = **CI 가 차단** — `check:analysis-core-pin` 이 sha256 을 대조한다.
//                        패키지화 이후의 "lane 핀 == 코어 패키지 버전" 게이트(A24)와 같은 자리다.
//
//   즉 이 스크립트 + 핀 파일이 **A24 게이트의 lane 쪽 절반**이다. 패키지화가 오면 이 둘을
//   버리고 `dependencies` 한 줄로 바꾼다 — 그때까지의 계약은 sha256 이다.
//
// ── 소스는 한 글자도 고치지 않는다
//
//   `@/…` 경로 alias 만 lane `tsconfig.json` 의 `paths` 가 받는다(vendor 로 매핑하거나
//   `shims/` 로 매핑). 텍스트 치환이 들어가는 순간 "복사"가 "이식"이 되고, 그때부터는
//   sha256 이 아무것도 증명하지 못한다.
//
// ── 워킹트리가 아니라 **git 객체**에서 읽는다 (2026-09-12 실증으로 도달한 결론)
//
//   초판은 워크트리 파일을 `cp` 했다. 그런데 코어 워크트리는 **다른 세션과 공유**된다 —
//   이 작업 중에도 HEAD 가 `c522cf86` → `d08e1ad2` 로 움직였고, 그 상태에서 재동기를 돌면
//   핀이 **내가 고른 적 없는 커밋**을 가리킨다. `git show <ref>:<path>` 로 읽으면
//   ① 워크트리가 어디에 있든 상관없고 ② 더티 여부도 상관없으며 ③ 핀의 `coreSha` 가
//   실제로 읽은 바이트의 출처와 **정의상** 일치한다.
//   `--ref` 를 주면 그 커밋, 안 주면 HEAD 다. 둘 다 SHA 로 정규화해 기록한다.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GOLDEN_FILES, RUNTIME_FILES, SHIMMED_SPECIFIERS, VENDOR_FILES } from "../packages/analysis-core/vendor-manifest.ts";

const LANE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const VENDOR_DIR = join(LANE_ROOT, "packages/analysis-core/vendor");
export const PIN_PATH = join(LANE_ROOT, "packages/analysis-core/ANALYSIS_CORE_PIN.json");

export interface PinFile {
  /** 이 벤더 트리를 뜬 코어 커밋. 갱신은 재동기 + 이 값 교체가 **한 커밋**이어야 한다. */
  coreSha: string;
  coreRef: string;
  syncedAt: string;
  /** vendor 가 아니라 lane shim 이 받는 `@/…` 지정자. 늘어나면 경계가 넓어진 것이다. */
  shimmedSpecifiers: string[];
  runtimeFileCount: number;
  goldenFileCount: number;
  /** vendor 상대 경로 → sha256(파일 바이트). */
  files: Record<string, string>;
}

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function readPin(): PinFile {
  return JSON.parse(readFileSync(PIN_PATH, "utf8")) as PinFile;
}

/**
 * 벤더 트리가 목록 밖 모듈을 참조하는지 본다 — **집합이 조용히 커지는 것**을 막는 가드다.
 * 허용되는 바깥 참조는 ① bare 패키지(zod·node:*) ② `SHIMMED_SPECIFIERS` 둘뿐이다.
 */
/**
 * 목록 밖 참조를 찾는다. 인자는 **테스트가 가짜 트리를 넣기 위한 것**이고 기본값이 실사용이다
 * (`tests/vendor-graph.test.ts` — 가드에 구멍이 있으면 그 구멍은 조용하므로 가드도 검사한다).
 */
export function verifyGraph(
  opts: { vendorDir?: string; files?: readonly string[]; shimmed?: readonly string[] } = {},
): string[] {
  const vendorDir = opts.vendorDir ?? VENDOR_DIR;
  const fileList = opts.files ?? VENDOR_FILES;
  const shimmedList = opts.shimmed ?? SHIMMED_SPECIFIERS;
  const allowed = new Set<string>(fileList);
  const problems: string[] = [];
  // ⚠️ **`[^\n]` 이 아니라 `[\s\S]` 다 — 다중행 import 를 보지 못하던 구멍을 막는다.**
  //    초판은 `from` 이 `import` 와 **같은 줄**에 있을 때만 잡았다. 코어 스타일은
  //      import {
  //        buildStanceTargets,
  //      } from "./stance-targets";
  //    처럼 여러 줄로 쪼개므로 그 간선이 통째로 안 보였다. 2026-09-15 WU6 재동기에서 실제로
  //    터졌다: 코어가 `pure/stance-targets.ts` 를 새로 만들었는데 `--verify-graph` 가
  //    **"그래프 OK"** 를 찍고 지나갔고(목록 밖 참조 0건으로 봤다), 결손은 그 다음 `tsc` 의
  //    `Cannot find module './stance-targets'` 로만 드러났다. 가드가 할 일을 타입체커가 했다.
  //    `[\s\S]*?` 는 lazy 라 가장 가까운 `from "..."` 에서 멈춘다.
  const importRe = /(?:^|\n)\s*(?:import|export)\b[\s\S]*?from\s+["']([^"']+)["']/g;
  // ⚠️ **`from` 이 없는 두 형태**도 간선이다 — 위 정규식은 `from` 을 요구해 둘 다 놓친다:
  //      · `import "./side-effect";`      부수효과 import (모듈 평가만 하고 바인딩이 없다)
  //      · `await import("./lazy")`       동적 import (코드 스플릿·조건부 로드)
  //    둘 다 **벤더 목록 밖 파일을 실행시킬 수 있다** — 즉 lane 이 어떤 코어 코드를 돌리는지가
  //    리뷰 없이 바뀐다. 그게 이 검증이 존재하는 이유 그 자체다.
  //    (2026-09-15 F6: 다중행 `from` 을 고친 직후 같은 눈으로 남은 구멍을 찾은 것이다.)
  const bareImportRe = /(?:^|\n)\s*import\s+["']([^"']+)["']\s*;?/g;
  const dynamicImportRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const rel of fileList) {
    if (!rel.endsWith(".ts")) continue;
    const abs = join(vendorDir, rel);
    const src = readFileSync(abs, "utf8");
    let m: RegExpExecArray | null;
    const specs: string[] = [];
    for (const re of [importRe, bareImportRe, dynamicImportRe]) {
      re.lastIndex = 0;
      while ((m = re.exec(src))) specs.push(m[1]!);
    }
    for (const spec of specs) {
      if (spec.startsWith("node:")) continue;
      if ((shimmedList as readonly string[]).includes(spec)) continue;
      let target: string | null = null;
      if (spec.startsWith("@/")) target = spec.slice(2);
      else if (spec.startsWith(".")) {
        // vendor 안의 상대 경로 → vendor 상대 경로로 정규화
        const joined = resolve(dirname(join(vendorDir, rel)), spec);
        target = joined.slice(vendorDir.length + 1);
      } else continue; // bare package — package.json 이 정본
      const hit = [target, `${target}.ts`, `${target}/index.ts`].find((c) => allowed.has(c));
      if (!hit) problems.push(`${rel}: "${spec}" 은 벤더 목록에도 shim 에도 없다`);
    }
  }
  return problems;
}

function main(): void {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify-graph");
  const refIdx = args.indexOf("--ref");
  const ref = refIdx >= 0 ? args[refIdx + 1] : undefined;
  const positional = args.filter((a, i) => !a.startsWith("--") && i !== refIdx + 1);
  const worktree = positional[0];

  if (verifyOnly && !worktree) {
    const problems = verifyGraph();
    if (problems.length > 0) {
      console.error(`벤더 그래프가 목록 밖으로 나갔다:\n  ${problems.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`벤더 그래프 OK — ${VENDOR_FILES.length} 파일, 바깥 참조는 shim ${SHIMMED_SPECIFIERS.length} 개뿐`);
    return;
  }

  if (!worktree) {
    console.error("usage: pnpm sync:analysis-core <core-repo-path> [--ref <sha|branch>] [--verify-graph]");
    process.exit(2);
  }
  const core = resolve(worktree);
  if (!existsSync(join(core, ".git")) && !existsSync(join(core, "lib/measurement-analysis"))) {
    console.error(`${core} 는 코어 리포가 아니다`);
    process.exit(2);
  }

  const coreRef = ref ?? "HEAD";
  let coreSha: string;
  try {
    coreSha = execFileSync("git", ["-C", core, "rev-parse", `${coreRef}^{commit}`], { encoding: "utf8" }).trim();
  } catch {
    console.error(`${coreRef} 를 커밋으로 해석할 수 없다 (코어 리포: ${core})`);
    process.exit(2);
  }

  const files: Record<string, string> = {};
  for (const rel of VENDOR_FILES) {
    // ⚠️ **워크트리를 읽지 않는다.** `git show <sha>:<path>` 가 그 커밋의 바이트를 준다 —
    //    공유 워크트리가 어디에 있든, 더티든 무관하다. 핀이 거짓말을 할 수 없는 구조다.
    let bytes: Buffer;
    try {
      bytes = execFileSync("git", ["-C", core, "show", `${coreSha}:${rel}`], { maxBuffer: 64 * 1024 * 1024 });
    } catch {
      console.error(`코어 ${coreSha.slice(0, 8)} 에 없다: ${rel}`);
      process.exit(1);
    }
    const dst = join(VENDOR_DIR, rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, bytes); // 바이트 그대로. 어떤 치환도 하지 않는다.
    files[rel] = sha256(dst);
  }

  const problems = verifyGraph();
  if (problems.length > 0) {
    console.error(`벤더 그래프가 목록 밖으로 나갔다 — 목록을 넓힐지 판단이 필요하다:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }

  const pin: PinFile = {
    coreSha,
    coreRef,
    syncedAt: new Date().toISOString(),
    shimmedSpecifiers: [...SHIMMED_SPECIFIERS],
    runtimeFileCount: RUNTIME_FILES.length,
    goldenFileCount: GOLDEN_FILES.length,
    files,
  };
  writeFileSync(PIN_PATH, `${JSON.stringify(pin, null, 2)}\n`);
  console.log(`동기화 완료 — core ${coreSha.slice(0, 8)} (${coreRef}), ${VENDOR_FILES.length} 파일`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
