import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  allFilterValues,
  applyGlobalFilters,
  buildClientIndex,
  getDatasetReferenceDate,
  getFilterOptions,
  getFyOptions,
  getMonthOptionsForFySelection,
} from './dataUtils.js';

const BookingsContext = createContext(null);

export function BookingsProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', records: [] });

  useEffect(() => {
    let cancelled = false;
    fetch('/data/bookings.json')
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((records) => {
        if (!cancelled) setState({ status: 'ready', records });
      })
      .catch((error) => {
        if (!cancelled) setState({ status: 'error', records: [], error });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Recomputed only when the raw record list changes, then shared by every
  // view via context so the aggregation work happens exactly once.
  const derived = useMemo(() => {
    if (state.status !== 'ready') return null;
    const clientIndex = buildClientIndex(state.records);
    const referenceDate = getDatasetReferenceDate(state.records);
    const regionOptions = getFilterOptions(state.records, 'region');
    const fyOptions = getFyOptions(state.records);
    return { clientIndex, referenceDate, regionOptions, fyOptions };
  }, [state.records, state.status]);

  // --- Global filters: Financial Year, Month, Region — all three
  // multi-select, all shared across every page (Summary, Leaderboard, Genre
  // Affinity, Dormant Clients) so switching tabs never loses the selection.
  // Client Type / Client Category stay local to whichever page owns them
  // (currently just Leaderboard).
  //
  // Each filter's "raw" state is `null` until the user actually touches it
  // ("hasn't been touched yet", distinct from `[]`, which means the user
  // explicitly cleared every box and wants zero rows — see dataUtils.js's
  // standard checkbox semantics) or a real explicit array once they have.
  // The effective value resolves the default (every current option ticked)
  // synchronously during render — never via an effect, which would run one
  // render late and flash an empty "everything filtered out" result before
  // catching up. Month's effective value is *also* pruned against its
  // current (FY-selection-dependent) option list on every render, so a month
  // that stops being valid after the FY selection changes drops out
  // automatically instead of silently continuing to filter on it.
  const [fyFilterRaw, setFyFilterRaw] = useState(null);
  const [monthFilterRaw, setMonthFilterRaw] = useState(null);
  const [regionFilterRaw, setRegionFilterRaw] = useState(null);

  const fyFilter = fyFilterRaw ?? (derived ? allFilterValues(derived.fyOptions) : []);
  const regionFilter = regionFilterRaw ?? (derived ? allFilterValues(derived.regionOptions) : []);

  // Month is a drill-down scoped to whichever FY(s) are ticked — recomputed
  // whenever that selection changes, never disabled (an unrestricted/"all"
  // FY selection scopes to every FY, i.e. the whole dataset).
  const monthOptions = useMemo(() => {
    if (!derived) return [];
    return getMonthOptionsForFySelection(state.records, fyFilter);
  }, [derived, state.records, fyFilter]);

  const monthFilter = useMemo(() => {
    const effective = monthFilterRaw ?? allFilterValues(monthOptions);
    const validKeys = new Set(monthOptions.map((o) => o.value));
    return effective.filter((k) => validKeys.has(k));
  }, [monthFilterRaw, monthOptions]);

  const globalFilteredRecords = useMemo(() => {
    if (!derived) return [];
    return applyGlobalFilters(state.records, { fyFilter, monthFilter, regionFilter });
  }, [derived, state.records, fyFilter, monthFilter, regionFilter]);

  const globalFilteredClientIndex = useMemo(() => buildClientIndex(globalFilteredRecords), [globalFilteredRecords]);

  const value = useMemo(
    () => ({
      status: state.status,
      error: state.error,
      records: state.records,
      clientIndex: derived?.clientIndex ?? null,
      referenceDate: derived?.referenceDate ?? null,
      regionOptions: derived?.regionOptions ?? [],
      fyOptions: derived?.fyOptions ?? [],
      monthOptions,
      fyFilter,
      setFyFilter: setFyFilterRaw,
      monthFilter,
      setMonthFilter: setMonthFilterRaw,
      regionFilter,
      setRegionFilter: setRegionFilterRaw,
      globalFilteredRecords,
      globalFilteredClientIndex,
    }),
    [state, derived, monthOptions, fyFilter, monthFilter, regionFilter, globalFilteredRecords, globalFilteredClientIndex],
  );

  return <BookingsContext.Provider value={value}>{children}</BookingsContext.Provider>;
}

export function useBookings() {
  const ctx = useContext(BookingsContext);
  if (!ctx) throw new Error('useBookings must be used within a BookingsProvider');
  return ctx;
}
