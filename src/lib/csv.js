// Pure CSV helpers — no business logic, ported near-verbatim from the
// design-reference bundle's bookings-data.js (explicitly approved for reuse:
// it's just column-mapping + a Blob download, not a data-correctness
// concern). Callers always pass real, already-filtered app data — never the
// design reference's synthetic dataset.

/**
 * `columns`: [{ label, value }], where `value` is either a field name to
 * read straight off each row, or a function `(row) => cellValue` for
 * anything computed/formatted. Quotes a cell only when it actually contains
 * a comma, quote, or newline, escaping embedded quotes by doubling them.
 */
export function toCsv(rows, columns) {
  const header = columns.map((c) => c.label).join(',');
  const lines = rows.map((row) =>
    columns
      .map((c) => {
        const v = typeof c.value === 'function' ? c.value(row) : row[c.value];
        const s = v == null ? '' : String(v);
        return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(','),
  );
  return [header, ...lines].join('\n');
}

/** Triggers a browser file-save for `csv` text via a throwaway Blob URL + anchor click. */
export function downloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
