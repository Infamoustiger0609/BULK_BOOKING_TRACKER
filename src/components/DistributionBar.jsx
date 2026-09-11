import GradientBar from './GradientBar.jsx';

/**
 * One row of a categorical breakdown: label, a proportional gradient-filled
 * bar, and a count/pct readout. Used for booking-type mix, region/city
 * breakdowns, and single-value affinity rows — anywhere a "% of bookings"
 * distribution is shown as a list. Defaults to teal since these are all
 * booking-count (volume) based, never revenue. For a full multi-value
 * breakdown in one widget, see SegmentedBar instead.
 */
export default function DistributionBar({ label, count, pct, color = 'teal', highlight = false }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="w-28 shrink-0 truncate text-[11px] text-ink" title={label}>
        {label}
      </div>
      <GradientBar pct={pct} color={color} className={`flex-1 ${highlight ? 'ring-1 ring-highlight' : ''}`} />
      <div className="w-20 shrink-0 text-right text-[11px] text-ink-soft">
        {(pct * 100).toFixed(0)}% <span className="text-ink-soft/60">({count})</span>
      </div>
    </div>
  );
}
