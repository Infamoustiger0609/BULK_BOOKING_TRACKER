import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBookings } from '../lib/BookingsProvider.jsx';
import {
  allFilterValues,
  applyClientFilters,
  buildClientIndex,
  computeSparklineSeries,
  describeGlobalFilter,
  getFilterOptions,
  getSparklineGranularity,
} from '../lib/dataUtils.js';
import { formatCurrency, formatNumber, formatPercent } from '../lib/format.js';
import KPICard from '../components/KPICard.jsx';
import FilterBar from '../components/FilterBar.jsx';
import ClientTypeBadge from '../components/ClientTypeBadge.jsx';
import GradientBar from '../components/GradientBar.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ExportCsvButton from '../components/ExportCsvButton.jsx';

const CSV_COLUMNS = [
  { label: 'Rank', value: 'rank' },
  { label: 'Client', value: 'displayName' },
  { label: 'Client Type', value: 'clientType' },
  { label: 'Client Category', value: 'clientCategory' },
  { label: 'Revenue', value: 'totalRevenue' },
  { label: 'Tickets', value: 'totalTickets' },
  { label: 'Bookings', value: 'bookingCount' },
  { label: 'Avg Ticket Price', value: 'avgTicketPrice' },
];

const CONCENTRATION_TOP_N = 10;
const VISIBLE_ROWS = 10;
const SORT_OPTIONS = [
  { key: 'totalRevenue', label: 'Revenue' },
  { key: 'totalTickets', label: 'Tickets' },
  { key: 'bookingCount', label: 'Bookings' },
];

