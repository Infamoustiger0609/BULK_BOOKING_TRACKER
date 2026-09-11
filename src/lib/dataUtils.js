// Core, view-agnostic data logic: client-identity normalization, per-client
// aggregation, genre/industry affinity, dormant-client detection, and the
// one shared date-window function every date filter/preset should call.
// Nothing in here should import a React component — views consume these as
// plain functions so the logic stays reusable and independently testable.

const AFFINITY_DIMENSIONS = ['movieIndustry', 'movieLanguage', 'movieCategory'];

/** Trims + collapses whitespace and lowercases, for use as a grouping key. */
export function normalizeClientKey(record) {
  const raw = (record.corporateName || record.clientName || '').trim();
  if (!raw) return null;
  return raw.toLowerCase().replace(/\s+/g, ' ');
}

/** Prefers the record's own screening date; falls back to the 1st of its year/month. */
export function getEffectiveDate(record) {
  if (record.dateOfScreening) {
    const d = new Date(record.dateOfScreening);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (record.year != null && record.month != null) {
    return new Date(Date.UTC(record.year, record.month - 1, 1));
  }
  return null;
}

/** The latest effective date found anywhere in the dataset ("now" for this dataset). */
export function getDatasetReferenceDate(records) {
  let latest = null;
  for (const r of records) {
    const d = getEffectiveDate(r);
    if (d && (!latest || d > latest)) latest = d;
  }
  return latest;
}

/** Whole calendar months between two dates (b - a), ignoring day-of-month. */
export function monthsBetween(a, b) {
  if (!a || !b) return null;
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

// ---------------------------------------------------------------------------
// Client aggregation
// ---------------------------------------------------------------------------

/**
 * Groups every record by clientKey and rolls up revenue/tickets/booking
 * counts, the most common original-casing display name, and the client's
 * most common clientType/clientCategory. Returns both a Map (for O(1)
 * detail-page lookups) and a flat array (for list views), plus dataset-wide
 * totals used for "% of total" figures.
 */
export function buildClientIndex(records) {
  const byKey = new Map();

  for (const r of records) {
    const key = normalizeClientKey(r);
    if (!key) continue;

    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        key,
        nameCounts: new Map(),
        typeCounts: new Map(),
        categoryCounts: new Map(),
        totalRevenue: 0,
        totalTickets: 0,
        bookingCount: 0,
        lastBookingDate: null,
        records: [],
      };
      byKey.set(key, entry);
    }

    const rawName = (r.corporateName || r.clientName || '').trim();
    if (rawName) entry.nameCounts.set(rawName, (entry.nameCounts.get(rawName) || 0) + 1);
    if (r.clientType) entry.typeCounts.set(r.clientType, (entry.typeCounts.get(r.clientType) || 0) + 1);
    if (r.clientCategory) entry.categoryCounts.set(r.clientCategory, (entry.categoryCounts.get(r.clientCategory) || 0) + 1);

    entry.totalRevenue += r.totalAmount || 0;
    entry.totalTickets += r.tickets || 0;
    entry.bookingCount += 1;
    entry.records.push(r);

    const effDate = getEffectiveDate(r);
    if (effDate && (!entry.lastBookingDate || effDate > entry.lastBookingDate)) {
      entry.lastBookingDate = effDate;
    }
  }

  const list = [];
  let totalRevenue = 0;
  let totalTickets = 0;

  for (const entry of byKey.values()) {
    const displayName = argmax(entry.nameCounts) || entry.key;
    const clientType = argmax(entry.typeCounts);
    const clientCategory = argmax(entry.categoryCounts);
    const avgTicketPrice = entry.totalTickets > 0 ? entry.totalRevenue / entry.totalTickets : null;

    const agg = {
      key: entry.key,
      displayName,
      clientType,
      clientCategory,
      totalRevenue: entry.totalRevenue,
      totalTickets: entry.totalTickets,
      bookingCount: entry.bookingCount,
      avgTicketPrice,
      lastBookingDate: entry.lastBookingDate,
      records: entry.records,
    };
    byKey.set(entry.key, agg); // replace the working entry with the finalized one
    list.push(agg);
    totalRevenue += agg.totalRevenue;
    totalTickets += agg.totalTickets;
  }

  return { byKey, list, totalRevenue, totalTickets, totalBookings: records.length };
}

