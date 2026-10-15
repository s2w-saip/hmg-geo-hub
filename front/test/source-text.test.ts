import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { readSourceText } from "./source-text";

describe("readSourceText", () => {
  const dir = mkdtempSync(join(tmpdir(), "source-text-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name: string, text: string) => {
    const file = join(dir, name);
    writeFileSync(file, text, "utf8");
    return file;
  };

  it("CRLF 를 LF 로 되돌린다 — LF 체크아웃에서 읽은 것과 같다", () => {
    const lf = "-- 0065\nSET LOCAL lock_timeout = '3s';\n\n  selectableDates,\n";
    expect(readSourceText(put("crlf.sql", lf.replace(/\n/g, "\r\n")))).toBe(lf);
  });

  it("LF 파일은 그대로다", () => {
    const lf = "import { a } from \"b\";\n// 한글 주석 — 대시\n";
    expect(readSourceText(put("lf.ts", lf))).toBe(lf);
  });

  it("홀로 선 \\r 은 건드리지 않는다", () => {
    expect(readSourceText(put("cr.txt", "a\rb\r\nc"))).toBe("a\rb\nc");
  });

  it("file URL 도 받는다 (new URL(..., import.meta.url) 호출부)", () => {
    expect(readSourceText(pathToFileURL(put("url.tsv", "x\r\ny\r\n")))).toBe("x\ny\n");
  });
});
