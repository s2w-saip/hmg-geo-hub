/**
 * `/api/internal/summary/published` — 생성 러너의 캐시 무효화 계약(PR① T10).
 *
 * 고정하는 것: 시크릿 미설정 503 · 불일치 401 · 정답 200 · GET 405 · `revalidateTag` **정확히 2회** ·
 * 로그에 URL·토큰 미출력. 마지막 항목이 이 라우트를 만드는 이유의 절반이다 —
 * 러너는 `CRON_SECRET` 을 들고 이 라우트를 부르는데, 그 값이 로그에 새면 러너를 옮긴 의미가 없다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag, unstable_cache: (fn: unknown) => fn }));

const req = (headers?: Record<string, string>) =>
  new Request("http://internal/api/internal/summary/published", { method: "POST", headers });

const ORIGINAL = process.env.CRON_SECRET;

beforeEach(() => {
  revalidateTag.mockClear();
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe("POST /api/internal/summary/published", () => {
  it("CRON_SECRET 미설정이면 503 이고 무효화하지 않는다", async () => {
    delete process.env.CRON_SECRET;
    const { POST } = await import("./route");
    const res = await POST(req({ authorization: "Bearer anything" }));
    expect(res.status).toBe(503);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("토큰이 틀리면 401 이고 무효화하지 않는다", async () => {
    process.env.CRON_SECRET = "right";
    const { POST } = await import("./route");
    expect((await POST(req({ authorization: "Bearer wrong" }))).status).toBe(401);
    expect((await POST(req())).status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("맞으면 200 + {ok,at} 이고 태그 2개를 **정확히 2회** 무효화한다", async () => {
    process.env.CRON_SECRET = "right";
    const { POST } = await import("./route");
    const res = await POST(req({ authorization: "Bearer right" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; at: string };
    expect(body.ok).toBe(true);
    expect(Number.isNaN(Date.parse(body.at))).toBe(false);
    expect(revalidateTag).toHaveBeenCalledTimes(2);
    expect(revalidateTag.mock.calls.map((c) => c[0]).sort()).toEqual([
      "mirror-aggregates",
      "summary-aggregates",
    ]);
  });

  it("GET 은 405 다 (무효화는 프리페치로 일어나면 안 된다)", async () => {
    process.env.CRON_SECRET = "right";
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("어떤 경로에서도 토큰을 로그·응답 본문에 흘리지 않는다", async () => {
    process.env.CRON_SECRET = "s3cr3t-value";
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    const { POST } = await import("./route");
    const bodies = [
      await (await POST(req({ authorization: "Bearer s3cr3t-value" }))).text(),
      await (await POST(req({ authorization: "Bearer nope" }))).text(),
    ];
    const logged = spies.flatMap((s) => s.mock.calls.flat()).map(String).join("\n");
    for (const s of spies) s.mockRestore();
    expect(logged).not.toContain("s3cr3t-value");
    for (const b of bodies) expect(b).not.toContain("s3cr3t-value");
  });
});