export default function Leaderboard() {
  // Financial Year / Month / Region are GLOBAL filters owned by
  // BookingsProvider (see the header) — globalFilteredRecords already has
  // them applied. Client Type / Client Category stay local to this page.
  const { records, globalFilteredRecords, fyOptions, fyFilter, monthOptions, monthFilter } = useBookings();
  const sparklineGranularity = getSparklineGranularity({ fyFilter, monthFilter });
  const navigate = useNavigate();

  const clientTypeOptions = useMemo(() => getFilterOptions(records, 'clientType'), [records]);
  const clientCategoryOptions = useMemo(() => getFilterOptions(records, 'clientCategory'), [records]);

  const [clientTypeFilter, setClientTypeFilter] = useState(() => allFilterValues(clientTypeOptions));
  const [clientCategoryFilter, setClientCategoryFilter] = useState(() => allFilterValues(clientCategoryOptions));
  const [sortKey, setSortKey] = useState('totalRevenue');

  const filteredRecords = useMemo(
    () => applyClientFilters(globalFilteredRecords, { clientTypeFilter, clientCategoryFilter }),
    [globalFilteredRecords, clientTypeFilter, clientCategoryFilter],
  );

  const scopedClientIndex = useMemo(() => buildClientIndex(filteredRecords), [filteredRecords]);

  const sortedClients = useMemo(
    () => [...scopedClientIndex.list].sort((a, b) => b[sortKey] - a[sortKey]),
    [scopedClientIndex, sortKey],
  );

  const topRevenue = sortedClients.slice(0, CONCENTRATION_TOP_N).reduce((sum, c) => sum + c.totalRevenue, 0);
  const topShare = scopedClientIndex.totalRevenue > 0 ? topRevenue / scopedClientIndex.totalRevenue : null;

  // The single highest revenue figure in view — the denominator for each
  // row's mini progress bar, held fixed regardless of which column the
  // table is currently sorted by so the bars stay a stable ranking cue.
  const maxClientRevenue = scopedClientIndex.list.reduce((max, c) => Math.max(max, c.totalRevenue), 0);

  const windowLabel = describeGlobalFilter({ fyFilter, monthFilter }, { fyOptions, monthOptions });

  const sparklines = useMemo(
    () => ({
      revenue: computeSparklineSeries(filteredRecords, sparklineGranularity, 'totalRevenue'),
      tickets: computeSparklineSeries(filteredRecords, sparklineGranularity, 'totalTickets'),
      clients: computeSparklineSeries(filteredRecords, sparklineGranularity, 'clientCount'),
    }),
    [filteredRecords, sparklineGranularity],
  );

  const sortLabel = SORT_OPTIONS.find((o) => o.key === sortKey).label;

  const csvRows = useMemo(() => sortedClients.map((c, i) => ({ ...c, rank: i + 1 })), [sortedClients]);

  // Cap the visible scroll area at exactly VISIBLE_ROWS data rows (+ header)
  // by measuring real rendered row heights, rather than guessing a pixel
  // value — stays correct regardless of font metrics/zoom/content wrapping.
  const scrollRef = useRef(null);
  const [maxHeight, setMaxHeight] = useState(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const thead = el.querySelector('thead');
    const firstRow = el.querySelector('tbody tr');
    if (thead && firstRow) {
      setMaxHeight(thead.getBoundingClientRect().height + firstRow.getBoundingClientRect().height * VISIBLE_ROWS);
    }
  }, [sortedClients.length]);

  return (
    <div className="flex flex-col gap-3.5">
      <FilterBar
        filters={[
          { key: 'clientType', label: 'Client Type', options: clientTypeOptions, selected: clientTypeFilter, onChange: setClientTypeFilter },
          { key: 'clientCategory', label: 'Client Category', options: clientCategoryOptions, selected: clientCategoryFilter, onChange: setClientCategoryFilter },
        ]}
      />

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <KPICard label="Total Revenue" value={formatCurrency(scopedClientIndex.totalRevenue)} valueColor="gold" subLine={windowLabel} sparkline={sparklines.revenue} />
        <KPICard label="Total Tickets" value={formatNumber(scopedClientIndex.totalTickets)} valueColor="teal" subLine={windowLabel} sparkline={sparklines.tickets} />
        <KPICard label="Active Clients" value={formatNumber(scopedClientIndex.list.length)} valueColor="jade" subLine={windowLabel} sparkline={sparklines.clients} />
        <KPICard
          label={`Top ${CONCENTRATION_TOP_N} Concentration`}
          value={formatPercent(topShare, 1)}
          valueColor="highlight"
          subLine="of total revenue in view"
        />
      </div>

      <div className="card">
        <div className="flex items-center justify-between border-b border-ink/10 px-3.5 py-2">
          <span className="text-[11px] font-bold uppercase tracking-widest text-ink-soft">
            All {formatNumber(sortedClients.length)} clients by {sortLabel.toLowerCase()}
          </span>
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              {SORT_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setSortKey(opt.key)}
                  className={`interactive rounded px-2 py-1 text-[10px] font-bold uppercase tracking-widest ${
                    sortKey === opt.key ? 'bg-ink text-cream shadow-sm' : 'text-ink-soft hover:bg-ink/10'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <ExportCsvButton rows={csvRows} columns={CSV_COLUMNS} filename="client-leaderboard.csv" />
          </div>
        </div>

        {sortedClients.length === 0 ? (
          <EmptyState className="m-4" />
        ) : (
          <div ref={scrollRef} className="overflow-y-auto" style={maxHeight ? { maxHeight } : undefined}>
            <table className="w-full border-collapse text-[12px]">
              <thead className="sticky top-0 z-10 bg-white">
                <tr className="border-b border-ink/10 text-left text-[10px] uppercase tracking-widest text-ink-soft">
                  <th className="px-4 py-2 font-bold">#</th>
                  <th className="px-2 py-2 font-bold">Client</th>
                  <th className="px-2 py-2 text-right font-bold">Revenue</th>
                  <th className="px-2 py-2 text-right font-bold">Tickets</th>
                  <th className="px-2 py-2 text-right font-bold">Bookings</th>
                  <th className="px-2 py-2 text-right font-bold">Avg Ticket Price</th>
                </tr>
              </thead>
              <tbody>
                {sortedClients.map((client, i) => {
                  const share = scopedClientIndex.totalRevenue > 0 ? client.totalRevenue / scopedClientIndex.totalRevenue : null;
                  return (
                    <tr
                      key={client.key}
                      onClick={() => navigate(`/client/${encodeURIComponent(client.key)}`, { state: { from: 'leaderboard' } })}
                      className="row-interactive cursor-pointer border-b border-ink/5 last:border-0 hover:bg-cream-2"
                    >
                      <td className="bg-inherit px-4 py-2 font-serif font-bold tracking-tight text-ink-soft">{i + 1}</td>
                      <td className="bg-inherit px-2 py-2">
                        <div className="font-medium text-ink">{client.displayName}</div>
                        <ClientTypeBadge clientType={client.clientType} clientCategory={client.clientCategory} />
                      </td>
                      <td className="bg-inherit px-2 py-2 text-right">
                        <div className="font-serif font-bold tracking-tight text-gold">{formatCurrency(client.totalRevenue)}</div>
                        <div className="text-[10px] text-ink-soft">{formatPercent(share, 1)} of total</div>
                        <GradientBar
                          pct={maxClientRevenue > 0 ? client.totalRevenue / maxClientRevenue : 0}
                          color="gold"
                          className="mt-1 ml-auto h-1.5 w-20"
                        />
                      </td>
                      <td className="bg-inherit px-2 py-2 text-right font-medium text-teal">{formatNumber(client.totalTickets)}</td>
                      <td className="bg-inherit px-2 py-2 text-right text-ink">{formatNumber(client.bookingCount)}</td>
                      <td className="bg-inherit px-2 py-2 text-right text-ink-soft">{formatCurrency(client.avgTicketPrice)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
