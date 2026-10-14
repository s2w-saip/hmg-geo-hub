import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";

// 벌크 적용(카탈로그 엑셀 가져오기)의 청크 순차 적용 — 액션이 던져도 "적용 중" 에 멈추지 않는다(B079).
// 서버 액션 모듈은 DB·Scope 를 물고 있어 렌더 실측에 필요한 함수만 대역으로 둔다.
vi.mock("../../_actions", () => ({
  exportStandardCatalogXlsx: vi.fn(),
  previewStandardCatalogImport: vi.fn(),
  applyStandardCatalogChunk: vi.fn(),
}));

const { CatalogIo, applyInChunks } = await import("./catalog-io");

const item = (n: number) => ({ id: `id-${n}`, labels: {} });
const ok = (applied: number, failed: { id: string; error: string }[] = []) => ({ ok: true as const, value: { applied, failed } });
const no = (error: string) => ({ ok: false as const, error });
const items = Array.from({ length: 60 }, (_, i) => item(i)); // CHUNK 25 → 25 + 25 + 10

function render(locale: "ko" | "en") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">
      <CatalogIo />
    </NextIntlClientProvider>,
  );
}

describe("CatalogIo — 렌더", () => {
  it("내보내기·가져오기 버튼이 사전 문구로 렌더된다(대화상자는 닫힌 채)", () => {
    expect(render("ko")).toContain(ko.adminStandardPrompts.io.export);
    expect(render("ko")).toContain(ko.adminStandardPrompts.io.import);
    expect(render("en")).toContain(en.adminStandardPrompts.io.import);
    expect(render("ko")).not.toContain(ko.adminStandardPrompts.io.previewTitle);
  });
});

describe("applyInChunks — 청크 순차 적용", () => {
  it("적용 수는 청크 합, 실패 행은 id 를 유지한다(진행률은 청크 시작마다)", async () => {
    const progress: number[] = [];
    const out = await applyInChunks(items, "b", async (chunk) => ok(chunk.length - 1, [{ id: chunk[0].id, error: "삭제된 행은 편집할 수 없습니다" }]),
      (done) => progress.push(done));
    expect(progress).toEqual([0, 25, 50]);
    expect(out.applied).toBe(57);
    expect(out.failed.map((f) => f.id)).toEqual(["id-0", "id-25", "id-50"]);
  });

  it("거부된 청크(ok:false)는 남은 항목 전부를 그 문구로 실패 처리하고 멈춘다(종전 그대로)", async () => {
    let n = 0;
    const out = await applyInChunks(items, "b", async () => (++n === 2 ? no("권한이 없습니다") : ok(25)), () => undefined);
    expect(n).toBe(2);
    expect(out.applied).toBe(25);
    expect(out.failed).toHaveLength(35);
    expect(out.failed[0]).toEqual({ id: "id-25", error: "권한이 없습니다" });
  });

  it("액션이 던지면(세션 만료·전송 실패) 같은 실패 표시로 끝난다 — 결과를 돌려주므로 '적용 중' 에 멈추지 않는다", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const thrown of [new Error("UnauthorizedError"), new TypeError("Failed to fetch")]) {
        let n = 0;
        const progress: number[] = [];
        const out = await applyInChunks(items, "b", async () => {
          if (++n === 2) throw thrown;
          return ok(25);
        }, (done) => progress.push(done));
        expect(progress).toEqual([0, 25]);
        expect(out).toEqual({ applied: 25, failed: items.slice(25).map((it) => ({ id: it.id, error: "적용에 실패했습니다" })) });
      }
      // 첫 청크부터 던져도 전부 실패 행으로 남는다(실패분 재시도 대상).
      const out = await applyInChunks(items.slice(0, 3), "b", async () => { throw new Error("boom"); }, () => undefined);
      expect(out.failed.map((f) => f.id)).toEqual(["id-0", "id-1", "id-2"]);
    } finally {
      err.mockRestore();
    }
  });
});
