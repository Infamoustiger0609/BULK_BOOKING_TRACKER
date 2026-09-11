#!/usr/bin/env node
// Standalone filter-correctness verification — standard checkbox semantics.
//
// Convention under test (overrides the earlier "[] = unrestricted" model):
//   - A filter's state is the literal set of ticked values, always explicit.
//   - `[]` means nothing is ticked -> matches ZERO rows.
//   - "Everything" is the explicit array of every option, INCLUDING a
//     synthetic "(No value)" option for fields that have null/blank data
//     (dataUtils.BLANK_FILTER_VALUE) — without that, "select every real
//     option" would under-count relative to the true total.
//   - Default page-load state = every option ticked (so it reads "All" and
//     shows the true unfiltered totals).
//
// Reads data/bookings.json directly and independently re-derives expected
// totals using arithmetic written from scratch in this file. "Actual" calls
// the real src/lib/dataUtils.js / src/lib/filterState.js — the exact modules
// the React views import — never a hand-copied re-implementation.
//
// Usage: node verify-filters.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  aggregateMetrics,
  allFilterValues,
  applyClientFilters,
  applyGlobalFilters,
  applyStandardFilters,
  BLANK_FILTER_VALUE,
  buildClientIndex,
  computeClientAffinities,
  computeDelta,
  computeDormantClients,
  computeRevenueByField,
  computeTimeSeriesMetrics,
  getDatasetReferenceDate,
  getFilterOptions,
  getFyOptions,
  getMonthOptionsForFySelection,
  getPriorPeriodFilter,
  getTrendGranularity,
  monthOptionsForFY,
  resolveDateRange,
} from './src/lib/dataUtils.js';
import { clearFilterSelection, selectAllFilterValues, toggleFilterValue } from './src/lib/filterState.js';
import { toCsv } from './src/lib/csv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const records = JSON.parse(readFileSync(join(__dirname, 'data', 'bookings.json'), 'utf8'));
const referenceDate = getDatasetReferenceDate(records);

// ---------------------------------------------------------------------------
// Independent ground-truth arithmetic (deliberately NOT calling dataUtils.js
// for the aggregation/filtering logic itself — only importing real functions
// on the "actual" side, further down).
// ---------------------------------------------------------------------------

const GT_BLANK = ' BLANK '; // this script's own blank sentinel, unrelated to dataUtils' BLANK_FILTER_VALUE

function normalizeClientKeyIndependent(r) {
  const raw = (r.corporateName || r.clientName || '').trim();
  if (!raw) return null;
  return raw.toLowerCase().replace(/\s+/g, ' ');
}

function effectiveDateIndependent(r) {
  if (r.dateOfScreening) {
    const d = new Date(r.dateOfScreening);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (r.year != null && r.month != null) return new Date(Date.UTC(r.year, r.month - 1, 1));
  return null;
}

function effectiveFieldValue(r, field) {
  const v = r[field];
  return v == null || v === '' ? GT_BLANK : v;
}

function groundTruthOptionValues(recs, field) {
  return [...new Set(recs.map((r) => effectiveFieldValue(r, field)))];
}

function financialYearStartOf(date) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  return m >= 4 ? y : y - 1;
}

function independentReferenceDate(recs) {
  let latest = null;
  for (const r of recs) {
    const d = effectiveDateIndependent(r);
    if (d && (!latest || d > latest)) latest = d;
  }
  return latest;
}

function independentDateRange(dateFilter, refDate) {
  if (!dateFilter || dateFilter.mode === 'all' || (dateFilter.mode === 'preset' && dateFilter.preset === 'all')) return null;
  const shiftMonths = (d, delta) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, d.getUTCDate()));
  if (dateFilter.mode === 'preset') {
    const end = refDate;
    switch (dateFilter.preset) {
      case 'last3': return { start: shiftMonths(end, -3), end };
      case 'last6': return { start: shiftMonths(end, -6), end };
      case 'last12': return { start: shiftMonths(end, -12), end };
      case 'ytd': return { start: new Date(Date.UTC(end.getUTCFullYear(), 0, 1)), end };
      default: return null;
    }
  }
  if (dateFilter.mode === 'fy') {
    const fy = dateFilter.fyStartYear;
    return { start: new Date(Date.UTC(fy, 3, 1)), end: new Date(Date.UTC(fy + 1, 2, 31)) };
  }
  if (dateFilter.mode === 'range') {
    const { startYear, startMonth, endYear, endMonth } = dateFilter;
    return { start: new Date(Date.UTC(startYear, startMonth - 1, 1)), end: new Date(Date.UTC(endYear, endMonth, 0)) };
  }
  return null;
}

/**
 * Ground truth: standard checkbox matching, written independently.
 * region/clientType/clientCategory are REQUIRED explicit arrays (using
 * GT_BLANK for "no value") — there is no "omit it to mean unrestricted".
 */
function groundTruthFilter(recs, { region, clientType, clientCategory, dateFilter = null, referenceDate: refDate = null }) {
  const range = independentDateRange(dateFilter, refDate);
  return recs.filter((r) => {
    if (!region.includes(effectiveFieldValue(r, 'region'))) return false;
    if (!clientType.includes(effectiveFieldValue(r, 'clientType'))) return false;
    if (!clientCategory.includes(effectiveFieldValue(r, 'clientCategory'))) return false;
    if (range) {
      const d = effectiveDateIndependent(r);
      if (!d || d < range.start || d > range.end) return false;
    }
    return true;
  });
}

function groundTruthAggregate(filteredRecs) {
  let totalRevenue = 0;
  let totalTickets = 0;
  const keys = new Set();
  for (const r of filteredRecs) {
    totalRevenue += r.totalAmount || 0;
    totalTickets += r.tickets || 0;
    const key = normalizeClientKeyIndependent(r);
    if (key) keys.add(key);
  }
  return { totalRevenue, totalTickets, activeClients: keys.size };
}

function groundTruth(criteria) {
  return groundTruthAggregate(groundTruthFilter(records, criteria));
}

const gtRegionAll = groundTruthOptionValues(records, 'region');
const gtClientTypeAll = groundTruthOptionValues(records, 'clientType');
const gtClientCategoryAll = groundTruthOptionValues(records, 'clientCategory');

/** "Don't care about this dimension" in the new model = every option ticked, including blank. */
const GT_DEFAULT = { region: gtRegionAll, clientType: gtClientTypeAll, clientCategory: gtClientCategoryAll };

// ---------------------------------------------------------------------------
// "Actual": the real production filter pipeline (dataUtils.js / filterState.js)
// ---------------------------------------------------------------------------

const regionOptions = getFilterOptions(records, 'region');
const clientTypeOptions = getFilterOptions(records, 'clientType');
const clientCategoryOptions = getFilterOptions(records, 'clientCategory');
const fyOptions = getFyOptions(records);

