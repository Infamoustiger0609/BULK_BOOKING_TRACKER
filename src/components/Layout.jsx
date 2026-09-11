import { useState } from 'react';
import { Outlet, useLocation, useParams } from 'react-router-dom';
import { useBookings } from '../lib/BookingsProvider.jsx';
import Sidebar from './Sidebar.jsx';
import GlobalFilters from './GlobalFilters.jsx';

const TAB_TITLES = [
  { to: '/summary', label: 'Summary' },
  { to: '/leaderboard', label: 'Client Leaderboard' },
  { to: '/affinity', label: 'Genre Affinity' },
  { to: '/dormant', label: 'Dormant Clients' },
];

// The sticky top bar's title is the current page's name — or, on Client
// Detail, that client's own display name — never a hardcoded string per
// route. `useParams` picks up `clientKey` here even though Layout isn't the
// leaf route: React Router merges params from every matched route in the
// branch, so this stays correct without Layout needing to know which route
// actually declared the param.
function usePageTitle(clientIndex) {
  const location = useLocation();
  const { clientKey } = useParams();
  if (clientKey) {
    const client = clientIndex?.byKey?.get(decodeURIComponent(clientKey));
    return client ? client.displayName : 'Client';
  }
  const tab = TAB_TITLES.find((t) => location.pathname.startsWith(t.to));
  return tab ? tab.label : '';
}

export default function Layout() {
  const { status, records, referenceDate, clientIndex } = useBookings();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const pageTitle = usePageTitle(clientIndex);

  return (
    <div className="flex min-h-screen bg-cream">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
        recordCount={records.length}
        referenceDate={referenceDate}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-20 flex flex-wrap items-center gap-3.5 border-b border-ink/8 bg-cream/94 px-6 py-2.5 backdrop-blur-[6px]">
          <h2 className="m-0 font-serif text-[19px] font-bold tracking-[-0.01em]">{pageTitle}</h2>
          <div className="ml-auto flex flex-wrap gap-2">{status === 'ready' && <GlobalFilters />}</div>
        </div>

        <main className="max-w-[1560px] px-6 pt-[18px] pb-8">
          {status === 'loading' && <div className="py-20 text-center text-sm text-ink-soft">Loading bookings…</div>}
          {status === 'error' && (
            <div className="py-20 text-center text-sm text-coral">
              Couldn&rsquo;t load /data/bookings.json. Run <code className="rounded bg-ink/10 px-1">npm run sync-data</code>{' '}
              and reload.
            </div>
          )}
          {status === 'ready' && <Outlet />}
        </main>
      </div>
    </div>
  );
}
