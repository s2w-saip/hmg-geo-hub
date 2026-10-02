import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@/lib/auth/types";
import type { ScopeFilter } from "@/lib/scope/types";

// Hoisted mock handles — referenced inside the (hoisted) vi.mock factories.
const { afterMock, insertMock } = vi.hoisted(() => ({
  afterMock: vi.fn(),
  insertMock: vi.fn(),
}));

// `after()` is the fire-and-forget dispatch primitive. Default: behave as if a
// request context is present and run the callback (deferred → run now). Case ④
// overrides it to throw (no request context).
vi.mock("next/server", () => ({
  after: (cb: () => void) => afterMock(cb),
}));

// The real sink. audit.ts must route every event through insert(); we assert on
// the row shape it receives without touching Drizzle/Postgres.
vi.mock("@/lib/db/repositories/bff-audit-logs", () => ({
  bffAuditLogRepository: { insert: insertMock },
}));

import { auditScopeCall, auditDataAccess } from "./audit";

const scopeUser: User = {
  id: "user-1",
  email: "region@hmg.test",
  role: "region",
  scope: { all: false, regions: ["EU"] },
  operator: "assigned",
};

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: simulate an active request scope by running the deferred callback.
  afterMock.mockImplementation((cb: () => void) => cb());
  insertMock.mockResolvedValue({ id: "row-1" });
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("auditScopeCall", () => {
  it("① persists a scope_call row with actor/role/action + ScopeFilter snapshot in detail", async () => {
    const filter: ScopeFilter = { regions: ["EU"], countries: ["DE", "FR"] };

    const ret = auditScopeCall(scopeUser, "listProjects", filter);

    // synchronous void — callers get nothing back and are never blocked
    expect(ret).toBeUndefined();
    // dispatched via after() (post-response), not inline
    expect(afterMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(insertMock).toHaveBeenCalledTimes(1));
    expect(insertMock).toHaveBeenCalledWith({
      kind: "scope_call",
      actorId: "user-1",
      actorRole: "region",
      action: "listProjects",
      target: null,
      detail: filter,
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

describe("auditDataAccess", () => {
  it("② persists a data_access row with the table name in target and null detail", async () => {
    const ret = auditDataAccess(
      { id: "admin-1", role: "admin" },
      "profiles",
      "create:new@hmg.test",
    );

    expect(ret).toBeUndefined();
    await vi.waitFor(() => expect(insertMock).toHaveBeenCalledTimes(1));
    expect(insertMock).toHaveBeenCalledWith({
      kind: "data_access",
      actorId: "admin-1",
      actorRole: "admin",
      action: "create:new@hmg.test",
      target: "profiles",
      detail: null,
    });
  });
});

describe("sink failure semantics", () => {
  it("③ insert rejection → no throw + one console.error fallback carrying the payload", async () => {
    insertMock.mockRejectedValueOnce(new Error("db down"));

    // Must not throw despite the sink failing.
    expect(() =>
      auditScopeCall(scopeUser, "overview", { regions: ["EU"] }),
    ).not.toThrow();

    await vi.waitFor(() => expect(consoleErrorSpy).toHaveBeenCalledTimes(1));
    expect(insertMock).toHaveBeenCalledTimes(1);
    const [msg, payload] = consoleErrorSpy.mock.calls[0];
    expect(String(msg)).toContain("[bff-audit]");
    // The original payload survives to the fallback (no silent loss).
    expect(String(payload)).toContain("overview");
    expect(String(payload)).toContain("user-1");
  });
});

describe("no request context", () => {
  it("④ after() throwing (no request scope) → no throw, insert still fires via immediate fallback", async () => {
    afterMock.mockImplementation(() => {
      throw new Error("after() was called outside a request scope");
    });

    expect(() =>
      auditDataAccess({ id: "u-2", role: "hq" }, "entity_registry", "set-role:x:own"),
    ).not.toThrow();

    await vi.waitFor(() => expect(insertMock).toHaveBeenCalledTimes(1));
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "data_access",
        actorId: "u-2",
        actorRole: "hq",
        target: "entity_registry",
      }),
    );
    // Insert succeeded → no error fallback on this path.
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

// 2026-08-27 회귀 가드 — 프로덕션에서 `bff_audit_logs` INSERT 를 실행하던 백엔드
// 7개가 `ClientRead` 로 멈춰 서버 커넥션을 영구 점유했다(최장 1,165초). 원인은
// after() 에 넘긴 콜백이 `undefined` 를 반환해(구 `() => { void persist(row) }`)
// Vercel 이 after-work 를 이미 끝난 것으로 보고 인스턴스를 INSERT 도중에
// 정지시킨 것. after() 는 **넘겨받은 프로미스**에 대해서만 인스턴스를 살려둔다.
describe("after() 계약", () => {
  it("⑤ after() 콜백은 persist 프로미스를 반환한다 (waitUntil 이 INSERT 를 덮게)", async () => {
    let resolveInsert: (v: unknown) => void = () => {};
    insertMock.mockImplementationOnce(
      () => new Promise((res) => { resolveInsert = res; }),
    );
    // 콜백을 즉시 실행하지 않고 붙잡아 둔다 — 반환값을 검사하기 위해서.
    let captured: (() => unknown) | null = null;
    afterMock.mockImplementation((cb: () => unknown) => { captured = cb; });

    auditScopeCall(scopeUser, "standardTrend", { regions: ["EU"] });

    expect(captured).toBeTypeOf("function");
    const returned = captured!();
    expect(returned).toBeInstanceOf(Promise);

    resolveInsert({ id: "row-1" });
    await returned;
    expect(insertMock).toHaveBeenCalledTimes(1);
  });
});