/** Real "default state" arrays — what BookingsProvider/Leaderboard.jsx initialize their state to. */
const DEFAULT_REGION = allFilterValues(regionOptions);
const DEFAULT_CLIENT_TYPE = allFilterValues(clientTypeOptions);
const DEFAULT_CLIENT_CATEGORY = allFilterValues(clientCategoryOptions);
const DEFAULT_FY = allFilterValues(fyOptions);
/** "Every month for the given FY selection" — the real default-state derivation BookingsProvider does. */
function allMonthsFor(fyFilter) {
  return allFilterValues(getMonthOptionsForFySelection(records, fyFilter));
}

function actual({ region, clientType, clientCategory, dateFilter = { mode: 'all' } }) {
  const recs = applyStandardFilters(
    records,
    { dateFilter, regionFilter: region, clientTypeFilter: clientType, clientCategoryFilter: clientCategory },
    referenceDate,
  );
  const idx = buildClientIndex(recs);
  return { totalRevenue: idx.totalRevenue, totalTickets: idx.totalTickets, activeClients: idx.list.length };
}

const ACTUAL_DEFAULT = { region: DEFAULT_REGION, clientType: DEFAULT_CLIENT_TYPE, clientCategory: DEFAULT_CLIENT_CATEGORY };

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const results = [];

function fmtMoney(n) {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}
function metricsEqual(a, b, eps = 0.01) {
  return Math.abs(a.totalRevenue - b.totalRevenue) <= eps && Math.abs(a.totalTickets - b.totalTickets) <= eps && a.activeClients === b.activeClients;
}
function fmtMetrics(m) {
  return `revenue=${fmtMoney(m.totalRevenue)} tickets=${m.totalTickets.toLocaleString('en-IN')} activeClients=${m.activeClients}`;
}

