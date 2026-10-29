// Content-Disposition 헤더 값 생성 — 비 Latin-1 파일명 안전판.
//
// 2026-09-03 프로덕션 실증: `attachment; filename="구매맥락지도-….xlsx"` 를 그대로
// 헤더에 넣자 `new NextResponse()` 가 `Cannot convert argument to a ByteString
// because the character at index 22 has a value of 44396` 로 던져 내보내기가 500.
// HTTP 헤더 값은 ByteString(0–255)이어야 하므로 한글은 그대로 실을 수 없다.
//
// RFC 6266/5987: ASCII 폴백 `filename=` + UTF-8 percent-encoded `filename*=` 를
// 함께 보낸다. 브라우저는 `filename*` 을 우선하므로 다운로드 이름은 한글이 유지된다.
// (클라이언트는 어차피 `a.download` 로 이름을 다시 지정하지만, 직접 내비게이션·
// 다른 소비자를 위해 헤더도 올바르게 둔다.)

/** 경로 구분자·따옴표·개행·제어문자 제거. 빈 값이면 기본 이름. */
export function sanitizeFilename(raw: unknown, fallback = "context-map"): string {
  const base =
    typeof raw === "string"
      ? raw.replace(/[\x00-\x1f\x7f"\\/:*?<>|]/g, "").trim()
      : "";
  const name = base || fallback;
  return name.endsWith(".xlsx") ? name : `${name}.xlsx`;
}

/** 헤더에 그대로 실을 수 있는 ASCII 폴백 — 비 ASCII 는 `_` 로. 확장자는 보존. */
export function asciiFallbackFilename(name: string, fallback = "context-map.xlsx"): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/_{2,}/g, "_").trim();
  const stem = ascii.replace(/\.xlsx$/i, "").replace(/^[_\-\s]+|[_\-\s]+$/g, "");
  return stem ? `${stem}.xlsx` : fallback;
}

/**
 * `attachment; filename="<ascii>"; filename*=UTF-8''<percent-encoded>`.
 * 반환값의 모든 문자는 0x20–0x7e 범위다(ByteString 안전).
 */
export function attachmentContentDisposition(rawName: unknown): string {
  const name = sanitizeFilename(rawName);
  const ascii = asciiFallbackFilename(name);
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