function argmax(countMap) {
  let best = null;
  let bestCount = -1;
  for (const [value, count] of countMap.entries()) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Summary-page metrics: revenue/tickets/SPH/ATV, always aggregated from
// record-level totals — never as an average of each record's own rate.
// SPH is weighted by tickets (Σ sph·tickets / Σ tickets); ATV is derived
// straight from the aggregated totals (Σ totalAmount / Σ tickets), not from
// averaging each record's own `atp` field. Both the KPI row and every trend
// chart on the Summary page call this same function so the two can never
// disagree about how a rate is aggregated.
// ---------------------------------------------------------------------------

export function aggregateMetrics(records) {
  let totalRevenue = 0;
  let totalTickets = 0;
  let sphWeightedSum = 0;
  const clientKeys = new Set();
  for (const r of records) {
    totalRevenue += r.totalAmount || 0;
    totalTickets += r.tickets || 0;
    if (r.sph != null && r.tickets != null) sphWeightedSum += r.sph * r.tickets;
    const key = normalizeClientKey(r);
    if (key) clientKeys.add(key);
  }
  return {
    totalRevenue,
    totalTickets,
    clientCount: clientKeys.size,
    sph: totalTickets > 0 ? sphWeightedSum / totalTickets : null,
    atv: totalTickets > 0 ? totalRevenue / totalTickets : null,
    recordCount: records.length,
  };
}

/** Percent change of current vs. prior; null (renders nothing in DeltaBadge) when prior isn't a usable baseline. */
export function computeDelta(current, prior) {
  if (current == null || prior == null || prior === 0) return null;
  return (current - prior) / prior;
}

/**
 * The equivalent PRECEDING period for the global filter, for Summary's delta
 * badges — well-defined only when the current selection resolves to exactly
 * one period: a single FY with Month unrestricted (-> prior FY, in full), or
 * a single FY with exactly one Month ticked (-> prior calendar month). Any
 * other combination (0, 2+, or "all" FYs ticked; a genuine partial
 * multi-month selection) has no single well-defined "prior", so this returns
 * null and the delta badge renders nothing — same as it always has for "All
 * time". Returns ready-to-use { fyFilter, monthFilter } arrays, not a single
 * value, so the caller can pass the result straight to applyGlobalFilters.
 */
export function getPriorPeriodFilter({ fyFilter, monthFilter }, { records, monthOptions }) {
  if (fyFilter.length !== 1) return null;
  const fyStartYear = Number(fyFilter[0]);
  const monthIsUnrestricted = monthFilter.length === monthOptions.length;

  if (monthIsUnrestricted) {
    const priorFy = fyStartYear - 1;
    const priorMonthOptions = monthOptionsForFY(records, priorFy);
    if (priorMonthOptions.length === 0) return null; // no data at all for the prior FY
    return { fyFilter: [String(priorFy)], monthFilter: priorMonthOptions.map((o) => o.value) };
  }

  if (monthFilter.length === 1) {
    const [year, month] = monthFilter[0].split('-').map(Number);
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prevMonthKey = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
    const priorFy = financialYearOf(new Date(Date.UTC(prevYear, prevMonth - 1, 1)));
    return { fyFilter: [String(priorFy)], monthFilter: [prevMonthKey] };
  }

  return null; // a genuine partial multi-month selection within one FY — no single well-defined "prior"
}

/** 'month' when exactly one FY is selected, 'year' (by Financial Year) otherwise — 0, 2+, or "all" FYs selected. */
export function getTrendGranularity({ fyFilter }) {
  return fyFilter.length === 1 ? 'month' : 'year';
}

/**
 * Finer-grained sibling of getTrendGranularity, for the small sparkline on
 * each KPI card rather than the full trend chart: drops one more level to
 * 'week' when the selection is already narrowed to a single month (nothing
 * courser than a week would show any shape at all in that case), otherwise
 * matches the same month/year rule the big trend charts use.
 */
export function getSparklineGranularity({ fyFilter, monthFilter }) {
  if (monthFilter.length === 1) return 'week';
  return getTrendGranularity({ fyFilter });
}

/** Revenue/tickets/SPH/ATV per time bucket, sorted chronologically — the one series every trend chart (and KPI sparkline) reads from. */
export function computeTimeSeriesMetrics(records, granularity) {
  const buckets = new Map();
  for (const r of records) {
    const d = getEffectiveDate(r);
    if (!d) continue;
    let key;
    let label;
    let sortDate;
    if (granularity === 'week') {
      // Week-of-month derived straight from the day-of-month (1-7 -> wk1,
      // 8-14 -> wk2, ...) rather than trusting the source workbook's own
      // `week` column, whose numbering isn't consistently ISO-week or
      // week-of-month across sheets — this stays self-consistent everywhere.
      const weekOfMonth = Math.ceil(d.getUTCDate() / 7);
      key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-W${weekOfMonth}`;
      label = `Wk ${weekOfMonth}`;
      sortDate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), (weekOfMonth - 1) * 7 + 1));
    } else if (granularity === 'month') {
      key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      label = `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
      sortDate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    } else {
      const fy = financialYearOf(d);
      key = String(fy);
      label = financialYearLabel(fy);
      sortDate = new Date(Date.UTC(fy, 3, 1));
    }
    const bucket = buckets.get(key) || { key, label, sortDate, records: [] };
    bucket.records.push(r);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .sort((a, b) => a.sortDate - b.sortDate)
    .map((b) => ({ key: b.key, label: b.label, sortDate: b.sortDate, ...aggregateMetrics(b.records) }));
}

/** Bare array of one metric's value per bucket — what a KPICard's `sparkline` prop wants, without every caller re-destructuring computeTimeSeriesMetrics's fuller bucket shape. */
export function computeSparklineSeries(records, granularity, metricKey) {
  return computeTimeSeriesMetrics(records, granularity).map((b) => b[metricKey]);
}

/** Revenue+tickets grouped by an arbitrary field (e.g. region, city), sorted by revenue desc. */
export function computeRevenueByField(records, field) {
  const map = new Map();
  for (const r of records) {
    const v = r[field];
    if (v == null || v === '') continue;
    const entry = map.get(v) || { value: v, revenue: 0, tickets: 0 };
    entry.revenue += r.totalAmount || 0;
    entry.tickets += r.tickets || 0;
    map.set(v, entry);
  }
  return [...map.values()].sort((a, b) => b.revenue - a.revenue);
}

// ---------------------------------------------------------------------------
// Affinity / genre-loyalty
// ---------------------------------------------------------------------------

/**
 * % distribution of `records` across `field`, ignoring null/blank values in
 * the denominator (so missing data on older sheets doesn't dilute a real
 * signal). Sorted by count descending.
 */
export function computeDistribution(records, field) {
  const counts = new Map();
  let consideredCount = 0;
  for (const r of records) {
    const v = r[field];
    if (v == null || v === '') continue;
    counts.set(v, (counts.get(v) || 0) + 1);
    consideredCount += 1;
  }
  const items = [...counts.entries()]
    .map(([value, count]) => ({ value, count, pct: consideredCount ? count / consideredCount : 0 }))
    .sort((a, b) => b.count - a.count);
  return { items, consideredCount };
}

/**
 * For every client with >= minBookings, checks each affinity dimension
 * (movieIndustry / movieLanguage / movieCategory) for a value that accounts
 * for >= threshold of their bookings. A client can be "loyal" on more than
 * one dimension at once; each qualifying dimension produces its own entry so
 * the reverse-lookup ("who's loyal to Hollywood") can filter across all of
 * them uniformly.
 */
export function computeClientAffinities(clientList, { minBookings = 3, threshold = 0.65 } = {}) {
  const loyalties = [];
  for (const client of clientList) {
    if (client.bookingCount < minBookings) continue;
    for (const dimension of AFFINITY_DIMENSIONS) {
      const { items, consideredCount } = computeDistribution(client.records, dimension);
      const top = items[0];
      if (top && consideredCount > 0 && top.pct >= threshold) {
        loyalties.push({
          clientKey: client.key,
          displayName: client.displayName,
          clientType: client.clientType,
          clientCategory: client.clientCategory,
          totalRevenue: client.totalRevenue,
          bookingCount: client.bookingCount,
          dimension,
          value: top.value,
          pct: top.pct,
          matchCount: top.count,
          consideredCount,
        });
      }
    }
  }
  return loyalties;
}

/** Revenue + booking count per calendar month, sorted chronologically. Used by the client trend chart. */
export function computeMonthlyTrend(records) {
  const byMonth = new Map();
  for (const r of records) {
    const d = getEffectiveDate(r);
    if (!d) continue;
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const entry = byMonth.get(key) || { key, date: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), revenue: 0, bookingCount: 0 };
    entry.revenue += r.totalAmount || 0;
    entry.bookingCount += 1;
    byMonth.set(key, entry);
  }
  return [...byMonth.values()].sort((a, b) => a.date - b.date);
}

// ---------------------------------------------------------------------------
// Dormant / lapsed clients
// ---------------------------------------------------------------------------

/**
 * Clients with >= minBookings whose last booking is >= monthsThreshold
 * months before referenceDate (the latest date found anywhere in the
 * dataset — see getDatasetReferenceDate). Sorted by lifetime revenue desc.
 */
export function computeDormantClients(clientList, referenceDate, { monthsThreshold = 6, minBookings = 2 } = {}) {
  if (!referenceDate) return [];
  const dormant = [];
  for (const client of clientList) {
    if (client.bookingCount < minBookings || !client.lastBookingDate) continue;
    const monthsSince = monthsBetween(client.lastBookingDate, referenceDate);
    if (monthsSince >= monthsThreshold) {
      dormant.push({ ...client, monthsSince });
    }
  }
  return dormant.sort((a, b) => b.totalRevenue - a.totalRevenue);
}

// ---------------------------------------------------------------------------
// Shared date-window utility — every date-based filter/preset must call this
// instead of computing "the current period" itself.
// ---------------------------------------------------------------------------

export const DATE_PRESETS = [
  { key: 'all', label: 'All time' },
  { key: 'last3', label: 'Last 3 months' },
  { key: 'last6', label: 'Last 6 months' },
  { key: 'last12', label: 'Last 12 months' },
  { key: 'ytd', label: 'Year to date' },
];

/** Resolves a preset key to a concrete { start, end } window relative to referenceDate. */
export function getPresetDateRange(presetKey, referenceDate) {
  if (!referenceDate || presetKey === 'all') return null;
  const end = referenceDate;
  switch (presetKey) {
    case 'last3':
      return { start: shiftMonths(end, -3), end };
    case 'last6':
      return { start: shiftMonths(end, -6), end };
    case 'last12':
      return { start: shiftMonths(end, -12), end };
    case 'ytd':
      return { start: new Date(Date.UTC(end.getUTCFullYear(), 0, 1)), end };
    default:
      return null;
  }
}

function shiftMonths(date, delta) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, date.getUTCDate()));
}

