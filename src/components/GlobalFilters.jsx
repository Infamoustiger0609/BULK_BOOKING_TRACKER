import { useBookings } from '../lib/BookingsProvider.jsx';
import FilterBar from './FilterBar.jsx';

/**
 * The 3 global filters — Financial Year, Month, Region — shown compactly in
 * the header and shared by every page via BookingsProvider's context. All
 * three are multi-select with the same standard checkbox semantics (default
 * = every option ticked, "Select All"/"Clear" both land on well-defined
 * states, an empty selection matches nothing) — Month is never disabled: its
 * options are a live drill-down into whichever FY(s) are ticked, including
 * the fully-unrestricted "all FYs" default, which scopes to every month in
 * the dataset.
 */
export default function GlobalFilters() {
  const { fyOptions, fyFilter, setFyFilter, monthOptions, monthFilter, setMonthFilter, regionOptions, regionFilter, setRegionFilter } =
    useBookings();

  return (
    <FilterBar
      filters={[
        { key: 'fy', label: 'FY', options: fyOptions, selected: fyFilter, onChange: setFyFilter },
        { key: 'month', label: 'Month', options: monthOptions, selected: monthFilter, onChange: setMonthFilter },
        { key: 'region', label: 'Region', options: regionOptions, selected: regionFilter, onChange: setRegionFilter },
      ]}
    />
  );
}
