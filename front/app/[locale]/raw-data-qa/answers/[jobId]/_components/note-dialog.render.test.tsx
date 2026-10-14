import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";

// 노트 작성(B051): 실패(5xx·네트워크·15초 타임아웃)는 던지지 않고 null → 다이얼로그가 입력을 유지한 채
// 판정 저장 실패와 같은 문구(qaReview.detail.saveFailed)를 보인다. 성공은 종전대로 노트를 넘긴다.
// 요청 경로·본문은 그대로다(qa.parity.test.ts 'note: create …' 가 라우트 쪽을 덮는다).

// Radix 포털은 서버 렌더에서 아무것도 그리지 않는다 — 내용만 펼쳐 마크업을 본다.
vi.mock("@/components/ui/dialog", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? <div>{children}</div> : null),
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
  };
});

const { createNote, NoteDialog, NoteSaveFailed } = await import("./note-dialog");

const jobId = "11111111-1111-4111-8111-111111111111";
const target = { kind: "citation" as const, key: `${jobId}:6`, label: "example.org" };
const note = {
  id: "n1",
  targetKind: "citation",
  targetKey: `${jobId}:6`,
  targetLabel: "example.org",
  severity: "question",
  body: "분류?",
  reviewerName: "갑",
  createdAt: "2026-10-14T01:02:03.000Z",
  resolvedAt: null,
};
const draft = { jobId, target, severity: "question" as const, body: "  분류? " };

function wrap(node: ReactNode, locale: "ko" | "en" = "ko") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createNote — 요청은 그대로, 실패는 null", () => {
  it("성공: 같은 경로·본문(trim)으로 보내고 응답의 노트를 돌려준다", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ note }));
    await expect(createNote(draft, fetcher)).resolves.toEqual(note);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/qa/note");
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(String(init?.body))).toEqual({
      jobId,
      targetKind: "citation",
      targetKey: `${jobId}:6`,
      targetLabel: "example.org",
      severity: "question",
      body: "분류?",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 401, 404, 500, 502])("HTTP %i → null(자동 재시도 없음)", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "x" }, { status }));
    await expect(createNote(draft, fetcher)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("게이트웨이 HTML 5xx → null", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(createNote(draft, fetcher)).resolves.toBeNull();
  });

  it("네트워크 오류 → 미처리 거부 없이 null", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));
    await expect(createNote(draft, fetcher)).resolves.toBeNull();
  });

  it("15초 타임아웃 → 요청을 끊고 null", async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("Timeout", "AbortError")));
    }));
    const pending = createNote(draft, fetcher);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("성공 응답에 노트가 없으면 null", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    await expect(createNote(draft, fetcher)).resolves.toBeNull();
  });
});

describe("NoteDialog 마크업", () => {
  it("열리기 전에는 아무것도 그리지 않는다", () => {
    expect(wrap(<NoteDialog jobId={jobId} target={null} onClose={() => {}} onCreated={() => {}} />)).toBe("");
  });

  it("열린 직후에는 실패 고지가 없고 종전 요소(심각도·입력·취소·저장)가 그대로다", () => {
    const html = wrap(<NoteDialog jobId={jobId} target={target} onClose={() => {}} onCreated={() => {}} />);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain(ko.qaReview.detail.saveFailed);
    expect(html).toContain(ko.qaReview.notes.dialogTitle);
    expect(html).toContain(ko.qaReview.notes.placeholder);
    expect(html).toContain(ko.qaReview.common.cancel);
    expect(html).toContain(ko.qaReview.common.save);
    expect(html).toContain("example.org");
  });

  it("실패 고지는 기존 저장 실패 문구(ko·en)를 alert 로 보인다", () => {
    const k = wrap(<NoteSaveFailed />);
    expect(k).toContain('role="alert"');
    expect(k).toContain(ko.qaReview.detail.saveFailed);
    expect(wrap(<NoteSaveFailed />, "en")).toContain(en.qaReview.detail.saveFailed);
  });
});
