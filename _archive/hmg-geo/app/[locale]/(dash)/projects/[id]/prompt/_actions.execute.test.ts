import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/types";

// RUN(executePrompts) 회귀 테스트 — 2026-08-15~19 scope 장애 때 "Quick-Win"
// 프로젝트 6건이 영구 고아가 된 경로를 고정한다.
//
// 당시 사고 연쇄:
//   1) scope POST /api/v1/projects 가 zod 회귀(#454)로 전건 400 → 미러 생성 실패
//   2) 그런데도 예전 executePrompts 는 draft 전건을 enqueueAll 로 queued 전환
//   3) 다음 RUN 은 draft 가 0개라 "실행할 프롬프트가 없습니다"로 조기 반환
//   4) RUN 이 유일한 지연 미러 경로인데 영구히 눌리지 않음 = 자동 복구 불가
// 실측(2026-08-20, hmg 미러 DB): 6개 프로젝트 전부 queued 3건·scope_prompt_id
// 전부 NULL·scope_project_id NULL.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/db/repositories/projects", () => ({
  projectRepository: { getById: vi.fn() },
}));
vi.mock("@/lib/db/repositories/project-members", () => ({
  projectMemberRepository: { findMembership: vi.fn() },
}));
vi.mock("@/lib/auth/operator-policy", () => ({
  canOperateProject: vi.fn(() => true),
}));
vi.mock("@/lib/db/repositories/prompts", () => ({
  promptCandidateRepository: { listForProject: vi.fn() },
  promptRepository: {
    listForProject: vi.fn(),
    enqueueAll: vi.fn(),
    setScopePromptId: vi.fn(),
  },
}));
vi.mock("@/lib/prompts/excel", () => ({
  buildWorkbook: vi.fn(),
  parseWorkbook: vi.fn(),
}));
vi.mock("@/lib/scope/project-sync", () => ({
  pushDraftPromptsToScope: vi.fn(),
  attachScopeMirror: vi.fn(),
}));
vi.mock("@/lib/scope/server", () => ({ updatePrompt: vi.fn() }));
vi.mock("@/lib/db/repositories/scope-mirror", () => ({
  scopeMirrorRepository: { deletePromptData: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ auditDataAccess: vi.fn() }));
vi.mock("@/lib/db/repositories/project-custom-fields", () => ({
  projectCustomFieldRepository: {
    listForProject: vi.fn(),
    listValuesForProject: vi.fn(),
  },
}));

import { getSession } from "@/lib/auth/session";
import { projectRepository } from "@/lib/db/repositories/projects";
import { promptRepository } from "@/lib/db/repositories/prompts";
import { pushDraftPromptsToScope } from "@/lib/scope/project-sync";
import { executePrompts } from "./_actions";

const PROJECT_ID = "project-1";

function session(): Session {
  return {
    user: {
      id: "admin-1",
      email: "admin@hmg.test",
      role: "admin",
      scope: { all: true },
    },
  } as Session;
}

type Row = {
  id: string;
  text: string;
  brand: string | null;
  category: string | null;
  status: string;
  scopePromptId: string | null;
};

function row(id: string, status: string, scopePromptId: string | null): Row {
  return { id, text: `프롬프트 ${id}`, brand: null, category: null, status, scopePromptId };
}

const getSessionMock = vi.mocked(getSession);
const getByIdMock = vi.mocked(projectRepository.getById);
const listMock = vi.mocked(promptRepository.listForProject);
const enqueueMock = vi.mocked(promptRepository.enqueueAll);
const pushMock = vi.mocked(pushDraftPromptsToScope);

// 이 테스트가 쓰는 부분집합만 만들고 리포지토리 행 타입으로 좁힌다 — 전체 행을
// 흉내내지 않기 위한 캐스팅(`as unknown as`)이지 타입 회피가 아니다.
type ProjectRow = Awaited<ReturnType<typeof projectRepository.getById>>;
type PromptRows = Awaited<ReturnType<typeof promptRepository.listForProject>>;

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(session());
  getByIdMock.mockResolvedValue({
    id: PROJECT_ID,
    name: "Quick-Win",
    domain: null,
    brand: null,
    country: "KR",
    scopeProjectId: null,
    aiEngines: ["chatgpt"],
  } as unknown as ProjectRow);
});

function givenPrompts(...rows: Row[]): void {
  listMock.mockResolvedValue(rows as unknown as PromptRows);
}

async function run(): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await executePrompts(PROJECT_ID, "ko");
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (e) {
    // redirect() throws on success — normalize to ok:true.
    if ((e as Error).message === "NEXT_REDIRECT") return { ok: true };
    throw e;
  }
}

describe("executePrompts — scope 푸시 실패 시 draft 를 보존한다", () => {
  it("한 건도 못 밀면 enqueue 하지 않고 에러를 돌려준다 (draft 유지 = RUN 재시도 가능)", async () => {
    givenPrompts(row("p1", "draft", null), row("p2", "draft", null));
    pushMock.mockResolvedValue({
      pushedCount: 0,
      pushedIds: [],
      failedCount: 2,
      skipped: false,
    });

    const res = await run();

    expect(res.ok).toBe(false);
    // 핵심: 상태 전환이 일어나지 않아야 한다. 이게 고아를 만든 그 줄이다.
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("부분 성공이면 scope 가 받아준 것만 queued 로 넘긴다", async () => {
    givenPrompts(row("p1", "draft", null), row("p2", "draft", null));
    pushMock.mockResolvedValue({
      pushedCount: 1,
      pushedIds: ["p2"],
      failedCount: 1,
      skipped: false,
    });

    await run();

    // p1 은 draft 로 남아 다음 RUN 이 재시도한다.
    expect(enqueueMock).toHaveBeenCalledWith(PROJECT_ID, ["p2"]);
  });

  it("mock/데모(skipped)는 종전대로 전건을 queued 로 넘긴다", async () => {
    givenPrompts(row("p1", "draft", null), row("p2", "draft", null));
    pushMock.mockResolvedValue({
      pushedCount: 0,
      pushedIds: [],
      failedCount: 0,
      skipped: true,
    });

    await run();

    expect(enqueueMock).toHaveBeenCalledWith(PROJECT_ID, ["p1", "p2"]);
  });
});

describe("executePrompts — 기존 고아 적체를 RUN 으로 회수한다", () => {
  it("queued 인데 scope 에 없는 프롬프트를 RUN 대상에 포함한다", async () => {
    // 고아 6건의 실제 상태: status=queued, scope_prompt_id=NULL.
    givenPrompts(row("p1", "queued", null), row("p2", "queued", null));
    pushMock.mockResolvedValue({
      pushedCount: 2,
      pushedIds: ["p1", "p2"],
      failedCount: 0,
      skipped: false,
    });

    const res = await run();

    // 예전 코드는 draft 가 0개라 여기서 "실행할 프롬프트가 없습니다"로 끝났다.
    expect(res.ok).toBe(true);
    expect(pushMock).toHaveBeenCalledOnce();
    expect(pushMock.mock.calls[0][1].map((d) => d.id)).toEqual(["p1", "p2"]);
  });

  it("이미 scope 에 올라간 queued 프롬프트만 있으면 실행 대상이 없다", async () => {
    givenPrompts(row("p1", "queued", "sp-1"));

    const res = await run();

    expect(res.ok).toBe(false);
    expect(res.error).toBe("실행할 프롬프트가 없습니다");
    expect(pushMock).not.toHaveBeenCalled();
  });
});
