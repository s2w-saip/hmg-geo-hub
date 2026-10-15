/**
 * 앵커 표면 판정의 루트 id 해소 — **세 상태**를 가른다(N-4·N-14).
 *
 * "설정 안 함"과 "설정했는데 형식이 틀림"은 같은 `null` 이 아니다. 후자를 조용히 null 로
 * 떨구면 원장 `surfaceExpr` 의 global 팔이 생략되어 **루트 회차가 `surface='project'` 로
 * 기록된다**. 수리 전에는 22P02 로 롤백돼 원장이 무변경이었다.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  ANCHOR_ROOT_ENV,
  anchorRootProjectId,
  anchorRootProjectIdOrThrow,
  resolveAnchorRootProjectId,
} from "./anchor-root";
import { readSourceText } from "@/test/source-text";

const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";
const prev = process.env[ANCHOR_ROOT_ENV];

afterEach(() => {
  if (prev === undefined) delete process.env[ANCHOR_ROOT_ENV];
  else process.env[ANCHOR_ROOT_ENV] = prev;
  vi.restoreAllMocks();
});

describe("세 상태 판정", () => {
  it("정상 uuid → ok", () => {
    process.env[ANCHOR_ROOT_ENV] = ROOT;
    expect(resolveAnchorRootProjectId()).toEqual({ kind: "ok", projectId: ROOT });
  });

  it("앞뒤 공백은 다듬는다", () => {
    process.env[ANCHOR_ROOT_ENV] = `  ${ROOT}  `;
    expect(resolveAnchorRootProjectId()).toEqual({ kind: "ok", projectId: ROOT });
  });

  it("미설정·빈 문자열 → unset", () => {
    delete process.env[ANCHOR_ROOT_ENV];
    expect(resolveAnchorRootProjectId()).toEqual({ kind: "unset", projectId: null });
    process.env[ANCHOR_ROOT_ENV] = "   ";
    expect(resolveAnchorRootProjectId()).toEqual({ kind: "unset", projectId: null });
  });

  it("uuid 가 아니면 → malformed (원문을 들고 있다)", () => {
    process.env[ANCHOR_ROOT_ENV] = "root-from-env";
    expect(resolveAnchorRootProjectId()).toEqual({
      kind: "malformed",
      projectId: null,
      raw: "root-from-env",
    });
    // 하이픈 개수만 맞는 값도 거부한다.
    process.env[ANCHOR_ROOT_ENV] = "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz";
    expect(resolveAnchorRootProjectId().kind).toBe("malformed");
  });
});

describe("경로별 처리 (N-14)", () => {
  it("값만 쓰는 판: malformed 는 null + 경고", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env[ANCHOR_ROOT_ENV] = "root-from-env";
    expect(anchorRootProjectId()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("원장 쓰기 판: malformed 는 **던진다** (쓰지 않음을 유지)", () => {
    process.env[ANCHOR_ROOT_ENV] = "root-from-env";
    expect(() => anchorRootProjectIdOrThrow()).toThrow(/uuid 형식이 아니다/);
  });

  it("원장 쓰기 판이라도 **미설정은 던지지 않는다** (종전 동작 유지)", () => {
    delete process.env[ANCHOR_ROOT_ENV];
    expect(anchorRootProjectIdOrThrow()).toBeNull();
  });

  it("정상 uuid 는 두 판이 같은 값을 돌려준다", () => {
    process.env[ANCHOR_ROOT_ENV] = ROOT;
    expect(anchorRootProjectId()).toBe(ROOT);
    expect(anchorRootProjectIdOrThrow()).toBe(ROOT);
  });

  it("예외 메시지에 env 값 자체를 싣지 않는다 (길이만)", () => {
    process.env[ANCHOR_ROOT_ENV] = "super-secret-looking-value";
    try {
      anchorRootProjectIdOrThrow();
      throw new Error("던졌어야 한다");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).not.toContain("super-secret-looking-value");
      expect(msg).toContain("길이");
    }
  });
});

describe("경로 배선 — 어느 판을 쓰는지", () => {
  const read = async (rel: string) => {
    const path = await import("node:path");
    return readSourceText(path.resolve(__dirname, "..", "..", rel));
  };

  it("원장을 쓰는 경로는 던지는 판을 쓴다", async () => {
    for (const rel of [
      "lib/summary/generate/swap.ts",
      "scripts/summary/surface-global.ts",
      "scripts/summary/surface-website.ts",
      "scripts/summary/purge-excluded-cycles.ts",
      "scripts/db/backfill-answer-cycle-anchors.ts",
    ]) {
      expect(await read(rel), rel).toContain("anchorRootProjectIdOrThrow");
    }
  });

  it("관제는 적용 **직전에** 막는다 (여기서 던지면 크론 라우트가 죽는다)", async () => {
    const src = await read("lib/summary/cycle-control.ts");
    expect(src).toContain("resolveAnchorRootProjectId()");
    const iTry = src.indexOf("  try {\n    // N-14");
    const iGuard = src.indexOf('rootResolution.kind === "malformed"');
    expect(iTry).toBeGreaterThan(-1);
    expect(iGuard).toBeGreaterThan(iTry); // 가드가 try 안이다
  });

  it("미러 싱크는 죽이지 않고 앵커 재계산만 건너뛴다", async () => {
    const src = await read("lib/db/repositories/scope-mirror.ts");
    expect(src).toContain("function anchorRootForMirror()");
    expect(src).toContain("anchorRootForMirror().usable");
    expect(src).not.toContain("anchorRootProjectIdOrThrow");
  });
});
