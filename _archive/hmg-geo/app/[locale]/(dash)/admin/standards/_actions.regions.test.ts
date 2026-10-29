/**
 * H5 시장·언어 편집 **액션 레벨** 검증.
 *
 * ── 왜 이 층인가 ────────────────────────────────────────────────────────
 * 순수 규칙(`lib/standards/prompt-regions.test.ts`)은 정규화만 본다. 화면 렌더는
 * 어드민이 인증 벽 뒤라 이 세션에서 못 연다(양 세션 모두 307). 그 사이에 있는
 * **"액션이 어떤 patch·changes 를 만들고 scope 에 무엇을 보내는가"** 가 여기다.
 * 이 층이 비면 정규화가 맞아도 배선이 틀린 결함(잘못된 전파 조건·가짜 감사 로그·
 * 클라이언트 어휘 신뢰)이 통째로 안 잡힌다.
 *
 * 세션·DB·scope 게이트웨이를 모킹하고 `applyAuditedCatalogChange` 로 넘어가는
 * 인자를 검사한다. DB 는 건드리지 않는다.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const getSession = vi.fn();
const getById = vi.fn();
const applyAuditedCatalogChange = vi.fn();
const updateRootPrompt = vi.fn();
const getProject = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession }));
vi.mock("@/lib/auth/scope-policy", () => ({ canAccessAdmin: () => true }));
vi.mock("@/lib/db/repositories/prompts", () => ({
  promptRepository: { getById },
}));
vi.mock("@/lib/db/repositories/prompt-audit-logs", () => ({
  applyAuditedCatalogChange,
  createAuditedCatalogPrompt: vi.fn(),
  promptAuditLogRepository: { insert: vi.fn() },
}));
vi.mock("@/lib/scope/server", () => ({
  updateRootPrompt,
  createRootPrompt: vi.fn(),
  getProject,
}));
vi.mock("@/lib/scope/result-adapter", () => ({
  getRootConfig: () => ({ projectId: "root-scope-id" }),
}));
vi.mock("@/lib/db/repositories/standards", () => ({
  STANDARD_ROOT_PROJECT_ID: "root-local-id",
  standardPromptRepository: {},
  standardKeywordRepository: {},
  standardSourceRepository: {},
  listStandardCatalog: vi.fn(),
}));
vi.mock("@/lib/standards/excel", () => ({
  buildCatalogWorkbook: vi.fn(),
  parseCatalogWorkbook: vi.fn(),
}));

const ROW_ID = "11111111-1111-4111-8111-111111111111";

function row(over: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    projectId: "root-local-id",
    text: "q",
    regions: null,
    lang: null,
    scopePromptId: "scope-prompt-1",
    promptType: null,
    category: null,
    brand: null,
    ...over,
  };
}

/** applyAuditedCatalogChange 로 넘어간 인자. */
function lastCall() {
  return applyAuditedCatalogChange.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "actor-1" } });
  getProject.mockResolvedValue({ regions: ["KR", "US", "DE"] });
  applyAuditedCatalogChange.mockResolvedValue(undefined);
  updateRootPrompt.mockResolvedValue({});
});

async function mod() {
  return import("./_actions");
}

