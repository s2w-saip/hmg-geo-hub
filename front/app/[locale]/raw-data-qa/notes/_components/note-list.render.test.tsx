import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";

// 노트 모아보기.
// B052 해결 토글: 실패(HTTP 오류·네트워크·15초 타임아웃)는 null → 기존 저장 실패 문구, 성공은 서버의
//   resolvedAt·resolvedBy 로 그 행만 갱신(클라이언트 시각으로 덮지 않는다). 경로·본문은 그대로.
// B053 내보내기: 링크 다운로드 대신 응답 확인 뒤 저장 — 401·5xx 오류 본문이 CSV 로 저장되지 않고 기존 내보내기 실패 문구.
//   성공이면 서버 바이트·파일명 그대로(qa.parity.test.ts 'export: …' 가 라우트 쪽 바이트를 덮는다).

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { NoteList, NoteListFailure, applyResolved, downloadNotesCsv, patchNoteResolved } = await import("./note-list");
type Row = Parameters<typeof applyResolved>[0][number];

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  jobId: "11111111-1111-4111-8111-111111111111",
  targetKind: "citation",
  targetLabel: "example.org",
  severity: "issue",
  body: `본문 ${id}`,
  reviewerName: "갑",
  createdAt: "2026-10-01T01:02:03.000Z",
  resolvedAt: null,
  resolvedBy: null,
  promptText: "프롬프트",
  surface: "standard",
  ...over,
});

function wrap(node: ReactNode, locale: "ko" | "en" = "ko") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("patchNoteResolved — 요청은 그대로, 갱신 값은 서버 응답", () => {
  const SERVER_AT = "2020-01-02T03:04:05.000Z"; // 지금과 먼 서버 시각 — 클라이언트 시각을 쓰면 다르다

  it("해결: 같은 경로·본문으로 보내고 서버의 resolvedAt·resolvedBy 를 돌려준다", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ note: { id: "n1", resolvedAt: SERVER_AT, resolvedBy: "을" } }),
    );
    await expect(patchNoteResolved("n1", true, fetcher)).resolves.toEqual({ resolvedAt: SERVER_AT, resolvedBy: "을" });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/qa/note");
    expect(init).toMatchObject({ method: "PATCH", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(String(init?.body))).toEqual({ id: "n1", resolved: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("해결 취소: 서버가 비운 값(null)을 그대로", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ note: { id: "n1", resolvedAt: null, resolvedBy: null } }),
    );
    await expect(patchNoteResolved("n1", false, fetcher)).resolves.toEqual({ resolvedAt: null, resolvedBy: null });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ id: "n1", resolved: false });
  });

  it.each([400, 401, 403, 404, 500])("HTTP %i → null(자동 재시도 없음)", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "x" }, { status }));
    await expect(patchNoteResolved("n1", true, fetcher)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("네트워크 오류 → 미처리 거부 없이 null", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));
    await expect(patchNoteResolved("n1", true, fetcher)).resolves.toBeNull();
  });

  it("15초 타임아웃 → 요청을 끊고 null", async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("Timeout", "AbortError")));
    }));
    const pending = patchNoteResolved("n1", true, fetcher);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  it("성공 응답에 노트가 없으면 null", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    await expect(patchNoteResolved("n1", true, fetcher)).resolves.toBeNull();
  });

  it("applyResolved: 그 행만, 서버 값으로", () => {
    const rows = [row("a"), row("b"), row("c", { resolvedAt: "2026-10-02T00:00:00.000Z", resolvedBy: "병" })];
    const next = applyResolved(rows, "b", { resolvedAt: SERVER_AT, resolvedBy: "을" });
    expect(next[1]).toEqual({ ...rows[1], resolvedAt: SERVER_AT, resolvedBy: "을" });
    expect(next[0]).toBe(rows[0]);
    expect(next[2]).toBe(rows[2]);
    expect(applyResolved(next, "c", { resolvedAt: null, resolvedBy: null })[2]).toMatchObject({ resolvedAt: null, resolvedBy: null });
  });
});

