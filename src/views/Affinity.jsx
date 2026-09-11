import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBookings } from '../lib/BookingsProvider.jsx';
import { computeClientAffinities } from '../lib/dataUtils.js';
import { formatCurrency, formatNumber } from '../lib/format.js';
import { useDropdownPanel } from '../lib/useDropdownPanel.js';
import KPICard from '../components/KPICard.jsx';
import ClientTypeBadge from '../components/ClientTypeBadge.jsx';
import DistributionBar from '../components/DistributionBar.jsx';
import EmptyState from '../components/EmptyState.jsx';

const DIMENSIONS = [
  { key: 'movieIndustry', label: 'Movie Industry' },
  { key: 'movieLanguage', label: 'Movie Language' },
  { key: 'movieCategory', label: 'Movie Category' },
];
const MIN_BOOKINGS = 3;
const THRESHOLD = 0.65;

export default function Affinity() {
  // Financial Year / Month / Region are global (header) filters — this page
  // reads the already-scoped client index rather than the full dataset, so
  // whatever window is selected up top carries through here too.
  const { globalFilteredClientIndex } = useBookings();
  const navigate = useNavigate();

  const [dimension, setDimension] = useState('movieIndustry');
  const [search, setSearch] = useState('');
  const [selectedValue, setSelectedValue] = useState(null);

  const allLoyalties = useMemo(
    () => computeClientAffinities(globalFilteredClientIndex.list, { minBookings: MIN_BOOKINGS, threshold: THRESHOLD }),
    [globalFilteredClientIndex],
  );

  const dimensionLoyalties = useMemo(
    () => allLoyalties.filter((l) => l.dimension === dimension),
    [allLoyalties, dimension],
  );

  // Reverse-lookup index: "who is loyal to Hollywood" -> sorted by revenue.
  const valueCounts = useMemo(() => {
    const counts = new Map();
    for (const l of dimensionLoyalties) counts.set(l.value, (counts.get(l.value) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [dimensionLoyalties]);

  const searchMatches = useMemo(() => {
    if (!search.trim()) return valueCounts;
    const q = search.trim().toLowerCase();
    return valueCounts.filter(([value]) => value.toLowerCase().includes(q));
  }, [valueCounts, search]);

  const visibleLoyalties = useMemo(() => {
    const base = selectedValue ? dimensionLoyalties.filter((l) => l.value === selectedValue) : dimensionLoyalties;
    return [...base].sort((a, b) => b.totalRevenue - a.totalRevenue);
  }, [dimensionLoyalties, selectedValue]);

  const totalRevenueRepresented = visibleLoyalties.reduce((sum, l) => sum + l.totalRevenue, 0);

  const showSearchDropdown = !selectedValue && search.trim().length > 0;
  const { rendered: searchDropdownRendered, dataState: searchDropdownState } = useDropdownPanel(showSearchDropdown);

  function selectDimension(key) {
    setDimension(key);
    setSelectedValue(null);
    setSearch('');
  }

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[520px] text-[11px] text-ink-soft">
          Clients with {MIN_BOOKINGS}+ bookings where one value accounts for {Math.round(THRESHOLD * 100)}%+ of their bookings.
        </p>
        <div className="flex gap-0.5 rounded-md border border-ink/15 bg-white/70 p-0.5">
          {DIMENSIONS.map((d) => (
            <button
              key={d.key}
              onClick={() => selectDimension(d.key)}
              className={`interactive rounded px-2.5 py-1 text-[11px] font-semibold ${
                dimension === d.key ? 'bg-ink text-cream shadow-sm' : 'text-ink-soft hover:bg-ink/10'
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative max-w-sm">
        <input
          type="text"
          value={selectedValue || search}
          onChange={(e) => {
            setSelectedValue(null);
            setSearch(e.target.value);
          }}
          placeholder={`Search a ${DIMENSIONS.find((d) => d.key === dimension).label.toLowerCase()}… e.g. "Hollywood"`}
          className="interactive w-full rounded-md border border-ink/15 bg-white/80 px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-soft/60 focus:border-gold focus-visible:outline-none"
        />
        {selectedValue && (
          <button
            onClick={() => {
              setSelectedValue(null);
              setSearch('');
            }}
            className="interactive absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 text-[10px] font-semibold text-coral hover:text-coral/80"
          >
            Clear
          </button>
        )}
        {searchDropdownRendered && (
          <div className="card dropdown-panel absolute left-0 top-full z-20 mt-1 max-h-56 w-full overflow-y-auto py-1" data-state={searchDropdownState}>
            {searchMatches.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-ink-soft">No matching values.</div>
            ) : (
              searchMatches.map(([value, count]) => (
                <button
                  key={value}
                  onClick={() => {
                    setSelectedValue(value);
                    setSearch('');
                  }}
                  className="interactive mx-1 flex w-[calc(100%-0.5rem)] items-center justify-between rounded-md px-2 py-2 text-left text-[11px] text-ink hover:bg-cream-2"
                >
                  <span>{value}</span>
                  <span className="text-ink-soft">{count} client{count === 1 ? '' : 's'}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <KPICard size="compact" label="Loyal Clients" value={formatNumber(visibleLoyalties.length)} valueColor="jade" />
        <KPICard size="compact" label="Revenue Represented" value={formatCurrency(totalRevenueRepresented)} valueColor="gold" />
        <KPICard size="compact" label="Distinct Values" value={formatNumber(valueCounts.length)} valueColor="ink" />
        <KPICard
          size="compact"
          label="Filter"
          value={selectedValue || 'All values'}
          valueColor="ink"
          subLine={DIMENSIONS.find((d) => d.key === dimension).label}
        />
      </div>

      <div className="card">
        <div className="border-b border-ink/10 px-3.5 py-2 text-[11px] font-bold uppercase tracking-widest text-ink-soft">
          {selectedValue ? `Loyal to "${selectedValue}"` : 'All loyal clients'} · ranked by revenue
        </div>
        {visibleLoyalties.length === 0 ? (
          <EmptyState className="m-4" message="No clients meet the loyalty threshold for this selection." />
        ) : (
          <ul className="divide-y divide-ink/5">
            {visibleLoyalties.map((l) => (
              <li
                key={`${l.clientKey}-${l.dimension}`}
                onClick={() => navigate(`/client/${encodeURIComponent(l.clientKey)}`, { state: { from: 'affinity' } })}
                className="row-interactive grid cursor-pointer grid-cols-[1fr_2fr_auto] items-center gap-3 px-4 py-2 hover:bg-cream-2"
              >
                <div>
                  <div className="font-medium text-ink">{l.displayName}</div>
                  <ClientTypeBadge clientType={l.clientType} clientCategory={l.clientCategory} />
                </div>
                <DistributionBar label={l.value} count={l.matchCount} pct={l.pct} color="teal" highlight />
                <div className="text-right">
                  <div className="font-serif font-bold tracking-tight text-gold">{formatCurrency(l.totalRevenue)}</div>
                  <div className="text-[10px] text-ink-soft">{l.bookingCount} bookings total</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
