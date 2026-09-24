// A table as a CSV file, the way a spreadsheet opens it.
//
// The rows on the admin screens were typed by other people, a demo
// request by anyone at all, and a spreadsheet runs a cell that starts
// with = + - @ (or a tab or return before one) as a formula: a name
// typed as =HYPERLINK(…) would be a link inside the administrator's own
// sheet. Such a cell is written with a ' in front, which the sheet shows
// as the text it was. Numbers are left alone: -3 is a number.
//
// Callers: src/app/admin/page.tsx, src/app/admin/demos/page.tsx.

type Value = string | number | boolean | null | undefined;
export type Column<T> = [header: string, value: (row: T) => Value];

function cell(v: Value): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(rows: T[], columns: Column<T>[]): string {
  return [columns.map(([header]) => cell(header)), ...rows.map((r) => columns.map(([, value]) => cell(value(r))))]
    .map((line) => line.join(","))
    .join("\r\n");
}

/** Saves it as name-YYYY-MM-DD.csv, marked UTF-8 so a spreadsheet keeps ₹ and names as typed. */
export function downloadCsv<T>(name: string, rows: T[], columns: Column<T>[]) {
  const url = URL.createObjectURL(new Blob(["﻿", toCsv(rows, columns)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}-${new Date().toLocaleDateString("en-CA")}.csv`;
  a.click();
  // After the browser has started the download, not before.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
