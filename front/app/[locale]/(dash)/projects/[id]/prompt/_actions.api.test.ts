import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// API-source routing of the prompt-tab actions (HGH_SOURCE_G6=api, unit U9): candidates, crud,
// lifecycle, execute, io and custom fields go to the backend; the legacy repositories, the Scope
// push and the session gate are untouched; revalidatePath / redirect exactly as legacy (success
// only). Code -> message mapping: lib/hgh/adapters/projects.test.ts; outcome parity:
// lib/hgh/adapters/projects.parity.test.ts.

const h = vi.hoisted(() => ({ revalidate: [] as string[] }));
const untouched = () =>
  new Proxy(
    {},
    {
      // "then" and symbols stay undefined so a module-level proxy is not taken for a promise.
      get: (_t, name) =>
        name === "then" || typeof name === "symbol"
          ? undefined
          : () => {
              throw new Error(`legacy dependency touched: ${String(name)}`);
            },
    },
  );
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => h.revalidate.push(p) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: () => {
    throw new Error("legacy session gate touched");
  },
}));
vi.mock("@/lib/db/repositories/projects", () => ({ projectRepository: untouched() }));
vi.mock("@/lib/db/repositories/project-members", () => ({ projectMemberRepository: untouched() }));
vi.mock("@/lib/db/repositories/prompts", () => ({ promptCandidateRepository: untouched(), promptRepository: untouched() }));
vi.mock("@/lib/db/repositories/project-custom-fields", () => ({ projectCustomFieldRepository: untouched() }));
vi.mock("@/lib/db/repositories/scope-mirror", () => ({ scopeMirrorRepository: untouched() }));
vi.mock("@/lib/scope/project-sync", () => untouched());
vi.mock("@/lib/scope/server", () => untouched());
vi.mock("@/lib/audit", () => untouched());

const { bindHghAuth } = await import("@/lib/hgh/auth");
const { UnauthorizedError } = await import("@/lib/auth/errors");
const A = await import("./_actions");

