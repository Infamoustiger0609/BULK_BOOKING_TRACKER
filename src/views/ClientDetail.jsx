import { useMemo } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useBookings } from '../lib/BookingsProvider.jsx';
import { computeDistribution, computeMonthlyTrend, computeTimeSeriesMetrics } from '../lib/dataUtils.js';
import { formatCurrency, formatCurrencyCompact, formatDate, formatMonthYear, formatNumber } from '../lib/format.js';
import { AXIS_TICK_STYLE, pointLabel, verticalBarLabel } from '../lib/chartLabel.jsx';
import KPICard from '../components/KPICard.jsx';
import ClientTypeBadge from '../components/ClientTypeBadge.jsx';
import DistributionBar from '../components/DistributionBar.jsx';
import SegmentedBar from '../components/SegmentedBar.jsx';
import ChartTooltip from '../components/ChartTooltip.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ExportCsvButton from '../components/ExportCsvButton.jsx';

const AFFINITY_DIMENSIONS = [
  { key: 'movieIndustry', label: 'Movie Industry' },
  { key: 'movieLanguage', label: 'Movie Language' },
  { key: 'movieCategory', label: 'Movie Category' },
];

// Same 4-color rotation as SegmentedBar, for a list of DistributionBar rows
// (City Breakdown has too many rows — top 8 — to compress into one stacked
// bar the way Region Breakdown/Booking Type Mix do, but should still read
// as the same considered palette rather than one color repeated 8 times.
const ROW_COLORS = ['gold', 'teal', 'jade', 'highlight'];

const BOOKINGS_CSV_COLUMNS = [
  { label: 'Date', value: (r) => (formatDate(r.dateOfScreening) !== '—' ? formatDate(r.dateOfScreening) : formatMonthYear(new Date(Date.UTC(r.year || 0, (r.month || 1) - 1, 1)))) },
  { label: 'Movie', value: 'movieName' },
  { label: 'Cinema', value: 'cinemaLocation' },
  { label: 'City', value: 'city' },
  { label: 'Tickets', value: 'tickets' },
  { label: 'Amount', value: 'totalAmount' },
];

// Where "← Back to ..." returns to, driven by route state set when each
// list page navigates here (see Leaderboard/Affinity/Dormant's onClick) —
// not a hardcoded assumption. Falls back to Leaderboard for a direct link
// or a refreshed page, where no navigation state exists.
const ORIGINS = {
  leaderboard: { path: '/leaderboard', label: 'Client Leaderboard' },
  affinity: { path: '/affinity', label: 'Genre Affinity' },
  dormant: { path: '/dormant', label: 'Dormant Clients' },
};