describe("updateStandardPromptRegions — 저장 배선", () => {
  it("시장을 설정하면 patch·changes·scope 전파가 모두 맞다", async () => {
    getById.mockResolvedValue(row());
    const { updateStandardPromptRegions } = await mod();
    const res = await updateStandardPromptRegions(ROW_ID, { regions: ["US", "KR"] });
    expect(res.ok).toBe(true);

    const call = lastCall();
    expect(call.eventType).toBe("meta_updated");
    // 저장은 정규화된 **정렬 배열**.
    expect(call.patch.regions).toEqual(["KR", "US"]);
    // 감사는 **정렬 CSV** — computeChanges 가 String(v) 라 배열을 그대로 넣으면
    // 순서 차이가 가짜 변경이 된다.
    expect(call.changes.regions).toEqual({ old: null, new: "KR,US" });

    await call.applyScope();
    expect(updateRootPrompt).toHaveBeenCalledWith("scope-prompt-1", { regions: ["KR", "US"] });
  });

  it("★ lang 만 바뀌면 scope 로 전파하지 않는다 — 측정 축이 아니다", async () => {
    getById.mockResolvedValue(row());
    const { updateStandardPromptRegions } = await mod();
    const res = await updateStandardPromptRegions(ROW_ID, { lang: "ko" });
    expect(res.ok).toBe(true);

    const call = lastCall();
    expect(call.patch).toEqual({ lang: "KO" }); // 대문자 정규화
    expect(call.changes.lang).toEqual({ old: null, new: "KO" });
    expect(call.applyScope).toBeUndefined(); // ← 전파 없음
  });

  it("빈 배열은 null(미지정=상속)로 접혀 저장된다", async () => {
    getById.mockResolvedValue(row({ regions: ["KR"] }));
    const { updateStandardPromptRegions } = await mod();
    await updateStandardPromptRegions(ROW_ID, { regions: [] });
    const call = lastCall();
    expect(call.patch.regions).toBeNull();
    expect(call.changes.regions).toEqual({ old: "KR", new: null });
  });

  it("★ 어휘 밖 코드는 거절하고 아무것도 쓰지 않는다", async () => {
    getById.mockResolvedValue(row());
    const { updateStandardPromptRegions } = await mod();
    const res = await updateStandardPromptRegions(ROW_ID, { regions: ["KR", "JP"] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("JP");
    expect(applyAuditedCatalogChange).not.toHaveBeenCalled();
  });

  it("형식 오류와 어휘 밖의 메시지가 다르다", async () => {
    getById.mockResolvedValue(row());
    const { updateStandardPromptRegions } = await mod();
    const bad = await updateStandardPromptRegions(ROW_ID, { regions: ["NOPE!"] });
    const oov = await updateStandardPromptRegions(ROW_ID, { regions: ["JP"] });
    expect(bad.ok).toBe(false);
    expect(oov.ok).toBe(false);
    if (!bad.ok && !oov.ok) expect(bad.error).not.toBe(oov.error);
  });

  it("★ 순서만 다른 같은 집합은 변경으로 치지 않는다 — 빈 감사 로그 방지", async () => {
    // ⚠️ **저장된 값을 일부러 정렬되지 않은 상태로 둔다.** H5 이전에 쓰인 행은
    // 정렬 보장이 없으므로 이게 실제 상태다. 저장본을 이미 정렬된 값으로 두면
    // 순진한 `String(a) !== String(b)` 비교로 바꿔도 테스트가 통과해버린다
    // (2026-08-30 돌연변이 M4 로 실증 — 이 주석이 그 수정이다).
    getById.mockResolvedValue(row({ regions: ["US", "KR"] }));
    const { updateStandardPromptRegions } = await mod();
    const res = await updateStandardPromptRegions(ROW_ID, { regions: ["KR", "US"] });
    expect(res.ok).toBe(true);
    expect(applyAuditedCatalogChange).not.toHaveBeenCalled();
  });

  it("★ 저장본이 정렬돼 있지 않아도 실제 변경은 잡는다 (위 테스트의 반대편)", async () => {
    // 순서 무시 비교가 "아무것도 변경으로 안 침"으로 퇴화하지 않는지 확인한다.
    getById.mockResolvedValue(row({ regions: ["US", "KR"] }));
    const { updateStandardPromptRegions } = await mod();
    const res = await updateStandardPromptRegions(ROW_ID, { regions: ["KR"] });
    expect(res.ok).toBe(true);
    expect(lastCall().changes.regions).toEqual({ old: "KR,US", new: "KR" });
  });

  it("★ 클라이언트 어휘를 믿지 않는다 — 상한은 서버가 조회한 루트 실황이다", async () => {
    // 루트가 KR 만 허용하는 상황에서 US 를 보내면 거절돼야 한다.
    getProject.mockResolvedValue({ regions: ["KR"] });
    getById.mockResolvedValue(row());
    const { updateStandardPromptRegions } = await mod();
    const res = await updateStandardPromptRegions(ROW_ID, { regions: ["US"] });
    expect(res.ok).toBe(false);
    expect(applyAuditedCatalogChange).not.toHaveBeenCalled();
  });

  it("어휘 조회가 실패해도 편집을 막지 않는다 (형식 검사만)", async () => {
    // 반대로 굴면 scope 가 잠깐 흔들릴 때 어드민이 통째로 잠긴다.
    getProject.mockRejectedValue(new Error("scope down"));
    getById.mockResolvedValue(row());
    const { updateStandardPromptRegions } = await mod();
    const res = await updateStandardPromptRegions(ROW_ID, { regions: ["JP"] });
    expect(res.ok).toBe(true);
    expect(lastCall().patch.regions).toEqual(["JP"]);
  });

  it("scope 미연결(scopePromptId null) 행은 로컬만 바꾼다", async () => {
    getById.mockResolvedValue(row({ scopePromptId: null }));
    const { updateStandardPromptRegions } = await mod();
    await updateStandardPromptRegions(ROW_ID, { regions: ["KR"] });
    expect(lastCall().applyScope).toBeUndefined();
  });

  it("루트 카탈로그 밖 행은 거절한다", async () => {
    getById.mockResolvedValue(row({ projectId: "other-project" }));
    const { updateStandardPromptRegions } = await mod();
    const res = await updateStandardPromptRegions(ROW_ID, { regions: ["KR"] });
    expect(res.ok).toBe(false);
    expect(applyAuditedCatalogChange).not.toHaveBeenCalled();
  });
});

describe("bulkSetStandardPromptRegions — 일괄", () => {
  it("★ 감사는 건별 1행이다 (묶지 않는다)", async () => {
    getById.mockResolvedValue(row());
    const { bulkSetStandardPromptRegions } = await mod();
    const res = await bulkSetStandardPromptRegions([ROW_ID, ROW_ID, ROW_ID], ["KR"]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.updated).toBe(3);
    expect(applyAuditedCatalogChange).toHaveBeenCalledTimes(3);
  });

  it("★ 부분 성공을 허용한다 — 한 건의 실패가 나머지를 되돌리지 않는다", async () => {
    // 2번째만 카탈로그 밖 행으로 만든다.
    getById
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ projectId: "other" }))
      .mockResolvedValueOnce(row());
    const { bulkSetStandardPromptRegions } = await mod();
    const res = await bulkSetStandardPromptRegions([ROW_ID, ROW_ID, ROW_ID], ["KR"]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.updated).toBe(2);
      expect(res.value.failed).toHaveLength(1);
    }
  });

  it("빈 선택은 거절한다", async () => {
    const { bulkSetStandardPromptRegions } = await mod();
    expect((await bulkSetStandardPromptRegions([], ["KR"])).ok).toBe(false);
  });
});