const PID = "c0000000-0000-4000-8000-000000000003";
const Q = "d0000000-0000-4000-8000-000000000001";
const F = "f0000000-0000-4000-8000-000000000001";
const calls: { method: string; url: string; body: unknown }[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const data = (d: unknown, status = 200) => json(status, { data: d, meta: { mode: "crud" } });
let answer: (method: string, path: string) => Response;
const key = (c: { method: string; url: string }) => `${c.method} ${c.url}`;

beforeEach(() => {
  calls.length = 0;
  h.revalidate.length = 0;
  vi.stubEnv("HGH_SOURCE_G6", "api");
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubEnv("HGH_API_TRACE_FILE", "");
  bindHghAuth({ getAccessToken: async () => "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln" });
  answer = () => new Response(null, { status: 204 });
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const method = String(init.method ?? "GET");
    calls.push({ method, url: u.pathname, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    return answer(method, u.pathname);
  });
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const P = (s = "") => `/v1/projects/${PID}${s}`;
const TAB = `/projects/${PID}/prompt`;

describe("prompt actions on the api source", () => {
  it("candidates and manual add: backend paths and bodies; prompt tab revalidated per success", async () => {
    answer = (_m, path) =>
      path.endsWith("/select")
        ? data({ created: 1, prompt_ids: [Q], not_found: [] }, 201)
        : path.endsWith("/bulk-delete")
          ? data({ deleted: 2, not_found: [] })
          : path.endsWith("/prompts")
            ? data({ created: 2, prompt_ids: [] }, 201)
            : new Response(null, { status: 204 });
    await expect(A.selectFromCandidates(PID, [Q])).resolves.toEqual({ ok: true, value: { created: 1 } });
    await expect(A.deleteCandidates(PID, [Q, F])).resolves.toEqual({ ok: true, value: { count: 2 } });
    await expect(A.deleteCandidate(PID, Q)).resolves.toEqual({ ok: true, value: undefined });
    await expect(A.addManualPrompt(PID, "a\nb")).resolves.toEqual({ ok: true, value: { count: 2 } });
    expect(calls.map(key)).toEqual([
      `POST ${P("/prompt-candidates/select")}`,
      `POST ${P("/prompt-candidates/bulk-delete")}`,
      `DELETE ${P(`/prompt-candidates/${Q}`)}`,
      `POST ${P("/prompts")}`,
    ]);
    expect(h.revalidate).toEqual([TAB, TAB, TAB, TAB]);
  });

  it("lifecycle: impact read, pause, resume, hard delete, draft delete", async () => {
    answer = (m) =>
      m === "GET"
        ? data({ prompt_id: Q, answers: 1, mentions: 2, citations: 3, published: true, shared_rows: 0 })
        : m === "DELETE"
          ? new Response(null, { status: 204 })
          : data({ prompt_id: Q, status: "paused", propagation: "pending" });
    await expect(A.getPromptLifecycleImpact(PID, Q)).resolves.toEqual({ ok: true, value: { answers: 1, mentions: 2, citations: 3, sharedRows: 0 } });
    await A.pausePrompt(PID, Q);
    await A.resumePrompt(PID, Q);
    await A.deletePromptCascade(PID, Q);
    await A.deletePrompt(PID, Q);
    expect(calls.map(key)).toEqual([
      `GET ${P(`/prompts/${Q}/lifecycle-impact`)}`,
      `POST ${P(`/prompts/${Q}/pause`)}`,
      `POST ${P(`/prompts/${Q}/resume`)}`,
      `POST ${P(`/prompts/${Q}/hard-delete`)}`,
      `DELETE ${P(`/prompts/${Q}`)}`,
    ]);
    expect(h.revalidate).toEqual([TAB, TAB, TAB, TAB]);
  });

  // B019: an unpublished row resumes to 'queued' on the backend (lifecycle/service.py resume). The action
  // revalidates the tab on success, so the re-rendered list carries the server status; the list's
  // 'done' overlay applies only while the row still shows 'paused' (prompt-list applyStatusOverlay).
  it("resume of an unpublished prompt: backend answers queued; ok + the prompt tab revalidated (the list then shows the server status)", async () => {
    answer = () => data({ prompt_id: Q, status: "queued", propagation: "pending", outbox_id: 9 });
    await expect(A.resumePrompt(PID, Q)).resolves.toEqual({ ok: true, value: undefined });
    expect(calls.map(key)).toEqual([`POST ${P(`/prompts/${Q}/resume`)}`]);
    expect(h.revalidate).toEqual([TAB]);
  });

  it("executePrompts: 202 -> revalidate + redirect to the analysis tab; 409 -> legacy message, no redirect", async () => {
    answer = () => data({ queued: 2, recovered: 0, skipped_pending: 0, propagation: "pending" }, 202);
    await expect(A.executePrompts(PID, "ko")).rejects.toThrow(`REDIRECT:/ko/projects/${PID}/analysis`);
    expect(h.revalidate).toEqual([TAB]);
    h.revalidate.length = 0;
    answer = () => json(409, { error: { code: "nothing_to_execute", message: "m" } });
    await expect(A.executePrompts(PID, "ko")).resolves.toEqual({ ok: false, error: "실행할 프롬프트가 없습니다" });
    answer = () => json(403, { error: { code: "operator_forbidden", message: "m" } });
    await expect(A.executePrompts(PID, "ko")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(h.revalidate).toEqual([]);
  });

  it("custom fields and values", async () => {
    answer = (m, path) =>
      m === "POST" && path.endsWith("/prompt-fields")
        ? data({ field_id: F, label: "T", archived: false, value_count: 0, created_at: "2026-06-01T00:00:00Z" }, 201)
        : path.endsWith("/bulk-set")
          ? data({ field_id: F, count: 1 })
          : m === "DELETE"
            ? new Response(null, { status: 204 })
            : data({ field_id: F, label: "T", archived: true, value_count: 0, created_at: "2026-06-01T00:00:00Z", prompt_id: Q, value: "v" });
    await expect(A.addCustomField(PID, { label: "T" })).resolves.toEqual({ ok: true, value: { id: F } });
    await A.archiveCustomField(PID, F);
    await A.restoreCustomField(PID, F);
    await A.deleteCustomFieldHard(PID, F);
    await A.setPromptCustomFieldValue(PID, Q, F, " v ");
    await expect(A.setPromptCustomFieldValueBulk(PID, [Q], F, "v")).resolves.toEqual({ ok: true, value: { count: 1 } });
    await A.clearPromptCustomFieldValue(PID, Q, F);
    expect(calls.map(key)).toEqual([
      `POST ${P("/prompt-fields")}`,
      `POST ${P(`/prompt-fields/${F}/archive`)}`,
      `POST ${P(`/prompt-fields/${F}/restore`)}`,
      `DELETE ${P(`/prompt-fields/${F}`)}`,
      `PUT ${P(`/prompts/${Q}/fields/${F}`)}`,
      `POST ${P(`/prompt-fields/${F}/bulk-set`)}`,
      `DELETE ${P(`/prompts/${Q}/fields/${F}`)}`,
    ]);
    expect(calls[4].body).toEqual({ value: "v" });
    expect(h.revalidate).toHaveLength(7);
  });

  it("xlsx: export relays the file, import relays the upload and maps the summary", async () => {
    answer = (m) =>
      m === "GET"
        ? new Response(new Uint8Array([9]), { status: 200 })
        : data({ created: 1, updated: 2, skipped: 0, created_tags: 1, warnings: [] });
    const exp = await A.exportPromptsXlsx(PID);
    expect(exp).toMatchObject({ ok: true, value: { base64: "CQ==" } });
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array([1])], "p.xlsx"));
    await expect(A.importPromptsXlsx(PID, fd)).resolves.toEqual({ ok: true, value: { created: 1, updated: 2, skipped: 0, createdTags: 1, warnings: [] } });
    expect(calls.map(key)).toEqual([`GET ${P("/prompts/export")}`, `POST ${P("/prompts/import")}`]);
    expect(h.revalidate).toEqual([TAB]);
  });
});
