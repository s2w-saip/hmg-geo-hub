import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MIRROR_CACHE_REVALIDATE_COMMAND,
  mirrorCacheRevalidateNotice,
} from "./mirror-cache-notice";

// 운영 스크립트가 쓰기 뒤 무효화 명령을 안내하는가(hmg-geo PR #297 검증 G1·D4·C2).
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${REPO}/${p}`, "utf8");

describe("mirrorCacheRevalidateNotice", () => {
  it("실재하는 무효화 명령을 싣는다", () => {
    expect(mirrorCacheRevalidateNotice("x")).toContain(MIRROR_CACHE_REVALIDATE_COMMAND);
    expect(read("package.json")).toContain('"summary:generate":');
    expect(read("scripts/summary/generate-cycle.ts")).toContain('flag("revalidate-only")');
  });

  it.each([
    ["scripts/summary/hide-cycle.ts", 'mirrorCacheRevalidateNotice(unhide ? "숨김 해제" : "회차 숨김")'],
    ["scripts/db/reassign-cycle-rounds.ts", 'mirrorCacheRevalidateNotice("귀속 날짜 재배정")'],
    ["scripts/db/backfill-answer-cycle-anchors.ts", 'mirrorCacheRevalidateNotice("앵커 행 백필·재계산")'],
  ])("%s 가 쓰기 뒤 안내를 출력한다", (file, call) => {
    expect(read(file)).toContain(call);
  });
});
