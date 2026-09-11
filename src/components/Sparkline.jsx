import { Area, AreaChart, ResponsiveContainer } from 'recharts';

const STROKE = {
  gold: 'var(--color-gold)',
  teal: 'var(--color-teal)',
  jade: 'var(--color-jade)',
  highlight: 'var(--color-highlight)',
  coral: 'var(--color-coral)',
  ink: 'var(--color-ink-soft)',
};

/**
 * The trend shape at the bottom of a KPI card — no axes, no grid, no
 * tooltip, just the line + a soft gradient wash under it, in the same color
 * as the card's value. One shared component so every KPI card's sparkline
 * looks identical rather than each view rolling its own mini-chart.
 */
export default function Sparkline({ data, color = 'teal', height = 28 }) {
  const stroke = STROKE[color] || STROKE.teal;
  const points = (data || []).filter((v) => v != null);

  // Fewer than 2 points can't draw a line — a flat dash reads as "no trend
  // shape yet" without leaving a blank gap where the sparkline should be.
  if (points.length < 2) {
    return (
      <div style={{ height }} className="flex items-center">
        <div className="h-px w-full bg-ink/10" />
      </div>
    );
  }

  const chartData = points.map((value, i) => ({ i, value }));
  const gradientId = `sparkline-${color}`;

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 2, right: 1, bottom: 0, left: 1 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="value"
            stroke={stroke}
            strokeWidth={1.5}
            strokeLinecap="round"
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
