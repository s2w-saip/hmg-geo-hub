import * as React from "react";

// React 의 요청 캐시(=`cache()` 가 사는 곳)를 테스트에서 재현하는 하네스.
//
// 왜 필요한가: `cache()` 의 memoization 은 **react-server 빌드 + 활성 캐시
// 디스패처**가 있을 때만 동작한다. vitest 는 기본으로 클라이언트 빌드를 물고,
// 그쪽 `cache(fn)` 는 `return fn.apply(null, arguments)` 뿐인 **통과 함수**다
// (node_modules/react/cjs/react.development.js). 그 상태로 dedup 을 테스트하면
// 테스트가 아무것도 증명하지 못한 채 통과한다 — 그래서 아래 assert 가 있다.
//
// 사용법: 테스트 파일 맨 위에서 react 를 react-server 빌드로 mock 한 뒤, 실제
// 호출을 withRequestScope 안에서 한다. mock 팩토리는 호이스팅되어 외부 import 를
// 참조할 수 없으므로 각 테스트 파일이 로더를 인라인한다:
//
//   vi.mock("react", async () => {
//     const { createRequire } = await import("node:module");
//     const { dirname, join } = await import("node:path");
//     const req = createRequire(import.meta.url);
//     const root = dirname(req.resolve("react/package.json"));
//     return req(join(root, "cjs", "react.react-server.development.js"));
//   });

interface SharedInternals {
  A: unknown;
}

function sharedInternals(): SharedInternals {
  const mod = React as unknown as Record<string, SharedInternals | undefined>;
  const server = mod.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  if (!server) {
    throw new Error(
      "withRequestScope: react-server 빌드가 아니다 — 이 파일 상단에서 " +
        'vi.mock("react", loadReactServerBuild) 를 해야 cache() 가 실제로 memoize 한다.',
    );
  }
  return server;
}

/**
 * fn 을 "요청 하나" 안에서 실행한다 — 그 안의 `cache()` 호출은 하나의 캐시 루트를
 * 공유하고, 스코프를 벗어나면 버려진다(다음 요청은 새 캐시).
 */
export async function withRequestScope<T>(fn: () => Promise<T>): Promise<T> {
  const internals = sharedInternals();
  const root = new Map<() => unknown, unknown>();
  const prev = internals.A;
  internals.A = {
    getCacheForType(create: () => unknown) {
      if (!root.has(create)) root.set(create, create());
      return root.get(create);
    },
  };
  try {
    return await fn();
  } finally {
    internals.A = prev;
  }
}
