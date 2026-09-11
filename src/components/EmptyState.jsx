/** The one "nothing to show" placeholder — used for empty tables, charts, and lists alike. */
export default function EmptyState({ message = 'No data for this selection.', className = '' }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-ink/15 py-10 text-center ${className}`}>
      <div className="text-lg text-ink/30">·  ·  ·</div>
      <div className="text-xs font-medium text-ink-soft">{message}</div>
    </div>
  );
}