export default function ClientDetail() {
  const { clientKey } = useParams();
  const location = useLocation();
  const { clientIndex } = useBookings();
  const client = clientIndex.byKey.get(decodeURIComponent(clientKey));
  const origin = ORIGINS[location.state?.from] || ORIGINS.leaderboard;

  const monthlyTrend = useMemo(() => (client ? computeMonthlyTrend(client.records) : []), [client]);
  // Each KPI's own sparkline — this client's full lifetime history bucketed
  // monthly, independent of the global FY/Month filter (these KPIs already
  // show lifetime totals regardless of the header filter, same as before).
  const sparklines = useMemo(() => {
    if (!client) return null;
    const series = computeTimeSeriesMetrics(client.records, 'month');
    return {
      revenue: series.map((b) => b.totalRevenue),
      tickets: series.map((b) => b.totalTickets),
      bookings: series.map((b) => b.recordCount),
      atv: series.map((b) => b.atv),
    };
  }, [client]);
  const bookingTypeDist = useMemo(() => (client ? computeDistribution(client.records, 'bookingType') : null), [client]);
  const regionDist = useMemo(() => (client ? computeDistribution(client.records, 'region') : null), [client]);
  const cityDist = useMemo(() => (client ? computeDistribution(client.records, 'city') : null), [client]);
  const affinityDists = useMemo(
    () => (client ? AFFINITY_DIMENSIONS.map((d) => ({ ...d, dist: computeDistribution(client.records, d.key) })) : []),
    [client],
  );
  const chronological = useMemo(() => {
    if (!client) return [];
    return [...client.records].sort((a, b) => {
      const da = a.dateOfScreening ? new Date(a.dateOfScreening) : new Date(Date.UTC(a.year || 0, (a.month || 1) - 1, 1));
      const db = b.dateOfScreening ? new Date(b.dateOfScreening) : new Date(Date.UTC(b.year || 0, (b.month || 1) - 1, 1));
      return db - da;
    });
  }, [client]);

  if (!client) {
    return (
      <div className="flex flex-col gap-3.5">
        <Link to={origin.path} className="interactive inline-block rounded text-[11px] font-semibold text-teal hover:text-teal/80">
          ← Back to {origin.label}
        </Link>
        <EmptyState message="Client not found." />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3.5">
      <div>
        <Link to={origin.path} className="interactive inline-block rounded text-[11px] font-semibold text-teal hover:text-teal/80">
          ← Back to {origin.label}
        </Link>
        <div className="mt-1 flex items-center gap-2">
          <h2 className="font-serif text-2xl font-bold tracking-tight text-ink">{client.displayName}</h2>
          <ClientTypeBadge clientType={client.clientType} clientCategory={client.clientCategory} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <KPICard label="Lifetime Revenue" value={formatCurrency(client.totalRevenue)} valueColor="gold" sparkline={sparklines.revenue} />
        <KPICard label="Lifetime Tickets" value={formatNumber(client.totalTickets)} valueColor="teal" sparkline={sparklines.tickets} />
        <KPICard label="Booking Count" value={formatNumber(client.bookingCount)} valueColor="jade" sparkline={sparklines.bookings} />
        <KPICard label="Avg Ticket Price" value={formatCurrency(client.avgTicketPrice)} valueColor="gold" sparkline={sparklines.atv} />
      </div>

      <Section title="Monthly Booking Trend">
        {monthlyTrend.length === 0 ? (
          <EmptyState />
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={monthlyTrend} margin={{ top: 24, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#1e1e2c" strokeOpacity={0.08} vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(d) => formatMonthYear(d)}
                tick={AXIS_TICK_STYLE}
                axisLine={{ stroke: '#1e1e2c', strokeOpacity: 0.15 }}
                tickLine={false}
              />
              <YAxis yAxisId="revenue" tick={AXIS_TICK_STYLE} tickFormatter={formatCurrencyCompact} axisLine={false} tickLine={false} />
              <YAxis yAxisId="count" orientation="right" tick={AXIS_TICK_STYLE} allowDecimals={false} axisLine={false} tickLine={false} />
              <Tooltip
                content={
                  <ChartTooltip
                    labelFormatter={(l) => formatMonthYear(l)}
                    valueFormatter={(v, entry) => (entry.dataKey === 'revenue' ? formatCurrency(v) : formatNumber(v))}
                  />
                }
              />
              <Bar yAxisId="revenue" dataKey="revenue" name="Revenue" fill="var(--color-gold)" radius={[2, 2, 0, 0]} label={verticalBarLabel(formatCurrencyCompact)} />
              <Line
                yAxisId="count"
                dataKey="bookingCount"
                name="Bookings"
                stroke="var(--color-jade)"
                strokeWidth={2}
                dot={{ r: 3, fill: 'var(--color-cream)', stroke: 'var(--color-jade)', strokeWidth: 1.5 }}
              >
                <LabelList dataKey="bookingCount" content={pointLabel(formatNumber)} />
              </Line>
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </Section>

      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
        <Section title="Booking Type Mix">
          {!bookingTypeDist || bookingTypeDist.items.length === 0 ? <EmptyState /> : <SegmentedBar items={bookingTypeDist.items} />}
        </Section>

        <Section title="Region Breakdown">
          {!regionDist || regionDist.items.length === 0 ? <EmptyState /> : <SegmentedBar items={regionDist.items} />}
        </Section>
      </div>

      <Section title="City Breakdown (top 8 by bookings)">
        {!cityDist || cityDist.items.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 gap-x-6 md:grid-cols-2">
            {cityDist.items.slice(0, 8).map((item, i) => (
              <DistributionBar key={item.value} label={item.value} count={item.count} pct={item.pct} color={ROW_COLORS[i % ROW_COLORS.length]} />
            ))}
          </div>
        )}
      </Section>

      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
        {affinityDists.map((d) => (
          <Section key={d.key} title={d.label}>
            {d.dist.items.length === 0 ? <EmptyState /> : <SegmentedBar items={d.dist.items} />}
          </Section>
        ))}
      </div>

      <Section
        title={`All Bookings (${chronological.length})`}
        headerRight={<ExportCsvButton rows={chronological} columns={BOOKINGS_CSV_COLUMNS} filename={`${client.displayName}-bookings.csv`} />}
      >
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-ink/10 text-left text-[10px] uppercase tracking-widest text-ink-soft">
                <th className="px-3 py-2 font-bold">Date</th>
                <th className="px-2 py-2 font-bold">Movie</th>
                <th className="px-2 py-2 font-bold">Cinema</th>
                <th className="px-2 py-2 font-bold">City</th>
                <th className="px-2 py-2 text-right font-bold">Tickets</th>
                <th className="px-3 py-2 text-right font-bold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {chronological.map((r, i) => (
                <tr key={i} className="border-b border-ink/5 last:border-0">
                  <td className="px-3 py-1.5 text-ink-soft">{formatDate(r.dateOfScreening) !== '—' ? formatDate(r.dateOfScreening) : formatMonthYear(new Date(Date.UTC(r.year || 0, (r.month || 1) - 1, 1)))}</td>
                  <td className="px-2 py-1.5 text-ink">{r.movieName || '—'}</td>
                  <td className="px-2 py-1.5 text-ink-soft">{r.cinemaLocation || '—'}</td>
                  <td className="px-2 py-1.5 text-ink-soft">{r.city || '—'}</td>
                  <td className="px-2 py-1.5 text-right text-teal">{formatNumber(r.tickets)}</td>
                  <td className="px-3 py-1.5 text-right font-medium text-gold">{formatCurrency(r.totalAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, headerRight, children }) {
  return (
    <div className="card">
      <div className="flex items-center justify-between border-b border-ink/10 px-3.5 py-2">
        <span className="text-[11px] font-bold uppercase tracking-widest text-ink-soft">{title}</span>
        {headerRight}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}