/** Filters records to those with an effective date inside [range.start, range.end]. */
export function filterRecordsByDateRange(records, range) {
  if (!range) return records;
  return records.filter((r) => {
    const d = getEffectiveDate(r);
    return d && d >= range.start && d <= range.end;
  });
}

// --- Financial Year (Apr–Mar) support -------------------------------------

/** The FY a date falls in, expressed as its starting calendar year (Jan–Mar counts toward the prior year's FY). */
export function financialYearOf(date) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  return m >= 4 ? y : y - 1;
}

/** { start, end } for the FY starting in April of `fyStartYear` (e.g. 2024 -> Apr 2024–Mar 2025). */
export function getFinancialYearRange(fyStartYear) {
  return {
    start: new Date(Date.UTC(fyStartYear, 3, 1)),
    end: new Date(Date.UTC(fyStartYear + 1, 2, 31)),
  };
}

export function financialYearLabel(fyStartYear) {
  return `FY ${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, '0')}`;
}

/** Every FY actually present in the data, most recent first — for populating a FY picker. */
export function listFinancialYears(records) {
  let minFy = null;
  let maxFy = null;
  for (const r of records) {
    const d = getEffectiveDate(r);
    if (!d) continue;
    const fy = financialYearOf(d);
    if (minFy == null || fy < minFy) minFy = fy;
    if (maxFy == null || fy > maxFy) maxFy = fy;
  }
  if (minFy == null) return [];
  const list = [];
  for (let fy = maxFy; fy >= minFy; fy--) {
    list.push({ key: String(fy), label: financialYearLabel(fy), ...getFinancialYearRange(fy) });
  }
  return list;
}

