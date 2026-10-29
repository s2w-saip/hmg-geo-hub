// 벤더 핀 검증 — **버전 스큐 차단의 lane 쪽 절반**(스펙 §6.1 게이트 1 / 수용 A24).
//
//   pnpm check:analysis-core-pin
//
// 무엇을 판정하나:
//   ① 핀에 적힌 파일이 전부 있고 sha256 이 일치한다  → 벤더 트리를 손으로 고치면 실패
//   ② 벤더 트리에 핀에 없는 파일이 없다              → 몰래 얹은 파일이 실패
//   ③ 매니페스트 목록과 핀의 파일 집합이 같다        → 목록만 고치고 재동기를 안 하면 실패
//   ④ 벤더 그래프가 목록 밖을 참조하지 않는다        → 코어가 import 를 늘렸는데 목록이 그대로면 실패
//
// ⚠️ 이 체크는 "벤더가 코어와 같다"를 증명하지 **않는다** — 그것은 재동기 시점의
//    `sync-analysis-core.ts` 가 보장하고(더티 워크트리 거부 + coreSha 기록), 여기서는
//    "동기화 이후 아무도 손대지 않았다"를 지킨다. 둘이 합쳐져야 "lane 이 도는 순수 코드 =
//    코어 c522… 의 바이트" 가 성립한다.
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { VENDOR_FILES } from "../packages/analysis-core/vendor-manifest.ts";
import { PIN_PATH, VENDOR_DIR, readPin, sha256, verifyGraph } from "./sync-analysis-core.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function main(): void {
  const pin = readPin();
  const failures: string[] = [];

  const pinned = new Set(Object.keys(pin.files));
  const manifest = new Set<string>(VENDOR_FILES);

  // ③ 매니페스트 ↔ 핀
  for (const rel of manifest) if (!pinned.has(rel)) failures.push(`매니페스트에 있으나 핀에 없다: ${rel} (재동기 필요)`);
  for (const rel of pinned) if (!manifest.has(rel)) failures.push(`핀에 있으나 매니페스트에 없다: ${rel} (재동기 필요)`);

  // ① 핀 ↔ 디스크
  for (const [rel, expected] of Object.entries(pin.files)) {
    const abs = join(VENDOR_DIR, rel);
    let actual: string;
    try {
      actual = sha256(abs);
    } catch {
      failures.push(`벤더 파일 없음: ${rel}`);
      continue;
    }
    if (actual !== expected) {
      failures.push(`sha256 불일치: ${rel}\n    핀 ${expected}\n    실제 ${actual}`);
    }
  }

  // ② 디스크 → 핀 (몰래 얹은 파일)
  for (const abs of walk(VENDOR_DIR)) {
    const rel = relative(VENDOR_DIR, abs);
    if (!pinned.has(rel)) failures.push(`핀에 없는 파일이 벤더 트리에 있다: ${rel}`);
  }

  // ④ 그래프
  failures.push(...verifyGraph());

  if (failures.length > 0) {
    console.error("analysis-core 핀 검증 실패:");
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(
      `\n벤더는 코어 ${pin.coreSha.slice(0, 8)} 의 바이트 사본이다. 고치려면 코어를 고치고 ` +
        `\`pnpm sync:analysis-core <core-worktree>\` 로 다시 뜬다 — 여기서 직접 편집하지 않는다.`,
    );
    process.exit(1);
  }

  console.log(
    `analysis-core 핀 OK — core ${pin.coreSha.slice(0, 8)} · ` +
      `runtime ${pin.runtimeFileCount} + golden ${pin.goldenFileCount} = ${Object.keys(pin.files).length} 파일 sha256 일치 ` +
      `· shim ${pin.shimmedSpecifiers.join(", ")} (${PIN_PATH.split("/").slice(-1)[0]})`,
  );
}

main();