describe("downloadNotesCsv — 성공일 때만 저장, 바이트·파일명은 서버 그대로", () => {
  const CSV = "﻿created_at,reviewer\r\n2026-10-01T01:02:03.000Z,갑\r\n";
  const bytes = (b: Blob) => b.arrayBuffer().then((x) => Array.from(new Uint8Array(x)));

  it("200: 응답 바이트(BOM·CRLF)와 Content-Disposition 파일명으로 저장", async () => {
    const res = new Response(CSV, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="qa-notes-2026-10-14.csv"' },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(res);
    const save = vi.fn<(blob: Blob, filename: string) => void>();
    await expect(downloadNotesCsv("/api/qa/notes/export?severity=issue", fetcher, save)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith("/api/qa/notes/export?severity=issue");
    expect(save).toHaveBeenCalledTimes(1);
    const [blob, filename] = save.mock.calls[0];
    expect(filename).toBe("qa-notes-2026-10-14.csv");
    expect(await bytes(blob)).toEqual(Array.from(new TextEncoder().encode(CSV)));
  });

  it("filename* 를 우선하고, 헤더가 없으면 종전 이름 꼴(qa-notes-날짜.csv)", async () => {
    const save = vi.fn<(blob: Blob, filename: string) => void>();
    const star = new Response(CSV, { headers: { "Content-Disposition": "attachment; filename=\"x.csv\"; filename*=UTF-8''qa-notes-2026-10-13.csv" } });
    await downloadNotesCsv("/api/qa/notes/export", vi.fn<typeof fetch>().mockResolvedValue(star), save);
    expect(save.mock.calls[0][1]).toBe("qa-notes-2026-10-13.csv");
    await downloadNotesCsv("/api/qa/notes/export", vi.fn<typeof fetch>().mockResolvedValue(new Response(CSV)), save);
    expect(save.mock.calls[1][1]).toMatch(/^qa-notes-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it.each([401, 403, 500, 502])("HTTP %i: 오류 본문을 파일로 저장하지 않고 false", async (status) => {
    const save = vi.fn<(blob: Blob, filename: string) => void>();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "unauthorized" }, { status }));
    await expect(downloadNotesCsv("/api/qa/notes/export", fetcher, save)).resolves.toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("네트워크 오류 → 저장 없이 false", async () => {
    const save = vi.fn<(blob: Blob, filename: string) => void>();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));
    await expect(downloadNotesCsv("/api/qa/notes/export", fetcher, save)).resolves.toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("NoteList 마크업", () => {
  const filter = { severity: ["issue" as const] };

  it("내보내기는 같은 필터의 링크 다운로드가 아니라 버튼이고, 처음에는 실패 고지가 없다", () => {
    const html = wrap(<NoteList rows={[row("a"), row("b", { resolvedAt: "2026-10-02T00:00:00.000Z", resolvedBy: "을" })]}
      nextCursor={null} locale="ko" filter={filter} />);
    expect(html).not.toContain("/api/qa/notes/export");
    expect(html).not.toMatch(/\sdownload(=|\s|>)/);
    expect(html).toContain(ko.qaReview.notes.exportCsv);
    expect(html).not.toContain('role="alert"');
    expect(html).toContain(ko.qaReview.notes.resolve);
    expect(html).toContain(ko.qaReview.notes.unresolve);
    expect(html).toContain("본문 a");
  });

  it("빈 목록 문구는 그대로", () => {
    expect(wrap(<NoteList rows={[]} nextCursor={null} locale="ko" filter={{}} />)).toContain(ko.qaReview.notes.empty);
  });

  it("실패 고지: 토글은 기존 저장 실패 문구, 내보내기는 기존 내보내기 실패 문구(ko·en)", () => {
    const save = wrap(<NoteListFailure kind="save" />);
    expect(save).toContain('role="alert"');
    expect(save).toContain(ko.qaReview.detail.saveFailed);
    expect(wrap(<NoteListFailure kind="export" />)).toContain(ko.adminStandardPrompts.list.exportFailed);
    expect(wrap(<NoteListFailure kind="save" />, "en")).toContain(en.qaReview.detail.saveFailed);
    expect(wrap(<NoteListFailure kind="export" />, "en")).toContain(en.adminStandardPrompts.list.exportFailed);
  });
});
