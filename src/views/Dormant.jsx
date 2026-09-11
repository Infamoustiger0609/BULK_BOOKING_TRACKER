import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBookings } from '../lib/BookingsProvider.jsx';
import { computeDormantClients } from '../lib/dataUtils.js';
import { formatCurrency, formatDate, formatNumber } from '../lib/format.js';
import KPICard from '../components/KPICard.jsx';
import ClientTypeBadge from '../components/ClientTypeBadge.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ExportCsvButton from '../components/ExportCsvButton.jsx';

const MONTHS_THRESHOLD = 6;
const MIN_BOOKINGS = 2;

const CSV_COLUMNS = [
  { label: 'Client', value: 'displayName' },
  { label: 'Client Type', value: 'clientType' },
  { label: 'Client Category', value: 'clientCategory' },
  { label: 'Status', value: (c) => `Dormant - ${c.monthsSince}mo` },
  { label: 'Last Booking', value: (c) => formatDate(c.lastBookingDate) },
  { label: 'Bookings', value: 'bookingCount' },
  { label: 'Lifetime Revenue', value: 'totalRevenue' },
];

export default function Dormant() {
  // Financial Year / Month / Region are global (header) filters, applied to
  // the client list below. referenceDate ("now" for dormancy purposes) stays
  // the dataset's true latest activity regardless of the filter — narrowing
  // the view to a past period shouldn't move what "now" means.
  const { globalFilteredClientIndex, referenceDate } = useBookings();
  const navigate = useNavigate();

  const dormantClients = useMemo(
    () => computeDormantClients(globalFilteredClientIndex.list, referenceDate, { monthsThreshold: MONTHS_THRESHOLD, minBookings: MIN_BOOKINGS }),
    [globalFilteredClientIndex, referenceDate],
  );

  const atRiskRevenue = dormantClients.reduce((sum, c) => sum + c.totalRevenue, 0);
  const avgMonths = dormantClients.length
    ? dormantClients.reduce((sum, c) => sum + c.monthsSince, 0) / dormantClients.length
    : null;

  return (
    <div className="flex flex-col gap-3.5">
      <p className="max-w-[640px] text-[11px] text-ink-soft">
        2+ historical bookings, last booking {MONTHS_THRESHOLD}+ months before {formatDate(referenceDate)} (the latest
        activity in this dataset) — a win-back prospecting list, ranked by revenue at stake.
      </p>

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <KPICard size="compact" label="Dormant Clients" value={formatNumber(dormantClients.length)} valueColor="coral" />
        <KPICard size="compact" label="Revenue at Stake" value={formatCurrency(atRiskRevenue)} valueColor="gold" subLine="lifetime revenue, now dormant" />
        <KPICard size="compact" label="Avg Months Dormant" value={avgMonths != null ? avgMonths.toFixed(1) : '—'} valueColor="ink" />
        <KPICard size="compact" label="Reference Date" value={formatDate(referenceDate)} valueColor="ink" subLine="latest activity in dataset" />
      </div>

      <div className="card">
        <div className="flex items-center justify-between border-b border-ink/10 px-3.5 py-2">
          <span className="text-[11px] font-bold uppercase tracking-widest text-ink-soft">
            Win-back list · sorted by lifetime revenue
          </span>
          <ExportCsvButton rows={dormantClients} columns={CSV_COLUMNS} filename="dormant-clients.csv" />
        </div>
        {dormantClients.length === 0 ? (
          <EmptyState className="m-4" message="No clients currently meet the dormant threshold." />
        ) : (
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-ink/10 text-left text-[10px] uppercase tracking-widest text-ink-soft">
                <th className="px-4 py-2 font-bold">Client</th>
                <th className="px-2 py-2 font-bold">Status</th>
                <th className="px-2 py-2 font-bold">Last Booking</th>
                <th className="px-2 py-2 text-right font-bold">Bookings</th>
                <th className="px-2 py-2 text-right font-bold">Lifetime Revenue</th>
              </tr>
            </thead>
            <tbody>
              {dormantClients.map((client) => (
                <tr
                  key={client.key}
                  onClick={() => navigate(`/client/${encodeURIComponent(client.key)}`, { state: { from: 'dormant' } })}
                  className="row-interactive cursor-pointer border-b border-ink/5 last:border-0 hover:bg-cream-2"
                >
                  <td className="px-4 py-2">
                    <div className="font-medium text-ink">{client.displayName}</div>
                    <ClientTypeBadge clientType={client.clientType} clientCategory={client.clientCategory} />
                  </td>
                  <td className="px-2 py-2">
                    <span className="inline-block rounded-full bg-coral-soft px-2 py-0.5 text-[10px] font-semibold text-coral">
                      DORMANT · {client.monthsSince}mo
                    </span>
                  </td>
                  <td className="px-2 py-2 text-ink-soft">{formatDate(client.lastBookingDate)}</td>
                  <td className="px-2 py-2 text-right text-ink">{formatNumber(client.bookingCount)}</td>
                  <td className="px-2 py-2 text-right font-serif font-bold tracking-tight text-gold">{formatCurrency(client.totalRevenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