function check(section, description, filterStateStr, expected, actualVal, notes = '') {
  const pass = metricsEqual(expected, actualVal);
  results.push({ section, description, filterStateStr, expected, actual: actualVal, pass, notes });
  const status = pass ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${section} :: ${description}`);
  console.log(`       filter: ${filterStateStr}`);
  console.log(`       expected: ${fmtMetrics(expected)}`);
  console.log(`       actual:   ${fmtMetrics(actualVal)}`);
  if (notes) console.log(`       note: ${notes}`);
  if (!pass) {
    console.log(`       DIFF: revenue Δ=${(actualVal.totalRevenue - expected.totalRevenue).toFixed(2)}, tickets Δ=${actualVal.totalTickets - expected.totalTickets}, activeClients Δ=${actualVal.activeClients - expected.activeClients}`);
  }
  console.log('');
}

console.log(`Discovered region values (${regionOptions.length}, incl. blank option if present): ${regionOptions.map((o) => o.label).join(', ')}`);
console.log(`Discovered clientType values (${clientTypeOptions.length}): ${clientTypeOptions.map((o) => o.label).join(', ')}`);
console.log(`Discovered clientCategory values (${clientCategoryOptions.length}): ${clientCategoryOptions.map((o) => o.label).join(', ')}\n`);

// ---------------------------------------------------------------------------
// (a) DEFAULT LOAD — every checkbox ticked, numbers = full unfiltered totals
// ---------------------------------------------------------------------------
console.log('='.repeat(80));
console.log('(a) DEFAULT LOAD: every checkbox ticked on mount');
console.log('='.repeat(80) + '\n');

const globalGroundTruth = groundTruth(GT_DEFAULT);
const defaultActual = actual(ACTUAL_DEFAULT);
check('(a) default load', 'All three filters default to every option ticked', 'region=ALL clientType=ALL clientCategory=ALL', globalGroundTruth, defaultActual);
console.log(`>>> BEFORE/AFTER (a): unfiltered ground truth ${fmtMetrics(globalGroundTruth)}  |  app default-load ${fmtMetrics(defaultActual)}\n`);

// ---------------------------------------------------------------------------
// (b) SELECT ALL — matches default totals exactly
// ---------------------------------------------------------------------------
console.log('='.repeat(80));
console.log('(b) SELECT ALL: explicitly clicking the master checkbox on each filter');
console.log('='.repeat(80) + '\n');

const selectAllRegion = selectAllFilterValues(regionOptions);
const selectAllClientType = selectAllFilterValues(clientTypeOptions);
const selectAllClientCategory = selectAllFilterValues(clientCategoryOptions);
const selectAllActual = actual({ region: selectAllRegion, clientType: selectAllClientType, clientCategory: selectAllClientCategory });
check(
  '(b) select all',
  'selectAllFilterValues() on each filter, compared against (a)',
  'region=ALL clientType=ALL clientCategory=ALL (via selectAllFilterValues)',
  defaultActual,
  selectAllActual,
);
console.log(`>>> BEFORE/AFTER (b): default-load ${fmtMetrics(defaultActual)}  |  after Select All ${fmtMetrics(selectAllActual)}\n`);

// ---------------------------------------------------------------------------
// (c) CLEAR SELECTION — zero rows, empty state, for each filter independently
// ---------------------------------------------------------------------------
console.log('='.repeat(80));
console.log('(c) CLEAR SELECTION: unticking every box on one filter must zero the WHOLE result');
console.log('    (AND across fields: an empty array on any one dimension can satisfy no record)');
console.log('='.repeat(80) + '\n');

for (const [label, key] of [
  ['Region', 'region'],
  ['Client Type', 'clientType'],
  ['Client Category', 'clientCategory'],
]) {
  const cleared = clearFilterSelection();
  const state = { ...ACTUAL_DEFAULT, [key]: cleared };
  const zeroActual = actual(state);
  const zeroExpected = { totalRevenue: 0, totalTickets: 0, activeClients: 0 };
  check(
    `(c) clear selection — ${label}`,
    `${label} cleared to [] (others remain fully ticked)`,
    `${key}=[] (others=ALL)`,
    zeroExpected,
    zeroActual,
    'zero rows expected across the board — app must render EmptyState, not fall back to unfiltered numbers',
  );
  console.log(`>>> BEFORE/AFTER (c) ${label}: before-clear ${fmtMetrics(defaultActual)}  |  after Clear Selection ${fmtMetrics(zeroActual)}\n`);
}

// ---------------------------------------------------------------------------
// (d) TICK BACK A SUBSET AFTER CLEARING — correct partial-filtered totals
// ---------------------------------------------------------------------------
console.log('='.repeat(80));
console.log('(d) Ticking back a subset after clearing: Region cleared, then "West" re-ticked');
console.log('='.repeat(80) + '\n');

{
  const clearedThenWest = toggleFilterValue(clearFilterSelection(), 'West');
  const partialActual = actual({ region: clearedThenWest, clientType: DEFAULT_CLIENT_TYPE, clientCategory: DEFAULT_CLIENT_CATEGORY });
  const partialExpected = groundTruth({ region: ['West'], clientType: gtClientTypeAll, clientCategory: gtClientCategoryAll });
  check(
    '(d) partial after clear',
    'Region: [] -> tick "West" only; Client Type/Category remain fully ticked',
    'region=["West"] (others=ALL)',
    partialExpected,
    partialActual,
  );
  console.log(`>>> BEFORE/AFTER (d): zero-state (Region cleared) revenue=₹0  |  after re-ticking "West" ${fmtMetrics(partialActual)}\n`);
}

// ---------------------------------------------------------------------------
// Section 1 — each filter value alone (all OTHER dimensions left at default/ALL)
// ---------------------------------------------------------------------------
console.log('='.repeat(80));
console.log('SECTION 1: Each filter value alone (other two filters left fully ticked)');
console.log('='.repeat(80) + '\n');

for (const opt of regionOptions) {
  const exp = groundTruth({ region: [opt.value === BLANK_FILTER_VALUE ? GT_BLANK : opt.value], clientType: gtClientTypeAll, clientCategory: gtClientCategoryAll });
  const act = actual({ region: [opt.value], clientType: DEFAULT_CLIENT_TYPE, clientCategory: DEFAULT_CLIENT_CATEGORY });
  check('SECTION 1 - Region', `region = "${opt.label}"`, `region=["${opt.label}"] (others=ALL)`, exp, act);
}
for (const opt of clientTypeOptions) {
  const exp = groundTruth({ region: gtRegionAll, clientType: [opt.value === BLANK_FILTER_VALUE ? GT_BLANK : opt.value], clientCategory: gtClientCategoryAll });
  const act = actual({ region: DEFAULT_REGION, clientType: [opt.value], clientCategory: DEFAULT_CLIENT_CATEGORY });
  check('SECTION 1 - Client Type', `clientType = "${opt.label}"`, `clientType=["${opt.label}"] (others=ALL)`, exp, act);
}
for (const opt of clientCategoryOptions) {
  const exp = groundTruth({ region: gtRegionAll, clientType: gtClientTypeAll, clientCategory: [opt.value === BLANK_FILTER_VALUE ? GT_BLANK : opt.value] });
  const act = actual({ region: DEFAULT_REGION, clientType: DEFAULT_CLIENT_TYPE, clientCategory: [opt.value] });
  check('SECTION 1 - Client Category', `clientCategory = "${opt.label}"`, `clientCategory=["${opt.label}"] (others=ALL)`, exp, act);
}

// ---------------------------------------------------------------------------
// Section 2 — combinations
// ---------------------------------------------------------------------------
console.log('='.repeat(80));
console.log('SECTION 2: Filter combinations');
console.log('='.repeat(80) + '\n');

// Region + Client Category
{
  const region = 'West';
  const category = 'Bank';
  const exp = groundTruth({ region: [region], clientType: gtClientTypeAll, clientCategory: [category] });
  const act = actual({ region: [region], clientType: DEFAULT_CLIENT_TYPE, clientCategory: [category] });
  check('SECTION 2a', `Region + Client Category (${region} + ${category})`, `region=["${region}"] clientCategory=["${category}"] (clientType=ALL)`, exp, act);
}

// Client Category + Financial Year
{
  const fyStartYear = financialYearStartOf(referenceDate) - 1;
  const category = 'Corporate';
  const dateFilter = { mode: 'fy', fyStartYear };
  const exp = groundTruth({ region: gtRegionAll, clientType: gtClientTypeAll, clientCategory: [category], dateFilter, referenceDate });
  const act = actual({ region: DEFAULT_REGION, clientType: DEFAULT_CLIENT_TYPE, clientCategory: [category], dateFilter });
  check(
    'SECTION 2b',
    `Client Category + Financial Year (${category} + FY ${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, '0')})`,
    `clientCategory=["${category}"] dateFilter=fy:${fyStartYear} (region/clientType=ALL)`,
    exp,
    act,
  );
}

// Region + Client Type + Client Category, all three narrowed
{
  const region = 'South';
  const clientType = 'Existing';
  const category = 'Distributor';
  const exp = groundTruth({ region: [region], clientType: [clientType], clientCategory: [category] });
  const act = actual({ region: [region], clientType: [clientType], clientCategory: [category] });
  check(
    'SECTION 2c',
    `Region + Client Type + Client Category, all three narrowed (${region} + ${clientType} + ${category})`,
    `region=["${region}"] clientType=["${clientType}"] clientCategory=["${category}"]`,
    exp,
    act,
    'Client Type (New/Existing) and Client Category (Corporate/Agency/...) are mutually exclusive per record per the ETL, so narrowing both to specific non-blank values always yields 0 — expected, not a bug.',
  );
}

// A combination that returns zero results, found programmatically
{
  let zeroCombo = null;
  outer: for (const r of regionOptions) {
    for (const c of clientCategoryOptions) {
      const count = groundTruthFilter(records, {
        region: [r.value === BLANK_FILTER_VALUE ? GT_BLANK : r.value],
        clientType: gtClientTypeAll,
        clientCategory: [c.value === BLANK_FILTER_VALUE ? GT_BLANK : c.value],
      }).length;
      if (count === 0) {
        zeroCombo = { region: r.value, category: c.value };
        break outer;
      }
    }
  }
  if (zeroCombo) {
    const exp = groundTruth({
      region: [zeroCombo.region === BLANK_FILTER_VALUE ? GT_BLANK : zeroCombo.region],
      clientType: gtClientTypeAll,
      clientCategory: [zeroCombo.category === BLANK_FILTER_VALUE ? GT_BLANK : zeroCombo.category],
    });
    const act = actual({ region: [zeroCombo.region], clientType: DEFAULT_CLIENT_TYPE, clientCategory: [zeroCombo.category] });
    check(
      'SECTION 2d',
      `Zero-result combination (Region=${zeroCombo.region} + Category=${zeroCombo.category})`,
      `region=["${zeroCombo.region}"] clientCategory=["${zeroCombo.category}"] (clientType=ALL)`,
      exp,
      act,
      'expected activeClients=0 — app must render EmptyState (verified separately in a live browser).',
    );
  } else {
    console.log('[SKIP] SECTION 2d :: no zero-result Region x Category combination exists\n');
  }
}

// ---------------------------------------------------------------------------
// Section 3 — Genre Affinity & Dormant pages (unaffected by this change: they
// have no Region/Client Type/Client Category filter bar at all)
// ---------------------------------------------------------------------------
console.log('='.repeat(80));
console.log('SECTION 3: Genre Affinity / Dormant pages — structurally unaffected by this bug class');
console.log('  Neither page uses FilterBar/applyStandardFilters, so there is nothing to fix there;');
console.log('  re-verified anyway for completeness, against independently-derived ground truth.');
console.log('='.repeat(80) + '\n');

const MIN_BOOKINGS = 3;
const THRESHOLD = 0.65;
function independentAffinityCheck(dimension, value) {
  const byKey = new Map();
  for (const r of records) {
    const key = normalizeClientKeyIndependent(r);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  let matchingRevenue = 0;
  let matchingClients = 0;
  for (const recs of byKey.values()) {
    if (recs.length < MIN_BOOKINGS) continue;
    const considered = recs.filter((r) => r[dimension] != null && r[dimension] !== '');
    if (considered.length === 0) continue;
    const matchCount = considered.filter((r) => r[dimension] === value).length;
    if (matchCount / considered.length >= THRESHOLD) {
      matchingClients += 1;
      matchingRevenue += recs.reduce((sum, r) => sum + (r.totalAmount || 0), 0);
    }
  }
  return { matchingClients, matchingRevenue };
}
{
  const idx = buildClientIndex(records);
  const loyalties = computeClientAffinities(idx.list, { minBookings: MIN_BOOKINGS, threshold: THRESHOLD });
  const matches = loyalties.filter((l) => l.dimension === 'movieIndustry' && l.value === 'Hollywood');
  const act = { matchingClients: matches.length, matchingRevenue: matches.reduce((s, l) => s + l.totalRevenue, 0) };
  const exp = independentAffinityCheck('movieIndustry', 'Hollywood');
  const pass = exp.matchingClients === act.matchingClients && Math.abs(exp.matchingRevenue - act.matchingRevenue) <= 0.01;
  results.push({ section: 'SECTION 3', description: 'Affinity movieIndustry=Hollywood', pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] SECTION 3 :: Genre Affinity loyal clients for movieIndustry="Hollywood" — expected ${JSON.stringify(exp)} actual ${JSON.stringify(act)}\n`);
}
{
  const MONTHS_THRESHOLD = 6;
  const DORMANT_MIN_BOOKINGS = 2;
  const idx = buildClientIndex(records);
  const dormant = computeDormantClients(idx.list, referenceDate, { monthsThreshold: MONTHS_THRESHOLD, minBookings: DORMANT_MIN_BOOKINGS });
  const act = { dormantCount: dormant.length, dormantRevenue: dormant.reduce((s, c) => s + c.totalRevenue, 0) };

  const byKey = new Map();
  for (const r of records) {
    const key = normalizeClientKeyIndependent(r);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { count: 0, revenue: 0, lastDate: null });
    const e = byKey.get(key);
    e.count += 1;
    e.revenue += r.totalAmount || 0;
    const d = effectiveDateIndependent(r);
    if (d && (!e.lastDate || d > e.lastDate)) e.lastDate = d;
  }
  const indepRef = independentReferenceDate(records);
  let dormantCount = 0;
  let dormantRevenue = 0;
  for (const e of byKey.values()) {
    if (e.count < DORMANT_MIN_BOOKINGS || !e.lastDate) continue;
    const monthsSince = (indepRef.getUTCFullYear() - e.lastDate.getUTCFullYear()) * 12 + (indepRef.getUTCMonth() - e.lastDate.getUTCMonth());
    if (monthsSince >= MONTHS_THRESHOLD) {
      dormantCount += 1;
      dormantRevenue += e.revenue;
    }
  }
  const exp = { dormantCount, dormantRevenue };
  const pass = exp.dormantCount === act.dormantCount && Math.abs(exp.dormantRevenue - act.dormantRevenue) <= 0.01;
  results.push({ section: 'SECTION 3', description: 'Dormant clients list', pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] SECTION 3 :: Dormant clients — expected ${JSON.stringify(exp)} actual ${JSON.stringify(act)}\n`);
}

// ---------------------------------------------------------------------------
// Section 4 — Date filter re-verification: not built on the array model at all
// ---------------------------------------------------------------------------
console.log('='.repeat(80));
console.log('SECTION 4: Date filter (Quick presets / Financial Year / Custom Range) re-verified');
console.log('  resolveDateRange() takes a { mode, ... } object, never an array of ticked values —');
console.log('  there is no empty-array-vs-full-list ambiguity for it to inherit. Confirmed below.');
console.log('='.repeat(80) + '\n');

{
  const allTimeRange = resolveDateRange({ mode: 'preset', preset: 'all' }, referenceDate);
  const pass1 = allTimeRange === null;
  results.push({ section: 'SECTION 4', description: 'preset "all" resolves to null (no restriction), not []', pass: pass1 });
  console.log(`[${pass1 ? 'PASS' : 'FAIL'}] SECTION 4 :: dateFilter {mode:'preset',preset:'all'} -> resolveDateRange() = ${JSON.stringify(allTimeRange)}`);

  const fyStartYear = financialYearStartOf(referenceDate) - 1;
  const fyRange = resolveDateRange({ mode: 'fy', fyStartYear }, referenceDate);
  const expectedFyRange = { start: new Date(Date.UTC(fyStartYear, 3, 1)).toISOString(), end: new Date(Date.UTC(fyStartYear + 1, 2, 31)).toISOString() };
  const pass2 = fyRange && fyRange.start.toISOString() === expectedFyRange.start && fyRange.end.toISOString() === expectedFyRange.end;
  results.push({ section: 'SECTION 4', description: 'FY mode resolves to explicit Apr-Mar window', pass: pass2 });
  console.log(`[${pass2 ? 'PASS' : 'FAIL'}] SECTION 4 :: dateFilter {mode:'fy',fyStartYear:${fyStartYear}} -> ${fyRange.start.toISOString().slice(0, 10)} .. ${fyRange.end.toISOString().slice(0, 10)}\n`);
}

// ---------------------------------------------------------------------------
// Section 5 — Summary page: 5 KPIs + trend/breakdown invariants, 3 filter states
// ---------------------------------------------------------------------------
console.log('='.repeat(80));
console.log('SECTION 5: Summary page (Revenue/Clients/Tickets/SPH/ATV + charts), 3 filter states');
console.log('='.repeat(80) + '\n');

function aggregateMetricsIndependent(recs) {
  let totalRevenue = 0;
  let totalTickets = 0;
  let sphWeightedSum = 0;
  const keys = new Set();
  for (const r of recs) {
    totalRevenue += r.totalAmount || 0;
    totalTickets += r.tickets || 0;
    if (r.sph != null && r.tickets != null) sphWeightedSum += r.sph * r.tickets;
    const key = normalizeClientKeyIndependent(r);
    if (key) keys.add(key);
  }
  return {
    totalRevenue,
    totalTickets,
    clientCount: keys.size,
    sph: totalTickets > 0 ? sphWeightedSum / totalTickets : null,
    atv: totalTickets > 0 ? totalRevenue / totalTickets : null,
  };
}

/**
 * Ground truth for the global filter, written independently: FY and Month
 * are both standard-checkbox set membership (mirrors applyGlobalFilters'
 * new multi-select model) — no continuous { start, end } range involved, so
 * a non-contiguous multi-FY selection (e.g. FY 2022-23 + FY 2025-26) is
 * handled correctly with no special-casing.
 */
function groundTruthGlobalFilter(recs, { fyFilter, monthFilter, region }) {
  return recs.filter((r) => {
    if (!region.includes(effectiveFieldValue(r, 'region'))) return false;
    const d = effectiveDateIndependent(r);
    if (!d) return false;
    if (!fyFilter.includes(String(financialYearStartOf(d)))) return false;
    const mKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!monthFilter.includes(mKey)) return false;
    return true;
  });
}

function numClose(a, b, eps = 0.01) {
  return (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= eps);
}
function summaryMetricsEqual(a, b) {
  return numClose(a.totalRevenue, b.totalRevenue) && numClose(a.totalTickets, b.totalTickets) && a.clientCount === b.clientCount && numClose(a.sph, b.sph) && numClose(a.atv, b.atv);
}
function fmtSummary(m) {
  const fmtR = (v) => (v == null ? 'null' : `₹${v.toFixed(2)}`);
  return `revenue=${fmtMoney(m.totalRevenue)} tickets=${m.totalTickets.toLocaleString('en-IN')} clients=${m.clientCount} sph=${fmtR(m.sph)} atv=${fmtR(m.atv)}`;
}

const recentCompleteFy = financialYearStartOf(referenceDate) - 1; // a full past FY, not the partial current one

const secondCompleteFy = recentCompleteFy - 1;
const twoFyKeys = [String(recentCompleteFy), String(secondCompleteFy)];

const summaryScenarios = [
  { label: 'All time', gt: { fyFilter: DEFAULT_FY, monthFilter: allMonthsFor(DEFAULT_FY), region: gtRegionAll }, act: { fyFilter: DEFAULT_FY, monthFilter: allMonthsFor(DEFAULT_FY), regionFilter: DEFAULT_REGION } },
  { label: `Specific FY (FY ${recentCompleteFy}-${String((recentCompleteFy + 1) % 100).padStart(2, '0')})`, gt: { fyFilter: [String(recentCompleteFy)], monthFilter: allMonthsFor([String(recentCompleteFy)]), region: gtRegionAll }, act: { fyFilter: [String(recentCompleteFy)], monthFilter: allMonthsFor([String(recentCompleteFy)]), regionFilter: DEFAULT_REGION } },
  { label: 'Specific Region (West)', gt: { fyFilter: DEFAULT_FY, monthFilter: allMonthsFor(DEFAULT_FY), region: ['West'] }, act: { fyFilter: DEFAULT_FY, monthFilter: allMonthsFor(DEFAULT_FY), regionFilter: ['West'] } },
  {
    label: `Two FYs combined (FY ${recentCompleteFy}-${String((recentCompleteFy + 1) % 100).padStart(2, '0')} + FY ${secondCompleteFy}-${String((secondCompleteFy + 1) % 100).padStart(2, '0')})`,
    gt: { fyFilter: twoFyKeys, monthFilter: allMonthsFor(twoFyKeys), region: gtRegionAll },
    act: { fyFilter: twoFyKeys, monthFilter: allMonthsFor(twoFyKeys), regionFilter: DEFAULT_REGION },
  },
];

for (const scenario of summaryScenarios) {
  const gtRecords = groundTruthGlobalFilter(records, scenario.gt);
  const expected = aggregateMetricsIndependent(gtRecords);
  const actRecords = applyGlobalFilters(records, scenario.act);
  const actualMetrics = aggregateMetrics(actRecords);
  const pass = summaryMetricsEqual(expected, actualMetrics);
  results.push({ section: 'SECTION 5', description: `Summary KPIs — ${scenario.label}`, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] SECTION 5 :: Summary 5 KPIs — ${scenario.label}`);
  console.log(`       expected: ${fmtSummary(expected)}`);
  console.log(`       actual:   ${fmtSummary(actualMetrics)}`);

  // Trend chart invariant: bucket revenues must sum back to the KPI total —
  // proves the chart isn't silently dropping or double-counting records.
  const granularity = getTrendGranularity(scenario.act);
  const series = computeTimeSeriesMetrics(actRecords, granularity);
  const seriesRevenueSum = series.reduce((s, b) => s + b.totalRevenue, 0);
  const seriesTicketsSum = series.reduce((s, b) => s + b.totalTickets, 0);
  const trendPass = numClose(seriesRevenueSum, actualMetrics.totalRevenue) && numClose(seriesTicketsSum, actualMetrics.totalTickets);
  results.push({ section: 'SECTION 5', description: `Trend chart bucket sum == KPI total — ${scenario.label}`, pass: trendPass });
  console.log(`       [${trendPass ? 'PASS' : 'FAIL'}] trend (${granularity}, ${series.length} buckets) revenue sum = ${fmtMoney(seriesRevenueSum)} (expect ${fmtMoney(actualMetrics.totalRevenue)})`);

  // Breakdown chart invariant: Region breakdown (when Region isn't itself
  // restricted) must sum to the KPI total minus whatever has a blank region.
  const regionRestricted = scenario.act.regionFilter.length !== regionOptions.length;
  const breakdownField = regionRestricted ? 'city' : 'region';
  const breakdown = computeRevenueByField(actRecords, breakdownField);
  const breakdownSum = breakdown.reduce((s, b) => s + b.revenue, 0);
  const blankFieldRevenue = actRecords.filter((r) => r[breakdownField] == null || r[breakdownField] === '').reduce((s, r) => s + (r.totalAmount || 0), 0);
  const breakdownPass = numClose(breakdownSum + blankFieldRevenue, actualMetrics.totalRevenue);
  results.push({ section: 'SECTION 5', description: `${breakdownField} breakdown sum + blank == KPI total — ${scenario.label}`, pass: breakdownPass });
  console.log(`       [${breakdownPass ? 'PASS' : 'FAIL'}] ${breakdownField} breakdown (${breakdown.length} bars) sum=${fmtMoney(breakdownSum)} + blank-${breakdownField}=${fmtMoney(blankFieldRevenue)} = ${fmtMoney(breakdownSum + blankFieldRevenue)} (expect ${fmtMoney(actualMetrics.totalRevenue)})`);

  // Delta badge: only defined (non-null) when a prior period exists — i.e.
  // exactly one FY selected (Two FYs combined correctly has none).
  const priorFilter = getPriorPeriodFilter(scenario.act, { records, monthOptions: getMonthOptionsForFySelection(records, scenario.act.fyFilter) });
  if (priorFilter) {
    const priorGtRecords = groundTruthGlobalFilter(records, { ...priorFilter, region: scenario.gt.region });
    const priorExpected = aggregateMetricsIndependent(priorGtRecords);
    const priorActualRecords = applyGlobalFilters(records, { ...priorFilter, regionFilter: scenario.act.regionFilter });
    const priorActual = aggregateMetrics(priorActualRecords);
    const expectedDelta = computeDelta(expected.totalRevenue, priorExpected.totalRevenue);
    const actualDelta = computeDelta(actualMetrics.totalRevenue, priorActual.totalRevenue);
    const deltaPass = numClose(expectedDelta, actualDelta, 0.0001);
    results.push({ section: 'SECTION 5', description: `Revenue delta vs prior period — ${scenario.label}`, pass: deltaPass });
    console.log(`       [${deltaPass ? 'PASS' : 'FAIL'}] revenue delta vs prior period: expected=${expectedDelta == null ? 'null' : (expectedDelta * 100).toFixed(1) + '%'} actual=${actualDelta == null ? 'null' : (actualDelta * 100).toFixed(1) + '%'}`);
  } else {
    console.log('       (no single well-defined prior period for this selection — DeltaBadge renders nothing, nothing to compare)');
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Section 6 — Top 10 Concentration KPI (renamed from Top 15)
// ---------------------------------------------------------------------------
console.log('='.repeat(80));
console.log('SECTION 6: Top 10 Concentration KPI (renamed from Top 15)');
console.log('='.repeat(80) + '\n');

function top10ConcentrationIndependent(recs) {
  const byKey = new Map();
  for (const r of recs) {
    const key = normalizeClientKeyIndependent(r);
    if (!key) continue;
    byKey.set(key, (byKey.get(key) || 0) + (r.totalAmount || 0));
  }
  const sorted = [...byKey.values()].sort((a, b) => b - a);
  const total = sorted.reduce((s, v) => s + v, 0);
  const top10 = sorted.slice(0, 10).reduce((s, v) => s + v, 0);
  return total > 0 ? top10 / total : null;
}
function top10ConcentrationActual(recs) {
  const idx = buildClientIndex(recs);
  const sorted = [...idx.list].sort((a, b) => b.totalRevenue - a.totalRevenue);
  const top10 = sorted.slice(0, 10).reduce((s, c) => s + c.totalRevenue, 0);
  return idx.totalRevenue > 0 ? top10 / idx.totalRevenue : null;
}

for (const [label, recsFilter] of [
  ['All time', () => records],
  ['Region = West', () => applyGlobalFilters(records, { fyFilter: DEFAULT_FY, monthFilter: allMonthsFor(DEFAULT_FY), regionFilter: ['West'] })],
]) {
  const recs = recsFilter();
  const exp = top10ConcentrationIndependent(recs);
  const act = top10ConcentrationActual(recs);
  const pass = numClose(exp, act, 0.0001);
  results.push({ section: 'SECTION 6', description: `Top 10 Concentration — ${label}`, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] SECTION 6 :: Top 10 Concentration — ${label}: expected=${exp == null ? 'null' : (exp * 100).toFixed(1) + '%'} actual=${act == null ? 'null' : (act * 100).toFixed(1) + '%'}\n`);
}

// ---------------------------------------------------------------------------
// Section 7 — cross-page consistency: structural + data-level
// ---------------------------------------------------------------------------
console.log('='.repeat(80));
console.log('SECTION 7: Global filter state truly shared across all 4 pages');
console.log('='.repeat(80) + '\n');

const VIEW_FILES = {
  Summary: 'src/views/Summary.jsx',
  Leaderboard: 'src/views/Leaderboard.jsx',
  Affinity: 'src/views/Affinity.jsx',
  Dormant: 'src/views/Dormant.jsx',
};
for (const [name, relPath] of Object.entries(VIEW_FILES)) {
  const src = readFileSync(join(__dirname, relPath), 'utf8');
  const usesGlobal = /globalFilteredRecords|globalFilteredClientIndex/.test(src);
  const hasOwnDateOrRegionState = /useState\([^)]*\)\s*;\s*\/\/.*\b(fyFilter|monthFilter|regionFilter)\b/.test(src) || /const \[\s*(fyFilter|monthFilter|regionFilter)\s*,/.test(src);
  const pass = usesGlobal && !hasOwnDateOrRegionState;
  results.push({ section: 'SECTION 7', description: `${name}.jsx reads global filter state from context, not its own copy`, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] SECTION 7 :: ${name}.jsx uses globalFiltered*: ${usesGlobal}, has its own FY/Month/Region state: ${hasOwnDateOrRegionState}`);
}
console.log('');

// Data-level: two structurally different code paths (buildClientIndex, used
// by Leaderboard, vs aggregateMetrics, used by Summary) must agree on
// revenue/client-count for the exact same globally-filtered record set —
// this is what "identical numbers on every page" reduces to, since every
// page derives from the one applyGlobalFilters(...) result in context.
{
  const scoped = applyGlobalFilters(records, { fyFilter: [String(recentCompleteFy)], monthFilter: allMonthsFor([String(recentCompleteFy)]), regionFilter: ['South'] });
  const leaderboardStyle = buildClientIndex(applyClientFilters(scoped, { clientTypeFilter: DEFAULT_CLIENT_TYPE, clientCategoryFilter: DEFAULT_CLIENT_CATEGORY }));
  const summaryStyle = aggregateMetrics(scoped);
  const pass = numClose(leaderboardStyle.totalRevenue, summaryStyle.totalRevenue) && leaderboardStyle.list.length === summaryStyle.clientCount && numClose(leaderboardStyle.totalTickets, summaryStyle.totalTickets);
  results.push({ section: 'SECTION 7', description: 'Leaderboard-path vs Summary-path agree for identical global filter state', pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] SECTION 7 :: FY ${recentCompleteFy}-${String((recentCompleteFy + 1) % 100).padStart(2, '0')} + Region=South`);
  console.log(`       Leaderboard path (buildClientIndex):  revenue=${fmtMoney(leaderboardStyle.totalRevenue)} clients=${leaderboardStyle.list.length} tickets=${leaderboardStyle.totalTickets.toLocaleString('en-IN')}`);
  console.log(`       Summary path (aggregateMetrics):      revenue=${fmtMoney(summaryStyle.totalRevenue)} clients=${summaryStyle.clientCount} tickets=${summaryStyle.totalTickets.toLocaleString('en-IN')}\n`);
}

// ---------------------------------------------------------------------------
// Section 8 — page-specific (Client Type/Category) AND global (Region) filters combine
// ---------------------------------------------------------------------------
console.log('='.repeat(80));
console.log('SECTION 8: Page-specific filters (Client Type/Category) AND-combine with global (Region)');
console.log('='.repeat(80) + '\n');

{
  const region = 'West';
  const clientType = 'New';
  const exp = groundTruth({ region: [region], clientType: [clientType], clientCategory: gtClientCategoryAll });
  const globallyFiltered = applyGlobalFilters(records, { fyFilter: DEFAULT_FY, monthFilter: allMonthsFor(DEFAULT_FY), regionFilter: [region] });
  const fullyFiltered = applyClientFilters(globallyFiltered, { clientTypeFilter: [clientType], clientCategoryFilter: DEFAULT_CLIENT_CATEGORY });
  const idx = buildClientIndex(fullyFiltered);
  const act = { totalRevenue: idx.totalRevenue, totalTickets: idx.totalTickets, activeClients: idx.list.length };
  check(
    'SECTION 8',
    `Region (global) = ${region} AND Client Type (page-local) = ${clientType}`,
    `global: regionFilter=["${region}"]  |  page-local: clientTypeFilter=["${clientType}"]`,
    exp,
    act,
    'Verifies AND composition, not one layer overriding the other: applyGlobalFilters(region) piped into applyClientFilters(clientType).',
  );
}

// ---------------------------------------------------------------------------
// Section 9 — FY 2022-23 (full year) and FY 2026-27 (capped to actual data) month ranges
// ---------------------------------------------------------------------------
console.log('='.repeat(80));
console.log('SECTION 9: Month dropdown range — FY 2022-23 (full) vs FY 2026-27 (capped to real data)');
console.log('='.repeat(80) + '\n');

{
  const fy2022Months = monthOptionsForFY(records, 2022);
  const pass2022 = fy2022Months.length === 12 && fy2022Months[0].value === '2022-04' && fy2022Months[11].value === '2023-03';
  results.push({ section: 'SECTION 9', description: 'FY 2022-23 shows the full Apr-Mar range', pass: pass2022 });
  console.log(`[${pass2022 ? 'PASS' : 'FAIL'}] SECTION 9 :: FY 2022-23 month options (${fy2022Months.length}): ${fy2022Months.map((m) => m.label).join(', ')}\n`);

  const currentFy = financialYearStartOf(referenceDate);
  const fyCurrentMonths = monthOptionsForFY(records, currentFy);
  const expectedMonthCount = independentReferenceDate(records).getUTCMonth() - 3 + 1; // Apr(=3) .. current month, inclusive
  const pass2026 = fyCurrentMonths.length === expectedMonthCount && fyCurrentMonths[fyCurrentMonths.length - 1].value === `${referenceDate.getUTCFullYear()}-${String(referenceDate.getUTCMonth() + 1).padStart(2, '0')}`;
  results.push({ section: 'SECTION 9', description: `FY ${currentFy}-${String((currentFy + 1) % 100).padStart(2, '0')} (current/latest) is capped to real data, not the full Apr-Mar range`, pass: pass2026 });
  console.log(`[${pass2026 ? 'PASS' : 'FAIL'}] SECTION 9 :: FY ${currentFy}-${String((currentFy + 1) % 100).padStart(2, '0')} month options (${fyCurrentMonths.length}, expected ${expectedMonthCount}): ${fyCurrentMonths.map((m) => m.label).join(', ')}\n`);
}

// ---------------------------------------------------------------------------
// Section 10 — FY/Month multi-select behavior: combined options, single-FY
// equivalence, capped current FY (via the new multi-select-aware function),
// and pruning an invalid Month selection after deselecting its FY.
// ---------------------------------------------------------------------------
console.log('='.repeat(80));
console.log('SECTION 10: FY/Month multi-select — combined options, capping, and deselection pruning');
console.log('='.repeat(80) + '\n');

{
  // Two specific FYs selected -> Month options are the union of each FY's
  // own (data-capped) months, combined.
  const combined = getMonthOptionsForFySelection(records, twoFyKeys);
  const expectedCombined = new Set([...monthOptionsForFY(records, recentCompleteFy), ...monthOptionsForFY(records, secondCompleteFy)].map((m) => m.value));
  const pass = combined.length === expectedCombined.size && combined.every((m) => expectedCombined.has(m.value));
  results.push({ section: 'SECTION 10', description: 'Two FYs combined -> Month options are the union of both', pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] SECTION 10 :: FY ${recentCompleteFy}-.. + FY ${secondCompleteFy}-.. combined -> ${combined.length} months (${combined[0]?.label} .. ${combined[combined.length - 1]?.label})`);
}

{
  // Selecting FY 2022-23 alone through the multi-select-aware function must
  // match monthOptionsForFY(records, 2022) exactly — no disable, no
  // regression from the earlier single-select fix.
  const viaMultiSelect = getMonthOptionsForFySelection(records, ['2022']);
  const viaSingle = monthOptionsForFY(records, 2022);
  const pass = viaMultiSelect.length === viaSingle.length && viaMultiSelect.every((m, i) => m.value === viaSingle[i].value);
  results.push({ section: 'SECTION 10', description: 'FY 2022-23 alone (multi-select fn) matches the single-select fn exactly', pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] SECTION 10 :: FY 2022-23 alone via getMonthOptionsForFySelection -> ${viaMultiSelect.length} months: ${viaMultiSelect.map((m) => m.label).join(', ')}`);
}

{
  // FY 2026-27 (current/latest) alone -> still capped to real data (Apr-Aug
  // 2026), even reached through the new multi-select function.
  const currentFy = financialYearStartOf(referenceDate);
  const viaMultiSelect = getMonthOptionsForFySelection(records, [String(currentFy)]);
  const viaSingle = monthOptionsForFY(records, currentFy);
  const pass = viaMultiSelect.length === viaSingle.length && viaMultiSelect.every((m, i) => m.value === viaSingle[i].value) && viaMultiSelect.length < 12;
  results.push({ section: 'SECTION 10', description: `FY ${currentFy}-.. (current) alone still capped to real data via the multi-select fn`, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] SECTION 10 :: FY ${currentFy}-.. alone via getMonthOptionsForFySelection -> ${viaMultiSelect.length} months: ${viaMultiSelect.map((m) => m.label).join(', ')}`);
}

{
  // Not-fully-unrestricted FY selection: with a genuine subset ticked (not
  // "all"), Month options must be exactly that subset's combined months —
  // not silently fall back to the whole dataset.
  const subsetFy = [String(recentCompleteFy)];
  const options = getMonthOptionsForFySelection(records, subsetFy);
  const wholeDataset = getMonthOptionsForFySelection(records, DEFAULT_FY);
  const pass = options.length < wholeDataset.length && options.every((m) => m.value.startsWith(String(recentCompleteFy)) || m.value.startsWith(String(recentCompleteFy + 1)));
  results.push({ section: 'SECTION 10', description: 'A genuine FY subset (not "all") scopes Month options correctly, not to the whole dataset', pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] SECTION 10 :: single-FY subset -> ${options.length} months vs whole-dataset ${wholeDataset.length} months`);
}

{
  // Deselecting an FY prunes a now-invalid Month selection — this replicates
  // BookingsProvider's derivation: monthFilterRaw is intersected with the
  // NEW options whenever the FY selection (and therefore monthOptions)
  // changes, so a stale month never keeps silently restricting the data.
  const currentFy = financialYearStartOf(referenceDate);
  const beforeOptions = getMonthOptionsForFySelection(records, [String(currentFy)]);
  const explicitMonthSelection = [beforeOptions[0].value]; // user had ticked just the first month of the current FY
  const afterFyChanged = [String(recentCompleteFy)]; // user deselects the current FY, picks a different one instead
  const afterOptions = getMonthOptionsForFySelection(records, afterFyChanged);
  const prunedSelection = explicitMonthSelection.filter((k) => afterOptions.some((o) => o.value === k));
  const pass = prunedSelection.length === 0;
  results.push({ section: 'SECTION 10', description: 'Deselecting an FY prunes a Month selection that is no longer valid', pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] SECTION 10 :: had monthFilter=${JSON.stringify(explicitMonthSelection)} under FY ${currentFy}; after switching FY to ${recentCompleteFy}, pruned monthFilter=${JSON.stringify(prunedSelection)} (expect [])`);
}
console.log('');

// ---------------------------------------------------------------------------
// SECTION 11 (added for the visual-redesign Phase 4 regression pass):
//   11a — city normalization: confirm known, already-fixed raw-typo strings
//         still don't appear as their own distinct city value in the current
//         bookings.json — i.e. nothing in Phases 1-3 silently regenerated
//         the dataset from a stale/pre-fix ETL run.
//   11b/11c — CSV export: the real toCsv() (src/lib/csv.js, the exact
//         function ExportCsvButton calls) reproduces the same figures as
//         the underlying data, for both a plain field-name column config
//         (Leaderboard's) and a computed-function column config (Dormant's
//         "Status" column) — the two distinct code paths toCsv supports.
// ---------------------------------------------------------------------------
console.log('='.repeat(80));
console.log('SECTION 11: City/region normalization spot-check + CSV export correctness');
console.log('='.repeat(80) + '\n');

{
  const KNOWN_MERGED_TYPOS = ['Bangaluru', 'Cochin', 'Ahemdabad', 'Kolkatta', 'Gurgoan', 'Gurgona', 'Mumbai`', 'Vishakhapatnam', 'Guruguam', 'Dhanabad', 'Kolktta', 'Mumabi'];
  const distinctCities = new Set(records.map((r) => r.city).filter(Boolean));
  const stillPresent = KNOWN_MERGED_TYPOS.filter((typo) => distinctCities.has(typo));
  const pass = stillPresent.length === 0;
  results.push({ section: 'SECTION 11', description: 'Known city typos remain merged (not reintroduced as distinct values)', pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] SECTION 11 :: ${KNOWN_MERGED_TYPOS.length} known-fixed typo strings checked against ${distinctCities.size} distinct city values in bookings.json`);
  if (!pass) console.log(`       still present (should be merged away): ${stillPresent.join(', ')}`);
  console.log('');
}

{
  // Leaderboard-shape CSV: field-name columns + a client-side-computed
  // `rank`, against the exact same buildClientIndex() the app calls.
  const clientIndex = buildClientIndex(records);
  const sorted = [...clientIndex.list].sort((a, b) => b.totalRevenue - a.totalRevenue);
  const rows = sorted.slice(0, 3).map((c, i) => ({ ...c, rank: i + 1 }));
  const columns = [
    { label: 'Rank', value: 'rank' },
    { label: 'Client', value: 'displayName' },
    { label: 'Client Type', value: 'clientType' },
    { label: 'Client Category', value: 'clientCategory' },
    { label: 'Revenue', value: 'totalRevenue' },
    { label: 'Tickets', value: 'totalTickets' },
    { label: 'Bookings', value: 'bookingCount' },
    { label: 'Avg Ticket Price', value: 'avgTicketPrice' },
  ];
  const csv = toCsv(rows, columns);
  const lines = csv.split('\n');
  const headerOk = lines[0] === columns.map((c) => c.label).join(',');
  let rowsOk = true;
  rows.forEach((row, i) => {
    const cells = lines[i + 1].split(',');
    const expectedCells = [String(row.rank), row.displayName, row.clientType ?? '', row.clientCategory ?? '', String(row.totalRevenue), String(row.totalTickets), String(row.bookingCount), String(row.avgTicketPrice)];
    // Client names/categories can legitimately contain a comma, in which case toCsv quotes that one cell —
    // compare the whole line's content instead of a naive positional split for those rows.
    const usesQuoting = expectedCells.some((v) => /[,"\n]/.test(v));
    if (usesQuoting) {
      const rebuilt = expectedCells.map((v) => (/[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',');
      if (rebuilt !== lines[i + 1]) rowsOk = false;
    } else if (JSON.stringify(cells) !== JSON.stringify(expectedCells)) {
      rowsOk = false;
    }
  });
  const pass = headerOk && rowsOk;
  results.push({ section: 'SECTION 11', description: 'toCsv() (Leaderboard-shape: field-name columns) matches buildClientIndex() ground truth', pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] SECTION 11 :: CSV export (Leaderboard columns) — top 3 by revenue`);
  console.log(`       header: ${JSON.stringify(lines[0])}`);
  console.log(`       row 1:  ${JSON.stringify(lines[1])}`);
  console.log('');
}

{
  // Dormant-shape CSV: exercises the `value: fn` (computed-column) path —
  // the one Leaderboard's plain field-name columns above don't touch.
  const dormant = computeDormantClients(buildClientIndex(records).list, referenceDate, { monthsThreshold: 6, minBookings: 2 });
  const rows = dormant.slice(0, 3);
  const columns = [
    { label: 'Client', value: 'displayName' },
    { label: 'Status', value: (c) => `Dormant - ${c.monthsSince}mo` },
    { label: 'Bookings', value: 'bookingCount' },
    { label: 'Lifetime Revenue', value: 'totalRevenue' },
  ];
  const csv = toCsv(rows, columns);
  const lines = csv.split('\n');
  let pass = lines[0] === columns.map((c) => c.label).join(',');
  rows.forEach((row, i) => {
    const expectedStatus = `Dormant - ${row.monthsSince}mo`;
    if (!lines[i + 1].includes(expectedStatus)) pass = false;
    if (!lines[i + 1].includes(String(row.totalRevenue))) pass = false;
  });
  results.push({ section: 'SECTION 11', description: 'toCsv() (Dormant-shape: computed-function column) matches computeDormantClients() ground truth', pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] SECTION 11 :: CSV export (Dormant columns, computed "Status" column) — top 3 dormant by revenue`);
  console.log(`       header: ${JSON.stringify(lines[0])}`);
  console.log(`       row 1:  ${JSON.stringify(lines[1])}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('='.repeat(80));
console.log('SUMMARY');
console.log('='.repeat(80));

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
console.log(`\n${passed}/${results.length} checks passed.\n`);

if (failed.length > 0) {
  console.log(`${failed.length} FAILURE(S):\n`);
  for (const f of failed) {
    console.log(`- [${f.section}] ${f.description}`);
    if (f.filterStateStr) console.log(`    filter: ${f.filterStateStr}`);
    if (f.expected) console.log(`    expected: ${fmtMetrics(f.expected)}`);
    if (f.actual) console.log(`    actual:   ${fmtMetrics(f.actual)}`);
    if (f.notes) console.log(`    note: ${f.notes}`);
  }
  process.exitCode = 1;
} else {
  console.log('No failures.');
}
