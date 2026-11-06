// Multi-value encoding for dimension-filter URL params. The separator is NOT a
// comma: some catalog option values contain commas (e.g. depth2 "EV,Hybrid Brand
// Awareness", depth3 "EV, Hybrid Awareness"), which a comma split would shred.
// "~" appears in no option value, so values round-trip intact. The client panel
// (write side) and the server param reader (read side) MUST use these together —
// neutral module (no "use client"/"server-only") so both can import it.
export const FILTER_SEP = "~";

export function joinFilterValues(values: string[]): string {
  return values.join(FILTER_SEP);
}

// Accepts the panel's `searchParams.get()` (string | null) or Next's server
// searchParams value (string | string[]). "all" / empty are dropped sentinels.
export function splitFilterValues(
  raw: string | string[] | undefined | null,
): string[] {
  const s =
    typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join(FILTER_SEP) : "";
  return s
    .split(FILTER_SEP)
    .map((v) => v.trim())
    .filter((v) => v && v !== "all");
}

// ─── time(기간) axis — "YYYY-MM-DD..YYYY-MM-DD" 단일 값 인코딩 ───────────────
// 한쪽이 비면 open-ended ("2026-06-01.." = 그날부터 지금까지). 클라이언트 패널
// (write)과 서버 파서 readStandardFilters(read)가 같은 함수를 써야 한다.
const TIME_RANGE_SEP = "..";
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface TimeRangeValue {
  from?: string; // YYYY-MM-DD inclusive
  to?: string; // YYYY-MM-DD inclusive
}

export function encodeTimeRange(range: TimeRangeValue): string | null {
  const from = range.from && ISO_DAY.test(range.from) ? range.from : "";
  const to = range.to && ISO_DAY.test(range.to) ? range.to : "";
  if (!from && !to) return null;
  return `${from}${TIME_RANGE_SEP}${to}`;
}

// Invalid / malformed input → null (축 미적용). from > to 는 뒤집어 복원한다.
export function parseTimeRange(
  raw: string | string[] | undefined | null,
): TimeRangeValue | null {
  const s = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";
  if (!s || !s.includes(TIME_RANGE_SEP)) return null;
  const [rawFrom, rawTo] = s.split(TIME_RANGE_SEP, 2);
  let from = ISO_DAY.test(rawFrom) ? rawFrom : undefined;
  let to = ISO_DAY.test(rawTo) ? rawTo : undefined;
  if (!from && !to) return null;
  if (from && to && from > to) [from, to] = [to, from];
  return { from, to };
}
