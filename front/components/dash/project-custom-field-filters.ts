// Server-safe half of the project custom-field filter: the URL param scheme
// and its parser. Kept OUT of project-custom-field-filter-bar.tsx because that
// file is "use client" — importing a function from a client module into a
// server component throws "Attempted to call ... from the server" at runtime
// (this crashed the /projects/[id]/analysis/{mention,citation} pages).
import { splitFilterValues } from "@/components/dash/filter-encoding";

export const customFieldParamName = (fieldId: string) => `cf_${fieldId}`;

// Parses `cf_<fieldId>=<값들>` search params into the shape scope-aggregates
// consumes. 2026-07-31: 커스텀 태그 필터가 메인 필터 패널의 다중 선택 축으로
// 흡수되면서 값이 FILTER_SEP 로 join 된 다중값(cf_<id>=a~b)이 될 수 있어
// splitFilterValues 로 파싱한다 — 단일값(a)도 그대로 [a] 로 수렴.
export function readProjectCustomFieldFilters(
  sp: Record<string, string | string[] | undefined>,
  fields: { id: string }[],
): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {};
  for (const f of fields) {
    const values = splitFilterValues(sp[customFieldParamName(f.id)]);
    if (values.length) out[f.id] = values;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// 필드 목록 없이 `cf_<uuid>` 파라미터를 그대로 읽는 버전 — 클라이언트가 현재
// URL을 그대로 전달하는 lazy 드릴다운 라우트용(정의 목록을 다시 조회하지 않는다).
// fieldId 는 uuid 형태만 통과시켜 임의 키가 SQL 파라미터로 새지 않게 한다
// (술어는 ::uuid 캐스팅이라 형식 위반은 어차피 실패하지만, 라우트에서 먼저 거른다).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function readProjectCustomFieldFiltersRaw(
  sp: Record<string, string | string[] | undefined>,
): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(sp)) {
    if (!key.startsWith("cf_")) continue;
    const fieldId = key.slice(3);
    if (!UUID_RE.test(fieldId)) continue;
    const values = splitFilterValues(raw);
    if (values.length) out[fieldId] = values;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
