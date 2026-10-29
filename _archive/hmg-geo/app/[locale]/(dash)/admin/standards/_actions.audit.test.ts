import { describe, it, expect, vi, beforeEach } from "vitest";

// catalog-prompt-audit 액션 테스트 — 스타일 (b): 전면 모킹, 실 DB 없음.
// 트랜잭션 원자성 자체는 composite(리포지터리)의 책임이고, 여기서는 액션이
// composite를 올바른 이벤트·changes·Scope 콜백으로 호출하는지를 검증한다.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/scope/server", () => ({
  createRootPrompt: vi.fn(),
  updateRootPrompt: vi.fn(),
  deleteRootPrompt: vi.fn(),
}));
vi.mock("@/lib/db/repositories/prompts", () => ({
  promptRepository: {
    getById: vi.fn(),
    getByScopePromptId: vi.fn(),
    setKind: vi.fn(),
  },
}));
vi.mock("@/lib/db/repositories/standards", () => ({
  STANDARD_ROOT_PROJECT_ID: "26751906-c175-485c-9e69-29fc68d0fdbb",
  standardPromptRepository: { insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  standardKeywordRepository: { insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  standardSourceRepository: { insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  listStandardCatalog: vi.fn(),
}));
vi.mock("@/lib/db/repositories/prompt-audit-logs", () => ({
  applyAuditedCatalogChange: vi.fn(),
  createAuditedCatalogPrompt: vi.fn(),
  promptAuditLogRepository: { insert: vi.fn() },
}));
vi.mock("@/lib/standards/excel", () => ({
  buildCatalogWorkbook: vi.fn(),
  parseCatalogWorkbook: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { createRootPrompt, updateRootPrompt } from "@/lib/scope/server";
import { promptRepository } from "@/lib/db/repositories/prompts";
import { listStandardCatalog } from "@/lib/db/repositories/standards";
import { parseCatalogWorkbook } from "@/lib/standards/excel";
import {
  applyAuditedCatalogChange,
  createAuditedCatalogPrompt,
  promptAuditLogRepository,
} from "@/lib/db/repositories/prompt-audit-logs";
import {
  createStandardPrompt,
  setStandardPromptKind,
  deleteStandardPrompt,
  toggleStandardPromptEnabled,
  updateStandardPromptText,
  updateStandardPromptLabels,
  softDeleteStandardPrompt,
  restoreStandardPrompt,
  previewStandardCatalogImport,
  applyStandardCatalogChunk,
} from "./_actions";

const ROOT = "26751906-c175-485c-9e69-29fc68d0fdbb";
const admin = {
  user: { id: "u-admin", role: "admin", scope: { all: true }, operator: "global" },
};
const row = {
  id: "p-1",
  projectId: ROOT,
  text: "old text",
  kind: "single",
  scopePromptId: "sp-1",
  deletedAt: null,
  brand: "Kia",
  promptType: null,
  category: null,
  listType: null,
  depth1: null,
  depth2: null,
  depth3: null,
  depth4: null,
  funnelStage: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(admin as never);
  vi.mocked(promptRepository.getById).mockResolvedValue(row as never);
});

describe("updateStandardPromptText", () => {
  it("composite를 text_updated + old/new changes로 호출한다", async () => {
    vi.mocked(applyAuditedCatalogChange).mockResolvedValue();
    const res = await updateStandardPromptText("p-1", "new text");
    expect(res.ok).toBe(true);
    const call = vi.mocked(applyAuditedCatalogChange).mock.calls[0][0];
    expect(call.eventType).toBe("text_updated");
    expect(call.changes).toEqual({ text: { old: "old text", new: "new text" } });
    expect(call.patch).toEqual({ text: "new text" });
  });

  it("scopePromptId가 있으면 applyScope 콜백이 scope text PATCH를 부른다", async () => {
    vi.mocked(applyAuditedCatalogChange).mockImplementation(async (input) => {
      await input.applyScope?.();
    });
    vi.mocked(updateRootPrompt).mockResolvedValue({} as never);
    const res = await updateStandardPromptText("p-1", "new text");
    expect(res.ok).toBe(true);
    expect(updateRootPrompt).toHaveBeenCalledWith("sp-1", { text: "new text" });
  });

  it("composite가 throw하면(=Scope 실패 포함 롤백) ok:false를 돌려준다", async () => {
    vi.mocked(applyAuditedCatalogChange).mockRejectedValue(new Error("scope 500"));
    const res = await updateStandardPromptText("p-1", "new text");
    expect(res).toEqual({ ok: false, error: expect.any(String) });
  });

  it("변경 없음(동일 text)이면 composite를 부르지 않는다", async () => {
    const res = await updateStandardPromptText("p-1", "old text");
    expect(res.ok).toBe(true);
    expect(applyAuditedCatalogChange).not.toHaveBeenCalled();
  });

  it("비admin 세션은 UnauthorizedError를 던진다", async () => {
    vi.mocked(getSession).mockResolvedValue({
      user: { ...admin.user, role: "hq" },
    } as never);
    await expect(updateStandardPromptText("p-1", "x")).rejects.toThrow();
  });

  it("카탈로그 밖 행(projectId 불일치)은 ok:false", async () => {
    vi.mocked(promptRepository.getById).mockResolvedValue({
      ...row,
      projectId: "other-project",
    } as never);
    const res = await updateStandardPromptText("p-1", "x");
    expect(res.ok).toBe(false);
  });
});

describe("updateStandardPromptLabels", () => {
  it("meta_updated 이벤트 + 바뀐 라벨만 changes에 담는다", async () => {
    vi.mocked(applyAuditedCatalogChange).mockResolvedValue();
    const res = await updateStandardPromptLabels("p-1", { depth1: "EV", brand: "Kia" });
    expect(res.ok).toBe(true);
    const call = vi.mocked(applyAuditedCatalogChange).mock.calls[0][0];
    expect(call.eventType).toBe("meta_updated");
    expect(call.changes).toEqual({ depth1: { old: null, new: "EV" } });
  });

  it("scope-가시 필드(brand 등) 변경 시 keywords PATCH 콜백을 구성한다", async () => {
    vi.mocked(applyAuditedCatalogChange).mockImplementation(async (input) => {
      await input.applyScope?.();
    });
    vi.mocked(updateRootPrompt).mockResolvedValue({} as never);
    const res = await updateStandardPromptLabels("p-1", { brand: "Hyundai" });
    expect(res.ok).toBe(true);
    expect(updateRootPrompt).toHaveBeenCalledWith(
      "sp-1",
      expect.objectContaining({ keywords: expect.any(Array) }),
    );
  });

  it("로컬 전용 필드(depth)만 바뀌면 scope PATCH 없이 로컬+로그만", async () => {
    vi.mocked(applyAuditedCatalogChange).mockImplementation(async (input) => {
      await input.applyScope?.();
    });
    const res = await updateStandardPromptLabels("p-1", { depth2: "충전" });
    expect(res.ok).toBe(true);
    expect(updateRootPrompt).not.toHaveBeenCalled();
  });
});

describe("softDelete / restore", () => {
  it("softDelete는 deleted 이벤트 + scope active=false 콜백을 구성한다", async () => {
    vi.mocked(applyAuditedCatalogChange).mockImplementation(async (input) => {
      await input.applyScope?.();
    });
    vi.mocked(updateRootPrompt).mockResolvedValue({} as never);
    const res = await softDeleteStandardPrompt("p-1");
    expect(res.ok).toBe(true);
    expect(updateRootPrompt).toHaveBeenCalledWith("sp-1", { enabled: false });
    const call = vi.mocked(applyAuditedCatalogChange).mock.calls[0][0];
    expect(call.eventType).toBe("deleted");
    expect(call.patch.deletedAt).toBeInstanceOf(Date);
  });

  it("이미 삭제된 행의 softDelete는 no-op", async () => {
    vi.mocked(promptRepository.getById).mockResolvedValue({
      ...row,
      deletedAt: new Date(),
    } as never);
    const res = await softDeleteStandardPrompt("p-1");
    expect(res.ok).toBe(true);
    expect(applyAuditedCatalogChange).not.toHaveBeenCalled();
  });

  it("restore는 restored 이벤트 + scope active=true", async () => {
    vi.mocked(promptRepository.getById).mockResolvedValue({
      ...row,
      deletedAt: new Date(),
    } as never);
    vi.mocked(applyAuditedCatalogChange).mockImplementation(async (input) => {
      await input.applyScope?.();
    });
    vi.mocked(updateRootPrompt).mockResolvedValue({} as never);
    const res = await restoreStandardPrompt("p-1");
    expect(res.ok).toBe(true);
    expect(updateRootPrompt).toHaveBeenCalledWith("sp-1", { enabled: true });
    const call = vi.mocked(applyAuditedCatalogChange).mock.calls[0][0];
    expect(call.eventType).toBe("restored");
    expect(call.patch.deletedAt).toBeNull();
  });
});

describe("기존 액션 배선 (catalog-prompt-audit)", () => {
  it("createStandardPrompt는 로컬 카탈로그 행 + created 이벤트 + scope 링크를 만든다", async () => {
    vi.mocked(createAuditedCatalogPrompt).mockResolvedValue({ id: "p-new" });
    const res = await createStandardPrompt({ text: "새 프롬프트" });
    expect(res).toEqual({ ok: true, value: { id: "p-new" } });
    expect(createAuditedCatalogPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "u-admin",
        values: expect.objectContaining({ text: "새 프롬프트" }),
      }),
    );
  });

  it("createStandardPrompt의 pushScope 콜백은 createRootPrompt를 keywords와 함께 부른다", async () => {
    vi.mocked(createRootPrompt).mockResolvedValue({ prompt_id: "sp-new" } as never);
    vi.mocked(createAuditedCatalogPrompt).mockImplementation(async (input) => {
      const scoped = await input.pushScope?.();
      expect(scoped).toEqual({ scopePromptId: "sp-new" });
      return { id: "p-new" };
    });
    const res = await createStandardPrompt({ text: "t", brand: "Kia" });
    expect(res.ok).toBe(true);
    expect(createRootPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "t", keywords: expect.any(Array) }),
    );
  });

  it("setStandardPromptKind는 kind_changed 이벤트로 composite를 태운다", async () => {
    vi.mocked(applyAuditedCatalogChange).mockImplementation(async (input) => {
      await input.applyScope?.();
    });
    vi.mocked(updateRootPrompt).mockResolvedValue({} as never);
    const res = await setStandardPromptKind("p-1", "acr");
    expect(res.ok).toBe(true);
    const call = vi.mocked(applyAuditedCatalogChange).mock.calls[0][0];
    expect(call.eventType).toBe("kind_changed");
    expect(call.changes).toEqual({ kind: { old: "single", new: "acr" } });
    expect(updateRootPrompt).toHaveBeenCalledWith("sp-1", { kind: "acr" });
  });

  it("deleteStandardPrompt는 물리 삭제 대신 softDelete로 위임된다", async () => {
    vi.mocked(applyAuditedCatalogChange).mockResolvedValue();
    const res = await deleteStandardPrompt("p-1");
    expect(res.ok).toBe(true);
    expect(vi.mocked(applyAuditedCatalogChange).mock.calls[0][0].eventType).toBe("deleted");
  });

  it("toggleStandardPromptEnabled는 로컬 행이 있으면 enabled_changed 로그를 남긴다", async () => {
    vi.mocked(updateRootPrompt).mockResolvedValue({} as never);
    vi.mocked(promptRepository.getByScopePromptId).mockResolvedValue({
      ...row,
      id: "p-1",
    } as never);
    const res = await toggleStandardPromptEnabled("sp-1", false);
    expect(res.ok).toBe(true);
    expect(promptAuditLogRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        promptId: "p-1",
        eventType: "enabled_changed",
        changes: { enabled: { old: "true", new: "false" } },
      }),
    );
  });
});

