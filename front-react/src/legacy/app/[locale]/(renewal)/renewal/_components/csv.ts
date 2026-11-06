// CSV download for the renewal cards' ⋯ menu: the numbers the card shows, in its order.
// UTF-8 with a BOM so spreadsheet apps read Korean; quotes doubled; one row per line.

export type CsvCell = string | number | null | undefined;

export function toCsv(rows: ReadonlyArray<ReadonlyArray<CsvCell>>): string {
  const cell = (v: CsvCell) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

export function downloadCsv(fileName: string, rows: ReadonlyArray<ReadonlyArray<CsvCell>>): void {
  const blob = new Blob(["﻿" + toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName.endsWith(".csv") ? fileName : `${fileName}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
