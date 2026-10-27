import type { ReactNode } from "react";
import { Link } from "@/i18n/navigation";

export type SearchValues = Record<string, string | string[] | undefined>;
export type SourceRow = Record<string, unknown>;
export type SourceColumn = { key: string; label: string; render?: (row: SourceRow) => ReactNode };

export function sourceHref(base: string, sp: SearchValues, patch: SearchValues) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...sp, ...patch })) if (value !== undefined && value !== "") {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  return `${base}?${params}`;
}

export function sourceValue(value: unknown, empty = "데이터 없음"): ReactNode {
  if (value === null || value === undefined || value === "") return <span className="text-sm font-normal text-muted-foreground">{empty}</span>;
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : empty;
  if (typeof value === "boolean") return value ? "예" : "아니요";
  if (Array.isArray(value)) return value.length ? value.map(v => String(v)).join(", ") : empty;
  return String(value);
}

export function SourceLink({ value, children }: { value: unknown; children?: ReactNode }) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return <>{children ?? sourceValue(value)}</>;
  return <a href={value} target="_blank" rel="noopener noreferrer" className="break-all text-brand-700 underline underline-offset-2">{children ?? value}</a>;
}

export function SourceNotice({ children }: { children: ReactNode }) {
  return <div role="status" className="rounded-xl border border-dashed bg-muted/20 px-5 py-4 text-sm text-muted-foreground">{children}</div>;
}

export function SourceMetrics({ items }: { items: { label: string; value: unknown; percent?: boolean }[] }) {
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{items.map(item => <div key={item.label} className="min-w-0 rounded-xl border bg-card p-4">
    <p className="text-sm text-muted-foreground">{item.label}</p><p className="mt-2 text-2xl font-semibold tabular-nums">
      {item.percent && typeof item.value === "number" ? `${item.value.toFixed(1)}%` : sourceValue(item.value)}
    </p></div>)}</div>;
}

export function SourceTable({ title, rows, columns, empty = "데이터 없음" }: { title: string; rows: SourceRow[]; columns: SourceColumn[]; empty?: string }) {
  return <section className="min-w-0 overflow-hidden rounded-xl border bg-card">
    <h3 className="border-b px-4 py-3 font-semibold">{title}</h3>
    {rows.length ? <div className="max-h-[480px] overflow-auto overscroll-contain"><table className="w-full text-left text-sm">
      <thead className="sticky top-0 z-10 bg-muted"><tr>{columns.map(c => <th key={c.key} className="whitespace-nowrap px-4 py-3 font-medium">{c.label}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index} className="border-t hover:bg-muted/20">{columns.map(c => <td key={c.key} className="max-w-xl px-4 py-3 align-top tabular-nums [overflow-wrap:anywhere]">{c.render ? c.render(row) : sourceValue(row[c.key], empty)}</td>)}</tr>)}</tbody>
    </table></div> : <p className="p-6 text-sm text-muted-foreground">{empty}</p>}
  </section>;
}

export function SourcePager({ base, sp, total, next, prev }: { base: string; sp: SearchValues; total?: number; next?: string | null; prev?: string | null }) {
  return <div className="flex items-center justify-between gap-3 text-sm">
    <span className="text-muted-foreground">{total === undefined ? "" : `총 ${total.toLocaleString()}건`}</span>
    <div className="flex gap-4">{prev != null && <Link className="underline" href={sourceHref(base, sp, { cursor: prev })}>이전</Link>}
      {next && <Link className="underline" href={sourceHref(base, sp, { cursor: next })}>다음</Link>}</div>
  </div>;
}
