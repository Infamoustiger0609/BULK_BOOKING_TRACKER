import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useBookings } from '../lib/BookingsProvider.jsx';
import {
  aggregateMetrics,
  applyGlobalFilters,
  computeDelta,
  computeRevenueByField,
  computeSparklineSeries,
  computeTimeSeriesMetrics,
  getPriorPeriodFilter,
  getSparklineGranularity,
  getTrendGranularity,
} from '../lib/dataUtils.js';
import { formatCurrency, formatCurrencyCompact, formatNumber } from '../lib/format.js';
import { AXIS_TICK_STYLE, verticalBarLabel } from '../lib/chartLabel.jsx';
import KPICard from '../components/KPICard.jsx';
import GradientAreaChart from '../components/GradientAreaChart.jsx';
import ChartTooltip from '../components/ChartTooltip.jsx';
import EmptyState from '../components/EmptyState.jsx';

const TOP_REGION_ROWS = 10;
const TOP_CITY_ROWS = 15;

export default function Summary() {
  // The only filters on this page are the 3 global ones (FY / Month /
  // Region) — no page-local filter row, unlike Leaderboard.
  const { records, globalFilteredRecords, fyFilter, monthFilter, monthOptions, regionFilter, regionOptions } = useBookings();

  const currentMetrics = useMemo(() => aggregateMetrics(globalFilteredRecords), [globalFilteredRecords]);

  // Prior-period comparison: only well-defined for a single-FY (or
  // single-FY + single-month) selection — see getPriorPeriodFilter. Any
  // broader multi-select combination (0, 2+, or "all" FYs; a partial
  // multi-month pick) has no single well-defined "prior", same as "All
  // time" always has — the delta badge just renders nothing then. Same
  // Region filter applied to both sides so it's an apples-to-apples delta.
  const priorMetrics = useMemo(() => {
    const priorFilter = getPriorPeriodFilter({ fyFilter, monthFilter }, { records, monthOptions });
    if (!priorFilter) return null;
    const priorRecords = applyGlobalFilters(records, { ...priorFilter, regionFilter });
    return priorRecords.length ? aggregateMetrics(priorRecords) : null;
  }, [records, fyFilter, monthFilter, monthOptions, regionFilter]);

  const deltas = {
    revenue: computeDelta(currentMetrics.totalRevenue, priorMetrics?.totalRevenue),
    clients: computeDelta(currentMetrics.clientCount, priorMetrics?.clientCount),
    tickets: computeDelta(currentMetrics.totalTickets, priorMetrics?.totalTickets),
    sph: computeDelta(currentMetrics.sph, priorMetrics?.sph),
    atv: computeDelta(currentMetrics.atv, priorMetrics?.atv),
  };

  // Monthly bars once exactly one FY narrows the view; yearly (by Financial
  // Year) for "All time" or any other multi-FY selection that could span
  // several years.
  const granularity = getTrendGranularity({ fyFilter });
  const timeSeries = useMemo(() => computeTimeSeriesMetrics(globalFilteredRecords, granularity), [globalFilteredRecords, granularity]);

  // Each KPI card's own sparkline — one step finer than the big trend
  // charts (drops to weekly once the view is already narrowed to a single
  // month) so the shape still has something to show even at the most
  // zoomed-in selection.
  const sparklineGranularity = getSparklineGranularity({ fyFilter, monthFilter });
  const sparklines = useMemo(
    () => ({
      revenue: computeSparklineSeries(globalFilteredRecords, sparklineGranularity, 'totalRevenue'),
      clients: computeSparklineSeries(globalFilteredRecords, sparklineGranularity, 'clientCount'),
      tickets: computeSparklineSeries(globalFilteredRecords, sparklineGranularity, 'totalTickets'),
      sph: computeSparklineSeries(globalFilteredRecords, sparklineGranularity, 'sph'),
      atv: computeSparklineSeries(globalFilteredRecords, sparklineGranularity, 'atv'),
    }),
    [globalFilteredRecords, sparklineGranularity],
  );

  // Region is only meaningful as a breakdown when it isn't itself the active
  // restriction (a Region selection would otherwise collapse this to one
  // bar) — fall back to City-wise within whatever region(s) are selected.
  const regionRestricted = regionFilter.length !== regionOptions.length;
  const breakdown = useMemo(
    () => computeRevenueByField(globalFilteredRecords, regionRestricted ? 'city' : 'region').slice(0, regionRestricted ? TOP_CITY_ROWS : TOP_REGION_ROWS),
    [globalFilteredRecords, regionRestricted],
  );

  return (
    <div className="flex flex-col gap-3.5">
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
        <KPICard label="Revenue" value={formatCurrency(currentMetrics.totalRevenue)} valueColor="gold" delta={deltas.revenue} sparkline={sparklines.revenue} />
        <KPICard label="Clients" value={formatNumber(currentMetrics.clientCount)} valueColor="jade" delta={deltas.clients} sparkline={sparklines.clients} />
        <KPICard label="Total Tickets" value={formatNumber(currentMetrics.totalTickets)} valueColor="teal" delta={deltas.tickets} sparkline={sparklines.tickets} />
        <KPICard label="SPH" value={formatCurrency(currentMetrics.sph)} valueColor="teal" delta={deltas.sph} subLine="spend per head" sparkline={sparklines.sph} />
        <KPICard label="Avg Ticket Value" value={formatCurrency(currentMetrics.atv)} valueColor="gold" delta={deltas.atv} sparkline={sparklines.atv} />
      </div>

      <GradientAreaChart title="Revenue Trend" data={timeSeries} dataKey="totalRevenue" color="gold" valueFormatter={formatCurrencyCompact} />

      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
        <GradientAreaChart title="SPH Trend" data={timeSeries} dataKey="sph" color="teal" valueFormatter={formatCurrencyCompact} />
        <GradientAreaChart title="ATV Trend" data={timeSeries} dataKey="atv" color="gold" valueFormatter={formatCurrencyCompact} />
      </div>

      <BreakdownChart
        title={regionRestricted ? `City-wise Revenue (within selected region${regionFilter.length > 1 ? 's' : ''})` : 'Region-wise Revenue'}
        data={breakdown}
      />
    </div>
  );
}