// --- Custom month-range support --------------------------------------------

/** { start, end } spanning the 1st of startYear/startMonth through the last day of endYear/endMonth. */
export function getMonthRange(startYear, startMonth, endYear, endMonth) {
  if (startYear == null || startMonth == null || endYear == null || endMonth == null) return null;
  const start = new Date(Date.UTC(startYear, startMonth - 1, 1));
  const end = new Date(Date.UTC(endYear, endMonth, 0)); // day 0 of the *next* month = last day of endMonth
  return { start, end };
}

// --- Global header filter: Financial Year + Month, both multi-select -------
//
// FY and Month are matched exactly like Region/Client Type/Client Category:
// every record's derived FY-year and year-month are compared against an
// explicit "ticked" set (standard checkbox model, see below — [] matches
// nothing, "everything" is an explicit full array, never an implicit
// default). There's deliberately no single { start, end } window resolved
// anywhere in this section any more — a multi-FY selection like "FY 2022-23
// + FY 2025-26" isn't a contiguous range, so set membership is the only
// model that works for both filters and for their combination.
//
// Month's OPTIONS list is still a drill-down scoped to whichever FY(s) are
// selected, and still only ever lists months with real data — so the
// current/latest FY still naturally caps at whatever month the data
// actually reaches (a side effect of monthOptionsForFY only listing months
// with data, not a special case for "the latest FY"), and a fully-ticked FY
// selection lists every month in the whole dataset, never disabled.

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Month options with actual data, scoped to `fyStartYear` (or the whole
 * dataset if null/undefined), in FY order (Apr..Mar) rather than calendar
 * order, so the dropdown reads the way a finance-dashboard year does.
 */
