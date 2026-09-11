const FILL = {
  gold: 'var(--color-gold)',
  teal: 'var(--color-teal)',
  jade: 'var(--color-jade)',
  highlight: 'var(--color-highlight)',
  coral: 'var(--color-coral)',
};

/**
 * The bare filled bar underneath DistributionBar (and used directly wherever
 * a compact proportional bar is needed on its own, e.g. next to a revenue
 * figure) — one rounded track, a gradient-filled fill sized to `pct`
 * (0-1), never a flat single-color block.
 */
export default function GradientBar({ pct, color = 'teal', className = '', trackClassName = 'bg-ink/8' }) {
  const fill = FILL[color] || FILL.teal;
  return (
    <div className={`h-2 overflow-hidden rounded-full ${trackClassName} ${className}`}>
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.max(Math.min(pct, 1) * 100, pct > 0 ? 2 : 0)}%`,
          background: `linear-gradient(180deg, color-mix(in srgb, ${fill} 85%, white) 0%, ${fill} 60%, color-mix(in srgb, ${fill} 80%, black) 100%)`,
        }}
      />
    </div>
  );
}