// The 4-color system rotating across bars (orange -> blue -> teal -> gold,
// repeating) instead of every bar sharing one color — this is a categorical
// breakdown by region/city, not a single metric, so each bar gets its own
// identity color the same way SegmentedBar's segments do.
const ROTATION = [
  { token: 'gold', var: 'var(--color-gold)' },
  { token: 'teal', var: 'var(--color-teal)' },
  { token: 'jade', var: 'var(--color-jade)' },
  { token: 'highlight', var: 'var(--color-highlight)' },
];

// Region/City breakdown: gradient-filled, rounded-top bars with a hover
// glow — same underlying Bar chart as before, richer per-bar styling.
function BreakdownChart({ title, data }) {
  const [hoverIndex, setHoverIndex] = useState(null);

  return (
    <div className="card">
      <div className="border-b border-ink/10 px-3.5 py-2 text-[11px] font-bold uppercase tracking-widest text-ink-soft">{title}</div>
      <div className="p-4">
        {data.length === 0 ? (
          <EmptyState />
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data} margin={{ top: 24, right: 12, left: 0, bottom: 0 }} onMouseLeave={() => setHoverIndex(null)}>
              <defs>
                {ROTATION.map((c) => (
                  <linearGradient key={c.token} id={`summary-breakdown-${c.token}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={c.var} stopOpacity={1} />
                    <stop offset="100%" stopColor={c.var} stopOpacity={0.6} />
                  </linearGradient>
                ))}
                {ROTATION.map((c) => (
                  <filter key={c.token} id={`summary-breakdown-glow-${c.token}`} x="-60%" y="-60%" width="220%" height="220%">
                    <feDropShadow dx="0" dy="0" stdDeviation="4" floodColor={c.var} floodOpacity="0.6" />
                  </filter>
                ))}
              </defs>
              <CartesianGrid stroke="#1e1e2c" strokeOpacity={0.08} vertical={false} />
              <XAxis dataKey="value" tick={AXIS_TICK_STYLE} axisLine={{ stroke: '#1e1e2c', strokeOpacity: 0.15 }} tickLine={false} />
              <YAxis tick={AXIS_TICK_STYLE} tickFormatter={formatCurrencyCompact} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip valueFormatter={(v) => formatCurrency(v)} />} cursor={{ fill: 'var(--color-ink)', fillOpacity: 0.04 }} />
              <Bar
                dataKey="revenue"
                name="Revenue"
                radius={[3, 3, 0, 0]}
                label={verticalBarLabel(formatCurrencyCompact)}
                onMouseEnter={(_, index) => setHoverIndex(index)}
                onMouseLeave={() => setHoverIndex(null)}
              >
                {data.map((entry, index) => {
                  const c = ROTATION[index % ROTATION.length];
                  return (
                    <Cell
                      key={entry.value}
                      fill={`url(#summary-breakdown-${c.token})`}
                      style={index === hoverIndex ? { filter: `url(#summary-breakdown-glow-${c.token})` } : undefined}
                    />
                  );
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
