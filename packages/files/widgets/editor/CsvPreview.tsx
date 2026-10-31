// Table preview for CSV/TSV: sticky header and row numbers, numbers right-
// aligned, a column sort and a row filter. Read-only; editing stays in the
// text editor so a save writes exactly the bytes the person typed.
import { useDeferredValue, useMemo, useState } from "react";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import { TextInput } from "../../../../apps/web/src/components/ui/index.ts";
import { compareCells, numericColumns, parseCsv } from "./csv.ts";

/** Rendered rows; the filter and sort still see every parsed row. */
const VISIBLE_ROWS = 1_000;

export default function CsvPreview({ text, path }: { text: string; path: string }) {
  const table = useMemo(() => parseCsv(text, path), [text, path]);
  const numeric = useMemo(() => numericColumns(table), [table]);
  const [sort, setSort] = useState<{ column: number; direction: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState("");
  const needle = useDeferredValue(filter.trim().toLowerCase());
  const rows = useMemo(() => {
    const indexed = table.rows.map((cells, index) => ({ cells, row: index + 1 }));
    const kept = needle ? indexed.filter((entry) => entry.cells.some((cell) => cell.toLowerCase().includes(needle))) : indexed;
    if (!sort) return kept;
    const isNumeric = numeric[sort.column] === true;
    return [...kept].sort((left, right) =>
      compareCells(left.cells[sort.column] ?? "", right.cells[sort.column] ?? "", isNumeric) * sort.direction || left.row - right.row);
  }, [table, needle, sort, numeric]);
  const columns = Array.from({ length: table.columns }, (_, index) => index);
  const toggleSort = (column: number) => setSort((current) => current?.column !== column
    ? { column, direction: 1 }
    : current.direction === 1 ? { column, direction: -1 } : null);

  return (
    <div className="editor-body editor-csv-preview">
      <div className="editor-csv-bar">
        <TextInput
          uiSize="sm"
          type="search"
          value={filter}
          placeholder={tr("editor.filepane.csvFilter")}
          aria-label={tr("editor.filepane.csvFilter")}
          onChange={(event) => setFilter(event.target.value)}
        />
        <span className="editor-csv-summary" aria-live="polite">
          {needle
            ? tr("editor.filepane.csvMatches", { count: rows.length, total: table.rows.length })
            : tr("editor.filepane.csvSize", { rows: table.rows.length, columns: table.columns })}
          {table.truncated ? ` · ${tr("editor.filepane.csvTruncated")}` : ""}
        </span>
      </div>
      <div className="editor-csv-scroll">
        <table className="editor-csv-table">
          <thead>
            <tr>
              <th className="editor-csv-ln" scope="col" aria-label={tr("editor.filepane.csvRow")}>#</th>
              {columns.map((column) => {
                const active = sort?.column === column;
                return (
                  <th
                    key={column}
                    scope="col"
                    className={numeric[column] ? "numeric" : undefined}
                    aria-sort={active ? (sort.direction === 1 ? "ascending" : "descending") : "none"}
                  >
                    <button type="button" className="editor-csv-sort" onClick={() => toggleSort(column)} title={tr("editor.filepane.csvSort")}>
                      <span dir="auto">{table.header[column] ?? ""}</span>
                      <span className="editor-csv-sort-mark" aria-hidden>{active ? (sort.direction === 1 ? "▲" : "▼") : ""}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, VISIBLE_ROWS).map((row) => (
              <tr key={row.row}>
                <td className="editor-csv-ln">{row.row}</td>
                {columns.map((column) => (
                  <td key={column} className={numeric[column] ? "numeric" : undefined} dir="auto">{row.cells[column] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > VISIBLE_ROWS && (
          <div className="editor-csv-more">{tr("editor.filepane.csvMoreRows", { count: rows.length - VISIBLE_ROWS })}</div>
        )}
      </div>
    </div>
  );
}
