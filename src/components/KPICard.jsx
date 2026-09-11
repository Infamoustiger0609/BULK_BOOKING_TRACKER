import DeltaBadge from './DeltaBadge.jsx';
import Sparkline from './Sparkline.jsx';

const VALUE_COLOR = {
  gold: 'text-gold',
  teal: 'text-teal',
  jade: 'text-jade',
  highlight: 'text-highlight',
  ink: 'text-ink',
  coral: 'text-coral',
};

/**
 * label -> big serif number -> optional delta badge(s) -> optional sub-line,
 * with an optional top-right "breakdown" corner stat for KPIs that have a
 * natural 2-way split (e.g. New vs Existing). This is the one KPI shape used
 * everywhere in the dashboard — don't build a one-off card look elsewhere.
 */
export default function KPICard({ label, value, valueColor = 'ink', delta, subLine, breakdown, sparkline, size = 'default', className = '' }) {
  const valueSizeClass = size === 'compact' ? 'text-[22px] leading-[1.1]' : 'text-[24px] leading-none';
  return (
    <div className={`card relative px-3.5 py-3 ${className}`}>
      {breakdown && (
        <div className="absolute right-3 top-3 text-right">
          <div className="text-[9px] font-bold uppercase tracking-[0.08em] text-ink-soft">{breakdown.label}</div>
          <div className="font-sans text-xs font-semibold text-ink">{breakdown.value}</div>
        </div>
      )}
      <div className="text-[9px] font-bold uppercase tracking-[0.08em] text-ink-soft">{label}</div>
      <div className={`mt-1 font-serif font-bold tracking-[-0.01em] ${valueSizeClass} ${VALUE_COLOR[valueColor] || VALUE_COLOR.ink}`}>
        {value}
      </div>
      {delta != null && (
        <div className="mt-1.5">
          <DeltaBadge value={delta} />
        </div>
      )}
      {subLine && <div className="mt-1 text-[11px] text-ink-soft">{subLine}</div>}
      {sparkline && (
        <div className="mt-2">
          <Sparkline data={sparkline} color={valueColor} />
        </div>
      )}
    </div>
  );
}