export function monthOptionsForFY(records, fyStartYear) {
  const range = fyStartYear != null ? getFinancialYearRange(fyStartYear) : null;
  const present = new Set();
  for (const r of records) {
    const d = getEffectiveDate(r);
    if (!d) continue;
    if (range && (d < range.start || d > range.end)) continue;
    present.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return [...present]
    .sort()
    .map((key) => {
      const [year, month] = key.split('-').map(Number);
      return { value: key, label: `${MONTH_NAMES[month - 1]} ${year}` };
    });
}

/** { value, label } options for the FY multi-select — every FY present in the data, most recent first. */
export function getFyOptions(records) {
  return listFinancialYears(records).map((fy) => ({ value: fy.key, label: fy.label }));
}

/**
 * Month options for the multi-select, scoped to whichever FY keys are
 * currently ticked: the union of each selected FY's own (data-capped)
 * months. An empty fyFilter (nothing ticked) correctly yields no month
 * options; every FY ticked yields the same result as the whole dataset
 * (every FY's months, combined, is every month there is) — so this needs no
 * separate "is FY unrestricted" branch to behave correctly in either case.
 */
export function getMonthOptionsForFySelection(records, fyFilter) {
  const seen = new Map();
  for (const key of fyFilter) {
    const fyStartYear = Number(key);
    if (Number.isNaN(fyStartYear)) continue;
    for (const opt of monthOptionsForFY(records, fyStartYear)) {
      if (!seen.has(opt.value)) seen.set(opt.value, opt);
    }
  }
  return [...seen.values()].sort((a, b) => a.value.localeCompare(b.value));
}

/**
 * Compact human-readable summary of the current FY/Month selection, for KPI
 * sub-lines — describes by month when Month is the more specific/restricted
 * choice, else by FY, else "All time".
 */
export function describeGlobalFilter({ fyFilter, monthFilter }, { fyOptions, monthOptions }) {
  const fyIsAll = fyOptions.length > 0 && fyFilter.length === fyOptions.length;
  const monthIsAll = monthOptions.length > 0 && monthFilter.length === monthOptions.length;
  if (fyIsAll && monthIsAll) return 'All time';

  if (!monthIsAll) {
    const labels = monthOptions.filter((o) => monthFilter.includes(o.value)).map((o) => o.label);
    if (labels.length === 0) return 'No period selected';
    if (labels.length <= 2) return labels.join(', ');
    return `${labels.length} months selected`;
  }

  const labels = fyOptions.filter((o) => fyFilter.includes(o.value)).map((o) => o.label);
  if (labels.length === 0) return 'No period selected';
  if (labels.length <= 2) return labels.join(', ');
  return `${labels.length} FYs selected`;
}

// --- Single entry point ----------------------------------------------------

/**
 * The one function every date-based filter/preset in the app must call to
 * turn its current selection into a concrete { start, end } window (or null
 * for "all time"). `dateFilter` is one of:
 *   { mode: 'all' }
 *   { mode: 'preset', preset: 'last6' | 'last12' | ... }        (see DATE_PRESETS)
 *   { mode: 'fy', fyStartYear: 2024 }                            (Apr 2024–Mar 2025)
 *   { mode: 'range', startYear, startMonth, endYear, endMonth }  (month-level, inclusive)
 */
export function resolveDateRange(dateFilter, referenceDate) {
  if (!dateFilter || dateFilter.mode === 'all') return null;
  switch (dateFilter.mode) {
    case 'preset':
      return getPresetDateRange(dateFilter.preset, referenceDate);
    case 'fy':
      return dateFilter.fyStartYear == null ? null : getFinancialYearRange(dateFilter.fyStartYear);
    case 'range':
      return getMonthRange(dateFilter.startYear, dateFilter.startMonth, dateFilter.endYear, dateFilter.endMonth);
    default:
      return null;
  }
}

export const DEFAULT_DATE_FILTER = { mode: 'preset', preset: 'all' };

// ---------------------------------------------------------------------------
// Multi-select filter semantics — standard checkbox model.
//
// A filter's state is always an explicit array of the values whose checkbox
// is ticked. There is no overloaded meaning for `[]`: it means "nothing is
// ticked, so nothing matches," full stop — the same as any other subset.
// "Everything selected" is represented by an explicit array containing every
// current option, not by `[]`; that's what makes the closed state read "All"
// and made ticking every box independently (not via a shortcut) equal it.
//
// Because a positive-match test (`selected.includes(record[field])`) can
// never match a record whose field is null, a field with any null/blank
// values gets a synthetic BLANK_FILTER_VALUE option standing in for "(No
// value)" — that option must be ticked, like any other, for those records to
// be included. Without it, "select every real option" would silently
// under-count relative to the true total, which is exactly the bug this
// model exists to avoid.
// ---------------------------------------------------------------------------

export const BLANK_FILTER_VALUE = ' __blank__';

/** Distinct values of `field` across `records`, plus a "(No value)" option if any record has it blank. */
export function getFilterOptions(records, field) {
  const values = new Set();
  let hasBlank = false;
  for (const r of records) {
    const v = r[field];
    if (v == null || v === '') hasBlank = true;
    else values.add(v);
  }
  const options = [...values].sort().map((v) => ({ value: v, label: v }));
  if (hasBlank) options.push({ value: BLANK_FILTER_VALUE, label: '(No value)' });
  return options;
}

/** The "everything ticked" state for a given option list — the default/select-all filter value. */
export function allFilterValues(options) {
  return options.map((o) => o.value);
}

function matchesSelection(record, field, selected) {
  const raw = record[field];
  const effective = raw == null || raw === '' ? BLANK_FILTER_VALUE : raw;
  return selected.includes(effective);
}

/**
 * Applies the GLOBAL filter set — Financial Year, Month, Region — shared
 * across every page via BookingsProvider. This is the one place that logic
 * lives; every page reads its result (globalFilteredRecords from
 * useBookings()) rather than re-deriving it. fyFilter/monthFilter/
 * regionFilter are each an explicit array of ticked values, matched exactly
 * like Region always has been — see the "standard checkbox model" note above.
 */
export function applyGlobalFilters(records, { fyFilter, monthFilter, regionFilter }) {
  return records.filter((r) => {
    if (!matchesSelection(r, 'region', regionFilter)) return false;
    const d = getEffectiveDate(r);
    if (!d) return false; // every record in this dataset has a derivable date; one without any can't belong to an FY/Month bucket
    if (!fyFilter.includes(String(financialYearOf(d)))) return false;
    const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!monthFilter.includes(monthKey)) return false;
    return true;
  });
}

