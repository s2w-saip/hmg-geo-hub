/**
 * `listRootPrompts` 가 공용 `pageAll` 을 지나는지 **실행으로** 확인한다.
 *
 * 이 함수는 2026-08-30 전수 조사 시점에 상한 20(= 2,000 프롬프트)으로 커서가
 * 남아도 조용히 끝났다. 호출부가 0건이라 라이브 피해는 없었지만
 * `enforce("listRootPrompts")` 로 게이트웨이에 노출돼 있어 되살아나면 루트
 * 12,012 중 6분의 1만 돌려준다. **죽은 코드여도 테스트로 못을 박는다** —
 * 다음에 누가 쓸 때 같은 사고가 나지 않게.
 */
import { PROMPT_MAX_PAGES } from "./paging";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PROMPT_MAX_PAGES } from "./paging";

vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({
    // scope.all = true → enforce/assertProjectInScope 가 즉시 통과한다.
    user: { id: "u1", role: "admin", scope: { all: true } },
  }),
}));
vi.mock("@/lib/audit", () => ({ auditScopeCall: () => {} }));

const listPrompts = vi.fn();
vi.mock("@/lib/scope/index", () => ({
  isMockMode: () => false,
  getScopeClient: () => ({ listPrompts: (...a: unknown[]) => listPrompts(...a) }),
}));

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  process.env.SCOPE_ROOT_PROJECT_ID = "root-1";
  listPrompts.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("listRootPrompts — 상한 20(2,000) 절단의 회귀 방지", () => {
  it("종전 사본 상한 20(2,000) 이 아니라 공용 PROMPT_MAX_PAGES 를 쓴다", async () => {
    // ⚠️ 원래 이 자리는 "12,012 을 전량 돌려준다" 였다. 2026-08-30 에 상한을 300
    // 으로 올려 그 단언을 만족시키려다 **크론이 300s 타임아웃으로 2시간 죽었다.**
    // 전량 수집은 상한이 아니라 증분 커서로 푸는 문제다(paging.ts 헤더). 여기서
    // 고정할 것은 "사본 상한 20 을 벗어나 공용 헬퍼를 지난다" 이지 "전량" 이 아니다.
    const TOTAL = 12_012;
    listPrompts.mockImplementation(async (_p: string, q: { cursor?: string }) => {
      const offset = q.cursor ? Number(q.cursor) : 0;
      const data = Array.from({ length: Math.min(100, TOTAL - offset) }, (_, i) => ({
        prompt_id: `p${offset + i}`,
      }));
      const next = offset + data.length;
      return { data, next_cursor: next < TOTAL ? String(next) : null };
    });

    const { listRootPrompts } = await import("./server");
    const out = await listRootPrompts();

    expect(listPrompts).toHaveBeenCalledTimes(PROMPT_MAX_PAGES);
    expect(listPrompts.mock.calls.length).toBeGreaterThan(20); // 사본 상한 탈출
    expect(out).toHaveLength(PROMPT_MAX_PAGES * 100);
    // 루트가 상한을 넘으므로 **절단되고, 그 절단은 시끄럽다**(조용한 절단이 결함이었다).
    expect(warn).toHaveBeenCalled();
  });

  it("상한을 넘기면 PAGE CAP HIT 로 시끄럽다 — 공용 헬퍼를 지난다는 증거", async () => {
    // 이 문자열은 리포 전체에서 lib/scope/paging.ts 한 곳만 낸다.
    let i = 0;
    listPrompts.mockImplementation(async () => ({
      data: [{ prompt_id: `p${i}` }],
      next_cursor: String(++i),
    }));

    const { listRootPrompts } = await import("./server");
    const out = await listRootPrompts();

    expect(listPrompts).toHaveBeenCalledTimes(PROMPT_MAX_PAGES);
    expect(out).toHaveLength(PROMPT_MAX_PAGES);
    const hits = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("PAGE CAP HIT"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("listRootPrompts(project=root-1)");
  });
});
