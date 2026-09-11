import { Area, AreaChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AXIS_TICK_STYLE, pointLabel } from '../lib/chartLabel.jsx';
import ChartTooltip from './ChartTooltip.jsx';
import EmptyState from './EmptyState.jsx';

const STROKE = {
  gold: 'var(--color-gold)',
  teal: 'var(--color-teal)',
  jade: 'var(--color-jade)',
  highlight: 'var(--color-highlight)',
  coral: 'var(--color-coral)',
};

/**
 * The one trend-chart shape used everywhere a metric is plotted over time:
 * a smooth curved line over a gradient-filled area (solid-ish at the line,
 * fading to nothing at the baseline), value labels on every point, in the
 * series' assigned color. One shared component so Revenue/SPH/ATV trend
 * (and anything plotted the same way later) never grow one-off variants.
 */
export default function GradientAreaChart({ title, data, dataKey, color = 'gold', valueFormatter = (v) => v, height = 200 }) {
  const stroke = STROKE[color] || STROKE.gold;
  const gradientId = `trend-${color}-${dataKey}`;

  return (
    <div className="card">
      <div className="border-b border-ink/10 px-3.5 py-2 text-[11px] font-bold uppercase tracking-widest text-ink-soft">{title}</div>
      <div className="p-4">
        {data.length === 0 ? (
          <EmptyState />
        ) : (
          <ResponsiveContainer width="100%" height={height}>
            <AreaChart data={data} margin={{ top: 24, right: 12, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={stroke} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#1e1e2c" strokeOpacity={0.08} vertical={false} />
              <XAxis dataKey="label" tick={AXIS_TICK_STYLE} axisLine={{ stroke: '#1e1e2c', strokeOpacity: 0.15 }} tickLine={false} />
              <YAxis tick={AXIS_TICK_STYLE} tickFormatter={valueFormatter} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip valueFormatter={(v) => valueFormatter(v)} />} />
              <Area
                type="monotone"
                dataKey={dataKey}
                name={title}
                stroke={stroke}
                strokeWidth={2}
                strokeLinecap="round"
                fill={`url(#${gradientId})`}
                dot={{ r: 3, fill: 'var(--color-cream)', stroke, strokeWidth: 1.5 }}
                activeDot={{ r: 5, fill: 'var(--color-cream)', stroke, strokeWidth: 2 }}
              >
                <LabelList dataKey={dataKey} content={pointLabel(valueFormatter)} />
              </Area>
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
