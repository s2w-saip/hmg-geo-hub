import { describe, expect, it } from "vitest";
import {
  asciiFallbackFilename,
  attachmentContentDisposition,
  sanitizeFilename,
} from "./content-disposition";

// 2026-09-03 프로덕션 500 재현: 한글 파일명이 헤더 ByteString 범위를 넘었다.
const KOREAN = "구매맥락지도-20260903.xlsx";

describe("attachmentContentDisposition", () => {
  it("헤더 값 전체가 ByteString(0x20–0x7e) 범위다 — 한글 파일명 포함", () => {
    const v = attachmentContentDisposition(KOREAN);
    for (const ch of v) {
      const code = ch.charCodeAt(0);
      expect(code, `char ${JSON.stringify(ch)} in ${v}`).toBeGreaterThanOrEqual(0x20);
      expect(code).toBeLessThanOrEqual(0x7e);
    }
  });

  it("ASCII 폴백 + RFC 5987 filename* 을 함께 싣는다", () => {
    const v = attachmentContentDisposition(KOREAN);
    expect(v).toMatch(/^attachment; filename="[\x20-\x7e]+\.xlsx"; filename\*=UTF-8''/);
    expect(decodeURIComponent(v.split("filename*=UTF-8''")[1]!)).toBe(KOREAN);
  });

  it("ASCII 이름은 그대로, 확장자 없으면 .xlsx 를 붙인다", () => {
    expect(attachmentContentDisposition("context-map")).toBe(
      `attachment; filename="context-map.xlsx"; filename*=UTF-8''context-map.xlsx`,
    );
  });

  it("헤더 주입 문자(따옴표·개행·경로)는 제거된다", () => {
    const v = attachmentContentDisposition('a"b\r\nc/d.xlsx');
    expect(v).not.toMatch(/[\r\n"\\/]{2}/);
    expect(sanitizeFilename('a"b\r\nc/d.xlsx')).toBe("abcd.xlsx");
  });

  it("전부 비 ASCII 면 폴백 이름을 쓴다", () => {
    expect(asciiFallbackFilename("지도.xlsx")).toBe("context-map.xlsx");
    expect(sanitizeFilename(undefined)).toBe("context-map.xlsx");
  });
});