describe("벌크 (preview / chunk apply)", () => {
  const catalogRow = (over: Record<string, unknown>) => ({ ...row, ...over });

  it("preview: 파싱 결과를 현재 행과 대조해 changes/unmatched/unchanged로 나눈다", async () => {
    vi.mocked(parseCatalogWorkbook).mockResolvedValue({
      rows: [
        { id: "p-1", text: "새 본문", labels: {} }, // 변경
        { id: "p-1x", text: "x", labels: {} }, // id 미매칭
        { id: "p-2", labels: { brand: "Kia" } }, // 불변 (이미 Kia)
      ],
      warnings: ["w1"],
    });
    vi.mocked(listStandardCatalog).mockResolvedValue({
      rows: [
        catalogRow({ id: "p-1", text: "old" }),
        catalogRow({ id: "p-2", brand: "Kia" }),
      ],
      stats: {},
    } as never);
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array([1])], "c.xlsx"));
    const res = await previewStandardCatalogImport(fd);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.items.map((i) => i.id)).toEqual(["p-1"]);
    expect(res.value.items[0].changes.text).toEqual({ old: "old", new: "새 본문" });
    expect(res.value.unmatchedIds).toEqual(["p-1x"]);
    expect(res.value.unchanged).toBe(1);
    expect(res.value.warnings).toEqual(["w1"]);
    expect(res.value.batchId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("chunk: 항목별 독립 처리 — 한 건 실패해도 나머지는 적용된다", async () => {
    vi.mocked(promptRepository.getById)
      .mockResolvedValueOnce(row as never)
      .mockResolvedValueOnce(catalogRow({ id: "p-2" }) as never);
    vi.mocked(applyAuditedCatalogChange)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("scope down"));
    const res = await applyStandardCatalogChunk(
      [
        { id: "p-1", text: "n1", labels: {} },
        { id: "p-2", text: "n2", labels: {} },
      ],
      "11111111-1111-1111-1111-111111111111",
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.applied).toBe(1);
    expect(res.value.failed).toEqual([{ id: "p-2", error: expect.any(String) }]);
    // batchId가 composite에 전달됐는지
    const call = vi.mocked(applyAuditedCatalogChange).mock.calls[0][0];
    expect(call.batchId).toBe("11111111-1111-1111-1111-111111111111");
    expect(call.eventType).toBe("text_updated");
  });

  it("chunk: 적용 시점 재대조로 변경 없는 항목은 skip(applied로 계산)", async () => {
    vi.mocked(promptRepository.getById).mockResolvedValue(
      catalogRow({ text: "n1" }) as never,
    );
    const res = await applyStandardCatalogChunk(
      [{ id: "p-1", text: "n1", labels: {} }],
      "11111111-1111-1111-1111-111111111111",
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.applied).toBe(1);
    expect(applyAuditedCatalogChange).not.toHaveBeenCalled();
  });

  it("chunk: 25건 초과·잘못된 batchId는 거부", async () => {
    const many = Array.from({ length: 26 }, (_, i) => ({
      id: "p-" + i,
      labels: {},
    }));
    const res1 = await applyStandardCatalogChunk(many, "11111111-1111-1111-1111-111111111111");
    expect(res1.ok).toBe(false);
    const res2 = await applyStandardCatalogChunk([{ id: "p-1", labels: {} }], "not-a-uuid");
    expect(res2.ok).toBe(false);
  });
});
