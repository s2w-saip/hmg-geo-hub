/**
 * `generator_version` 의 sha 해석 — 러너에서 `unknown` 이 찍히던 결함의 회귀 테스트.
 *
 * 2026-09-10 러너 실측: 릴리스는 `git archive` 번들이라 `/opt/hmg-runner/current` 에 `.git` 이
 * 없다. `git rev-parse` 가 실패해 `website-cycle-v1+unknown` 이 `summary_generations` 에
 * 남았고, 그러면 **프로덕션 행이 어느 코드에서 나왔는지 추적할 수 없다.**
 * 배포 스크립트가 릴리스 디렉토리명에서 sha 를 떼어 `HMG_GIT_SHA` 로 넣어 준다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync }));

const ORIGINAL = process.env.HMG_GIT_SHA;

beforeEach(() => {
  vi.resetModules();
  execFileSync.mockReset();
  delete process.env.HMG_GIT_SHA;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.HMG_GIT_SHA;
  else process.env.HMG_GIT_SHA = ORIGINAL;
});

async function load() {
  return import("./context");
}

describe("gitShortSha / generatorVersion", () => {
  it("HMG_GIT_SHA 가 있으면 그것을 쓰고 git 을 부르지 않는다", async () => {
    process.env.HMG_GIT_SHA = "7965e09";
    const { gitShortSha, generatorVersion } = await load();
    expect(gitShortSha()).toBe("7965e09");
    expect(generatorVersion("website-cycle-v1")).toBe("website-cycle-v1+7965e09");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("env 앞뒤 공백은 잘라낸다 (배포 스크립트가 개행을 흘릴 수 있다)", async () => {
    process.env.HMG_GIT_SHA = "  a357aec\n";
    const { generatorVersion } = await load();
    expect(generatorVersion("global-cycle-v1")).toBe("global-cycle-v1+a357aec");
  });

  it("env 가 비어 있으면(빈 문자열) git 폴백으로 간다", async () => {
    process.env.HMG_GIT_SHA = "   ";
    execFileSync.mockReturnValue("deadbee\n");
    const { generatorVersion } = await load();
    expect(generatorVersion("website-cycle-v1")).toBe("website-cycle-v1+deadbee");
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it("env 가 없으면 git 을 부르되 **stderr 를 버린다**", async () => {
    execFileSync.mockReturnValue("abc1234\n");
    const { gitShortSha } = await load();
    expect(gitShortSha()).toBe("abc1234");
    const [cmd, args, opts] = execFileSync.mock.calls[0] as [
      string,
      string[],
      { stdio?: unknown[] },
    ];
    expect(cmd).toBe("git");
    expect(args).toEqual(["rev-parse", "--short", "HEAD"]);
    // `.git` 이 없는 러너에서 실패는 정상 경로다 — fatal 이 매 틱 journald 에 쌓이면
    // 진짜 오류 신호가 묻힌다.
    expect(opts.stdio).toEqual(["ignore", "pipe", "ignore"]);
  });

  it("둘 다 없으면 unknown (죽지 않는다)", async () => {
    execFileSync.mockImplementation(() => {
      throw new Error("fatal: not a git repository");
    });
    const { generatorVersion } = await load();
    expect(generatorVersion("global-cycle-v1")).toBe("global-cycle-v1+unknown");
  });
});
