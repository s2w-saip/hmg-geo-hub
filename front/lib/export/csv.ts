// Dependency-free CSV export for the browser. Used by the prompt + answer
// analysis "내보내기" buttons so operators can pull the data into Excel/Sheets.
//
// - Prepends a UTF-8 BOM (﻿) so Excel opens Hangul without mojibake.
// - CRLF row endings (Excel-friendly).
// - Values are escaped per RFC 4180: quote when they contain a comma, quote,
//   or newline; embedded quotes are doubled.
//
// Browser-only (Blob / document / URL). Import from a "use client" component
// and call inside an event handler.

export type CsvCell = string | number | null | undefined;

function escapeCell(value: CsvCell): string {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: CsvCell[][]): string {
  const lines = [headers, ...rows].map((r) => r.map(escapeCell).join(","));
  return "﻿" + lines.join("\r\n");
}

export function downloadCsv(
  filename: string,
  headers: string[],
  rows: CsvCell[][],
): void {
  const blob = new Blob([toCsv(headers, rows)], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// YYYYMMDD stamp for filenames. Called inside a click handler (browser), so a
// fresh Date is safe here.
export function dateStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
