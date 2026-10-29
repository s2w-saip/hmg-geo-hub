import { describe, expect, it, vi } from "vitest";

// react-server 빌드로 바꿔야 `cache()` 가 실제로 memoize 한다 (test/request-scope.ts 참조).
// 팩토리는 파일 최상단으로 호이스팅되므로 외부 import 를 참조할 수 없다 — 로더를 인라인한다.
vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});

const { withRequestScope } = await import("@/test/request-scope");

const { cache } = await import("react");
const { dedupeInRequest, requestDeduped, stableKey } = await import("./request-dedupe");

describe("stableKey", () => {
  it("키 순서가 달라도 같은 키 — 섹션마다 filters 를 다르게 조립해도 접힌다", () => {
    expect(stableKey([{ region: ["KR"], engine: ["gpt"] }])).toBe(
      stableKey([{ engine: ["gpt"], region: ["KR"] }]),
    );
  });

  it("undefined 축은 미지정과 같다 — { region: undefined } 와 {} 는 한 키", () => {
    expect(stableKey([{ region: undefined }])).toBe(stableKey([{}]));
  });

  it("배열 순서는 보존한다 — 정렬 정규화는 게이트웨이의 일이다", () => {
    expect(stableKey([{ region: ["KR", "US"] }])).not.toBe(stableKey([{ region: ["US", "KR"] }]));
  });

  it("값이 다르면 키가 다르다", () => {
    expect(stableKey([{ region: ["KR"] }])).not.toBe(stableKey([{ region: ["US"] }]));
    expect(stableKey([{}, "week"])).not.toBe(stableKey([{}, "day"]));
  });
});

describe("요청단위 dedup", () => {
  it("같은 요청·같은 키면 실행은 1회, 프로미스도 동일 인스턴스", async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      return calls;
    };
    const [a, b] = await withRequestScope(async () => {
      const p1 = dedupeInRequest("k", run);
      const p2 = dedupeInRequest("k", run);
      expect(p1).toBe(p2);
      return Promise.all([p1, p2]);
    });
    expect(calls).toBe(1);
    expect([a, b]).toEqual([1, 1]);
  });

  it("요청이 다르면 접히지 않는다 — 요청 간 캐시는 unstable_cache 의 층이다", async () => {
    let calls = 0;
    const run = async () => (calls += 1);
    await withRequestScope(async () => dedupeInRequest("k", run));
    await withRequestScope(async () => dedupeInRequest("k", run));
    expect(calls).toBe(2);
  });

  it("키가 다르면 각각 실행된다", async () => {
    let calls = 0;
    const run = async () => (calls += 1);
    await withRequestScope(async () => {
      await Promise.all([dedupeInRequest("a", run), dedupeInRequest("b", run)]);
    });
    expect(calls).toBe(2);
  });

  it("실패한 호출은 캐시에 남지 않는다 — 같은 요청의 다른 섹션이 재시도할 수 있다", async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return "ok";
    };
    const out = await withRequestScope(async () => {
      await expect(dedupeInRequest("k", run)).rejects.toThrow("boom");
      return dedupeInRequest("k", run);
    });
    expect(out).toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("requestDeduped — 객체 인자", () => {
  // 이 리포의 페처는 전부 filters 객체를 받는다. 섹션이 갈라지면 각 섹션이 자기
  // 객체 리터럴을 만들어 넘기게 되므로, 참조 동일성 기반 dedup 은 조용히 실패한다.
  it("값이 같고 참조가 다른 filters 를 하나로 접는다", async () => {
    let calls = 0;
    const fetcher = requestDeduped("f", async (_filters: Record<string, unknown>) => {
      calls += 1;
      return calls;
    });
    await withRequestScope(async () => {
      await Promise.all([
        fetcher({ region: ["KR"], engine: ["gpt"] }),
        fetcher({ engine: ["gpt"], region: ["KR"] }), // 다른 객체·다른 키 순서
      ]);
    });
    expect(calls).toBe(1);
  });

  it("반증: 순수 React cache() 는 같은 상황에서 접지 못한다 (이 래퍼가 필요한 이유)", async () => {
    let calls = 0;
    const naive = cache(async (_filters: Record<string, unknown>) => {
      calls += 1;
      return calls;
    });
    await withRequestScope(async () => {
      await Promise.all([naive({ region: ["KR"] }), naive({ region: ["KR"] })]);
    });
    expect(calls).toBe(2);
  });

  it("값이 다르면 접지 않는다 — 필터를 좁히면 새로 읽는다", async () => {
    let calls = 0;
    const fetcher = requestDeduped("f", async (_f: Record<string, unknown>) => (calls += 1));
    await withRequestScope(async () => {
      await Promise.all([fetcher({ region: ["KR"] }), fetcher({ region: ["US"] })]);
    });
    expect(calls).toBe(2);
  });

  it("네임스페이스가 다르면 같은 인자라도 섞이지 않는다", async () => {
    const a = requestDeduped("a", async (_f: Record<string, unknown>) => "A");
    const b = requestDeduped("b", async (_f: Record<string, unknown>) => "B");
    const out = await withRequestScope(async () => Promise.all([a({}), b({})]));
    expect(out).toEqual(["A", "B"]);
  });
});
