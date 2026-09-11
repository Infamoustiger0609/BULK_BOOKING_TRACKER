/**
 * The one tooltip every chart in the dashboard uses (pass as
 * `<Tooltip content={<ChartTooltip valueFormatter={...} />} />`) so hover
 * styling never diverges chart-to-chart. `valueFormatter(value, entry)`
 * defaults to the raw value; `labelFormatter(label)` defaults to the raw label.
 */
export default function ChartTooltip({ active, payload, label, valueFormatter = (v) => v, labelFormatter = (l) => l }) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="rounded-md border border-ink/10 bg-ink px-3 py-2 shadow-lg">
      {label != null && <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-cream/70">{labelFormatter(label)}</div>}
      <div className="flex flex-col gap-0.5">
        {payload.map((entry) => (
          <div key={entry.dataKey || entry.name} className="flex items-center gap-2 text-[11px]">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: entry.color }} />
            <span className="text-cream/70">{entry.name}</span>
            <span className="ml-auto font-semibold text-cream">{valueFormatter(entry.value, entry)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
