/**
 * T18 프로브 게이트의 단위 가드 — 헤더 비교와 "요청 컨텍스트 밖" 처리.
 *
 * mirrorCache 와 붙인 통합 동작(키에 솔트가 붙는가·요청당 1개인가)은
 * lib/scope/server.perf-nocache.test.ts 가 본다. 여기서는 게이트 자체만 본다.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

let headerValue: string | null = null;
let headersThrows = false;
vi.mock("next/headers", () => ({
  headers: async () => {
    if (headersThrows) {
      // Next 가 요청 컨텍스트 밖(크론 잡·빌드 프리렌더·unstable_cache 콜백 안)에서
      // 던지는 것을 흉내낸다.
      throw new Error("`headers` was called outside a request scope");
    }
    return { get: (n: string) => (n === "x-hmg-perf-nocache" ? headerValue : null) };
  },
}));

const { perfSecretMatches, perfNoCacheSalt, perfNoCacheActive, withNoCacheSalt } =
  await import("./nocache-probe");

const SECRET = "probe-secret-value";
const ORIGINAL = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  headerValue = null;
  headersThrows = false;
});
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe("perfSecretMatches", () => {
  it("같은 값이면 참", () => {
    expect(perfSecretMatches(SECRET, SECRET)).toBe(true);
  });
  it("길이가 달라도 던지지 않고 거짓 (timingSafeEqual 의 길이 예외 회피)", () => {
    expect(perfSecretMatches("short", SECRET)).toBe(false);
    expect(perfSecretMatches(SECRET + "x", SECRET)).toBe(false);
  });
  it("빈 값은 항상 거짓 — 미설정 시크릿이 빈 헤더와 맞아떨어지지 않게", () => {
    expect(perfSecretMatches("", "")).toBe(false);
    expect(perfSecretMatches("", SECRET)).toBe(false);
    expect(perfSecretMatches(SECRET, "")).toBe(false);
  });
});

describe("perfNoCacheSalt — fail-closed", () => {
  it("헤더 없음 → null", async () => {
    expect(await perfNoCacheSalt()).toBeNull();
    expect(await perfNoCacheActive()).toBe(false);
  });
  it("헤더 불일치 → null", async () => {
    headerValue = "nope";
    expect(await perfNoCacheSalt()).toBeNull();
  });
  it("CRON_SECRET 미설정 → null (헤더를 읽지도 않는다)", async () => {
    delete process.env.CRON_SECRET;
    headerValue = SECRET;
    expect(await perfNoCacheSalt()).toBeNull();
  });
  it("요청 컨텍스트 밖(headers() 가 던짐) → null, 예외를 흘리지 않는다", async () => {
    headersThrows = true;
    headerValue = SECRET;
    await expect(perfNoCacheSalt()).resolves.toBeNull();
  });
  it("일치 → uuid 솔트", async () => {
    headerValue = SECRET;
    const salt = await perfNoCacheSalt();
    expect(salt).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(await perfNoCacheActive()).toBe(true);
  });
});

describe("withNoCacheSalt", () => {
  it("게이트 off 면 base 를 그대로 부른다 — 솔트 셀을 만들지 않는다", async () => {
    const base = vi.fn(async (n: number) => n * 2);
    const buildSalted = vi.fn(() => async (n: number) => n * 3);
    const wrapped = withNoCacheSalt(base, buildSalted);
    expect(await wrapped(5)).toBe(10);
    expect(buildSalted).not.toHaveBeenCalled();
    expect(base).toHaveBeenCalledWith(5);
  });

  it("게이트 on 이면 솔트 셀로 우회하고 base 는 부르지 않는다", async () => {
    headerValue = SECRET;
    const base = vi.fn(async (n: number) => n * 2);
    const buildSalted = vi.fn(() => async (n: number) => n * 3);
    const wrapped = withNoCacheSalt(base, buildSalted);
    expect(await wrapped(5)).toBe(15);
    expect(base).not.toHaveBeenCalled();
    expect(buildSalted).toHaveBeenCalledTimes(1);
    expect(typeof buildSalted.mock.calls[0][0]).toBe("string");
  });
});
