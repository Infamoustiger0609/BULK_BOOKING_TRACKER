// Fixed order, never randomized — the full 4-color system rotates across
// segments (orange -> blue -> teal -> gold) so a categorical breakdown reads
// as deliberately varied rather than one color repeated at fading
// opacities. A 5th+ value folds into "Other" rather than generating a new
// hue or wrapping back to orange.
const SEGMENT_COLORS = ['var(--color-gold)', 'var(--color-teal)', 'var(--color-jade)', 'var(--color-highlight)'];
const MAX_SEGMENTS = SEGMENT_COLORS.length;

/**
 * A full categorical split (e.g. every movie industry a client has booked,
 * not just their top one) as one stacked horizontal bar plus a legend —
 * used wherever a "% breakdown" needs to read as a single shape rather than
 * a list of individual DistributionBar rows. `items` is already-sorted
 * output from computeDistribution: [{ value, count, pct }, ...].
 */
export default function SegmentedBar({ items }) {
  if (!items || items.length === 0) return null;

  const top = items.slice(0, MAX_SEGMENTS - 1);
  const rest = items.slice(MAX_SEGMENTS - 1);
  const restPct = rest.reduce((sum, i) => sum + i.pct, 0);
  const restCount = rest.reduce((sum, i) => sum + i.count, 0);
  const segments = restPct > 0 ? [...top, { value: 'Other', pct: restPct, count: restCount }] : top;

  return (
    <div>
      <div className="flex h-3 w-full gap-[2px]">
        {segments.map((s, i) => (
          <div
            key={s.value}
            className="h-full rounded-full"
            style={{ width: `${Math.max(s.pct * 100, 1.5)}%`, background: SEGMENT_COLORS[i] }}
            title={`${s.value} — ${(s.pct * 100).toFixed(0)}%`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {segments.map((s, i) => (
          <div key={s.value} className="flex items-center gap-1.5 text-[10px]">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SEGMENT_COLORS[i] }} />
            <span className="font-medium text-ink">{s.value}</span>
            <span className="text-ink-soft">
              {(s.pct * 100).toFixed(0)}% · {s.count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