/**
 * Applies the PAGE-LOCAL filter set — Client Type, Client Category —
 * currently only used by the Leaderboard view, on top of the already
 * globally-filtered records.
 */
export function applyClientFilters(records, { clientTypeFilter, clientCategoryFilter }) {
  return records.filter((r) => matchesSelection(r, 'clientType', clientTypeFilter) && matchesSelection(r, 'clientCategory', clientCategoryFilter));
}

/**
 * Composes applyGlobalFilters + applyClientFilters using the older
 * mode-based dateFilter shape ({mode:'preset'|'fy'|'range', ...}). Kept for
 * verify-filters.js's broader combination tests; the app itself now calls
 * applyGlobalFilters/applyClientFilters separately (see Leaderboard.jsx).
 * regionFilter/clientTypeFilter/clientCategoryFilter must each be an
 * explicit array of ticked values (see BLANK_FILTER_VALUE above) — there is
 * no "omit it to mean unrestricted" shorthand.
 */
export function applyStandardFilters(records, { dateFilter, regionFilter, clientTypeFilter, clientCategoryFilter }, referenceDate) {
  const range = resolveDateRange(dateFilter, referenceDate);
  return filterRecordsByDateRange(records, range).filter(
    (r) =>
      matchesSelection(r, 'region', regionFilter) &&
      matchesSelection(r, 'clientType', clientTypeFilter) &&
      matchesSelection(r, 'clientCategory', clientCategoryFilter),
  );
}
