import { NavLink } from 'react-router-dom';
import { formatMonthYear, formatNumber } from '../lib/format.js';

const NAV_ITEMS = [
  { to: '/summary', label: 'Summary' },
  { to: '/leaderboard', label: 'Client Leaderboard' },
  { to: '/affinity', label: 'Genre Affinity' },
  { to: '/dormant', label: 'Dormant Clients' },
];

/**
 * The persistent left rail: brand badge + wordmark, page nav, and a footer
 * stat line — collapsible to a 60px icon-only rail via `onToggleCollapsed`.
 * Purely chrome — no data fetching of its own, just the counts/date handed
 * down from BookingsProvider via Layout.
 */
export default function Sidebar({ collapsed, onToggleCollapsed, recordCount, referenceDate }) {
  return (
    <aside
      className="sticky top-0 flex h-screen shrink-0 flex-col overflow-hidden bg-ink-2 text-cream transition-[width] duration-150 ease-in-out"
      style={{ width: collapsed ? 60 : 224 }}
    >
      <div className="flex items-start justify-between gap-1.5 border-b border-cream/10 px-4 py-3.5">
        {!collapsed && (
          <div className="min-w-0">
            <div className="inline-block rounded bg-highlight px-1.5 py-0.5 text-[10px] font-extrabold tracking-wide text-ink-2">
              PVR INOX
            </div>
            <div className="mt-2 whitespace-nowrap font-serif text-[15px] font-bold leading-tight">BulkBooking Dashboard</div>
            <div className="mt-0.5 whitespace-nowrap text-[10px] text-cream/45">Client Intelligence &amp; Sales Analysis</div>
          </div>
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="interactive flex h-5 w-5 shrink-0 items-center justify-center rounded border border-cream/15 bg-cream/6 text-[11px] text-cream"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      <nav className="flex flex-col gap-0.5 p-2.5">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            title={item.label}
            className={({ isActive }) =>
              `interactive overflow-hidden whitespace-nowrap rounded-lg px-2.5 py-2.5 text-left text-[12px] font-semibold ${
                isActive ? 'bg-teal text-cream' : 'text-cream/60 hover:bg-cream/10 hover:text-cream'
              }`
            }
          >
            {collapsed ? item.label[0] : item.label}
          </NavLink>
        ))}
      </nav>

      {!collapsed && (
        <div className="mt-auto whitespace-nowrap border-t border-cream/10 px-4 py-3.5 text-[9px] leading-relaxed text-cream/40">
          <div>{formatNumber(recordCount)} bookings loaded</div>
          <div>Data through {formatMonthYear(referenceDate)}</div>
        </div>
      )}
    </aside>
  );
}
