/**
 * Filled pill, arrow + percentage, colored by direction — never by category.
 * Renders nothing (not a "0%") when a comparison genuinely can't be
 * computed, so `value` should be `null`/`undefined` in that case rather than 0.
 */
export default function DeltaBadge({ value }) {
  if (value == null || Number.isNaN(value)) return null;

  const isUp = value > 0;
  const isFlat = value === 0;
  const pct = `${isUp ? '+' : ''}${(value * 100).toFixed(1)}%`;

  const textClass = isFlat ? 'text-ink-soft' : isUp ? 'text-green' : 'text-coral';
  const arrow = isFlat ? '→' : isUp ? '↑' : '↓';

  return (
    <span className={`inline-flex items-center gap-1 rounded-full bg-ink/5 px-1.5 py-0.5 text-[10px] font-bold ${textClass}`}>
      <span>{arrow}</span>
      <span>{pct}</span>
    </span>
  );
}
