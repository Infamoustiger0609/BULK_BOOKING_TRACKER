import { toCsv, downloadCsv } from '../lib/csv.js';

/**
 * One button, used identically on Leaderboard/Dormant/Client Detail:
 * builds a CSV from `rows`/`columns` (see lib/csv.js) and triggers a
 * browser download of `filename` on click. Callers always pass the same
 * real, already-filtered array the table on screen is rendering — never a
 * separate re-fetch — so the export can't drift from what's visible.
 */
export default function ExportCsvButton({ rows, columns, filename, label = 'Export CSV' }) {
  return (
    <button
      type="button"
      onClick={() => downloadCsv(filename, toCsv(rows, columns))}
      disabled={rows.length === 0}
      className="interactive rounded-[5px] border border-ink/15 bg-white px-[9px] py-[5px] text-[10px] font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
}
